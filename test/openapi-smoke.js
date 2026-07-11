const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33099);
const token = process.env.TEST_TOKEN || 'test-token';
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
let server;

function writeTestConfig() {
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, JSON.stringify({ port, useLocalTunnel: false, productionDomain: `http://localhost:${port}`, authToken: token, localTunnelSubdomain: null }, null, 2) + '\n');
}
function restoreConfig() {
  if (fs.existsSync(backupPath)) { fs.copyFileSync(backupPath, configPath); fs.unlinkSync(backupPath); }
  else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}
function get(pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }, (res) => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout'))); req.on('error', reject); req.end();
  });
}
async function waitForServer(logPath) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('Server running')) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}
function assert(cond, label, details='') { if (!cond) throw new Error(label + (details ? ': ' + details : '')); console.log('PASS ' + label); }

(async () => {
  const logPath = '/tmp/asc-openapi-smoke.log';
  writeTestConfig(); fs.rmSync(logPath, { force: true });
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
  } finally {
    if (server) server.kill('SIGTERM');
    restoreConfig();
  }
})().catch((err) => { if (server) server.kill('SIGTERM'); restoreConfig(); console.error(err.stack || err.message); process.exit(1); });
