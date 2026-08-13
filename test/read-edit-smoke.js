// Smoke tests for the /api/read-or-edit-file handler hardening:
// - GET must be a pure read: no token minting, no syntax check, no
//   beautification, no writes of any kind (even for .js paths).
// - Symlinks inside the workspace that resolve outside it are rejected
//   for both reads (GET) and writes (POST).
// - validateConfig rejects the documented placeholder secrets.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tokenStorePath = path.join(root, 'tokenStore.json');

function assert(condition, label, details = '') {
  if (!condition) throw new Error(`${label}${details ? ': ' + details : ''}`);
  console.log(`PASS ${label}`);
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    type() { return res; },
    send(body) { res.body = body; return res; },
    json(body) { res.body = body; return res; }
  };
  return res;
}

(async () => {
  // Point the workspace at a throwaway temp dir BEFORE loading the handler,
  // which captures getCurrentDirectory at require time.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-readedit-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-readedit-out-'));
  // Give configHandler a valid existing config so its module-level load succeeds.
  process.env.CONFIG_FILE_PATH = path.join(workDir, 'config.json');
  fs.writeFileSync(process.env.CONFIG_FILE_PATH, JSON.stringify({
    port: 3000,
    productionDomain: 'http://localhost:3000',
    authToken: 't'.repeat(64)
  }));

  const tokenStoreExisted = fs.existsSync(tokenStorePath);
  const tokenStoreBefore = tokenStoreExisted ? fs.readFileSync(tokenStorePath, 'utf8') : null;

  try {
    const terminal = require('../api/terminal');
    terminal.getCurrentDirectory = () => Promise.resolve(workDir);

    const handlerFactory = require('../api/readEditTextFile2Handler');
    const handler = handlerFactory(() => 'http://127.0.0.1:3000');

    // --- 1. GET on a .js path must not write anything ---------------------
    const jsFile = path.join(workDir, 'sample.js');
    const originalContent = 'const a = 1;\nconst b = 2;\n';
    fs.writeFileSync(jsFile, originalContent);

    const getRes = mockRes();
    await handler({ method: 'GET', query: { filePath: 'sample.js' }, body: {} }, getRes);

    assert(getRes.body === originalContent, 'GET returns the raw file content unchanged');
    assert(getRes.statusCode === null, 'GET succeeds (implicit 200)');
    assert(fs.readFileSync(jsFile, 'utf8') === originalContent, 'GET does not beautify or rewrite the .js file');
    if (tokenStoreExisted) {
      assert(fs.readFileSync(tokenStorePath, 'utf8') === tokenStoreBefore, 'GET leaves the token store unchanged');
    } else {
      assert(!fs.existsSync(tokenStorePath), 'GET does not mint tokens (no tokenStore.json created)');
    }

    // --- 2. Symlink inside the workspace pointing outside must be rejected ---
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret');
    const link = path.join(workDir, 'escape-link');
    fs.symlinkSync(outsideDir, link, 'dir');

    const escapeGet = mockRes();
    await handler({ method: 'GET', query: { filePath: 'escape-link/secret.txt' }, body: {} }, escapeGet);
    assert(escapeGet.statusCode === 400, 'GET rejects a symlink escape outside the workspace', `got ${escapeGet.statusCode}`);

    const escapePost = mockRes();
    await handler({ method: 'POST', body: { filePath: 'escape-link/created.txt', replacements: [{ originalText: 'x', replacementText: 'y' }] }, query: {} }, escapePost);
    assert(escapePost.statusCode === 400, 'POST rejects a symlink escape outside the workspace', `got ${escapePost.statusCode}`);
    assert(!fs.existsSync(path.join(outsideDir, 'created.txt')), 'rejected symlink escape did not write outside the workspace');

    // --- 3. POST edit path stays intact ------------------------------------
    const txtFile = path.join(workDir, 'notes.txt');
    fs.writeFileSync(txtFile, 'const a = 1;\n');
    const postRes = mockRes();
    await handler({ method: 'POST', body: { filePath: 'notes.txt', replacements: [{ originalText: 'const a', replacementText: 'const z' }] }, query: {} }, postRes);
    assert(postRes.statusCode === null, 'POST edit succeeds (implicit 200)');
    assert(fs.readFileSync(txtFile, 'utf8').includes('const z = 1;'), 'POST edit modifies the file as requested');
    assert(String(postRes.body).includes('File url:'), 'POST still mints an access token URL');

    // --- 4. Placeholder secrets must be rejected ---------------------------
    const { validateConfig } = require('../serverModules/configHandler');
    const placeholderTokens = [
      'replace-me',
      'replace-me-too',
      'replace-with-a-long-random-secret',
      'replace-with-a-separate-long-random-secret'
    ];
    for (const placeholder of placeholderTokens) {
      let threw = false;
      try {
        validateConfig({ port: 3000, productionDomain: 'http://localhost:3000', authToken: placeholder });
      } catch (err) { threw = true; }
      assert(threw, `validateConfig rejects the documented authToken placeholder ${placeholder}`);

      threw = false;
      try {
        validateConfig({ port: 3000, productionDomain: 'http://localhost:3000', authToken: 't'.repeat(64), mcpToken: placeholder });
      } catch (err) { threw = true; }
      assert(threw, `validateConfig rejects the documented mcpToken placeholder ${placeholder}`);
    }

    console.log('ALL read-edit smoke tests passed');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    if (!tokenStoreExisted) fs.rmSync(tokenStorePath, { force: true });
  }
})().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
