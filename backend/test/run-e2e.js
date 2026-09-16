/* eslint-disable */
/**
 * e2e entry point.
 *
 * Default mode: starts an isolated throwaway MySQL 8 container, runs the
 * real-persistence suite, and removes the container afterwards. Works on a
 * clean checkout with no database prepared beforehand.
 *
 * CI mode with an existing database:
 *   E2E_DB=external MYSQL_HOST=... MYSQL_PORT=3306 DB_USER=... DB_PASSWORD=... DB_NAME=... npm run test:e2e
 *
 * Exit codes are meaningful:
 *   0            success and clean teardown
 *   jest code    tests failed (teardown still verified clean)
 *   70           docker / start / ready phase failure
 *   71           teardown failure (possible leaked container — printed by name)
 *   72           interrupted by signal after best-effort teardown
 *   73           jest overran the watchdog (likely a leaked handle)
 *
 * Jest is deliberately run WITHOUT --forceExit so a connection leak (app server
 * or mysql2 pool left open) makes the run hang / fail instead of being masked.
 */
const path = require('path');
const { spawn } = require('child_process');
const {
  PhaseError,
  startContainer,
  stopContainer,
  waitForReady,
  APP_USER,
  APP_PASSWORD,
  APP_DB
} = require('./harness/mysql-docker');

const USE_EXTERNAL = process.env.E2E_DB === 'external';
const JEST_TIMEOUT_MS = Number(process.env.E2E_JEST_TIMEOUT_MS || 10 * 60 * 1000);
let containerName = '';
let jestChild = null;

function log(message) {
  process.stdout.write(`[e2e-runner] ${message}\n`);
}

async function runJest() {
  const jestBin = require.resolve('jest/bin/jest.js');
  return new Promise((resolve) => {
    jestChild = spawn(
      process.execPath,
      [jestBin, '--config', 'jest-e2e.json', '--runInBand'],
      { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', env: process.env }
    );
    // No --forceExit: a leaked handle is a real failure. The watchdog turns an
    // otherwise-infinite hang into a non-zero exit (73) after tearing the DB down.
    const watchdog = setTimeout(() => {
      log(`jest exceeded ${Math.round(JEST_TIMEOUT_MS / 1000)}s — likely a leaked handle; killing`);
      jestChild.kill('SIGKILL');
      resolve({ code: 73, signal: null, timedOut: true });
    }, JEST_TIMEOUT_MS);
    jestChild.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code: code ?? 1, signal });
    });
    jestChild.on('error', (error) => {
      clearTimeout(watchdog);
      resolve({ code: 1, signal: null, error });
    });
  });
}

async function teardown() {
  if (USE_EXTERNAL || !containerName) return;
  log(`stopping and removing isolated database container ${containerName}`);
  await stopContainer(containerName);
  containerName = '';
}

async function main() {
  let jestResult = { code: 0 };

  if (USE_EXTERNAL) {
    log('using externally provided MySQL (E2E_DB=external); will not start/stop a container');
    const host = process.env.MYSQL_HOST || '127.0.0.1';
    const port = Number(process.env.MYSQL_PORT || 3306);
    try {
      await waitForReady({ container: null, host, port, user: APP_USER, password: APP_PASSWORD, database: APP_DB }, 30000, 'ready');
    } catch (error) {
      log(error instanceof PhaseError ? error.message : `[ready] ${error.message}`);
      return 70;
    }
  } else {
    log('starting isolated MySQL 8 container for the e2e suite');
    try {
      const container = await startContainer();
      containerName = container.name;
      process.env.MYSQL_HOST = container.host;
      process.env.MYSQL_PORT = String(container.port);
      process.env.DB_USER = APP_USER;
      process.env.DB_PASSWORD = APP_PASSWORD;
      process.env.DB_NAME = APP_DB;
      log(`database ready on ${container.host}:${container.port} (container ${container.name})`);
    } catch (error) {
      log(error instanceof PhaseError ? error.message : `[start] ${error.message}`);
      return 70;
    }
  }

  jestResult = await runJest();
  if (jestResult.error) log(`jest failed to spawn: ${jestResult.error.message}`);

  try {
    await teardown();
  } catch (error) {
    log(error instanceof PhaseError ? error.message : `[teardown] ${error.message}`);
    if (containerName) log(`MANUAL CLEANUP NEEDED: docker rm -fv ${containerName}`);
    return jestResult.code === 0 ? 71 : jestResult.code;
  }

  if (!USE_EXTERNAL) log('isolated database container removed cleanly');
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
  teardown()
    .then(() => process.exit(72))
    .catch((error) => {
      log(`[teardown] ${error.message}`);
      if (containerName) log(`MANUAL CLEANUP NEEDED: docker rm -fv ${containerName}`);
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
