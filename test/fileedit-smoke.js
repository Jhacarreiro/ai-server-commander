const fs = require('fs');
const path = require('path');
const readEditTextFileHandler = require('../api/readEditTextFile2Handler');

const root = path.resolve(__dirname, '..');
const tokenStorePath = path.join(root, 'tokenStore.json');
const tokenBackupPath = path.join(root, 'tokenStore.json.test-backup');
const scratch = path.join(root, '.tmp-fileedit-smoke');
const handler = readEditTextFileHandler(() => 'http://127.0.0.1:9');

function assert(condition, label, details = '') {
    if (!condition) throw new Error(`${label}${details ? ': ' + details : ''}`);
    console.log(`PASS ${label}`);
}

function backupTokenStore() {
    if (fs.existsSync(tokenStorePath)) fs.copyFileSync(tokenStorePath, tokenBackupPath);
}

function restoreTokenStore() {
    if (fs.existsSync(tokenBackupPath)) {
        fs.copyFileSync(tokenBackupPath, tokenStorePath);
        fs.unlinkSync(tokenBackupPath);
    } else if (fs.existsSync(tokenStorePath)) {
        fs.unlinkSync(tokenStorePath);
    }
}

function mockRes() {
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    return {
        statusCode: 200,
        sent: undefined,
        body: undefined,
        done,
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(payload) {
            this.sent = payload;
            settle(this);
            return this;
        },
        json(payload) {
            this.body = payload;
            settle(this);
            return this;
        },
        type() {
            return this;
        }
    };
}

function errorText(res) {
    if (res.sent !== undefined) return String(res.sent);
    return typeof res.body === 'string' ? res.body : JSON.stringify(res.body || {});
}

async function edit(filePath, replacements) {
    const res = mockRes();
    await handler({
        method: 'POST',
        query: {},
        body: { filePath, replacements }
    }, res);
    await res.done;
    return res;
}

(async () => {
    backupTokenStore();
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const missing = path.join(scratch, 'does-not-exist.txt');
        const missingRes = await edit(missing, [
            { originalText: 'search-me', replacementText: 'replacement' }
        ]);
        assert(missingRes.statusCode === 400, 'missing file without empty originalText is HTTP 400', String(missingRes.statusCode));
        assert(errorText(missingRes).includes('empty originalText'), 'missing-file 400 names the empty originalText rule', errorText(missingRes).slice(0, 240));
        assert(!fs.existsSync(missing), 'missing file without create replacement is not created');

        for (const [label, originalText] of [
            ['omitted', undefined],
            ['null', null],
            ['false', false],
            ['zero', 0],
            ['empty-array', []]
        ]) {
            const target = path.join(scratch, `not-a-create-${label}.txt`);
            const payload = originalText === undefined
                ? [{ replacementText: 'created-by-truthy-guard' }]
                : [{ originalText, replacementText: 'created-by-truthy-guard' }];
            const res = await edit(target, payload);
            assert(res.statusCode === 400, `${label} originalText does not authorize create`, String(res.statusCode));
            assert(!fs.existsSync(target), `${label} originalText does not leave a new file`);
        }

        const created = path.join(scratch, 'created.txt');
        const createRes = await edit(created, [
            { originalText: '', replacementText: 'hello-from-create\n' }
        ]);
        assert(createRes.statusCode === 200, 'literal empty originalText creates the file', String(createRes.statusCode));
        assert(fs.readFileSync(created, 'utf8') === 'hello-from-create\n', 'created file contains replacement text');

        const partial = path.join(scratch, 'partial-create.txt');
        const partialRes = await edit(partial, [
            { originalText: '', replacementText: 'first-line\n' },
            { originalText: 'does-not-exist', replacementText: 'second-line\n' }
        ]);
        assert(partialRes.statusCode === 400, 'failed follow-up replacement is HTTP 400', String(partialRes.statusCode));
        assert(errorText(partialRes).includes('Created file removed'), 'rollback message says the created file was removed', errorText(partialRes).slice(0, 300));
        assert(!fs.existsSync(partial), 'failed create is unlinked instead of leaving empty original content');

        const existing = path.join(scratch, 'existing.txt');
        fs.writeFileSync(existing, 'keep-this\n', 'utf8');
        const existingFail = await edit(existing, [
            { originalText: 'missing-token', replacementText: 'nope' }
        ]);
        assert(existingFail.statusCode === 400, 'failed edit of existing file is HTTP 400', String(existingFail.statusCode));
        assert(fs.readFileSync(existing, 'utf8') === 'keep-this\n', 'failed edit leaves the existing file unchanged');

        const mixedNonString = path.join(scratch, 'mixed-nonstring.txt');
        const mixedRes = await edit(mixedNonString, [
            { originalText: '', replacementText: 'created\n' },
            { originalText: 123, replacementText: 'nope' }
        ]);
        assert(mixedRes.statusCode === 400, 'non-string originalText in a create batch is HTTP 400', String(mixedRes.statusCode));
        assert(!fs.existsSync(mixedNonString), 'non-string originalText does not create a file');

        const existingNonString = await edit(existing, [
            { originalText: 0, replacementText: 'nope' }
        ]);
        assert(existingNonString.statusCode === 400, 'non-string originalText on existing file is HTTP 400', String(existingNonString.statusCode));
        assert(fs.readFileSync(existing, 'utf8') === 'keep-this\n', 'non-string originalText leaves the existing file unchanged');

        const existingOk = await edit(existing, [
            { originalText: 'keep-this', replacementText: 'changed' }
        ]);
        assert(existingOk.statusCode === 200, 'successful edit of existing file is HTTP 200', String(existingOk.statusCode));
        assert(fs.readFileSync(existing, 'utf8') === 'changed\n', 'successful edit updates the existing file');

        const racePath = path.join(scratch, 'vanished-after-exists.txt');
        const originalExistsSync = fs.existsSync;
        fs.existsSync = (candidate) => {
            if (path.resolve(String(candidate)) === path.resolve(racePath)) return true;
            return originalExistsSync(candidate);
        };
        try {
            const raceRes = await edit(racePath, [
                { originalText: 'was-here', replacementText: 'now-here' }
            ]);
            assert(raceRes.statusCode >= 400, 'vanished existing file fails closed', String(raceRes.statusCode));
            assert(!originalExistsSync(racePath), 'vanished existing file is not recreated via a+');
        } finally {
            fs.existsSync = originalExistsSync;
        }

        const badJs = path.join(scratch, 'created-bad.js');
        const badJsRes = await edit(badJs, [
            { originalText: '', replacementText: 'function (' }
        ]);
        assert(badJsRes.statusCode === 400, 'invalid newly created JS is HTTP 400', String(badJsRes.statusCode));
        assert(!fs.existsSync(badJs), 'invalid newly created JS is removed on rollback');
    } finally {
        console.error = originalConsoleError;
        restoreTokenStore();
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
    }
})().catch((err) => {
    restoreTokenStore();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
    console.error(err.stack || err.message);
    process.exit(1);
});
