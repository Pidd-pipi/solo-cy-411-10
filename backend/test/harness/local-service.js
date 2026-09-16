/* eslint-disable */
/**
 * Real long-lived TCP service used by the LOCAL lifecycle driver.
 *
 * It is a genuine OS process that binds a real port, writes real files into a
 * real data directory and stays alive until signalled — standing in for the
 * persistent datastore so the lifecycle orchestration (start -> ready -> run ->
 * stop) can be exercised without Docker while still using real processes,
 * real connections and real filesystem cleanup. It is never used by the
 * recurrence e2e suite (that one always runs against MySQL).
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.E2E_LOCAL_PORT);
const dataDir = process.env.E2E_LOCAL_DATA_DIR;

if (process.env.E2E_LOCAL_FAIL === 'start') {
  process.stderr.write('local service: forced start failure\n');
  process.exit(2);
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'ready.marker'), new Date().toISOString());

const server = net.createServer((socket) => {
  socket.end('ready\n');
});

server.on('error', (error) => {
  process.stderr.write(`local service: ${error.message}\n`);
  process.exit(3);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`local test service listening on ${port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

// Keep the event loop alive on a real timer (mirrors a running database).
setInterval(() => {}, 1 << 30);
