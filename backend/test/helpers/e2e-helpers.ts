import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import mysql, { Pool } from 'mysql2/promise';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from '../../src/app.module';

// ---------------------------------------------------------------------------
// Real, persistent environment. There are no fakes, in-memory repositories or
// single-connection serialisation here: the Nest app uses the production
// TypeORM connection pool and supertest opens real HTTP requests (so concurrent
// requests genuinely use distinct pooled connections). A second, independent
// mysql2 pool is used only for fixture setup and authoritative read-back.
// ---------------------------------------------------------------------------

const DEFAULT_DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.DB_USER || 'carbontrack_user',
  password: process.env.DB_PASSWORD || 'carbontrack_pwd',
  database: process.env.DB_NAME || 'carbontrack_db'
};

export const TEST_REGION = 'Shanghai';
export const TEST_REGION_EMPTY = 'RecurrenceTestEmptyRegion'; // has no carbon factors

export interface MaintenanceDb {
  pool: Pool;
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

export function createMaintenanceDb(config = DEFAULT_DB_CONFIG): MaintenanceDb {
  const pool = mysql.createPool({ ...config, connectionLimit: 8, dateStrings: true, multipleStatements: false });
  return {
    pool,
    async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
      const [rows] = await pool.query(sql, params);
      return rows as T[];
    },
    async close() {
      await pool.end();
    }
  };
}

/** Initialise an empty database with the production schema (roles/factors seed). */
export async function bootstrapSchema(): Promise<void> {
  const conn = await mysql.createConnection({ ...DEFAULT_DB_CONFIG, multipleStatements: true });
  try {
    const initSql = fs.readFileSync(path.resolve(__dirname, '../../../database/init.sql'), 'utf8');
    await conn.query(initSql);
  } finally {
    await conn.end();
  }
}

export async function createNestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
  // Bind a real ephemeral port so concurrent requests use genuine sockets and
  // distinct pooled connections (supertest-style listen would do the same).
  await app.listen(0);
  return app;
}

// ---------------------------------------------------------------------------
// User / auth fixtures. Each run and each case uses an isolated user whose data
// is fully purged before and after the suite, so repeated runs stay consistent.
// ---------------------------------------------------------------------------

let seq = 0;
export function uniqueRunTag(): string {
  // process.pid + counter + fixed date keeps it unique per run without Math.random
  // (determinism is fine; uniqueness only has to hold within a database).
  return `r${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}p${process.pid}s${(seq += 1)}`;
}

export interface ApiContext {
  app: INestApplication;
  token: string;
  userId: number;
  username: string;
  region: string;
}

export async function registerAndLogin(app: INestApplication, region = TEST_REGION): Promise<ApiContext> {
  const http = app.getHttpServer();
  const tag = uniqueRunTag();
  const username = `rt_${tag}`;
  const email = `${username}@recurrence.test`;
  const password = 'password123';

  // register returns { user } without a token; follow up with login.
  await fetchJson(http, 'POST', '/users/register', null, { username, email, password, region });
  const loginBody = await fetchJson<{ token: string; user: { id: number } }>(http, 'POST', '/users/login', null, {
    email,
    password
  });
  return { app, token: loginBody.body.token, userId: Number(loginBody.body.user.id), username, region };
}

// ---------------------------------------------------------------------------
// tiny fetch helpers over the real Node http server (no supertest type churn)
// ---------------------------------------------------------------------------

import http from 'http';

export interface JsonResponse<T = any> {
  status: number;
  body: T;
}

export function fetchJson<T = any>(
  server: http.Server,
  method: string,
  urlPath: string,
  token: string | null,
  payload?: unknown
): Promise<JsonResponse<T>> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body));

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let parsed: any = raw;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          parsed = { raw };
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Authoritative read-back directly from MySQL (never trusts API echo)
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: number;
  activityId: number | null;
  occurrenceDate: string;
  status: string;
}

export interface ActivityRow {
  id: number;
  category: string;
  subType: string;
  amount: string;
  unit: string;
  carbonValue: string;
  recordDate: string;
  templateId: number | null;
  isGenerated: number;
  manuallyAdjusted: number;
}

