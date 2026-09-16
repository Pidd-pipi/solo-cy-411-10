import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import dayjs from 'dayjs';
import {
  ApiContext,
  JsonResponse,
  MaintenanceDb,
  bootstrapSchema,
  createMaintenanceDb,
  createNestApp,
  fetchJson,
  getActivities,
  getLedger,
  getTemplates,
  registerAndLogin,
  seedPausedTemplate
} from './helpers/e2e-helpers';

// ---------------------------------------------------------------------------
// Real-persistence regression suite for recurring activity templates.
//
// Every assertion goes through the real Nest HTTP layer and is then
// independently read back from MySQL. No in-memory doubles, fake repositories
// or single-connection serialisation: the Nest app uses its production TypeORM
// pool (concurrent HTTP requests therefore use distinct pooled connections),
// and concurrency tests also take a genuine InnoDB row lock from a second
// independent connection. Temporary users/templates/activities/ledger rows are
// purged after each test so repeated runs stay consistent.
//
// Prereq: reachable MySQL 8 with the carbontrack schema
// (MYSQL_HOST/PORT/DB_USER/DB_PASSWORD/DB_NAME). Run: npm run test:e2e
// ---------------------------------------------------------------------------

const fmt = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');
const T = dayjs();

const BASE_TEMPLATE = {
  name: 'regression commute',
  category: 'transport',
  subType: 'metro',
  amount: 10,
  unit: 'km',
  frequency: 'daily'
} as const;

type InvalidCall = (ctx: ApiContext, id: number) => Promise<JsonResponse>;

