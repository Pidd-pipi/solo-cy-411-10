import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import dayjs from 'dayjs';
import { Repository } from 'typeorm';
import { ActivityCategory } from '../constants/activity';
import { ErrorCodes } from '../constants/errorCodes';
import { Messages } from '../constants/messages';
import { RecomputeMode, RecurrenceFrequency, GenerationStatus } from '../constants/recurrence';
import { ActivityTemplate } from '../models/activityTemplate';
import { ActivityTemplateGeneration } from '../models/activityTemplateGeneration';
import { AppError } from '../utils/AppError';
import { logTemplate } from '../utils/logger';
import { DATE_FORMAT, isValidCalendarDate } from '../utils/recurrence';
import { FactorService } from './factorService';
import { RecurrenceGenerationService } from './recurrenceGenerationService';
import { UserService } from './userService';

export interface ActivityTemplateInput {
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

export interface ActivityTemplateUpdateInput extends Partial<Omit<ActivityTemplateInput, 'enabled'>> {
  recomputeMode?: RecomputeMode;
}

@Injectable()
export class ActivityTemplateService {
  constructor(
    @InjectRepository(ActivityTemplate) private readonly templateRepo: Repository<ActivityTemplate>,
    @InjectRepository(ActivityTemplateGeneration) private readonly generationRepo: Repository<ActivityTemplateGeneration>,
    private readonly factorService: FactorService,
    private readonly userService: UserService,
    private readonly generator: RecurrenceGenerationService
  ) {}

  async list(userId: number) {
    logTemplate('info', 'TEMPLATE_LIST_START');
    const templates = await this.templateRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
    const counts = await this.generationRepo
      .createQueryBuilder('g')
      .select('g.template_id', 'templateId')
      .addSelect('SUM(CASE WHEN g.activity_id IS NOT NULL THEN 1 ELSE 0 END)', 'generatedCount')
      .where('g.template_id IN (:...ids)', { ids: templates.length ? templates.map((t) => Number(t.id)) : [0] })
      .andWhere('g.status IN (:...active)', { active: [GenerationStatus.GENERATED, GenerationStatus.ADJUSTED] })
      .groupBy('g.template_id')
      .getRawMany<{ templateId: string; generatedCount: string }>();
    const countMap = new Map(counts.map((row) => [Number(row.templateId), Number(row.generatedCount)]));
    return templates.map((template) => ({ ...template, generatedCount: countMap.get(Number(template.id)) ?? 0 }));
  }

  async create(userId: number, input: ActivityTemplateInput) {
    logTemplate('info', 'TEMPLATE_CREATE_START', { userId, frequency: input.frequency, category: input.category });
    await this.validate(userId, input);
    const start = dayjs(input.startDate).format(DATE_FORMAT);
    const template = this.templateRepo.create({
      userId,
      name: input.name,
      category: input.category,
      subType: input.subType,
      amount: String(Number(input.amount)),
      unit: input.unit,
      frequency: input.frequency,
      startDate: start,
      endDate: input.endDate ? dayjs(input.endDate).format(DATE_FORMAT) : null,
      anchorDate: start,
      effectiveDate: start,
      enabled: false,
      pausedAt: null
    });
    let saved = await this.templateRepo.save(template);
    logTemplate('info', 'TEMPLATE_CREATE_SUCCESS', { id: saved.id, amount: saved.amount, unit: saved.unit });
    if (input.enabled) {
      const { template: enabled } = await this.generator.enableTemplate(Number(saved.id));
      saved = enabled;
    }
    return { message: input.enabled ? Messages.TEMPLATE_ENABLED : Messages.TEMPLATE_CREATED, template: saved };
  }

