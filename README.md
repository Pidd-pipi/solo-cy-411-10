# CarbonTrack 碳足迹追踪平台

CarbonTrack 是面向个人与小微企业的碳排放记录、分析、目标管理和排行榜全栈 Web 应用。

## Docker Compose 一键启动（首选）

```bash
cp .env.example .env
docker compose up -d
```

访问地址：

- 前端：http://localhost:18411
- 后端健康检查：http://localhost:19411/health
- MySQL：localhost:3306

停止服务：

```bash
docker compose down
```

## 主要功能

- 用户注册、登录、JWT 认证和 RBAC 权限校验
- 活动记录新增、编辑、删除、分类筛选和分页列表
- 周期模板按日/周/月自动生成活动：启用即补算截至当天的缺记录，暂停不补记、恢复从恢复日续算，月模板短月落到当月最后一天且下月恢复原日
- CarbonFactor 按地区与分类匹配并自动计算 `carbon_value`
- 仪表盘展示今日、本周、本月碳排放和趋势图
- 目标管理展示目标完成进度和到期区间
- 排行榜按地区和时间段查看用户低碳排名
- 管理员查看操作审计日志

## 本地开发方式（备选）

```bash
cd backend
npm install
npm run dev
```

```bash
cd frontend
npm install
npm run dev
```

本地开发时前端 Vite 会把 `/api` 代理到 `http://localhost:19411`。生产 Docker 中由 Nginx 将 `/api/` 反向代理到 `http://backend:3000/`，前端代码不硬编码 localhost。

## 周期模板回归测试（真实 MySQL）

回归测试**不使用内存替身、假仓储或单连接串行化**：用真实 Nest HTTP（supertest 风格请求，并发时走不同连接池连接）+ 真实 MySQL，独立连接做权威回读，并用第二条连接持有真实 InnoDB 行锁验证并发。

先启动数据库（例如 `docker compose up -d db`，或任意可连的 MySQL 8），再执行：

```bash
cd backend
npm install
# 连接配置走环境变量，默认与 compose 一致（127.0.0.1:3306 / carbontrack_user / carbontrack_pwd / carbontrack_db）
MYSQL_HOST=127.0.0.1 npm run test:e2e
```

`npm run test:e2e` 会先对库执行 `database/init.sql`（幂等），启动 App 后跑用例；每个用例使用独立用户并在结束后清理（外键级联删除模板/台账/活动，审计日志显式删除），可连续重复运行、结果一致。

覆盖用例（`backend/test/recurrence.e2e-spec.ts`）：

- 正常补算到当天、碳值正确、无未来日期；重复读取不重复生成。
- 暂停日晚于当天：只补到当天；跨天暂停期间重复读取不新增；恢复后从恢复日续算、暂停区间不补（台账为 `detached` 空记录）。
- 起始、结束、暂停、恢复四类入口对不存在的日历日期（如 `2026-02-30`）返回 400 `TEMPLATE_DATE_RANGE_INVALID`，且不留下半条数据。
- 手工修改的生成记录在 `rebuild` 后保持原值，其余按新模板重算。
- 月模板短月落到当月最后一天、次月恢复原 anchor 日（含闰年）。
- 并发：第二连接持锁时 6 个并发补算全部 409 且零写入；8 个真实并发请求只有成功者写一次，台账/活动条数精确。
- 因子缺失导致补算中途失败时整事务回滚：活动 0 条、台账 0 条、模板保持未启用。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 18、TypeScript、Vite、Ant Design、ECharts、Zustand、Axios、dayjs |
| 后端 | NestJS、TypeScript、TypeORM、class-validator、bcryptjs、JWT、winston |
| 数据库 | MySQL 8.0 |
| 部署 | Docker Compose、Nginx 多阶段构建 |

## 项目目录结构

```text
.
├── docker-compose.yml
├── .env
├── .env.example
├── database/
│   └── init.sql
├── backend/
│   ├── Dockerfile
│   └── src/
│       ├── routes/
│       ├── controllers/
│       ├── services/
│       ├── models/
│       ├── middlewares/
│       ├── utils/
│       ├── types/
│       ├── constants/
│       └── config/
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    └── src/
        ├── api/
        ├── stores/
        ├── types/
        ├── components/common/
        ├── hooks/
        ├── pages/
        ├── router/
        ├── utils/
        └── constants/
```

