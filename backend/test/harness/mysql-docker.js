/* eslint-disable */
/**
 * Ephemeral, ISOLATED, REAL MySQL 8 lifecycle for the recurrence e2e suite.
 *
 * On a clean checkout there is no running database, so the test entry point
 * starts its own throwaway MySQL container (a real persistent server with its
 * own data directory on a private port), waits until the application user can
 * actually log in, runs Jest, and then force-removes the container together with
 * its anonymous data volume. Nothing is mocked and no shared/developer database
 * is touched; the schema is applied by the test layer (bootstrapSchema).
 *
 * Escape hatch for CI that already provides MySQL: set E2E_DB=external together
 * with MYSQL_HOST/PORT/DB_USER/DB_PASSWORD/DB_NAME — the harness then only waits
 * for readiness and never starts/stops a container.
 */
const net = require('net');
const { execFile } = require('child_process');

const DEFAULT_IMAGE = process.env.E2E_MYSQL_IMAGE || 'mysql:8.0';
const ROOT_PASSWORD = 'e2e_root_pwd';
const APP_USER = process.env.DB_USER || 'carbontrack_user';
const APP_PASSWORD = process.env.DB_PASSWORD || 'carbontrack_pwd';
const APP_DB = process.env.DB_NAME || 'carbontrack_db';

class PhaseError extends Error {
  constructor(phase, message, cause) {
    super(`[${phase}] ${message}${cause ? ` — ${causeMessage(cause)}` : ''}`);
    this.phase = phase;
    this.cause = cause;
  }
}

function causeMessage(cause) {
  if (!cause) return '';
  if (typeof cause === 'string') return cause;
  return cause.message || String(cause);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function dockerAvailable() {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function imageExists(image) {
  try {
    await run('docker', ['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

async function ensureImage(image) {
  if (await imageExists(image)) return;
  await run('docker', ['pull', image]);
}

/** True when the application credentials can open the target database. */
async function dbReady(container, host, port, user, password, database) {
  if (container) {
    try {
      await run('docker', [
        'exec',
        container,
        'mysql',
        '-h127.0.0.1',
        `-u${user}`,
        `-p${password}`,
        '-Nse',
        'SELECT 1',
        database
      ]);
      return true;
    } catch {
      return false;
    }
  }
  // external DB: TCP connect probe (credentials are validated later by the app)
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForReady({ container, host, port, user, password, database }, timeoutMs, phase) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      if (await dbReady(container, host, port, user, password, database)) return;
    } catch (error) {
      lastErr = causeMessage(error);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new PhaseError(phase, `MySQL did not become ready within ${Math.round(timeoutMs / 1000)}s`, lastErr);
}

async function startContainer() {
  if (!(await dockerAvailable())) {
    throw new PhaseError('docker', 'Docker is required to run the real-MySQL e2e suite (or set E2E_DB=external with a reachable MySQL).');
  }
  const host = '127.0.0.1';
  const port = await freePort();
  const stamp = `${Date.now()}-${process.pid}`;
  const name = `carbontrack-e2e-${stamp}`;

  // Clear any same-named leftover (extremely unlikely) before starting.
  await run('docker', ['rm', '-fv', name]).catch(() => undefined);

  try {
    await ensureImage(DEFAULT_IMAGE);
    await run('docker', [
      'run',
      '-d',
      '--name',
      name,
      '-e',
      `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`,
      '-e',
      `MYSQL_DATABASE=${APP_DB}`,
      '-e',
      `MYSQL_USER=${APP_USER}`,
      '-e',
      `MYSQL_PASSWORD=${APP_PASSWORD}`,
      '-p',
      `${host}:${port}:3306`,
      DEFAULT_IMAGE
    ]);
  } catch (error) {
    await run('docker', ['rm', '-fv', name]).catch(() => undefined);
    throw new PhaseError('start', `failed to start ${DEFAULT_IMAGE} container ${name}`, error);
  }

  await waitForReady({ container: name, host, port, user: APP_USER, password: APP_PASSWORD, database: APP_DB }, 150000, 'ready');

  return { name, host, port };
}

async function stopContainer(name) {
  if (!name) return;
  try {
    // -v also removes the anonymous /var/lib/mysql volume: full cleanup, no residue.
    await run('docker', ['rm', '-fv', name]);
  } catch (error) {
    throw new PhaseError('teardown', `failed to remove container ${name}`, error);
  }
}

module.exports = {
  PhaseError,
  startContainer,
  stopContainer,
  waitForReady,
  APP_USER,
  APP_PASSWORD,
  APP_DB
};
