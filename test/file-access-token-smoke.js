const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToken, retrieveFile } = require('../serverModules/fileAccessHandler');

const root = path.resolve(__dirname, '..');
const tokenStorePath = path.join(root, 'tokenStore.json');
const backupPath = path.join(root, 'tokenStore.json.test-backup');
const baseUrl = 'http://127.0.0.1:33142';

function assert(condition, label, details = '') {
    if (!condition) throw new Error(`${label}${details ? ': ' + details : ''}`);
    console.log(`PASS ${label}`);
}

function backupTokenStore() {
    if (fs.existsSync(tokenStorePath)) fs.copyFileSync(tokenStorePath, backupPath);
}

function restoreTokenStore() {
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, tokenStorePath);
        fs.unlinkSync(backupPath);
    } else if (fs.existsSync(tokenStorePath)) {
        fs.unlinkSync(tokenStorePath);
    }
}

function readStore() {
    if (!fs.existsSync(tokenStorePath)) return {};
    return JSON.parse(fs.readFileSync(tokenStorePath, 'utf8'));
}

function writeStore(store) {
    fs.writeFileSync(tokenStorePath, JSON.stringify(store, null, 2), 'utf8');
}

function tokenFromUrl(url) {
    const match = String(url).match(/\/access\/([a-f0-9]+)(?:\?|$)/);
    if (!match) throw new Error('no access token in URL: ' + url);
    return match[1];
}

function futureDate(ms = 600000) {
    return new Date(Date.now() + ms).toISOString();
}

function pastDate(ms = 60000) {
    return new Date(Date.now() - ms).toISOString();
}

function mockRes() {
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    return {
        statusCode: 200,
        sent: undefined,
        headers: {},
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
        setHeader(key, value) {
            this.headers[key] = value;
            return this;
        }
    };
}

async function retrieve(token, query = {}) {
    const res = mockRes();
    await retrieveFile({ params: { token }, query }, res);
    await res.done;
    return res;
}

(async () => {
    backupTokenStore();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-fileaccess-'));
    const filePath = path.join(scratch, 'sample.txt');
    const otherPath = path.join(scratch, 'other.txt');
    fs.writeFileSync(filePath, 'token-body\n', 'utf8');
    fs.writeFileSync(otherPath, 'other-body\n', 'utf8');

    try {
        writeStore({});
        const missing = await retrieve('nosuch');
        assert(missing.statusCode === 404 && String(missing.sent).includes('Token not found'), 'missing token is rejected with 404');

        writeStore({
            invalidexp: { filePath, expiryDate: 'not-a-date' }
        });
        const invalid = await retrieve('invalidexp');
        assert(invalid.statusCode === 410 && String(invalid.sent).includes('Token has expired'), 'invalid expiryDate fails closed with 410');

        writeStore({
            missingexp: { filePath }
        });
        const noExpiry = await retrieve('missingexp');
        assert(noExpiry.statusCode === 410 && String(noExpiry.sent).includes('Token has expired'), 'missing expiryDate fails closed with 410');

        writeStore({
            pastexp: { filePath, expiryDate: pastDate() }
        });
        const past = await retrieve('pastexp');
        assert(past.statusCode === 410 && String(past.sent).includes('Token has expired'), 'past expiryDate is rejected with 410');

        writeStore({
            futureexp: { filePath, expiryDate: futureDate() }
        });
        const future = await retrieve('futureexp');
        assert(future.statusCode === 200 && future.sent === 'token-body\n' && future.headers['Content-Type'] === 'text/plain', 'future expiryDate still serves the file');

        writeStore({
            broken: null
        });
        const broken = await retrieve('broken');
        assert(broken.statusCode === 404, 'null token-store entry is treated as missing');

        writeStore({
            'null-entry': null,
            'string-entry': 'not-an-object',
            'invalid-expiry': { filePath, expiryDate: 'garbage' },
            'missing-expiry': { filePath },
            'past-expiry': { filePath, expiryDate: pastDate() },
            'future-other': { filePath: otherPath, expiryDate: futureDate() }
        });
        let mintedUrl;
        try {
            mintedUrl = createToken(() => baseUrl, filePath);
        } catch (err) {
            throw new Error('createToken threw on malformed store: ' + (err && err.message));
        }
        const mintedToken = tokenFromUrl(mintedUrl);
        const afterMint = readStore();
        assert(mintedUrl === `${baseUrl}/access/${mintedToken}` && /^[a-f0-9]{40}$/.test(mintedToken), 'createToken still mints an access URL when the store has malformed entries');
        assert(Boolean(afterMint[mintedToken]) && afterMint[mintedToken].filePath === filePath, 'minted token is persisted for the requested file');
        assert(!afterMint['null-entry'] && !afterMint['string-entry'] && !afterMint['invalid-expiry'] && !afterMint['missing-expiry'] && !afterMint['past-expiry'], 'createToken cleanup drops invalid, missing, past, and malformed entries');
        assert(Boolean(afterMint['future-other']) && afterMint['future-other'].filePath === otherPath, 'createToken keeps a still-valid token for a different file');

        const redacted = {
            mintedUrl: String(mintedUrl).replace(/\/access\/[a-f0-9]+/, '/access/<redacted>'),
            remaining: Object.fromEntries(Object.entries(afterMint).map(([key, value]) => [
                key === mintedToken ? '<minted>' : key,
                value && typeof value === 'object'
                    ? { filePath: value.filePath === filePath ? '<sample>' : (value.filePath === otherPath ? '<other>' : '<other-path>'), hasExpiry: Boolean(value.expiryDate) }
                    : value
            ]))
        };
        console.log('STORE after mixed malformed createToken (redacted): ' + JSON.stringify(redacted));

        writeStore({
            keepme: { filePath, expiryDate: futureDate() }
        });
        const reusedUrl = createToken(() => baseUrl, filePath);
        assert(reusedUrl === `${baseUrl}/access/keepme`, 'createToken reuses a still-valid future token for the same file');

        writeStore({
            stale: { filePath, expiryDate: pastDate() }
        });
        const replacedUrl = createToken(() => baseUrl, filePath);
        const replacedStore = readStore();
        assert(!String(replacedUrl).includes('/access/stale') && !replacedStore.stale, 'createToken does not reuse a past token');
    } finally {
        restoreTokenStore();
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
    }
})().catch((err) => {
    restoreTokenStore();
    console.error(err.stack || err.message);
    process.exit(1);
});
