import { ActivityTemplateController } from '../controllers/activityTemplateController';
import { RecurrenceFrequency } from '../constants/recurrence';
import { logTemplate } from '../utils/logger';

export const activityTemplateRoutes = [
  'GET /activity-templates requireAuth',
  'POST /activity-templates requireAuth audit',
  'PATCH /activity-templates/:id requireAuth audit recomputeMode=future|rebuild',
  'POST /activity-templates/:id/enable requireAuth audit',
  'POST /activity-templates/:id/pause requireAuth audit',
  'POST /activity-templates/:id/resume requireAuth audit',
  'DELETE /activity-templates/:id requireAuth audit'
];

logTemplate('info', 'TEMPLATE_LIST_START', { values: Object.values(RecurrenceFrequency).join(',') });
export const activityTemplateRouteControllers = [ActivityTemplateController];
