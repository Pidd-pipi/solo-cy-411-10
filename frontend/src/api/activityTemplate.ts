import { ActivityCategory } from '../constants/activity';
import { RecomputeMode, RecurrenceFrequency } from '../constants/recurrence';
import { ActivityTemplate } from '../types/entities';
import { request } from '../utils/request';

export interface ActivityTemplatePayload {
  name: string;
  category: ActivityCategory;
  subType: string;
  amount: number;
  unit: string;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate?: string | null;
  enabled?: boolean;
}

export interface ActivityTemplateUpdatePayload extends Partial<ActivityTemplatePayload> {
  recomputeMode?: RecomputeMode;
}

export function fetchTemplates(): Promise<ActivityTemplate[]> {
  return request.get('/activity-templates');
}

export function createTemplate(payload: ActivityTemplatePayload): Promise<{ message: string; template: ActivityTemplate }> {
  return request.post('/activity-templates', payload);
}

export function updateTemplate(id: number, payload: ActivityTemplateUpdatePayload): Promise<{ message: string; template: ActivityTemplate }> {
  return request.patch(`/activity-templates/${id}`, payload);
}

export function enableTemplate(id: number): Promise<{ message: string; template: ActivityTemplate }> {
  return request.post(`/activity-templates/${id}/enable`);
}

export function pauseTemplate(id: number, date?: string): Promise<{ message: string; template: ActivityTemplate }> {
  return request.post(`/activity-templates/${id}/pause`, date ? { date } : {});
}

export function resumeTemplate(id: number, date?: string): Promise<{ message: string; template: ActivityTemplate }> {
  return request.post(`/activity-templates/${id}/resume`, date ? { date } : {});
}

export function deleteTemplate(id: number): Promise<{ message: string }> {
  return request.delete(`/activity-templates/${id}`);
}
