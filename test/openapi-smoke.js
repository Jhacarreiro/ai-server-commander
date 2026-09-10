const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33099);
const token = process.env.TEST_TOKEN || 't'.repeat(64);
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
const tokenStorePath = path.join(root, 'tokenStore.json');
const tokenStoreBackup = path.join(root, 'tokenStore.json.test-backup');
let server;
let scratchDir;

function writeTestConfig() {
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, JSON.stringify({ port, useLocalTunnel: false, productionDomain: `http://localhost:${port}`, authToken: token, localTunnelSubdomain: null }, null, 2) + '\n');
}
function restoreConfig() {
  if (fs.existsSync(backupPath)) { fs.copyFileSync(backupPath, configPath); fs.unlinkSync(backupPath); }
  else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}
function backupTokenStore() {
  if (fs.existsSync(tokenStorePath)) fs.copyFileSync(tokenStorePath, tokenStoreBackup);
}
function restoreTokenStore() {
  if (fs.existsSync(tokenStoreBackup)) {
    fs.copyFileSync(tokenStoreBackup, tokenStorePath);
    fs.unlinkSync(tokenStoreBackup);
  } else if (fs.existsSync(tokenStorePath)) {
    fs.unlinkSync(tokenStorePath);
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
      timeout: 10000
    }, (res) => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function get(pathName) { return request('GET', pathName); }
async function waitForServer(logPath) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('Server running')) return;
    try {
      const probe = await get('/openapi.json');
      if (probe.status === 200) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'server did not start');
}
function assert(cond, label, details='') { if (!cond) throw new Error(label + (details ? ': ' + details : '')); console.log('PASS ' + label); }

function assertPlain400Schema(operation, label) {
  const content = (((operation || {}).responses || {})['400'] || {}).content || {};
  const plain = content['text/plain'];
  assert(plain && plain.schema && plain.schema.type === 'string', label + ' 400 schema is text/plain string', JSON.stringify(content));
  assert(!content['application/json'], label + ' 400 does not advertise JSON', JSON.stringify(content));
}

function assertWirePlain400(response, label, snippet) {
  const contentType = String((response.headers && response.headers['content-type']) || '');
  assert(response.status === 400, label + ' returns 400', String(response.status) + ' ' + String(response.body).slice(0, 200));
  assert(/^text\/plain(?:\s*;|$)/i.test(contentType), label + ' Content-Type is text/plain', contentType);
  assert(typeof response.body === 'string' && response.body.includes(snippet), label + ' body is the plain-text error envelope', String(response.body).slice(0, 240));
  let parsed;
  try { parsed = JSON.parse(response.body); } catch (_) { parsed = undefined; }
  assert(!(parsed && typeof parsed === 'object' && parsed.error && Object.keys(parsed).length === 1), label + ' body is not JSON {error}', String(response.body).slice(0, 240));
}

(async () => {
  const logPath = '/tmp/asc-openapi-smoke.log';
  writeTestConfig();
  backupTokenStore();
  fs.rmSync(logPath, { force: true });
  const out = fs.openSync(logPath, 'a');
  server = spawn('node', ['main.js'], { cwd: root, stdio: ['ignore', out, out] });
  try {
    await waitForServer(logPath);
    const r = await get('/openapi.json');
    assert(r.status === 200, '/openapi.json reachable', String(r.status));
    const spec = JSON.parse(r.body);
    const paths = spec.paths || {};
    const packageVersion = require('../package.json').version;
    assert(spec.info.version === packageVersion, 'OpenAPI version matches package', spec.info.version);
    assert(paths['/api/runTerminalScript'] && paths['/api/runTerminalScript'].get && paths['/api/runTerminalScript'].post, 'OpenAPI has GET/POST /api/runTerminalScript');
    assert(paths['/v1/commands/execute'] && paths['/v1/commands/execute'].post, 'OpenAPI has POST /v1/commands/execute');
    assert(spec.components && spec.components.schemas && spec.components.schemas.CommandResponse, 'OpenAPI has command schemas');
    const responseProperties = spec.components.schemas.CommandResponse.properties;
    assert(responseProperties.activityId && responseProperties.interrupted, 'OpenAPI has activity and interruption fields');

    const fileOps = paths['/api/read-or-edit-file'] || {};
    assert(fileOps.get && fileOps.post, 'OpenAPI has GET/POST /api/read-or-edit-file');
    assertPlain400Schema(fileOps.get, 'GET /api/read-or-edit-file');
    assertPlain400Schema(fileOps.post, 'POST /api/read-or-edit-file');

    const currentDir = process.env.HOME || root;
    const scratchBase = root.startsWith(currentDir) ? path.join(root, 'runtime') : currentDir;
    fs.mkdirSync(scratchBase, { recursive: true });
    scratchDir = fs.mkdtempSync(path.join(scratchBase, 'read-or-edit-400-'));
    const missingReplacementFile = path.join(scratchDir, 'target.txt');
    const brokenJsFile = path.join(scratchDir, 'broken.js');
    fs.writeFileSync(missingReplacementFile, 'alpha\n', 'utf8');
    fs.writeFileSync(brokenJsFile, 'const x =\n', 'utf8');

    const post400 = await request('POST', '/api/read-or-edit-file', {
      filePath: missingReplacementFile,
      replacements: [{ originalText: 'this-text-is-not-in-the-file-xyzzy-12345', replacementText: 'beta' }]
    });
    assertWirePlain400(post400, 'POST /api/read-or-edit-file', 'Unsuccessful replacements');

    const get400 = await get('/api/read-or-edit-file?filePath=' + encodeURIComponent(brokenJsFile));
    assertWirePlain400(get400, 'GET /api/read-or-edit-file', 'Issues found in the file');
  } finally {
    if (server) server.kill('SIGTERM');
    restoreConfig();
    restoreTokenStore();
    if (scratchDir) {
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
})().catch((err) => {
  if (server) server.kill('SIGTERM');
  restoreConfig();
  restoreTokenStore();
  if (scratchDir) {
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
  }
  console.error(err.stack || err.message);
  process.exit(1);
});
