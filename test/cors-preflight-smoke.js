const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33102);
const token = process.env.TEST_TOKEN || 't'.repeat(64);
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
let server;

function writeTestConfig() {
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, JSON.stringify({
    port,
    host: '127.0.0.1',
    useLocalTunnel: false,
    productionDomain: `http://localhost:${port}`,
    authToken: token,
    localTunnelSubdomain: null
  }, null, 2) + '\n');
}

function restoreConfig() {
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, configPath);
    fs.unlinkSync(backupPath);
  } else if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

function request(method, pathName, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers,
      timeout: 12000
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(logPath) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('Server running')) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'server log missing');
}

function assert(condition, label, details = '') {
  if (!condition) throw new Error(`${label}${details ? ': ' + details : ''}`);
  console.log(`PASS ${label}`);
}

(async () => {
  const logPath = '/tmp/asc-cors-preflight-smoke.log';
  writeTestConfig();
  fs.rmSync(logPath, { force: true });
  const out = fs.openSync(logPath, 'a');
  server = spawn('node', ['main.js'], { cwd: root, stdio: ['ignore', out, out] });
  try {
    await waitForServer(logPath);

    // Real preflight: answered before auth, no token needed, CORS headers set.
    let r = await request('OPTIONS', '/api/runTerminalScript', {
      Origin: 'https://chat.openai.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, authorization'
    });
    assert(r.status === 204, 'real preflight gets 204', String(r.status));
    assert(r.headers['access-control-allow-origin'] === 'https://chat.openai.com', 'preflight echoes allow-origin');
    assert(String(r.headers['access-control-allow-methods'] || '').includes('POST'), 'preflight lists allow-methods');
    assert(r.headers['access-control-allow-credentials'] === 'true', 'preflight allows credentials');

    r = await request('OPTIONS', '/oauth/token', {
      Origin: 'https://chat.openai.com',
      'Access-Control-Request-Method': 'POST'
    });
    assert(r.status === 204, 'real preflight to OAuth endpoint gets 204', String(r.status));

    // OPTIONS without preflight headers must NOT be swallowed by the middleware:
    // they fall through to auth/Express handling as before the change.
    r = await request('OPTIONS', '/api/runTerminalScript', {});
    assert(r.status !== 204, 'plain OPTIONS is not answered as preflight', String(r.status));

    r = await request('OPTIONS', '/api/runTerminalScript', { Origin: 'https://chat.openai.com' });
    assert(r.status !== 204, 'OPTIONS with Origin only is not answered as preflight', String(r.status));

    r = await request('OPTIONS', '/api/runTerminalScript', { 'Access-Control-Request-Method': 'POST' });
    assert(r.status !== 204, 'OPTIONS with method only is not answered as preflight', String(r.status));

    // Non-OPTIONS traffic is unaffected even with a browser Origin header.
    r = await request('GET', '/api/runTerminalScript?command=printf%20cors_ok', {
      Authorization: `Bearer ${token}`,
      Origin: 'https://chat.openai.com'
    });
    assert(r.status === 200 && r.body && String(r.body.output) === 'cors_ok', 'GET with Origin still executes', String(r.status));
  } finally {
    if (server) server.kill('SIGTERM');
    restoreConfig();
  }
})().catch((err) => {
  if (server) server.kill('SIGTERM');
  restoreConfig();
  console.error(err.stack || err.message);
  process.exit(1);
});
