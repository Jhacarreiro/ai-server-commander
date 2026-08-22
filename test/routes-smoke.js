const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33099);
const token = process.env.TEST_TOKEN || 't'.repeat(64);
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
let server;

function writeTestConfig() {
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, JSON.stringify({
    port,
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

function request(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: 12000
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Like request(), but sends a raw (possibly malformed) JSON body.
function rawRequest(method, pathName, rawBody) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(rawBody !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) } : {})
      },
      timeout: 12000
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (rawBody !== undefined) req.write(rawBody);
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
  const logPath = '/tmp/asc-routes-smoke.log';
  writeTestConfig();
  fs.rmSync(logPath, { force: true });
  const out = fs.openSync(logPath, 'a');
  server = spawn('node', ['main.js'], { cwd: root, stdio: ['ignore', out, out] });
  try {
    await waitForServer(logPath);
    let r = await request('GET', '/api/runTerminalScript?command=printf%20hello_get');
    assert(r.status === 200 && r.body.output === 'hello_get' && r.body.exitCode === 0, 'GET legacy command');

    r = await request('GET', '/api/runTerminalScript?command=pwd&cwd=%2Ftmp&timeoutMs=5000&maxOutputChars=99');
    assert(r.status === 200 && r.body.output === '/tmp' && r.body.maxOutputChars === 99, 'GET options are honored', JSON.stringify(r.body));

    r = await request('POST', '/api/runTerminalScript', { mode: 'inline', command: 'printf hello_post', timeoutMs: 5000 });
    assert(r.status === 200 && r.body.output === 'hello_post' && r.body.mode === 'inline', 'POST inline command');

    r = await request('POST', '/api/runTerminalScript?command=pwd&cwd=%2Ftmp&timeoutMs=5000&maxOutputChars=99');
    assert(r.status === 200 && r.body.output === '/tmp' && r.body.maxOutputChars === 99, 'POST query-only options are honored', JSON.stringify(r.body));

    r = await request('POST', '/api/runTerminalScript?command=pwd&cwd=%2Ftmp&maxOutputChars=99', { command: 'pwd', cwd: root, maxOutputChars: 42 });
    assert(r.status === 200 && r.body.output === root && r.body.maxOutputChars === 42, 'POST body options override query fallbacks', JSON.stringify(r.body));

    r = await request('POST', '/v1/commands/execute', { mode: 'script', script: 'echo line1\necho line2', timeoutMs: 5000 });
    assert(r.status === 200 && r.body.output.includes('line1') && r.body.output.includes('line2') && r.body.mode === 'script', 'POST script command');

    r = await request('POST', '/v1/commands/execute', { mode: 'inline', command: 'exit 42', timeoutMs: 5000 });
    assert(r.status === 200 && r.body.exitCode === 42, 'exit code preserved', JSON.stringify(r.body));

    r = await request('POST', '/v1/commands/execute', { mode: 'inline', command: 'pwd', cwd: '/definitely/missing' });
    assert(r.status === 400, 'invalid cwd is rejected', JSON.stringify(r.body));

    const largeScript = 'printf body_limit_ok\n#' + 'x'.repeat(150000);
    r = await request('POST', '/v1/commands/execute', { mode: 'script', script: largeScript, shell: '/bin/sh', timeoutMs: 5000 });
    assert(r.status === 200 && r.body.output === 'body_limit_ok', 'JSON body limit accepts allowed scripts', JSON.stringify(r.body));

    r = await request('POST', '/v1/commands/execute', { mode: 'inline', command: 'sleep 3', timeoutMs: 500 });
    assert(r.status === 200 && r.body.timedOut === true, 'timeout returns timedOut true', JSON.stringify(r.body));

    // Body-parse error class: malformed JSON is a client (400) error and must
    // carry the specific message, not the generic 500 text.
    r = await rawRequest('POST', '/api/runTerminalScript', '{"mode":"inline","command":');
    assert(r.status === 400 && r.body.error === 'Invalid request body.', 'malformed JSON body returns 400 with Invalid request body', JSON.stringify(r.body));

    // Oversized bodies are rejected as 413 (entity.too.large) before parsing.
    r = await rawRequest('POST', '/v1/commands/execute', '{"script":"' + 'x'.repeat(600000) + '"}');
    assert(r.status === 413 && r.body.error === 'Request body too large.', 'oversized body returns 413 with Request body too large', JSON.stringify(r.body).slice(0, 160));

    const bothFieldsBody = { command: 'printf rest_both_should_not_run', script: 'printf script_both_should_not_run' };
    r = await request('POST', '/v1/commands/execute', bothFieldsBody);
    assert(
      r.status === 400 && r.body && r.body.message === 'Provide either command or script, not both.',
      'POST rejects both command and script',
      JSON.stringify(r.body)
    );
    console.log('LIVE REST both-fields POST /v1/commands/execute\n' + JSON.stringify({
      request: bothFieldsBody,
      status: r.status,
      body: r.body
    }, null, 2));
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
