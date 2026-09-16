import { create } from 'zustand';
import {
  createTemplate,
  deleteTemplate,
  enableTemplate,
  fetchTemplates,
  pauseTemplate,
  resumeTemplate,
  updateTemplate,
  ActivityTemplatePayload,
  ActivityTemplateUpdatePayload
} from '../api/activityTemplate';
import { ActivityTemplate } from '../types/entities';

interface ActivityTemplateStore {
  templates: ActivityTemplate[];
  loading: boolean;
  load: () => Promise<void>;
  create: (payload: ActivityTemplatePayload) => Promise<void>;
  update: (id: number, payload: ActivityTemplateUpdatePayload) => Promise<void>;
  enable: (id: number) => Promise<void>;
  pause: (id: number) => Promise<void>;
  resume: (id: number) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export const useActivityTemplateStore = create<ActivityTemplateStore>((set, get) => ({
  templates: [],
  loading: false,
  async load() {
    set({ loading: true });
    try {
      const templates = await fetchTemplates();
      set({ templates });
    } finally {
      set({ loading: false });
    }
  },
  async create(payload) {
    await createTemplate(payload);
    await get().load();
  },
  async update(id, payload) {
    await updateTemplate(id, payload);
    await get().load();
  },
  async enable(id) {
    await enableTemplate(id);
    await get().load();
  },
  async pause(id) {
    await pauseTemplate(id);
    await get().load();
  },
  async resume(id) {
    await resumeTemplate(id);
    await get().load();
  },
  async remove(id) {
    await deleteTemplate(id);
    await get().load();
  }
}));
