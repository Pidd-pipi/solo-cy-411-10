/* eslint-disable */
// Real Jest test executed inside the spawned test process. It opens a REAL TCP
// connection to the service the runner started (proving the persistent service
// really is up during the test) and writes a REAL marker file (proving the test
// process genuinely ran) so the lifecycle suite can assert both from outside.
const net = require('net');
const fs = require('fs');
const path = require('path');

test('persistent service is reachable and test process really ran', (done) => {
  expect(process.env.E2E_SERVICE_HOST).toBeTruthy();
  expect(process.env.E2E_SERVICE_PORT).toBeTruthy();
  const socket = net.connect(
    { host: process.env.E2E_SERVICE_HOST, port: Number(process.env.E2E_SERVICE_PORT) },
    () => {
      socket.end();
      const root = process.env.E2E_LOCAL_ROOT;
      if (root) fs.writeFileSync(path.join(root, 'pass-marker'), String(process.pid));
      done();
    }
  );
  socket.on('error', done);
});
