const fs = require('fs');
const path = require('path');

process.env.MAX_ACCESS_FILE_BYTES = '1024';

const { retrieveFile, createToken } = require('../serverModules/fileAccessHandler');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

function mockRes() {
    return {
        statusCode: 200,
        sent: undefined,
        headers: {},
        status(n) { this.statusCode = n; return this; },
        send(s) { this.sent = s; return this; },
        setHeader(k, v) { this.headers[k] = v; return this; },
    };
}

const tokenStorePath = path.join(__dirname, '..', 'tokenStore.json');
const runtimeDir = path.join(__dirname, '..', 'runtime');

function writeStore(obj) {
    fs.writeFileSync(tokenStorePath, JSON.stringify(obj));
}

function futureExpiry(ms = 10 * 60 * 1000) {
    return new Date(Date.now() + ms).toISOString();
}

(async () => {
    assert(typeof retrieveFile === 'function', 'retrieveFile export exists');
    assert(typeof createToken === 'function', 'createToken export exists');

    let hadStore = false;
    let originalStore;
    if (fs.existsSync(tokenStorePath)) {
        hadStore = true;
        originalStore = fs.readFileSync(tokenStorePath);
    }

    fs.mkdirSync(runtimeDir, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(runtimeDir, 'accessfile-'));

    try {
        const smallPath = path.join(scratch, 'small.txt');
        const smallContent = 'hello-access-file';
        fs.writeFileSync(smallPath, smallContent);

        const oversizedPath = path.join(scratch, 'oversized.bin');
        fs.writeFileSync(oversizedPath, Buffer.alloc(2048, 0x61));

        // 1. Malformed entries are normalized
        writeStore({
            goodtok: { filePath: smallPath, expiryDate: futureExpiry() },
            badtok: 'just a string',
            bad2: { filePath: 5, expiryDate: futureExpiry() },
            bad3: { filePath: 'x', expiryDate: 'not-a-date' },
        });
        const badRes = mockRes();
        await retrieveFile({ params: { token: 'badtok' }, query: {} }, badRes);
        assert(
            badRes.statusCode === 404 && String(badRes.sent).includes('Token not found'),
            'malformed token dropped as not found',
            JSON.stringify({ statusCode: badRes.statusCode, sent: badRes.sent })
        );
        const goodRes = mockRes();
        await retrieveFile({ params: { token: 'goodtok' }, query: {} }, goodRes);
        assert(
            goodRes.statusCode === 200 && goodRes.sent === smallContent,
            'well-formed token still retrieves file',
            JSON.stringify({ statusCode: goodRes.statusCode, sent: goodRes.sent })
        );

        // 2. Expired token still rejected
        writeStore({
            expired: { filePath: smallPath, expiryDate: new Date(Date.now() - 60 * 1000).toISOString() },
        });
        const expiredRes = mockRes();
        await retrieveFile({ params: { token: 'expired' }, query: {} }, expiredRes);
        assert(
            expiredRes.statusCode === 410 && String(expiredRes.sent).includes('Token has expired.'),
            'expired token rejected with 410',
            JSON.stringify({ statusCode: expiredRes.statusCode, sent: expiredRes.sent })
        );

        // 3. Oversized file rejected with 413
        writeStore({
            bigtok: { filePath: oversizedPath, expiryDate: futureExpiry() },
        });
        const bigRes = mockRes();
        await retrieveFile({ params: { token: 'bigtok' }, query: {} }, bigRes);
        assert(
            bigRes.statusCode === 413 && String(bigRes.sent).includes('MAX_ACCESS_FILE_BYTES'),
            'oversized file rejected with 413',
            JSON.stringify({ statusCode: bigRes.statusCode, sent: bigRes.sent })
        );

        // 4. Diff path on oversized file bounded before materializing
        const bigDiffRes = mockRes();
        await retrieveFile({ params: { token: 'bigtok' }, query: { diff: '1' } }, bigDiffRes);
        assert(
            bigDiffRes.statusCode === 413 && String(bigDiffRes.sent).includes('MAX_ACCESS_FILE_BYTES'),
            'diff path caps oversized file before git diff',
            JSON.stringify({ statusCode: bigDiffRes.statusCode, sent: bigDiffRes.sent })
        );

        // 5. Diff path on a small untracked file
        writeStore({
            difftok: { filePath: smallPath, expiryDate: futureExpiry() },
        });
        const smallDiffRes = mockRes();
        await retrieveFile({ params: { token: 'difftok' }, query: { diff: '1' } }, smallDiffRes);
        assert(
            smallDiffRes.statusCode === 200 && String(smallDiffRes.sent).includes('diff2html'),
            'diff path returns html for small untracked file',
            JSON.stringify({ statusCode: smallDiffRes.statusCode, sent: typeof smallDiffRes.sent })
        );

        // 6. Happy path read
        writeStore({
            happytok: { filePath: smallPath, expiryDate: futureExpiry() },
        });
        const happyRes = mockRes();
        await retrieveFile({ params: { token: 'happytok' }, query: {} }, happyRes);
        assert(
            happyRes.statusCode === 200 &&
                happyRes.sent === smallContent &&
                happyRes.headers['Content-Type'] === 'text/plain',
            'happy path read sets text/plain and returns file content',
            JSON.stringify({ statusCode: happyRes.statusCode, sent: happyRes.sent, headers: happyRes.headers })
        );
    } finally {
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
        if (hadStore) {
            fs.writeFileSync(tokenStorePath, originalStore);
        } else {
            try { fs.rmSync(tokenStorePath, { force: true }); } catch (_) {}
        }
    }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
