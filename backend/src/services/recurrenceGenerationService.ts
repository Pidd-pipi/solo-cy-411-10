import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import dayjs from 'dayjs';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { ErrorCodes } from '../constants/errorCodes';
import { GenerationStatus, RecomputeMode, RecurrenceFrequency } from '../constants/recurrence';
import { Activity } from '../models/activity';
import { ActivityTemplate } from '../models/activityTemplate';
import { ActivityTemplateGeneration } from '../models/activityTemplateGeneration';
import { AppError } from '../utils/AppError';
import { calculateCarbonValue } from '../utils/carbonCalculator';
import { logTemplate } from '../utils/logger';
import { DATE_FORMAT, enumerateOccurrences } from '../utils/recurrence';
import { FactorService } from './factorService';
import { UserService } from './userService';

export interface ReconcileResult {
  inserted: number;
  updated: number;
  removed: number;
}

const today = () => dayjs().format(DATE_FORMAT);
const dayBefore = (value: string) => dayjs(value, DATE_FORMAT).subtract(1, 'day').format(DATE_FORMAT);
const maxDate = (a: string, b: string) => (a < b ? b : a);
const minDate = (a: string | null, b: string) => (a === null ? b : a < b ? a : b);

interface ReconcileOptions {
  highOverride?: string;
}

type LockedWork<T> = (manager: EntityManager, template: ActivityTemplate) => Promise<T>;
interface LockOptions {
  saveTemplate?: boolean;
}

/**
 * Owns all writes against the generation ledger and the generated activity rows.
 * It deliberately does NOT depend on ActivityService (the dependency points the
 * other way) to keep the Nest DI graph acyclic.
 */