## 环境变量说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `carbontrack` | Compose 项目名和容器名前缀 |
| `DB_NAME` | `carbontrack_db` | MySQL 数据库名 |
| `DB_USER` | `carbontrack_user` | MySQL 应用用户 |
| `DB_PASSWORD` | `carbontrack_pwd` | MySQL 应用密码 |
| `DB_ROOT_PASSWORD` | `carbontrack_root` | MySQL root 密码 |
| `JWT_SECRET` | `change_me_to_a_long_random_string` | JWT 签名密钥 |
| `FRONTEND_PORT` | `18411` | 前端端口映射 |
| `BACKEND_PORT` | `19411` | 后端端口映射 |
| `DB_PORT` | `3306` | 数据库端口映射 |

## Docker 部署说明

- `docker-compose.yml` 顶层声明 `name: carbontrack`，没有 `version:` 字段。
- 容器名带 `${COMPOSE_PROJECT_NAME:-carbontrack}` 前缀。
- 数据库使用命名卷 `carbontrack_mysql_data`，不绑定到中文路径。
- `db` 配置 healthcheck，`backend` 等待数据库 healthy，`frontend` 等待后端 healthy。
- 前端暴露 `18411:80`，后端暴露 `19411:3000`，数据库暴露 `3306:3306`。
- 如端口冲突，修改 `.env` 中 `FRONTEND_PORT`、`BACKEND_PORT`、`DB_PORT` 后重新执行 `docker compose up -d`。

## 核心实体贯穿全栈

- User：`database/init.sql` → `backend/src/models/user.ts` → `backend/src/services/userService.ts` → `backend/src/controllers/userController.ts` → `backend/src/routes/users.ts` → `frontend/src/api/user.ts` → `frontend/src/stores/userStore.ts` → `frontend/src/pages/Profile.tsx`
- Activity：`database/init.sql` → `backend/src/models/activity.ts` → `backend/src/services/activityService.ts` → `backend/src/controllers/activityController.ts` → `backend/src/routes/activities.ts` → `frontend/src/api/activity.ts` → `frontend/src/stores/activityStore.ts` → `frontend/src/pages/Activities.tsx`
- Goal：`database/init.sql` → `backend/src/models/goal.ts` → `backend/src/services/goalService.ts` → `backend/src/controllers/goalController.ts` → `backend/src/routes/goals.ts` → `frontend/src/api/goal.ts` → `frontend/src/stores/goalStore.ts` → `frontend/src/pages/Goals.tsx`
- CarbonFactor：`database/init.sql` → `backend/src/models/carbonFactor.ts` → `backend/src/services/factorService.ts` → `backend/src/controllers/factorController.ts` → `backend/src/routes/factors.ts` → `frontend/src/api/factor.ts` → `frontend/src/pages/Activities.tsx`
- ActivityTemplate（周期模板）：`database/init.sql`（`activity_templates` + `activity_template_generations`）→ `backend/src/models/activityTemplate.ts`、`backend/src/models/activityTemplateGeneration.ts` → `backend/src/utils/recurrence.ts` → `backend/src/services/recurrenceGenerationService.ts`、`backend/src/services/activityTemplateService.ts` → `backend/src/controllers/activityTemplateController.ts` → `backend/src/routes/activityTemplates.ts` → `frontend/src/api/activityTemplate.ts` → `frontend/src/stores/activityTemplateStore.ts` → `frontend/src/pages/ActivityTemplates.tsx`

### 周期模板补算与并发保证

- 同模板同发生日唯一：台账表 `activity_template_generations` 的 `UNIQUE(template_id, occurrence_date)` 为最终幂等锚点。
- 并发补算：单个 QueryRunner 事务内首条语句 `SELECT … FOR UPDATE NOWAIT` 锁定模板行（MySQL errno 3572 → 409 `TEMPLATE_BACKFILL_BUSY`），整批对账同事务提交，异常整体回滚，不留半批记录。
- 台账状态：`generated`（可被重算）、`adjusted`（手工改过，永久保留）、`detached`（改了发生日或区间被移出）、`deleted`（删除墓碑，防止回补复活）。
- 手工单条增删改接口（`/activities`）的筛选、分页与字段保持不变；生成行通过 `template_id / is_generated / manually_adjusted` 标记。仪表盘和目标进度继续汇总 `activities` 表，自动包含生成数据。
- 已有数据卷通过 `SchemaSyncService`（`onModuleInit`）幂等建表/加列，无需手动迁移；新卷由 `database/init.sql` 初始化。

## 横切关注点