describe('recurring activity templates (real MySQL e2e)', () => {
  let app: INestApplication;
  let db: MaintenanceDb;
  const contexts: ApiContext[] = [];

  beforeAll(async () => {
    await bootstrapSchema();
    app = await createNestApp();
    db = createMaintenanceDb();
  }, 60000);

  afterAll(async () => {
    await db?.close();
    await app?.close();
  }, 30000);

  // ON DELETE CASCADE purges templates/ledger/activities/goals with the user;
  // audit_logs.user_id is nullable so clear it explicitly.
  afterEach(async () => {
    for (const ctx of contexts.splice(0)) {
      await db.query('DELETE FROM audit_logs WHERE user_id = ?', [ctx.userId]);
      await db.query('DELETE FROM users WHERE id = ?', [ctx.userId]);
    }
  });

  async function newUser(region = 'Shanghai'): Promise<ApiContext> {
    const ctx = await registerAndLogin(app, region);
    contexts.push(ctx);
    return ctx;
  }

  const server = () => app.getHttpServer();
  const api = (ctx: ApiContext, method: string, urlPath: string, payload?: unknown) =>
    fetchJson(server(), method, urlPath, ctx.token, payload);

  async function createTemplate(ctx: ApiContext, body: Record<string, unknown>): Promise<number> {
    const res = await api(ctx, 'POST', '/activity-templates', { ...BASE_TEMPLATE, ...body, enabled: false });
    expect(res.status).toBe(201);
    return Number(res.body.template.id);
  }

  const enable = (ctx: ApiContext, id: number) => api(ctx, 'POST', `/activity-templates/${id}/enable`);

  // ------------------------------------------------------------ normal backfill

  it('normal backfill fills every missing occurrence through today, with computed carbon and nothing in the future', async () => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(2, 'day')), endDate: null });

    const res = await enable(ctx, id);
    expect(res.status).toBe(201);
    expect(res.body.template.enabled).toBe(true);

    const activities = await getActivities(db, ctx.userId);
    expect(activities.map((a) => a.recordDate).sort()).toEqual(
      [-2, -1, 0].map((n) => fmt(T.add(n, 'day')))
    );
    for (const row of activities) {
      expect(Number(row.templateId)).toBe(id);
      expect(row.isGenerated).toBe(1);
      expect(Number(row.carbonValue)).toBeCloseTo(0.52, 2); // 10 km * 0.052
    }
    expect(activities.every((a) => a.recordDate <= fmt(T))).toBe(true);

    const ledger = await getLedger(db, id);
    expect(ledger).toHaveLength(3);
    expect(ledger.every((l) => l.status === 'generated' && l.activityId !== null)).toBe(true);
  });

  // ------------------------------------------------------------ idempotent reads

  it('repeated reads do not regenerate rows', async () => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(3, 'day')), endDate: null });
    await enable(ctx, id);

    for (let i = 0; i < 4; i += 1) {
      const list = await api(ctx, 'GET', '/activities');
      expect(list.status).toBe(200);
      expect((list.body as unknown[]).length).toBe(4);
      const summary = await api(ctx, 'GET', `/activities/summary?start=${fmt(T.subtract(30, 'day'))}&end=${fmt(T)}`);
      expect(summary.status).toBe(200);
    }

    const activities = await getActivities(db, ctx.userId);
    const ledger = await getLedger(db, id);
    expect(activities).toHaveLength(4);
    expect(ledger).toHaveLength(4);
    const keys = activities.map((a) => `${a.templateId}:${a.recordDate}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // ------------------------------------------------------------ pause in the future

  it('pause date later than today only backfills through today and produces no future activities', async () => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(5, 'day')), endDate: null });
    await enable(ctx, id);

    const pause = await api(ctx, 'POST', `/activity-templates/${id}/pause`, { date: fmt(T.add(5, 'day')) });
    expect(pause.status).toBe(201);

    const activities = await getActivities(db, ctx.userId);
    const dates = activities.map((a) => a.recordDate).sort();
    expect(dates).toEqual([-5, -4, -3, -2, -1, 0].map((n) => fmt(T.add(n, 'day'))));
    expect(dates.some((d) => d > fmt(T))).toBe(false);

    const [tpl] = await getTemplates(db, ctx.userId);
    expect(tpl.pausedAt).toBe(fmt(T.add(5, 'day')));
    expect(tpl.lastSyncedDate).toBe(fmt(T));
  });

  // ------------------------------------------- paused period never gains records
  // (a real cross-day paused state is seeded in MySQL, then driven over HTTP)

  it('while paused the missing gap stays empty across repeated reads (no makeup rows)', async () => {
    const ctx = await newUser();
    // Ran normally through T-3, paused starting T-2; gap = T-2, T-1.
    const id = await seedPausedTemplate(db, ctx, {
      start: fmt(T.subtract(10, 'day')),
      pausedAt: fmt(T.subtract(2, 'day')),
      syncedThrough: fmt(T.subtract(3, 'day'))
    });

    for (let i = 0; i < 3; i += 1) {
      const list = await api(ctx, 'GET', '/activities');
      expect(list.status).toBe(200);
    }

    const activities = await getActivities(db, ctx.userId);
    const dates = activities.map((a) => a.recordDate).sort();
    expect(dates).toEqual(Array.from({ length: 8 }, (_, n) => fmt(T.subtract(10 - n, 'day')))); // T-10 .. T-3
    expect(dates).not.toContain(fmt(T.subtract(2, 'day')));
    expect(dates).not.toContain(fmt(T.subtract(1, 'day')));
    expect(dates).not.toContain(fmt(T));
    expect(await getLedger(db, id)).toHaveLength(8);
  });

  // ------------------------------------------------------------ resume re-anchors

  it('resume continues from the resume day and never makes up the paused gap', async () => {
    const ctx = await newUser();
    const id = await seedPausedTemplate(db, ctx, {
      start: fmt(T.subtract(10, 'day')),
      pausedAt: fmt(T.subtract(2, 'day')),
      syncedThrough: fmt(T.subtract(3, 'day'))
    });

    const resume = await api(ctx, 'POST', `/activity-templates/${id}/resume`, { date: fmt(T) });
    expect(resume.status).toBe(201);

    const activities = await getActivities(db, ctx.userId);
    const dates = activities.map((a) => a.recordDate).sort();
    expect(dates).toContain(fmt(T.subtract(10, 'day')));
    expect(dates).toContain(fmt(T.subtract(3, 'day')));
    expect(dates).not.toContain(fmt(T.subtract(2, 'day')));
    expect(dates).not.toContain(fmt(T.subtract(1, 'day')));
    expect(dates).toContain(fmt(T));

    const ledger = await getLedger(db, id);
    const byDate = new Map(ledger.map((l) => [l.occurrenceDate, l]));
    for (const gap of [fmt(T.subtract(2, 'day')), fmt(T.subtract(1, 'day'))]) {
      expect(byDate.get(gap)?.status).toBe('detached');
      expect(byDate.get(gap)?.activityId).toBeNull();
    }
    expect(byDate.get(fmt(T))?.status).toBe('generated');

    const [tpl] = await getTemplates(db, ctx.userId);
    expect(tpl.pausedAt).toBeNull();
    expect(tpl.anchorDate).toBe(fmt(T));
  });

  // ------------------------------------------------------------ invalid calendar dates

  const invalidDateCases: [string, InvalidCall][] = [
    [
      'start',
      (ctx) =>
        api(ctx, 'POST', '/activity-templates', {
          ...BASE_TEMPLATE,
          startDate: '2026-02-30',
          endDate: '2026-12-31',
          enabled: false
        })
    ],
    [
      'end',
      (ctx) =>
        api(ctx, 'POST', '/activity-templates', {
          ...BASE_TEMPLATE,
          startDate: '2026-01-01',
          endDate: '2026-02-30',
          enabled: false
        })
    ],
    ['pause', (ctx, id) => api(ctx, 'POST', `/activity-templates/${id}/pause`, { date: '2026-02-30' })],
    ['resume', (ctx, id) => api(ctx, 'POST', `/activity-templates/${id}/resume`, { date: '2026-02-30' })]
  ];

  it.each(invalidDateCases)('rejects an impossible calendar date at the %s entry point', async (kind, call) => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(5, 'day')), endDate: null });
    await enable(ctx, id);
    if (kind === 'resume') {
      const paused = await api(ctx, 'POST', `/activity-templates/${id}/pause`, {});
      expect(paused.status).toBe(201);
    }

    const res = await call(ctx, id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEMPLATE_DATE_RANGE_INVALID');

    // Failed validation must leave no partial template/ledger/activity behind.
    const templates = await getTemplates(db, ctx.userId);
    expect(templates).toHaveLength(1);
    const ledger = await getLedger(db, id);
    expect(ledger.every((l) => l.activityId !== null || l.status === 'detached')).toBe(true);
    const [tpl] = templates;
    if (kind === 'pause') expect(tpl.pausedAt).toBeNull();
    if (kind === 'resume') expect(tpl.pausedAt).not.toBeNull();
  });

  // ------------------------------------------------------------ manual edit survives rebuild

  it('rebuild preserves a hand-adjusted row and recomputes the rest', async () => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(10, 'day')), endDate: null, amount: 10 });
    await enable(ctx, id);

    const target = (await getActivities(db, ctx.userId)).find((a) => a.recordDate === fmt(T.subtract(5, 'day')))!;
    expect(target).toBeTruthy();

    const patch = await api(ctx, 'PATCH', `/activities/${target.id}`, { amount: 999 });
    expect(patch.status).toBe(200);
    const patched = (await getActivities(db, ctx.userId)).find((a) => a.id === target.id)!;
    expect(Number(patched.amount)).toBe(999);
    expect(patched.manuallyAdjusted).toBe(1);
    expect((await getLedger(db, id)).find((l) => l.occurrenceDate === fmt(T.subtract(5, 'day')))?.status).toBe('adjusted');

    const rebuild = await api(ctx, 'PATCH', `/activity-templates/${id}`, { amount: 50, recomputeMode: 'rebuild' });
    expect(rebuild.status).toBe(200);

    const after = await getActivities(db, ctx.userId);
    expect(Number(after.find((a) => a.id === target.id)!.amount)).toBe(999); // hand value preserved
    for (const row of after.filter((a) => a.id !== target.id)) {
      expect(Number(row.amount)).toBe(50); // everything else recomputed
    }
    const ledgerAfter = await getLedger(db, id);
    expect(ledgerAfter.find((l) => l.occurrenceDate === fmt(T.subtract(5, 'day')))?.status).toBe('adjusted');
    expect(ledgerAfter.filter((l) => l.status === 'generated')).toHaveLength(after.length - 1);
  });

  // ------------------------------------------------------------ monthly short month

  it('monthly template clamps to the last day of short months and returns to the anchor day next month', async () => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { frequency: 'monthly', startDate: '2024-01-31', endDate: '2024-05-31' });

    const res = await enable(ctx, id);
    expect(res.status).toBe(201);

    const expected = ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31'];
    expect((await getLedger(db, id)).map((l) => l.occurrenceDate).sort()).toEqual(expected);
    expect((await getActivities(db, ctx.userId)).map((a) => a.recordDate).sort()).toEqual(expected);
  });

  // ------------------------------------------------------------ concurrency / atomicity

  it('a held row lock makes concurrent backfills return 409 and leaves zero partial rows', async () => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(6, 'day')), endDate: null });

    const lockConn = await db.pool.getConnection();
    try {
      await lockConn.beginTransaction();
      await lockConn.query('SELECT id FROM activity_templates WHERE id = ? FOR UPDATE', [id]);

      const contenders = await Promise.all(Array.from({ length: 6 }, () => enable(ctx, id)));
      expect(contenders.every((r) => r.status === 409 && r.body.code === 'TEMPLATE_BACKFILL_BUSY')).toBe(true);

      // No half batch while the lock is held.
      expect(await getActivities(db, ctx.userId)).toHaveLength(0);
      expect(await getLedger(db, id)).toHaveLength(0);

      await lockConn.commit();
    } finally {
      lockConn.release();
    }

    const winner = await enable(ctx, id);
    expect(winner.status).toBe(201);

    const expectedDates = Array.from({ length: 7 }, (_, n) => fmt(T.subtract(6 - n, 'day')));
    expect((await getLedger(db, id)).map((l) => l.occurrenceDate).sort()).toEqual(expectedDates);
    expect((await getActivities(db, ctx.userId)).map((a) => a.recordDate).sort()).toEqual(expectedDates);
  });

  it('genuine parallel HTTP enables never corrupt the ledger: each is 201-or-409 and the count is exact', async () => {
    const ctx = await newUser();
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(4, 'day')), endDate: null });

    const results = await Promise.all(Array.from({ length: 8 }, () => enable(ctx, id)));
    for (const r of results) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.code).toBe('TEMPLATE_BACKFILL_BUSY');
    }
    expect(results.some((r) => r.status === 201)).toBe(true);

    const ledger = await getLedger(db, id);
    const activities = await getActivities(db, ctx.userId);
    expect(ledger).toHaveLength(5);
    expect(activities).toHaveLength(5);
    expect(new Set(ledger.map((l) => l.occurrenceDate)).size).toBe(5);
  });

  // ------------------------------------------------------------ failure atomicity

  it('a backfill that fails mid-transaction rolls back completely with no activity or ledger rows', async () => {
    const region = 'RecurrenceTestEmptyRegion';
    const ctx = await newUser(region);

    // Provide a factor long enough for template validation, then remove it so the
    // first real backfill fails on factor resolution (region is unique to this test).
    await db.query(
      `INSERT INTO carbon_factors (category, sub_type, factor_value, unit, region)
       VALUES ('transport', 'metro', 0.0520, 'km', ?)`,
      [region]
    );
    const id = await createTemplate(ctx, { startDate: fmt(T.subtract(3, 'day')), endDate: null });
    await db.query('DELETE FROM carbon_factors WHERE region = ?', [region]);

    const res = await enable(ctx, id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FACTOR_NOT_FOUND');

    // Whole batch rolled back: zero rows of either kind, template left disabled.
    expect(await getActivities(db, ctx.userId)).toHaveLength(0);
    expect(await getLedger(db, id)).toHaveLength(0);
    const [tpl] = await getTemplates(db, ctx.userId);
    expect(tpl.enabled).toBe(0);
    expect(tpl.lastSyncedDate).toBeNull();
  });
});