@Injectable()
export class RecurrenceGenerationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ActivityTemplate) private readonly templateRepo: Repository<ActivityTemplate>,
    @InjectRepository(ActivityTemplateGeneration) private readonly generationRepo: Repository<ActivityTemplateGeneration>,
    private readonly factorService: FactorService,
    private readonly userService: UserService
  ) {}

  // ---------------------------------------------------------------- enable/pause/resume/edit

  async enableTemplate(id: number): Promise<{ template: ActivityTemplate; result: ReconcileResult }> {
    return this.locked(id, async (manager, template) => {
      // Paused templates keep enabled=true, so reaching here while enabled means a
      // duplicate/no-op enable; never jump a pause gap by reconciling on this path.
      if (template.enabled) {
        return { template, result: { inserted: 0, updated: 0, removed: 0 } };
      }
      template.enabled = true;
      template.pausedAt = null;
      const result = await this.reconcile(manager, template, RecomputeMode.FUTURE);
      return { template, result };
    });
  }

  async pauseTemplate(id: number, pauseDate: string): Promise<{ template: ActivityTemplate; result: ReconcileResult }> {
    const pauseAt = dayjs(pauseDate).format(DATE_FORMAT);
    return this.locked(id, async (manager, template) => {
      if (!template.enabled) {
        throw new AppError(ErrorCodes.TEMPLATE_NOT_ENABLED, `ActivityTemplate[id=${id}] pause failed: template not enabled`, HttpStatus.CONFLICT);
      }
      if (template.pausedAt) {
        throw new AppError(ErrorCodes.TEMPLATE_ALREADY_PAUSED, `ActivityTemplate[id=${id}] pause failed: already paused at ${template.pausedAt}`, HttpStatus.CONFLICT);
      }
      // Settle the open segment up to (but excluding) the pause day, then freeze.
      const result = await this.reconcile(manager, template, RecomputeMode.FUTURE, { highOverride: dayBefore(pauseAt) });
      template.pausedAt = pauseAt;
      logTemplate('info', 'TEMPLATE_PAUSE_SUCCESS', { id, pausedAt: pauseAt });
      return { template, result };
    });
  }

  async resumeTemplate(id: number, resumeDate: string): Promise<{ template: ActivityTemplate; result: ReconcileResult }> {
    const resumeAt = dayjs(resumeDate).format(DATE_FORMAT);
    return this.locked(id, async (manager, template) => {
      if (!template.enabled || !template.pausedAt) {
        throw new AppError(ErrorCodes.TEMPLATE_NOT_ENABLED, `ActivityTemplate[id=${id}] resume failed: template not paused`, HttpStatus.CONFLICT);
      }
      // Permanently void the pause gap against the OLD cadence so neither a later
      // catch-up nor a full rebuild can ever make up records for the paused days.
      const gapDates = enumerateOccurrences({
        frequency: template.frequency as RecurrenceFrequency,
        anchor: template.anchorDate,
        low: template.pausedAt,
        high: dayBefore(resumeAt)
      });
      await this.voidOccurrences(manager, Number(template.id), gapDates);
      // Re-anchor at the resume day: n=0 lands on resume day.
      template.pausedAt = null;
      template.anchorDate = resumeAt;
      template.effectiveDate = resumeAt;
      const result = await this.reconcile(manager, template, RecomputeMode.FUTURE);
      logTemplate('info', 'TEMPLATE_RESUME_SUCCESS', { id, anchorDate: resumeAt });
      return { template, result };
    });
  }

  /**
   * Write detached, activity-less ledger rows for dates that must never be
   * generated (the pause gap). An existing ledger row always wins, so this
   * never overwrites real history.
   */
  private async voidOccurrences(manager: EntityManager, templateId: number, dates: string[]): Promise<void> {
    for (const occurrenceDate of dates) {
      const existing = await manager.findOne(ActivityTemplateGeneration, { where: { templateId, occurrenceDate } });
      if (existing) continue;
      await manager.save(
        manager.create(ActivityTemplateGeneration, {
          templateId,
          activityId: null,
          occurrenceDate,
          status: GenerationStatus.DETACHED
        })
      );
    }
  }

  /**
   * Apply an already-validated template mutation under the per-template lock,
   * then reconcile the ledger according to the chosen edit mode.
   */
  async mutateTemplate(
    id: number,
    patch: Partial<Pick<ActivityTemplate, 'name' | 'category' | 'subType' | 'amount' | 'unit' | 'frequency' | 'startDate' | 'endDate' | 'anchorDate' | 'effectiveDate'>>,
    mode: RecomputeMode
  ): Promise<{ template: ActivityTemplate; result: ReconcileResult }> {
    return this.locked(id, async (manager, template) => {
      // Only defined keys overwrite the entity, so partial PATCH bodies never blank
      // untouched columns (Object.assign would otherwise write undefined).
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
          (template as unknown as Record<string, unknown>)[key] = value;
        }
      }
      let result: ReconcileResult = { inserted: 0, updated: 0, removed: 0 };
      if (template.enabled && !template.pausedAt) {
        if (mode === RecomputeMode.REBUILD) {
          template.effectiveDate = template.startDate;
          result = await this.reconcile(manager, template, RecomputeMode.REBUILD);
        } else {
          template.effectiveDate = today();
          result = await this.reconcile(manager, template, RecomputeMode.FUTURE);
        }
      }
      return { template, result };
    });
  }

  async deleteTemplate(id: number): Promise<void> {
    await this.locked(
      id,
      async (manager, template) => {
        // Keep the carbon history: generated rows become standalone manual records,
        // then the template (and its ledger) is removed.
        await manager.update(Activity, { templateId: Number(template.id) }, { templateId: null, isGenerated: false });
        await manager.delete(ActivityTemplateGeneration, { templateId: Number(template.id) });
        await manager.remove(template);
        logTemplate('info', 'TEMPLATE_DELETE_SUCCESS', { id });
      },
      { saveTemplate: false }
    );
  }

  // -------------------------------------------------------------- read-path catch-up

  /**
   * Best-effort catch-up invoked from the activity read paths. Each template is
   * reconciled in its own transaction; lock contention or a missing factor is
   * logged and skipped so the list / summary / dashboard / goal progress can
   * never fail because of background generation.
   */
  async catchUpUser(userId: number): Promise<void> {
    let dirty: ActivityTemplate[];
    try {
      dirty = await this.templateRepo.find({
        where: { userId, enabled: true, pausedAt: IsNull() },
        order: { id: 'ASC' }
      });
      const now = today();
      dirty = dirty.filter((tpl) => {
        if (!tpl.lastSyncedDate) return true; // never reconciled
        if (!dayjs(tpl.lastSyncedDate, DATE_FORMAT).isBefore(now, 'day')) return false; // caught up today
        // Once synced at/after the template end date, the schedule can never grow again.
        if (tpl.endDate && !dayjs(tpl.endDate, DATE_FORMAT).isAfter(dayjs(tpl.lastSyncedDate, DATE_FORMAT), 'day')) return false;
        return true;
      });
    } catch (error) {
      logTemplate('warn', 'TEMPLATE_BACKFILL_SKIPPED', { id: 0, reason: `dirty scan ${String(error)}` });
      return;
    }
    for (const tpl of dirty) {
      try {
        await this.runBackfill(Number(tpl.id));
      } catch (error: any) {
        const busy = error instanceof AppError && error.code === ErrorCodes.TEMPLATE_BACKFILL_BUSY;
        logTemplate(busy ? 'warn' : 'error', busy ? 'TEMPLATE_BACKFILL_BUSY' : 'TEMPLATE_BACKFILL_SKIPPED', {
          id: Number(tpl.id),
          reason: error?.message || String(error)
        });
      }
    }
  }

  async runBackfill(id: number): Promise<ReconcileResult> {
    const { result } = await this.locked(id, async (manager, template) => {
      const result = await this.reconcile(manager, template, RecomputeMode.FUTURE);
      return { result };
    });
    return result;
  }

  // -------------------------------------------------------------- manual CRUD hooks

  /** Called inside ActivityService.update's own transaction. */
  async reflectManualUpdate(manager: EntityManager, prev: Activity, next: Activity): Promise<void> {
    if (!prev.templateId && !prev.isGenerated) return;
    const dateMoved = prev.recordDate !== next.recordDate;
    // ANY manual change (carbon-relevant fields or just the note) marks the row as
    // hand-adjusted, so a later "rebuild" keeps the user's values untouched.
    const rowChanged =
      prev.category !== next.category ||
      prev.subType !== next.subType ||
      String(prev.amount) !== String(next.amount) ||
      prev.unit !== next.unit ||
      (prev.note ?? null) !== (next.note ?? null);
    const ledger = await manager.findOne(ActivityTemplateGeneration, { where: { activityId: Number(next.id) } });
    if (dateMoved) {
      // Remove the occurrence binding so the original date can be regenerated,
      // while the moved activity becomes a standalone manual record (no duplicate).
      if (ledger) {
        await manager.delete(ActivityTemplateGeneration, { id: ledger.id });
      }
      next.templateId = null;
      next.isGenerated = false;
      next.manuallyAdjusted = true;
      await manager.save(next);
      logTemplate('info', 'TEMPLATE_GENERATION_DETACHED', {
        id: Number(prev.templateId ?? ledger?.templateId ?? 0),
        occurrenceDate: prev.recordDate,
        activityId: Number(next.id)
      });
      return;
    }
    if (rowChanged && ledger && ledger.status === GenerationStatus.GENERATED) {
      ledger.status = GenerationStatus.ADJUSTED;
      await manager.save(ledger);
      next.manuallyAdjusted = true;
      await manager.save(next);
      logTemplate('info', 'TEMPLATE_GENERATION_ADJUSTED', { id: Number(ledger.templateId), occurrenceDate: ledger.occurrenceDate });
    }
  }

  /** Called inside ActivityService.remove's own transaction; the caller performs the row delete. */
  async reflectManualDelete(manager: EntityManager, activity: Activity): Promise<void> {
    if (!activity.templateId && !activity.isGenerated) return;
    const ledger = await manager.findOne(ActivityTemplateGeneration, { where: { activityId: Number(activity.id) } });
    if (ledger && ledger.status !== GenerationStatus.DELETED) {
      ledger.status = GenerationStatus.DELETED;
      ledger.activityId = null;
      await manager.save(ledger);
      logTemplate('info', 'TEMPLATE_GENERATION_DELETED', { id: Number(ledger.templateId), occurrenceDate: ledger.occurrenceDate });
    }
  }

  // -------------------------------------------------------------- locking + reconciliation

  private async locked<T>(id: number, work: LockedWork<T>, options: LockOptions = {}): Promise<T> {
    const saveTemplate = options.saveTemplate !== false;
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      // Row lock taken on THIS transaction connection. NOWAIT turns a concurrent
      // run for the same template into MySQL errno 3572 instead of queueing.
      const rows = await runner.query('SELECT * FROM activity_templates WHERE id = ? FOR UPDATE NOWAIT', [id]);
      if (!rows.length) {
        throw new AppError(ErrorCodes.TEMPLATE_NOT_FOUND, `ActivityTemplate[id=${id}] access failed: id not found`, HttpStatus.NOT_FOUND);
      }
      const template = await runner.manager.findOneByOrFail(ActivityTemplate, { id: Number(id) });
      const output = await work(runner.manager, template);
      if (saveTemplate) {
        await runner.manager.save(template);
      }
      await runner.commitTransaction();
      return output;
    } catch (error: any) {
      await runner.rollbackTransaction().catch(() => undefined);
      if (error?.errno === 3572 || error?.code === 'ER_LOCK_NOWAIT') {
        logTemplate('warn', 'TEMPLATE_BACKFILL_BUSY', { id, reason: 'another backfill holds the template row' });
        throw new AppError(ErrorCodes.TEMPLATE_BACKFILL_BUSY, `ActivityTemplate[id=${id}] backfill failed: another run is in progress`, HttpStatus.CONFLICT);
      }
      throw error;
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private async reconcile(manager: EntityManager, template: ActivityTemplate, mode: RecomputeMode, options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const result: ReconcileResult = { inserted: 0, updated: 0, removed: 0 };
    const now = today();
    const hardEnd = options.highOverride !== undefined ? options.highOverride : minDate(template.endDate, now);
    const hardStart = template.startDate;
    // Occurrences older than the active segment are settled by backfill on enable
    // (effective=start) but never touched again after a "future only" edit/resume.
    const activeStart = maxDate(template.anchorDate, template.effectiveDate);

    const frequency = template.frequency as RecurrenceFrequency;
    logTemplate('info', 'TEMPLATE_BACKFILL_START', {
      id: Number(template.id),
      mode,
      low: hardStart,
      high: hardEnd
    });

    const ledgerRows = await manager.find(ActivityTemplateGeneration, { where: { templateId: Number(template.id) } });
    const ledgerByDate = new Map(ledgerRows.map((row) => [row.occurrenceDate, row]));

    // Resolve the factor lazily: shrinking a schedule to nothing (or a future-dated
    // template) must not fail just because no occurrence needs carbon math right now.
    let factorCache: { id: number; value: number } | null = null;
    const resolveFactor = async (): Promise<{ id: number; value: number }> => {
      if (!factorCache) {
        const user = await this.userService.findById(Number(template.userId));
        const factor = await this.factorService.findMatching(template.category, template.subType, user.region);
        factorCache = { id: Number(factor.id), value: Number(factor.factorValue) };
      }
      return factorCache;
    };

    const windowEmpty = hardEnd < hardStart;
    const scheduled = windowEmpty
      ? new Set<string>()
      : new Set(enumerateOccurrences({ frequency, anchor: template.anchorDate, low: hardStart, high: hardEnd }));

    for (const occurrenceDate of scheduled) {
      const existing = ledgerByDate.get(occurrenceDate);
      const isActive = occurrenceDate >= activeStart;
      if (mode === RecomputeMode.REBUILD) {
        if (existing && existing.status === GenerationStatus.GENERATED && existing.activityId) {
          const factor = await resolveFactor();
          await this.applyTemplateValues(manager, template, Number(existing.activityId), occurrenceDate, factor.id, factor.value);
          result.updated += 1;
        } else if (isActive && !existing) {
          const factor = await resolveFactor();
          await this.insertGenerated(manager, template, occurrenceDate, factor.id, factor.value);
          result.inserted += 1;
        }
        // adjusted / detached / deleted are preserved; pause-gap missing dates are not made up.
      } else {
        // BACKFILL: only insert missing occurrences in the active segment; never
        // overwrite history and never resurrect adjusted/detached/deleted rows.
        if (isActive && !existing) {
          const factor = await resolveFactor();
          await this.insertGenerated(manager, template, occurrenceDate, factor.id, factor.value);
          result.inserted += 1;
        }
      }
    }

    if (mode === RecomputeMode.REBUILD) {
      // Reconcile to the new schedule. A generated row is retired when it falls
      // outside the template range, or when it is inside the current cadence
      // segment (>= anchor) but no longer scheduled (e.g. cadence change). Rows
      // older than the anchor are settled history from before a resume/future
      // edit and are preserved; user-adjusted/detached rows are detached, never
      // deleted; stale tombstones are pruned.
      for (const row of ledgerRows) {
        const beyondRange =
          row.occurrenceDate < hardStart ||
          (template.endDate !== null && row.occurrenceDate > template.endDate) ||
          row.occurrenceDate > now;
        const droppedByCadence = row.occurrenceDate >= template.anchorDate && !scheduled.has(row.occurrenceDate);
        if (!beyondRange && !droppedByCadence) continue;
        if (row.status === GenerationStatus.GENERATED && row.activityId) {
          await manager.delete(Activity, { id: row.activityId });
          await manager.delete(ActivityTemplateGeneration, { id: row.id });
          result.removed += 1;
        } else if (row.status === GenerationStatus.DELETED) {
          await manager.delete(ActivityTemplateGeneration, { id: row.id });
        } else if (row.activityId) {
          await manager.update(Activity, { id: row.activityId }, { templateId: null, isGenerated: false });
          row.activityId = null;
          row.status = GenerationStatus.DETACHED;
          await manager.save(row);
        }
      }
    }

    template.lastSyncedDate = now;
    logTemplate('info', 'TEMPLATE_BACKFILL_SUCCESS', {
      id: Number(template.id),
      inserted: result.inserted,
      updated: result.updated,
      removed: result.removed
    });
    return result;
  }

  private async insertGenerated(
    manager: EntityManager,
    template: ActivityTemplate,
    occurrenceDate: string,
    factorId: number,
    factorValue: number
  ): Promise<void> {
    const amount = Number(template.amount);
    const carbonValue = calculateCarbonValue({ category: template.category, amount, factorValue });
    const activity = manager.create(Activity, {
      userId: Number(template.userId),
      factorId,
      category: template.category,
      subType: template.subType,
      amount: String(amount),
      unit: template.unit,
      carbonValue: String(carbonValue),
      recordDate: occurrenceDate,
      note: template.name,
      templateId: Number(template.id),
      isGenerated: true,
      manuallyAdjusted: false
    });
    const saved = await manager.save(activity);
    await manager.save(
      manager.create(ActivityTemplateGeneration, {
        templateId: Number(template.id),
        activityId: Number(saved.id),
        occurrenceDate,
        status: GenerationStatus.GENERATED
      })
    );
    logTemplate('info', 'TEMPLATE_GENERATION_INSERT', { id: Number(template.id), occurrenceDate, activityId: Number(saved.id) });
  }

  private async applyTemplateValues(
    manager: EntityManager,
    template: ActivityTemplate,
    activityId: number,
    occurrenceDate: string,
    factorId: number,
    factorValue: number
  ): Promise<void> {
    const activity = await manager.findOne(Activity, { where: { id: activityId } });
    if (!activity) return;
    const carbonValue = calculateCarbonValue({ category: template.category, amount: Number(template.amount), factorValue });
    activity.category = template.category;
    activity.subType = template.subType;
    activity.amount = String(Number(template.amount));
    activity.unit = template.unit;
    activity.factorId = factorId;
    activity.carbonValue = String(carbonValue);
    activity.recordDate = occurrenceDate;
    await manager.save(activity);
  }
}
