import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import dayjs from 'dayjs';
import { DataSource, Between, Repository } from 'typeorm';
import { ActivityCategory } from '../constants/activity';
import { ErrorCodes } from '../constants/errorCodes';
import { Messages } from '../constants/messages';
import { Activity } from '../models/activity';
import { AppError } from '../utils/AppError';
import { calculateCarbonValue } from '../utils/carbonCalculator';
import { logTemplate } from '../utils/logger';
import { FactorService } from './factorService';
import { RecurrenceGenerationService } from './recurrenceGenerationService';
import { UserService } from './userService';

export interface ActivityInput {
  category: ActivityCategory;
  subType: string;
  amount: number;
  unit: string;
  recordDate: string;
  note?: string;
}

@Injectable()
export class ActivityService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Activity) private readonly activityRepo: Repository<Activity>,
    private readonly factorService: FactorService,
    private readonly userService: UserService,
    private readonly recurrence: RecurrenceGenerationService
  ) {}

  async list(userId: number, category?: ActivityCategory, start?: string, end?: string) {
    logTemplate('info', 'ACTIVITY_LIST_START');
    // Best-effort recurring catch-up on the read path. It must never break listing,
    // filtering, pagination, dashboard stats or goal progress aggregation.
    await this.recurrence.catchUpUser(userId).catch((error) => {
      logTemplate('warn', 'TEMPLATE_BACKFILL_SKIPPED', { id: 0, reason: `read catch-up ${String(error?.message ?? error)}` });
    });
    return this.activityRepo.find({
      where: {
        userId,
        ...(category ? { category } : {}),
        ...(start && end ? { recordDate: Between(start, end) } : {})
      },
      relations: ['factor'],
      order: { recordDate: 'DESC', id: 'DESC' }
    });
  }

  async create(userId: number, input: ActivityInput) {
    logTemplate('info', 'ACTIVITY_CREATE_START', { userId, category: input.category, subType: input.subType });
    if (!Object.values(ActivityCategory).includes(input.category)) {
      logTemplate('warn', 'ACTIVITY_CREATE_FAILED', { id: 0, field: 'Activity.category', reason: 'invalid enum' });
      throw new AppError(ErrorCodes.ACTIVITY_CATEGORY_INVALID, `Activity[id=0] create failed: category invalid`);
    }
    const user = await this.userService.findById(userId);
    const factor = await this.factorService.findMatching(input.category, input.subType, user.region);
    const carbonValue = calculateCarbonValue({ category: input.category, amount: Number(input.amount), factorValue: Number(factor.factorValue) });
    const activity = this.activityRepo.create({
      userId,
      factorId: Number(factor.id),
      category: input.category,
      subType: input.subType,
      amount: String(input.amount),
      unit: input.unit,
      carbonValue: String(carbonValue),
      recordDate: dayjs(input.recordDate).format('YYYY-MM-DD'),
      note: input.note || null,
      templateId: null,
      isGenerated: false,
      manuallyAdjusted: false
    });
    const saved = await this.activityRepo.save(activity);
    logTemplate('info', 'ACTIVITY_CREATE_SUCCESS', { id: saved.id, carbonValue });
    return { message: Messages.ACTIVITY_CREATED, activity: saved };
  }

  async update(userId: number, id: number, input: Partial<ActivityInput>) {
    logTemplate('info', 'ACTIVITY_UPDATE_START', { id, fields: Object.keys(input).join(',') });
    // Manual edit + ledger protection (adjusted / detached) must be atomic.
    return this.dataSource.transaction(async (manager) => {
      const activity = await manager.findOne(Activity, { where: { id, userId } });
      if (!activity) {
        logTemplate('warn', 'ACTIVITY_UPDATE_FAILED', { id, field: 'Activity.id', reason: 'not found' });
        throw new AppError(ErrorCodes.ACTIVITY_NOT_FOUND, `Activity[id=${id}] update failed: id not found`, HttpStatus.NOT_FOUND);
      }
      const previous: Activity = manager.create(Activity, {
        ...activity,
        recordDate: activity.recordDate,
        category: activity.category,
        subType: activity.subType,
        amount: activity.amount,
        unit: activity.unit
      });

      const nextCategory = input.category ?? activity.category;
      const nextSubType = input.subType ?? activity.subType;
      const nextAmount = Number(input.amount ?? activity.amount);
      const user = await this.userService.findById(userId);
      const factor = await this.factorService.findMatching(nextCategory, nextSubType, user.region);
      const carbonValue = calculateCarbonValue({ category: nextCategory, amount: nextAmount, factorValue: Number(factor.factorValue) });
      activity.category = nextCategory;
      activity.subType = nextSubType;
      activity.amount = String(nextAmount);
      activity.unit = input.unit ?? activity.unit;
      activity.factorId = Number(factor.id);
      activity.carbonValue = String(carbonValue);
      activity.recordDate = input.recordDate ? dayjs(input.recordDate).format('YYYY-MM-DD') : activity.recordDate;
      activity.note = input.note ?? activity.note;
      const saved = await manager.save(activity);
      await this.recurrence.reflectManualUpdate(manager, previous, saved);
      logTemplate('info', 'ACTIVITY_UPDATE_SUCCESS', { id: saved.id, carbonValue });
      return { message: Messages.ACTIVITY_UPDATED, activity: saved };
    });
  }

  async remove(userId: number, id: number) {
    await this.dataSource.transaction(async (manager) => {
      const activity = await manager.findOne(Activity, { where: { id, userId } });
      if (!activity) {
        throw new AppError(ErrorCodes.ACTIVITY_NOT_FOUND, `Activity[id=${id}] delete failed: id not found`, HttpStatus.NOT_FOUND);
      }
      // Flip the ledger tombstone first so the row delete can never resurrect the occurrence.
      await this.recurrence.reflectManualDelete(manager, activity);
      await manager.remove(activity);
    });
    logTemplate('info', 'ACTIVITY_DELETE_SUCCESS', { id });
    return { message: Messages.ACTIVITY_DELETED };
  }

  async summarize(userId: number, start: string, end: string) {
    const rows = await this.list(userId, undefined, start, end);
    const total = rows.reduce((sum, row) => sum + Number(row.carbonValue), 0);
    const byCategory = Object.values(ActivityCategory).map((category) => ({
      category,
      value: rows.filter((row) => row.category === category).reduce((sum, row) => sum + Number(row.carbonValue), 0)
    }));
    return { total: Number(total.toFixed(2)), byCategory, rows };
  }
}
