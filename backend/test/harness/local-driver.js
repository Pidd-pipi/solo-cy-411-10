/* eslint-disable */
/**
 * LOCAL lifecycle driver — exercises the exact orchestration with REAL OS
 * resources without needing Docker:
 *   start(): spawns a real long-lived TCP service process, allocates a real
 *            free port, creates a real temporary data directory and writes a
 *            real state file.
 *   isReady(): opens a REAL TCP connection to that port.
 *   stop(): really kills the process and really deletes the data directory.
 *
 * Real failure injection (no fake exits / log-only checks):
 *   E2E_LOCAL_FAIL=start   the service process exits during startup
 *                          (start-phase failure -> runner returns 70).
 *   stopFail=true          the data directory is made read-only before stop so
 *                          the real removal fails with EPERM (teardown failure
 *                          -> runner returns 71). When running as root the chmod
 *                          is bypassed, so the driver rejects stop itself rather
 *                          than silently succeeding.
 */
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

const ROOT = process.env.E2E_LOCAL_ROOT || path.join(os.tmpdir(), 'carbontrack-e2e-local');
const SERVICE = path.join(__dirname, 'local-service.js');

const localDriver = {
  name: 'local',
  root: ROOT,

  async start() {
    const id = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const dir = path.join(ROOT, id);
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const port = await freePort();

    const child = spawn(process.execPath, [SERVICE], {
      env: {
        ...process.env,
        E2E_LOCAL_PORT: String(port),
        E2E_LOCAL_DATA_DIR: dataDir,
        E2E_LOCAL_FAIL: process.env.E2E_LOCAL_FAIL || ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // Keep the child referenced: if the service dies during startup Node must
    // not drain the event loop before the awaiting promise rejects.

    // Resolve as soon as the TCP port accepts (success) or the process exits
    // (genuine start-phase failure) — never a fixed blind delay.
    const startup = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          clearInterval(probe);
          resolve(value);
        }
      };
      child.once('exit', (code) => finish(code ?? 1));
      const probe = setInterval(() => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.end();
          finish(0);
        });
        socket.on('error', () => socket.destroy());
      }, 60);
    });

    if (startup !== 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new PhaseError('start', `local test service exited during startup (code ${startup})`);
    }

    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ pid: child.pid, port, dir, dataDir }),
      'utf8'
    );

    return { name: id, host: '127.0.0.1', port, pid: child.pid, dir };
  },

  async isReady(target) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: target.host, port: target.port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(1500, () => {
        socket.destroy();
        resolve(false);
      });
    });
  },

  async stop(id) {
    const dir = path.join(ROOT, id);
    const stateFile = path.join(dir, 'state.json');

    // Always really terminate the service process first (a stop failure is about
    // data cleanup, not a lingering process).
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.pid) {
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }

    if (process.env.E2E_LOCAL_STOP_FAIL === '1') {
      // Genuine OS denial: make the directory non-writable so recursive removal
      // fails with EPERM (unlinking state.json/data needs write on this dir).
      try {
        fs.chmodSync(dir, 0o555);
      } catch {
        /* best effort */
      }
      let removed = false;
      try {
        fs.rmSync(dir, { recursive: true, force: false });
        removed = true;
      } catch (error) {
        throw new PhaseError('teardown', `failed to remove local data dir ${dir}`, error);
      }
      // Root bypasses permission denial; still report a real teardown failure so
      // the lifecycle contract (non-zero independent status) cannot silently pass.
      if (removed) {
        throw new PhaseError('teardown', `forced teardown failure was not enforced for ${id} (running as root?)`);
      }
      return;
    }

    fs.rmSync(dir, { recursive: true, force: true });
  },

  async exists(id) {
    return fs.existsSync(path.join(ROOT, id, 'state.json'));
  }
};

module.exports = { localDriver, PhaseError, ROOT };