  async update(userId: number, id: number, input: ActivityTemplateUpdateInput) {
    const mode = input.recomputeMode ?? RecomputeMode.FUTURE;
    if (!Object.values(RecomputeMode).includes(mode)) {
      throw new AppError(
        ErrorCodes.TEMPLATE_RECOMPUTE_MODE_INVALID,
        `ActivityTemplate[id=${id}] update failed: recomputeMode ${mode} invalid`,
        HttpStatus.BAD_REQUEST
      );
    }
    const existing = await this.requireOwned(userId, id);
    await this.validate(userId, {
      name: input.name ?? existing.name,
      category: input.category ?? existing.category,
      subType: input.subType ?? existing.subType,
      amount: input.amount ?? Number(existing.amount),
      unit: input.unit ?? existing.unit,
      frequency: input.frequency ?? existing.frequency,
      startDate: input.startDate ?? existing.startDate,
      endDate: input.endDate === undefined ? existing.endDate : input.endDate
    });

    const merged = {
      name: input.name ?? existing.name,
      category: input.category ?? existing.category,
      subType: input.subType ?? existing.subType,
      amount: input.amount ?? Number(existing.amount),
      unit: input.unit ?? existing.unit,
      frequency: input.frequency ?? existing.frequency,
      startDate: input.startDate ?? existing.startDate,
      endDate: input.endDate === undefined ? existing.endDate : input.endDate
    };
    const start = dayjs(merged.startDate).format(DATE_FORMAT);
    const end = merged.endDate ? dayjs(merged.endDate).format(DATE_FORMAT) : null;

    // A disabled template is a pure definition edit: keep anchor/effective aligned, no ledger work.
    if (!existing.enabled) {
      existing.name = input.name ?? existing.name;
      existing.category = merged.category;
      existing.subType = input.subType ?? existing.subType;
      existing.amount = String(Number(merged.amount));
      existing.unit = input.unit ?? existing.unit;
      existing.frequency = merged.frequency;
      existing.startDate = start;
      existing.endDate = end;
      existing.anchorDate = start;
      existing.effectiveDate = start;
      const saved = await this.templateRepo.save(existing);
      return { message: Messages.TEMPLATE_UPDATED, template: saved };
    }

    // Enabled template: frequency/start changes re-anchor so the cadence is unambiguous;
    // the chosen mode then decides whether history is rebuilt.
    const frequencyChanged = input.frequency !== undefined && input.frequency !== existing.frequency;
    const startChanged = input.startDate !== undefined && start !== existing.startDate;
    const anchorDate = frequencyChanged || startChanged || mode === RecomputeMode.REBUILD ? start : existing.anchorDate;
    const { template: saved } = await this.generator.mutateTemplate(
      id,
      {
        name: input.name,
        category: merged.category,
        subType: input.subType,
        amount: String(Number(merged.amount)),
        unit: input.unit,
        frequency: merged.frequency,
        startDate: start,
        endDate: end,
        anchorDate
      },
      mode
    );
    return { message: Messages.TEMPLATE_UPDATED, template: saved };
  }

  async enable(userId: number, id: number) {
    await this.requireOwned(userId, id);
    const { template } = await this.generator.enableTemplate(id);
    return { message: Messages.TEMPLATE_ENABLED, template };
  }

  async pause(userId: number, id: number, pauseDate?: string) {
    await this.requireOwned(userId, id);
    const at = this.resolveActionDate(id, 'pause', pauseDate);
    const { template } = await this.generator.pauseTemplate(id, at);
    return { message: Messages.TEMPLATE_PAUSED, template };
  }

  async resume(userId: number, id: number, resumeDate?: string) {
    await this.requireOwned(userId, id);
    const at = this.resolveActionDate(id, 'resume', resumeDate);
    const { template } = await this.generator.resumeTemplate(id, at);
    return { message: Messages.TEMPLATE_RESUMED, template };
  }

  private resolveActionDate(id: number, action: string, value?: string): string {
    const at = value || dayjs().format(DATE_FORMAT);
    if (!isValidCalendarDate(at)) {
      throw new AppError(
        ErrorCodes.TEMPLATE_DATE_RANGE_INVALID,
        `ActivityTemplate[id=${id}] ${action} failed: date ${value} is not a valid calendar date`,
        HttpStatus.BAD_REQUEST
      );
    }
    return at;
  }

