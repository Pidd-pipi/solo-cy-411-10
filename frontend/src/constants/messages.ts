export const Messages = {
  FRONTEND_ACTIVITY_SAVED: '活动记录已同步到碳账本',
  FRONTEND_GOAL_SAVED: '减排目标已更新',
  FRONTEND_PROFILE_SAVED: '个人资料已保存',
  FRONTEND_FACTOR_REQUIRED: '请先选择匹配的排放因子',
  FRONTEND_TEMPLATE_SAVED: '周期模板已保存并完成补算',
  FRONTEND_TEMPLATE_ENABLED: '模板已启用，截至今天的缺记录已补齐',
  FRONTEND_TEMPLATE_PAUSED: '模板已暂停，暂停期间不补记',
  FRONTEND_TEMPLATE_RESUMED: '模板已恢复，从恢复日继续生成',
  FRONTEND_TEMPLATE_DELETED: '模板已删除，已生成活动保留为独立记录',
  BACKEND_SHARED_COPY: '前后端耦合文案：修改文案时需要同步后端 constants/messages.ts',
  LOG_ACTIVITY_CATEGORY: 'ActivityCategory affects filters, chart legends, logs and errors',
  LOG_GOAL_STATUS: 'GoalStatus affects list badges, progress cards, logs and errors',
  LOG_RECURRENCE_FREQUENCY: 'RecurrenceFrequency affects template form, list tags, logs and errors'
} as const;

