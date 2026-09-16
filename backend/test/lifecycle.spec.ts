import 'reflect-metadata';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Regression tests FOR THE TEST ENTRY POINT's environment lifecycle.
//
// The real `test/run-e2e.js` orchestrator is spawned as a real OS child process
// with E2E_DRIVER=local, so it starts a real long-lived TCP service process,
// probes readiness with a real TCP connection, spawns a real Jest child
// process, and really kills the service and deletes a real temp data directory.
// These tests assert REAL exit codes and REAL filesystem/process state — never
// mocked commands or log text. The recurrence suite itself still runs against
// genuine MySQL via E2E_DRIVER=docker (see recurrence.e2e-spec.ts); nothing here
// weakens its real-process / independent-connection / row-lock / rollback path.
// ---------------------------------------------------------------------------

const BACKEND_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-e2e.js');
const FIXTURES = path.join(__dirname, 'lifecycle-fixtures');

interface RunnerResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function uniqueRoot(): string {
  const dir = path.join(os.tmpdir(), `carbontrack-lifecycle-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runRunner(env: NodeJS.ProcessEnv, timeoutMs = 45000): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, E2E_DRIVER: 'local', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runner timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const output = (r: RunnerResult) => `${r.stdout}\n${r.stderr}`;

/** Poll a TCP port until it refuses connections (service really stopped). */
async function waitForPortClosed(port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!open) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function resourceIds(root: string): string[] {
  return fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
}

function parseReadyPort(stdout: string): number {
  const match = /service ready on 127\.0\.0\.1:(\d+)/.exec(stdout);
  if (!match) throw new Error(`could not find ready port in runner output:\n${stdout}`);
  return Number(match[1]);
}

function parseResourceName(stdout: string): string {
  const match = /service ready on 127\.0\.0\.1:\d+ \(([^)]+)\)/.exec(stdout);
  if (!match) throw new Error(`could not find resource name in runner output:\n${stdout}`);
  return match[1];
}

describe('e2e entry-point environment lifecycle (real processes, real temp data)', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const dir = uniqueRoot();
    roots.push(dir);
    return dir;
  };

  afterEach(() => {
    // The runner removes its own resource subdir; remove the test-owned parent
    // root here so nothing lingers even when an assertion fails mid-test.
    for (const dir of roots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('successful run: service starts, real Jest passes, port closes and no temp data remains', async () => {
    const root = makeRoot();
    const result = await runRunner({
      E2E_LOCAL_ROOT: root,
      E2E_JEST_CONFIG: path.relative(BACKEND_ROOT, path.join(FIXTURES, 'pass.jest.json')),
      E2E_READY_TIMEOUT_MS: '20000'
    });

    expect(result.code).toBe(0);
    expect(output(result)).toContain('service ready on');
    expect(output(result)).toContain('isolated service removed cleanly');

    // The real service process is gone: its port refuses connections.
    const port = parseReadyPort(result.stdout);
    expect(await waitForPortClosed(port)).toBe(true);

    // No leftover temporary data whatsoever (the whole resource tree was removed).
    expect(resourceIds(root)).toHaveLength(0);
  });

  test('start-phase failure returns non-zero 70 and names the start phase, with no resource left', async () => {
    const root = makeRoot();
    const result = await runRunner({
      E2E_LOCAL_ROOT: root,
      E2E_LOCAL_FAIL: 'start',
      E2E_JEST_CONFIG: path.relative(BACKEND_ROOT, path.join(FIXTURES, 'pass.jest.json')),
      E2E_READY_TIMEOUT_MS: '20000'
    });

    expect(result.code).toBe(70);
    expect(output(result)).toContain('[start]');
    // Jest must never have been reached.
    expect(output(result)).not.toContain('PASS');
    expect(output(result)).not.toContain('FAIL');

    // The half-started resource directory is cleaned up on the failure path.
    expect(resourceIds(root)).toHaveLength(0);
  });

  test('test process that cannot launch returns independent code 74 and still tears the service down', async () => {
    const root = makeRoot();
    const result = await runRunner({
      E2E_LOCAL_ROOT: root,
      E2E_JEST_CONFIG: path.relative(BACKEND_ROOT, path.join(FIXTURES, 'pass.jest.json')),
      E2E_JEST_NODE: path.join(BACKEND_ROOT, 'definitely-not-a-node-binary'),
      E2E_READY_TIMEOUT_MS: '20000'
    });

    expect(result.code).toBe(74);
    expect(output(result)).toContain('service ready on'); // service did start

    const port = parseReadyPort(result.stdout);
    expect(await waitForPortClosed(port)).toBe(true);
    expect(resourceIds(root)).toHaveLength(0); // teardown still ran
  });

  test('failed tests return non-zero (Jest failure) yet teardown still runs and removes temp data', async () => {
    const root = makeRoot();
    const result = await runRunner({
      E2E_LOCAL_ROOT: root,
      E2E_JEST_CONFIG: path.relative(BACKEND_ROOT, path.join(FIXTURES, 'fail.jest.json')),
      E2E_READY_TIMEOUT_MS: '20000'
    });

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(71); // not the teardown status — Jest genuinely failed
    expect(output(result)).toContain('FAIL');
    expect(output(result)).toContain('isolated service removed cleanly');

    const port = parseReadyPort(result.stdout);
    expect(await waitForPortClosed(port)).toBe(true);
    expect(resourceIds(root)).toHaveLength(0);
  });

  test('teardown failure returns the independent status 71 and leaves the resource for manual cleanup', async () => {
    const root = makeRoot();
    const result = await runRunner({
      E2E_LOCAL_ROOT: root,
      E2E_JEST_CONFIG: path.relative(BACKEND_ROOT, path.join(FIXTURES, 'pass.jest.json')),
      E2E_LOCAL_STOP_FAIL: '1',
      E2E_READY_TIMEOUT_MS: '20000'
    });

    expect(result.code).toBe(71);
    expect(output(result)).toContain('[teardown]');
    expect(output(result)).toMatch(/MANUAL CLEANUP NEEDED for resource .+/);

    // The leaked resource genuinely remains on disk (real EPERM, not a log-only check).
    const leftover = resourceIds(root);
    expect(leftover.length).toBeGreaterThanOrEqual(1);
    const statePath = path.join(root, leftover[0], 'state.json');
    expect(fs.existsSync(statePath)).toBe(true);

    // Clean up the deliberately leaked, read-only resource ourselves.
    for (const id of leftover) {
      const dir = path.join(root, id);
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