  async remove(userId: number, id: number) {
    await this.requireOwned(userId, id);
    await this.generator.deleteTemplate(id);
    return { message: Messages.TEMPLATE_DELETED };
  }

  private async requireOwned(userId: number, id: number): Promise<ActivityTemplate> {
    const template = await this.templateRepo.findOne({ where: { id, userId } });
    if (!template) {
      throw new AppError(ErrorCodes.TEMPLATE_NOT_FOUND, `ActivityTemplate[id=${id}] access failed: id not found`, HttpStatus.NOT_FOUND);
    }
    return template;
  }

  private async validate(userId: number, input: {
    name?: string;
    category?: ActivityCategory;
    subType?: string;
    amount?: number;
    unit?: string;
    frequency?: RecurrenceFrequency;
    startDate?: string;
    endDate?: string | null;
  }): Promise<void> {
    if (!input.category || !Object.values(ActivityCategory).includes(input.category)) {
      logTemplate('warn', 'TEMPLATE_CREATE_FAILED', { id: 0, field: 'ActivityTemplate.category', reason: 'invalid enum' });
      throw new AppError(ErrorCodes.ACTIVITY_CATEGORY_INVALID, `ActivityTemplate[id=0] create failed: category invalid`, HttpStatus.BAD_REQUEST);
    }
    if (!input.frequency || !Object.values(RecurrenceFrequency).includes(input.frequency)) {
      logTemplate('warn', 'TEMPLATE_CREATE_FAILED', { id: 0, field: 'ActivityTemplate.frequency', reason: 'invalid enum' });
      throw new AppError(
        ErrorCodes.TEMPLATE_FREQUENCY_INVALID,
        `ActivityTemplate[id=0] create failed: frequency ${input.frequency} invalid`,
        HttpStatus.BAD_REQUEST
      );
    }
    if (!input.subType || !input.amount || Number(input.amount) <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, `ActivityTemplate[id=0] create failed: sub_type or amount invalid`, HttpStatus.BAD_REQUEST);
    }
    // Reject impossible calendar dates (e.g. 2026-02-30) explicitly instead of
    // letting dayjs roll them forward to 2026-03-02.
    if (!isValidCalendarDate(input.startDate)) {
      logTemplate('warn', 'TEMPLATE_CREATE_FAILED', { id: 0, field: 'ActivityTemplate.start_date', reason: 'not a real calendar date' });
      throw new AppError(
        ErrorCodes.TEMPLATE_DATE_RANGE_INVALID,
        `ActivityTemplate[id=0] create failed: start_date ${input.startDate} is not a valid calendar date`,
        HttpStatus.BAD_REQUEST
      );
    }
    const start = dayjs(input.startDate);
    if (input.endDate) {
      if (!isValidCalendarDate(input.endDate)) {
        logTemplate('warn', 'TEMPLATE_CREATE_FAILED', { id: 0, field: 'ActivityTemplate.end_date', reason: 'not a real calendar date' });
        throw new AppError(
          ErrorCodes.TEMPLATE_DATE_RANGE_INVALID,
          `ActivityTemplate[id=0] create failed: end_date ${input.endDate} is not a valid calendar date`,
          HttpStatus.BAD_REQUEST
        );
      }
      if (dayjs(input.endDate).isBefore(start, 'day')) {
        throw new AppError(
          ErrorCodes.TEMPLATE_DATE_RANGE_INVALID,
          `ActivityTemplate[id=0] create failed: end_date before start_date`,
          HttpStatus.BAD_REQUEST
        );
      }
    }
    // Fail fast at write time so a later backfill can never poison the activity read path.
    try {
      const user = await this.userService.findById(userId);
      await this.factorService.findMatching(input.category, input.subType, user.region);
    } catch (error: any) {
      throw new AppError(
        ErrorCodes.TEMPLATE_FACTOR_REQUIRED,
        `ActivityTemplate[id=0] create failed: matching factor unavailable: ${String(error?.message ?? error)}`,
        HttpStatus.BAD_REQUEST
      );
    }
  }
}
