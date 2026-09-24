// Share links from /api/read-or-edit-file: rotation, expiry, store bounds
// and size limits on /access/:token.
process.env.MAX_ACCESS_FILE_BYTES = '1024';
process.env.MAX_TOKEN_STORE_ENTRIES = '16';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToken, retrieveFile } = require('../serverModules/fileAccessHandler');

const tokenStorePath = path.join(__dirname, '..', 'tokenStore.json');
const backup = fs.existsSync(tokenStorePath) ? fs.readFileSync(tokenStorePath) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-tokens-'));

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const tokenOf = (url) => url.split('/access/')[1];
const readStore = () => JSON.parse(fs.readFileSync(tokenStorePath, 'utf8'));
async function fetchToken(token, query = {}) {
    const res = { statusCode: 200, body: undefined, headers: {}, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
    await retrieveFile({ params: { token }, query }, res);
    return res;
}

(async () => {
    try {
        fs.rmSync(tokenStorePath, { force: true });
        const small = path.join(tmp, 'small.txt');
        fs.writeFileSync(small, 'hello');

        const first = tokenOf(createToken(() => 'http://x', small));
        const second = tokenOf(createToken(() => 'http://x', small));
        assert(first !== second, 'each share link gets a new token');
        assert((await fetchToken(first)).statusCode === 404, 'minting a new link revokes the previous one for the same file');
        const ok = await fetchToken(second);
        assert(ok.statusCode === 200 && ok.body === 'hello', 'the current link serves the file');

        const store = readStore();
        store.badExpiry = { filePath: small, expiryDate: 'not a date' };
        store.garbage = 'just a string';
        store.nullEntry = null;
        fs.writeFileSync(tokenStorePath, JSON.stringify(store));
        assert((await fetchToken('badExpiry')).statusCode === 410, 'an unparseable expiry counts as expired');
        assert((await fetchToken('garbage')).statusCode === 404 && (await fetchToken('nullEntry')).statusCode === 404, 'malformed store entries are ignored instead of crashing');
        createToken(() => 'http://x', path.join(tmp, 'other.txt'));
        const cleaned = readStore();
        assert(!('badExpiry' in cleaned) && !('garbage' in cleaned) && !('nullEntry' in cleaned), 'malformed and expired entries are dropped on the next write');

        fs.writeFileSync(tokenStorePath, '{ not json');
        assert((await fetchToken(second)).statusCode === 404, 'an unreadable store fails closed');

        for (let i = 0; i < 40; i++) createToken(() => 'http://x', path.join(tmp, 'f' + i));
        assert(Object.keys(readStore()).length <= 16, 'the token store is capped at MAX_TOKEN_STORE_ENTRIES');

        const big = path.join(tmp, 'big.txt');
        fs.writeFileSync(big, 'a'.repeat(2048));
        assert((await fetchToken(tokenOf(createToken(() => 'http://x', big)))).statusCode === 413, 'files above MAX_ACCESS_FILE_BYTES are refused');
        const diff = await fetchToken(tokenOf(createToken(() => 'http://x', big)), { diff: '1' });
        assert(diff.statusCode === 500 && /too large/.test(diff.body), 'diffs of oversized files are refused before running git', String(diff.body));
        assert((await fetchToken(tokenOf(createToken(() => 'http://x', tmp)))).statusCode === 400, 'a directory is not served');
    } finally {
        if (backup) fs.writeFileSync(tokenStorePath, backup); else fs.rmSync(tokenStorePath, { force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