export interface TemplateRow {
  id: number;
  enabled: number;
  pausedAt: string | null;
  anchorDate: string;
  effectiveDate: string;
  lastSyncedDate: string | null;
}

export async function getTemplates(db: MaintenanceDb, userId: number): Promise<TemplateRow[]> {
  return db.query<TemplateRow>(
    `SELECT id, enabled, paused_at AS pausedAt, anchor_date AS anchorDate,
            effective_date AS effectiveDate, last_synced_date AS lastSyncedDate
     FROM activity_templates WHERE user_id = ? ORDER BY id`,
    [userId]
  );
}

export async function getActivities(db: MaintenanceDb, userId: number): Promise<ActivityRow[]> {
  return db.query<ActivityRow>(
    `SELECT id, category, sub_type AS subType, amount, unit, carbon_value AS carbonValue,
            record_date AS recordDate, template_id AS templateId, is_generated AS isGenerated,
            manually_adjusted AS manuallyAdjusted
     FROM activities WHERE user_id = ? ORDER BY record_date, id`,
    [userId]
  );
}

export async function getLedger(db: MaintenanceDb, templateId: number): Promise<LedgerRow[]> {
  return db.query<LedgerRow>(
    `SELECT id, activity_id AS activityId, occurrence_date AS occurrenceDate, status
     FROM activity_template_generations WHERE template_id = ? ORDER BY occurrence_date, id`,
    [templateId]
  );
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Seed the exact persisted state a system reaches after running a daily template
 * and pausing it in the past: the template is enabled + paused, and it has real
 * activities + ledger rows only through `syncedThrough` (the dates after that up
 * to the pause day are a genuine gap that was never generated). All rows are
 * written to real MySQL; the app is then driven through normal HTTP calls.
 */
export async function seedPausedTemplate(
  db: MaintenanceDb,
  ctx: ApiContext,
  opts: { start: string; pausedAt: string; syncedThrough: string; amount?: number }
): Promise<number> {
  const amount = opts.amount ?? 10;
  const factorRows = await db.query<{ id: number; factorValue: string }>(
    `SELECT id, factor_value AS factorValue FROM carbon_factors
     WHERE category = 'transport' AND sub_type = 'metro' AND region = ? LIMIT 1`,
    [ctx.region]
  );
  const factorId = Number(factorRows[0].id);
  const factorValue = Number(factorRows[0].factorValue);
  const carbon = Number((amount * factorValue).toFixed(2));

  const templateResult = await db.query<{ insertId: number }>(
    `INSERT INTO activity_templates
       (user_id, name, category, sub_type, amount, unit, frequency, start_date, end_date,
        anchor_date, effective_date, enabled, paused_at, last_synced_date)
     VALUES (?, 'seeded paused', 'transport', 'metro', ?, 'km', 'daily', ?, NULL, ?, ?, 1, ?, ?)`,
    [ctx.userId, String(amount), opts.start, opts.start, opts.start, opts.pausedAt, opts.syncedThrough]
  );
  const templateId = Number((templateResult as unknown as { insertId: number }).insertId);

  // enumerate real dates [start, syncedThrough] inclusive.
  const dates: string[] = [];
  const cursor = new Date(opts.start + 'T00:00:00Z');
  const end = new Date(opts.syncedThrough + 'T00:00:00Z');
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const recordDate of dates) {
    const activityResult = await db.query<{ insertId: number }>(
      `INSERT INTO activities
         (user_id, factor_id, category, sub_type, amount, unit, carbon_value, record_date, note,
          template_id, is_generated, manually_adjusted)
       VALUES (?, ?, 'transport', 'metro', ?, 'km', ?, ?, 'seeded paused', ?, 1, 0)`,
      [ctx.userId, factorId, String(amount), String(carbon), recordDate, templateId]
    );
    const activityId = Number((activityResult as unknown as { insertId: number }).insertId);
    await db.query(
      `INSERT INTO activity_template_generations (template_id, activity_id, occurrence_date, status)
       VALUES (?, ?, ?, 'generated')`,
      [templateId, activityId, recordDate]
    );
  }
  return templateId;
}