- 认证授权（JWT + RBAC）：`database/init.sql` 的 `roles`、`user_roles`，`backend/src/middlewares/auth.ts`，`backend/src/middlewares/roleCheck.ts`，`backend/src/utils/jwt.ts`，`backend/src/routes/*.ts`，`frontend/src/router/guards.ts`，`frontend/src/stores/authStore.ts`，`frontend/src/components/common/PermissionButton.tsx`，`frontend/src/types/auth.ts`
- 操作日志：`database/init.sql` 的 `audit_logs`，`backend/src/middlewares/auditLogger.ts`，`backend/src/services/auditLogService.ts`，`backend/src/models/auditLog.ts`，写操作路由审计拦截，`frontend/src/api/audit.ts`，`frontend/src/pages/AuditLog.tsx`
- 全局错误处理：`backend/src/middlewares/errorHandler.ts`，`backend/src/utils/AppError.ts`，`backend/src/constants/errorCodes.ts`，`frontend/src/utils/request.ts`，`frontend/src/components/common/GlobalErrorBoundary.tsx`

## 枚举出现位置清单

### ActivityCategory

- 后端定义：`backend/src/constants/activity.ts`
- 后端引用：`backend/src/constants/errorCodes.ts`、`backend/src/constants/logTemplates.ts`、`backend/src/models/activity.ts`、`backend/src/models/carbonFactor.ts`、`backend/src/services/activityService.ts`、`backend/src/services/factorService.ts`、`backend/src/routes/activities.ts`、`backend/src/routes/factors.ts`
- 前端定义：`frontend/src/constants/activity.ts`
- 前端引用：`frontend/src/constants/errorCodes.ts`、`frontend/src/constants/messages.ts`、`frontend/src/types/entities.ts`、`frontend/src/api/activity.ts`、`frontend/src/api/factor.ts`、`frontend/src/stores/activityStore.ts`、`frontend/src/components/common/CategoryBadge.tsx`、`frontend/src/components/common/ActivityCard.tsx`、`frontend/src/components/common/CarbonTrendChart.tsx`、`frontend/src/pages/Activities.tsx`、`frontend/src/pages/Ranking.tsx`、`frontend/src/utils/carbonCalculator.ts`、`frontend/src/utils/formatters.ts`

### GoalStatus

- 后端定义：`backend/src/constants/goal.ts`
- 后端引用：`backend/src/constants/errorCodes.ts`、`backend/src/constants/logTemplates.ts`、`backend/src/models/goal.ts`、`backend/src/services/goalService.ts`、`backend/src/routes/goals.ts`
- 前端定义：`frontend/src/constants/goal.ts`
- 前端引用：`frontend/src/constants/errorCodes.ts`、`frontend/src/constants/messages.ts`、`frontend/src/types/entities.ts`、`frontend/src/api/goal.ts`、`frontend/src/components/common/GoalProgressCard.tsx`、`frontend/src/pages/Goals.tsx`、`frontend/src/utils/formatters.ts`

### RecurrenceFrequency（新增）

- 后端定义：`backend/src/constants/recurrence.ts`
- 后端引用：`backend/src/constants/errorCodes.ts`、`backend/src/constants/logTemplates.ts`、`backend/src/models/activityTemplate.ts`、`backend/src/models/activityTemplateGeneration.ts`、`backend/src/services/activityTemplateService.ts`、`backend/src/services/recurrenceGenerationService.ts`、`backend/src/utils/recurrence.ts`、`backend/src/routes/activityTemplates.ts`
- 前端定义：`frontend/src/constants/recurrence.ts`
- 前端引用：`frontend/src/constants/errorCodes.ts`、`frontend/src/constants/messages.ts`、`frontend/src/types/entities.ts`、`frontend/src/api/activityTemplate.ts`、`frontend/src/stores/activityTemplateStore.ts`、`frontend/src/pages/ActivityTemplates.tsx`、`frontend/src/utils/formatters.ts`

## 强制分层与耦合设计

项目刻意保持“严禁合并职责到单一文件”：实体、服务、控制器、路由、API、store、页面拆分到独立文件。日志模块由 `backend/src/utils/logger.ts` 单独管理，但 controller、service、middleware 均引用它；日志模板集中在 `backend/src/constants/logTemplates.ts`，包含 20 条以上模板。错误码集中在 `backend/src/constants/errorCodes.ts`，但 service/controller 仍手动拼接包含实体名和字段名的错误 message。前端 `frontend/src/utils/formatters.ts` 同时包含日期、金额、碳排放、状态文本映射，`frontend/src/constants/messages.ts` 和后端 `backend/src/constants/messages.ts` 刻意保存耦合文案。

如果后续给 Activity 新增 `waste` 分类，至少需要修改：数据库初始化或 migration、Activity 实体、CarbonFactor 实体、前后端 `constants/activity.ts`、错误码、日志模板、formatters、ActivityCard、筛选器、Dashboard 图表分类等 8 个以上文件。

## License

MIT
