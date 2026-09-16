/* eslint-disable */
/**
 * e2e entry point with a swappable REAL lifecycle driver.
 *
 * Default (E2E_DRIVER=docker): starts an isolated throwaway MySQL 8 container,
 * runs the real-persistence suite, removes the container and its volume.
 *
 * E2E_DRIVER=local: same orchestration against a real long-lived TCP service
 * process and a real temp data directory (no Docker needed); used by the
 * lifecycle regression tests and equivalent in behaviour.
 *
 * E2E_DB=external: only wait for a reachable externally provided MySQL; never
 * start/stop anything.
 *
 * E2E_JEST_CONFIG=<path>: override the Jest config (the lifecycle suite points
 * this at tiny real Jest configs to force genuine success / failure / spawn
 * failure). Jest is still spawned as a real child process.
 *
 * Exit codes:
 *   0   success and clean teardown
 *   *   non-zero Jest code (teardown still verified clean)
 *   70  driver / start / ready phase failure
 *   71  teardown failure (leaked resource name is printed)
 *   72  interrupted by signal after best-effort teardown
 *   73  jest overran the watchdog (likely a leaked handle)
 *   74  the test process could not be launched at all (spawn failure)
 *
 * Jest is run WITHOUT --forceExit so a leaked handle hangs / fails visibly.
 */
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { dockerDriver, PhaseError, APP_USER, APP_PASSWORD, APP_DB } = require('./harness/mysql-docker');
const { localDriver } = require('./harness/local-driver');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const USE_EXTERNAL = process.env.E2E_DB === 'external';
const DRIVER_NAME = process.env.E2E_DRIVER || 'docker';
const JEST_CONFIG = process.env.E2E_JEST_CONFIG || 'jest-e2e.json';
const READY_TIMEOUT_MS = Number(process.env.E2E_READY_TIMEOUT_MS || (DRIVER_NAME === 'local' ? 20000 : 150000));
const JEST_TIMEOUT_MS = Number(process.env.E2E_JEST_TIMEOUT_MS || 10 * 60 * 1000);

let target = null; // { name, host, port }
let jestChild = null;

function log(message) {
  process.stdout.write(`[e2e-runner] ${message}\n`);
}

function loadDriver() {
  if (DRIVER_NAME === 'local') return localDriver;
  if (DRIVER_NAME === 'docker') return dockerDriver;
  throw new PhaseError('driver', `unknown E2E_DRIVER=${DRIVER_NAME} (expected docker|local)`);
}

function tcpReady(host, port) {
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

async function waitForReady(driver, readyTarget) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (driver ? await driver.isReady(readyTarget) : await tcpReady(readyTarget.host, readyTarget.port)) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, DRIVER_NAME === 'local' ? 200 : 1500));
  }
  throw new PhaseError('ready', `service did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)}s on ${readyTarget.host}:${readyTarget.port}`);
}

function runJest() {
  // Resolve the real jest CLI from its package.json (the package's "exports" map
  // blocks a direct require.resolve('jest/bin/jest.js') on Jest 29).
  const jestBin = process.env.E2E_JEST_BIN
    ? path.resolve(BACKEND_ROOT, process.env.E2E_JEST_BIN)
    : path.join(path.dirname(require.resolve('jest/package.json')), 'bin', 'jest.js');
  const nodeBin = process.env.E2E_JEST_NODE || process.execPath;
  const configPath = path.isAbsolute(JEST_CONFIG) ? JEST_CONFIG : path.resolve(BACKEND_ROOT, JEST_CONFIG);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        resolve(result);
      }
    };
    let watchdog;
    try {
      jestChild = spawn(nodeBin, [jestBin, '--config', configPath, '--runInBand'], {
        cwd: BACKEND_ROOT,
        stdio: 'inherit',
        env: process.env
      });
    } catch (error) {
      // Synchronous spawn rejection: the test process never launched.
      finish({ code: 74, error });
      return;
    }
    // No --forceExit: a leaked handle is a real failure. The watchdog turns an
    // infinite hang into a non-zero exit (73) after the DB is torn down.
    watchdog = setTimeout(() => {
      log(`jest exceeded ${Math.round(JEST_TIMEOUT_MS / 1000)}s — likely a leaked handle; killing`);
      jestChild.kill('SIGKILL');
      finish({ code: 73 });
    }, JEST_TIMEOUT_MS);
    jestChild.on('exit', (code, signal) => {
      // A null code with no signal and no pid means the process never started.
      if (code === null && signal === null && !jestChild.pid) {
        finish({ code: 74 });
        return;
      }
      finish({ code: code ?? 1, signal });
    });
    jestChild.on('error', (error) => {
      // Async spawn failure (e.g. E2E_JEST_NODE points at a non-existent binary).
      finish({ code: 74, error });
    });
  });
}

async function teardown(driver) {
  if (USE_EXTERNAL || !target) return;
  log(`stopping and removing ${DRIVER_NAME} resource ${target.name}`);
  await driver.stop(target.name);
  target = null;
}

async function main() {
  const driver = USE_EXTERNAL ? null : loadDriver();
  let jestResult = { code: 0 };

  if (USE_EXTERNAL) {
    log('using externally provided MySQL (E2E_DB=external); will not start/stop anything');
    target = {
      name: 'external',
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306)
    };
    try {
      await waitForReady(null, target);
    } catch (error) {
      log(error instanceof PhaseError ? error.message : `[ready] ${error.message}`);
      return 70;
    }
  } else {
    log(`starting isolated persistent service (driver=${DRIVER_NAME})`);
    try {
      target = await driver.start();
      process.env.MYSQL_HOST = target.host;
      process.env.MYSQL_PORT = String(target.port);
      process.env.DB_USER = APP_USER;
      process.env.DB_PASSWORD = APP_PASSWORD;
      process.env.DB_NAME = APP_DB;
      // The local service also exposes its address generically for lifecycle tests.
      process.env.E2E_SERVICE_HOST = target.host;
      process.env.E2E_SERVICE_PORT = String(target.port);
      await waitForReady(driver, target);
      log(`service ready on ${target.host}:${target.port} (${target.name})`);
    } catch (error) {
      log(error instanceof PhaseError ? error.message : `[start] ${error.stack || error.message}`);
      return 70;
    }
  }

  jestResult = await runJest();
  if (jestResult.error) log(`jest failed to spawn: ${jestResult.error.message}`);

  try {
    await teardown(driver);
  } catch (error) {
    log(error instanceof PhaseError ? error.message : `[teardown] ${error.message}`);
    if (target && target.name) log(`MANUAL CLEANUP NEEDED for resource ${target.name}`);
    return jestResult.code === 0 ? 71 : jestResult.code;
  }

  if (!USE_EXTERNAL) log('isolated service removed cleanly');
  return jestResult.signal ? 72 : jestResult.code;
}

function onSignal(signal) {
  log(`received ${signal}, tearing down`);
  if (jestChild && !jestChild.killed) {
    try {
      jestChild.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  let driver = null;
  try {
    driver = USE_EXTERNAL ? null : loadDriver();
  } catch {
    /* ignore */
  }
  teardown(driver)
    .then(() => process.exit(72))
    .catch((error) => {
      log(`[teardown] ${error.message}`);
      if (target && target.name) log(`MANUAL CLEANUP NEEDED for resource ${target.name}`);
      process.exit(72);
    });
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log(error instanceof PhaseError ? error.message : `[fatal] ${error.stack || error.message}`);
    process.exit(70);
  });
