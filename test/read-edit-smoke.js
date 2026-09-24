// Smoke tests for the /api/read-or-edit-file handler hardening:
// - GET must be a pure read: no token minting, no syntax check, no
//   beautification, no writes of any kind (even for .js paths).
// - Symlinks inside the workspace that resolve outside it are rejected
//   for both reads (GET) and writes (POST).
// - validateConfig rejects the documented placeholder secrets.
process.env.MAX_EDIT_FILE_BYTES = '4096';
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

    // --- 5. File creation is explicit and never left behind by a failed edit ---
    const createRes = mockRes();
    await handler({ method: 'POST', body: { filePath: 'created.txt', replacements: [{ originalText: '', replacementText: 'hello\n' }] }, query: {} }, createRes);
    assert(createRes.statusCode === null && fs.readFileSync(path.join(workDir, 'created.txt'), 'utf8') === 'hello\n', 'POST with an empty originalText creates a new file');

    const failedCreate = mockRes();
    await handler({ method: 'POST', body: { filePath: 'never.txt', replacements: [{ originalText: 'missing', replacementText: 'x' }] }, query: {} }, failedCreate);
    assert(failedCreate.statusCode === 400, 'failed edit on a missing file is rejected', `got ${failedCreate.statusCode}`);
    assert(!fs.existsSync(path.join(workDir, 'never.txt')), 'failed edit on a missing file does not leave an empty file');

    const badJs = mockRes();
    await handler({ method: 'POST', body: { filePath: 'broken.js', replacements: [{ originalText: '', replacementText: 'const = ;\n' }] }, query: {} }, badJs);
    assert(badJs.statusCode === 400 && !fs.existsSync(path.join(workDir, 'broken.js')), 'a new .js file with syntax errors is not kept');

    const missingRead = mockRes();
    await handler({ method: 'POST', body: { filePath: 'absent.txt' }, query: {} }, missingRead);
    assert(missingRead.statusCode === 500 && !fs.existsSync(path.join(workDir, 'absent.txt')), 'a read of a missing file does not create it');

    // --- 6. Client errors keep the message but never include a stack trace ---
    const hintRes = mockRes();
    await handler({ method: 'POST', body: { filePath: 'notes.txt', mergeText: 'no conflict blocks here' }, query: {} }, hintRes);
    const clientError = JSON.parse(hintRes.body.error);
    assert(hintRes.statusCode === 500 && /no conflict blocks were found/.test(clientError.message), 'error response keeps the actionable message');
    assert(!('stack' in clientError), 'error response does not include a stack trace');

    // --- 7. Limits on edit requests ------------------------------------------
    const bigFile = path.join(workDir, 'big.txt');
    fs.writeFileSync(bigFile, 'b'.repeat(5000));
    const bigEdit = mockRes();
    await handler({ method: 'POST', body: { filePath: 'big.txt', replacements: [{ originalText: 'b', replacementText: 'c' }] }, query: {} }, bigEdit);
    assert(bigEdit.statusCode === 413 && fs.readFileSync(bigFile, 'utf8') === 'b'.repeat(5000), 'editing a file above MAX_EDIT_FILE_BYTES is refused', String(bigEdit.statusCode));
    const bigRead = mockRes();
    await handler({ method: 'GET', query: { filePath: 'big.txt' }, body: {} }, bigRead);
    assert(bigRead.statusCode === 413, 'reading a file above MAX_EDIT_FILE_BYTES is refused');
    const tooMany = mockRes();
    await handler({ method: 'POST', body: { filePath: 'notes.txt', replacements: Array.from({ length: 51 }, () => ({ originalText: 'a', replacementText: 'b' })) }, query: {} }, tooMany);
    assert(tooMany.statusCode === 400 && /Too many replacements/.test(tooMany.body.error), 'more than MAX_REPLACEMENTS replacements are refused');
    const notArray = mockRes();
    await handler({ method: 'POST', body: { filePath: 'notes.txt', replacements: { originalText: 'a' } }, query: {} }, notArray);
    assert(notArray.statusCode === 400 && /must be an array/.test(notArray.body.error), 'replacements must be an array');

    // --- 8. JavaScript formatting never changes behavior or drops a BOM ---------
    const asiFile = path.join(workDir, 'asi.js');
    const asiSource = 'function f() {\n  return\n  { a: 1 }\n}\nconst  x =1;\n';
    fs.writeFileSync(asiFile, asiSource);
    const asiEdit = mockRes();
    await handler({ method: 'POST', body: { filePath: 'asi.js', replacements: [{ originalText: 'const  x =1;', replacementText: 'const  x =2;' }] }, query: {} }, asiEdit);
    assert(asiEdit.statusCode === null && fs.readFileSync(asiFile, 'utf8').includes('return\n  { a: 1 }'), 'a file with an ASI hazard is not reformatted', fs.readFileSync(asiFile, 'utf8'));
    const bomFile = path.join(workDir, 'bom.mjs');
    fs.writeFileSync(bomFile, '\uFEFFexport const  y =1;\n');
    const bomEdit = mockRes();
    await handler({ method: 'POST', body: { filePath: 'bom.mjs', replacements: [{ originalText: 'y =1', replacementText: 'y =2' }] }, query: {} }, bomEdit);
    const bomAfter = fs.readFileSync(bomFile, 'utf8');
    assert(bomEdit.statusCode === null && bomAfter.charCodeAt(0) === 0xFEFF && bomAfter.includes('export const y = 2;'), '.mjs files are checked and formatted, keeping the BOM', JSON.stringify(bomAfter));
    const badMjs = mockRes();
    await handler({ method: 'POST', body: { filePath: 'bom.mjs', replacements: [{ originalText: 'y = 2', replacementText: 'y = ' }] }, query: {} }, badMjs);
    assert(badMjs.statusCode === 400 && fs.readFileSync(bomFile, 'utf8') === bomAfter, 'an .mjs edit with a syntax error is reverted');
    const tsFile = path.join(workDir, 'typed.ts');
    fs.writeFileSync(tsFile, 'export const n: number = 1;\n');
    const tsEdit = mockRes();
    await handler({ method: 'POST', body: { filePath: 'typed.ts', replacements: [{ originalText: '= 1', replacementText: '= 2' }] }, query: {} }, tsEdit);
    assert(tsEdit.statusCode === null && fs.readFileSync(tsFile, 'utf8') === 'export const n: number = 2;\n', 'TypeScript files are edited without a JavaScript syntax check');
    const scriptFile = path.join(workDir, 'legacy.js');
    fs.writeFileSync(scriptFile, 'with (Math) { var r = max(1, 2); }\n');
    const scriptEdit = mockRes();
    await handler({ method: 'POST', body: { filePath: 'legacy.js', replacements: [{ originalText: 'max(1, 2)', replacementText: 'max(1, 3)' }] }, query: {} }, scriptEdit);
    assert(scriptEdit.statusCode === null, 'classic scripts that are invalid as modules are accepted', String(scriptEdit.body).slice(0, 200));

    // --- 9. One share link per successful edit; failed edits keep the old one --
    const linkFile = path.join(workDir, 'link.txt');
    fs.writeFileSync(linkFile, 'one\n');
    const linked = mockRes();
    await handler({ method: 'POST', body: { filePath: 'link.txt', replacements: [{ originalText: 'one', replacementText: 'two' }] }, query: {} }, linked);
    const urls = String(linked.body).match(/\/access\/[a-f0-9]+/g) || [];
    assert(urls.length === 2 && urls[0] === urls[1], 'file url and diff url share one token', JSON.stringify(urls));
    const failed = mockRes();
    await handler({ method: 'POST', body: { filePath: 'link.txt', replacements: [{ originalText: 'missing', replacementText: 'x' }] }, query: {} }, failed);
    const liveTokens = JSON.parse(fs.readFileSync(tokenStorePath, 'utf8'));
    assert(failed.statusCode === 400 && Object.keys(liveTokens).includes(urls[0].split('/access/')[1]), 'a failed edit does not revoke the existing share link');

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
