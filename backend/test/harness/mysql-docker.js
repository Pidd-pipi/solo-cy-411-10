/* eslint-disable */
/**
 * Docker / MySQL driver for the e2e lifecycle.
 *
 * Manages a REAL, ISOLATED MySQL 8 container (its own data directory on a
 * private port). Readiness is proven by logging in with the application
 * credentials inside the container; teardown force-removes the container AND
 * its anonymous volume. No shared/developer database is touched.
 *
 * CI escape hatch (E2E_DB=external) is handled by run-e2e.js directly.
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

const dockerDriver = {
  name: 'docker',

  /** Start a real container; readiness is checked separately via isReady(). */
  async start() {
    if (!(await dockerAvailable())) {
      throw new PhaseError('docker', 'Docker is required to run the real-MySQL e2e suite (or set E2E_DB=external with a reachable MySQL, or E2E_DRIVER=local).');
    }
    const host = '127.0.0.1';
    const port = await freePort();
    const stamp = `${Date.now()}-${process.pid}`;
    const name = `carbontrack-e2e-${stamp}`;

    await run('docker', ['rm', '-fv', name]).catch(() => undefined);

    try {
      await ensureImage(DEFAULT_IMAGE);
      await run('docker', [
        'run', '-d', '--name', name,
        '-e', `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`,
        '-e', `MYSQL_DATABASE=${APP_DB}`,
        '-e', `MYSQL_USER=${APP_USER}`,
        '-e', `MYSQL_PASSWORD=${APP_PASSWORD}`,
        '-p', `${host}:${port}:3306`,
        DEFAULT_IMAGE
      ]);
    } catch (error) {
      await run('docker', ['rm', '-fv', name]).catch(() => undefined);
      throw new PhaseError('start', `failed to start ${DEFAULT_IMAGE} container ${name}`, error);
    }

    return { name, host, port };
  },

  /** Real login from inside the container. */
  async isReady(target) {
    try {
      await run('docker', [
        'exec', target.name, 'mysql',
        '-h127.0.0.1', `-u${APP_USER}`, `-p${APP_PASSWORD}`,
        '-Nse', 'SELECT 1', APP_DB
      ]);
      return true;
    } catch {
      return false;
    }
  },

  async stop(name) {
    try {
      // -v also removes the anonymous /var/lib/mysql volume: full cleanup.
      await run('docker', ['rm', '-fv', name]);
    } catch (error) {
      throw new PhaseError('teardown', `failed to remove container ${name}`, error);
    }
  },

  async exists(name) {
    try {
      await run('docker', ['inspect', '-f', '{{.Id}}', name]);
      return true;
    } catch {
      return false;
    }
  }
};

module.exports = {
  dockerDriver,
  PhaseError,
  APP_USER,
  APP_PASSWORD,
  APP_DB,
  freePort
};
