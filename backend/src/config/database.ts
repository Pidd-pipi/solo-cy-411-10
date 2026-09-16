import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Activity } from '../models/activity';
import { ActivityTemplate } from '../models/activityTemplate';
import { ActivityTemplateGeneration } from '../models/activityTemplateGeneration';
import { AuditLog } from '../models/auditLog';
import { CarbonFactor } from '../models/carbonFactor';
import { Goal } from '../models/goal';
import { Role } from '../models/role';
import { User } from '../models/user';

export const databaseEntities = [User, Role, Activity, Goal, CarbonFactor, AuditLog, ActivityTemplate, ActivityTemplateGeneration];

export const databaseConfig = (): TypeOrmModuleOptions => ({
  type: 'mysql',
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  username: process.env.DB_USER || 'carbontrack_user',
  password: process.env.DB_PASSWORD || 'carbontrack_pwd',
  database: process.env.DB_NAME || 'carbontrack_db',
  entities: databaseEntities,
  synchronize: process.env.TYPEORM_SYNC === 'true',
  // Keep DATE / TIMESTAMP columns as 'YYYY-MM-DD' strings so recurrence windows
  // and the existing Between(start,end) filters never cross a Date/timezone boundary.
  extra: { dateStrings: true },
  logging: process.env.NODE_ENV === 'development'
});
