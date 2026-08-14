const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33145);
const token = process.env.TEST_TOKEN || 't'.repeat(64);
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
const tokenStorePath = path.join(root, 'tokenStore.json');
const tokenStoreBackupPath = path.join(root, 'tokenStore.json.test-backup');
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

function backupTokenStore() {
  if (fs.existsSync(tokenStorePath)) fs.copyFileSync(tokenStorePath, tokenStoreBackupPath);
}

function restoreTokenStore() {
  if (fs.existsSync(tokenStoreBackupPath)) {
    fs.copyFileSync(tokenStoreBackupPath, tokenStorePath);
    fs.unlinkSync(tokenStoreBackupPath);
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
      timeout: 12000
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
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
  const logPath = '/tmp/asc-read-edit-smoke.log';
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-readedit-'));
  const siblingDir = workDir + '-sibling';
  const outsideFile = path.join(path.dirname(workDir), `asc-readedit-outside-${path.basename(workDir)}.txt`);
  fs.mkdirSync(siblingDir);
  fs.writeFileSync(outsideFile, 'OUTSIDE_SECRET\n');
  fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'SIBLING_SECRET\n');

  const minifiedJs = 'const a=1;function x(){return 2}';
  fs.writeFileSync(path.join(workDir, 'sample.js'), minifiedJs);
  fs.writeFileSync(path.join(workDir, 'notes.txt'), 'alpha beta gamma\n');

  writeTestConfig();
  backupTokenStore();
  fs.rmSync(logPath, { force: true });
  const out = fs.openSync(logPath, 'a');
  server = spawn('node', ['main.js'], {
    cwd: root,
    env: { ...process.env, HOME: workDir },
    stdio: ['ignore', out, out]
  });
  try {
    await waitForServer(logPath);

    let r = await request('GET', '/api/read-or-edit-file?filePath=sample.js');
    assert(r.status === 200 && r.text === `File content:\n${minifiedJs}`, 'GET returns file bytes as-is', JSON.stringify({ status: r.status, text: r.text }));
    assert(fs.readFileSync(path.join(workDir, 'sample.js'), 'utf8') === minifiedJs, 'GET does not beautify or rewrite the file');

    r = await request('GET', '/api/read-or-edit-file?filePath=' + encodeURIComponent(`../${path.basename(outsideFile)}`));
    assert(r.status === 400 && r.body && /outside the workspace/i.test(r.body.error || ''), 'GET rejects ../ traversal', JSON.stringify(r.body));
    assert(!String(r.text).includes('OUTSIDE_SECRET'), 'traversal response does not leak outside file bytes');

    r = await request('GET', '/api/read-or-edit-file?filePath=' + encodeURIComponent(path.join(siblingDir, 'secret.txt')));
    assert(r.status === 400 && r.body && /outside the workspace/i.test(r.body.error || ''), 'GET rejects sibling-prefix paths', JSON.stringify(r.body));
    assert(!String(r.text).includes('SIBLING_SECRET'), 'sibling-prefix response does not leak sibling file bytes');

    r = await request('GET', '/api/read-or-edit-file?filePath=notes.txt&filePath=sample.js');
    assert(r.status === 400 && r.body && /filePath is required/i.test(r.body.error || ''), 'GET rejects repeated filePath query values', JSON.stringify({ status: r.status, body: r.body }));

    r = await request('GET', '/api/read-or-edit-file?filePath=missing-file.txt');
    assert(r.status === 404 && r.body && /not found/i.test(r.body.error || ''), 'GET missing file returns 404', JSON.stringify(r.body));

    r = await request('POST', '/api/read-or-edit-file', {
      filePath: 'notes.txt',
      replacements: [{ originalText: 'beta', replacementText: 'delta' }]
    });
    assert(r.status === 200, 'POST edit succeeds', String(r.status));
    const fileUrl = String(r.text).match(/File url: (\S+)/);
    const diffUrl = String(r.text).match(/Changed diff url: (\S+)/);
    assert(fileUrl && diffUrl, 'POST returns both access URLs', r.text);
    assert(fileUrl[1] + '?diff=1' === diffUrl[1], 'POST reuses one token for both URLs', JSON.stringify({ file: fileUrl && fileUrl[1], diff: diffUrl && diffUrl[1] }));
    assert(fs.readFileSync(path.join(workDir, 'notes.txt'), 'utf8') === 'alpha delta gamma\n', 'POST applies the replacement');
  } finally {
    if (server) server.kill('SIGTERM');
    restoreConfig();
    restoreTokenStore();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(siblingDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
})().catch((err) => {
  if (server) server.kill('SIGTERM');
  restoreConfig();
  restoreTokenStore();
  console.error(err.stack || err.message);
  process.exit(1);
});
