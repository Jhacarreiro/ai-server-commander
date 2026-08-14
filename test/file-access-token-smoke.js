const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createToken, retrieveFile } = require('../serverModules/fileAccessHandler');
const readEditTextFileHandler = require('../api/readEditTextFile2Handler');

const root = path.resolve(__dirname, '..');
const tokenStorePath = path.join(root, 'tokenStore.json');
const backupPath = path.join(root, 'tokenStore.json.test-backup');
const port = Number(process.env.TEST_PORT || 33139);
const authToken = process.env.TEST_TOKEN || 't'.repeat(64);
const baseUrl = `http://127.0.0.1:${port}`;
let server;

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

function mockRes() {
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    return {
        statusCode: 200,
        sent: undefined,
        body: undefined,
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
        json(payload) {
            this.body = payload;
            settle(this);
            return this;
        },
        type() {
            return this;
        },
        setHeader(key, value) {
            this.headers[key] = value;
            return this;
        }
    };
}

function request(method, requestPath, { body, token, headers } = {}) {
    return new Promise((resolve, reject) => {
        const payload = typeof body === 'undefined' ? undefined : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(headers || {}),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            },
            timeout: 12000
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
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
        try {
            const response = await request('GET', '/openapi.json');
            if (response.status === 200) return;
        } catch (_) {}
        if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('Server running')) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'server did not start');
}

(async () => {
    backupTokenStore();
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    const scratch = fs.mkdtempSync(path.join(root, 'runtime', 'fileaccess-'));
    const filePath = path.join(scratch, 'sample.txt');
    fs.writeFileSync(filePath, 'before-rotation\n', 'utf8');
    const otherPath = path.join(scratch, 'other.txt');
    fs.writeFileSync(otherPath, 'unrelated\n', 'utf8');
    const configPath = path.join(scratch, 'config.json');
    const logPath = path.join(scratch, 'server.log');
    const editTarget = path.join(scratch, 'edit-target.txt');
    fs.writeFileSync(editTarget, 'alpha\n', 'utf8');

    try {
        writeStore({});
        const firstUrl = createToken(() => baseUrl, filePath);
        const firstToken = tokenFromUrl(firstUrl);
        assert(firstUrl === `${baseUrl}/access/${firstToken}` && /^[a-f0-9]{40}$/.test(firstToken), 'createToken returns a fresh access URL');
        assert(Boolean(readStore()[firstToken]), 'fresh token is persisted');

        const secondUrl = createToken(() => baseUrl, filePath);
        const secondToken = tokenFromUrl(secondUrl);
        const storeAfterRotate = readStore();
        assert(firstToken !== secondToken, 'rotation mints a different token');
        assert(!storeAfterRotate[firstToken], 'rotation revokes the prior token for the same file');
        assert(Boolean(storeAfterRotate[secondToken]), 'rotated token is the only active token for the file');

        const otherUrl = createToken(() => baseUrl, otherPath);
        const otherToken = tokenFromUrl(otherUrl);
        const storeAfterOther = readStore();
        assert(Boolean(storeAfterOther[secondToken]) && Boolean(storeAfterOther[otherToken]), 'tokens for different files stay independent');

        const revokedRes = mockRes();
        await retrieveFile({ params: { token: firstToken }, query: {} }, revokedRes);
        await revokedRes.done;
        assert(revokedRes.statusCode === 404 && String(revokedRes.sent).includes('Token not found'), 'old token is rejected after rotation', JSON.stringify({ status: revokedRes.statusCode, sent: revokedRes.sent }));

        const primaryRes = mockRes();
        await retrieveFile({ params: { token: secondToken }, query: {} }, primaryRes);
        await primaryRes.done;
        assert(primaryRes.statusCode === 200 && primaryRes.sent === 'before-rotation\n' && primaryRes.headers['Content-Type'] === 'text/plain', 'active token serves the primary file', JSON.stringify({ status: primaryRes.statusCode, sent: primaryRes.sent }));

        const diffRes = mockRes();
        await retrieveFile({ params: { token: secondToken }, query: { diff: '1' } }, diffRes);
        await diffRes.done;
        assert(diffRes.statusCode === 200 && String(diffRes.sent).includes('diff2html'), 'active token serves the diff view', JSON.stringify({ status: diffRes.statusCode, sentType: typeof diffRes.sent }));

        writeStore({
            expiredtok: {
                filePath,
                expiryDate: new Date(Date.now() - 60 * 1000).toISOString()
            }
        });
        const expiredRes = mockRes();
        await retrieveFile({ params: { token: 'expiredtok' }, query: {} }, expiredRes);
        await expiredRes.done;
        assert(expiredRes.statusCode === 410 && String(expiredRes.sent).includes('Token has expired'), 'expired token is rejected with 410', JSON.stringify({ status: expiredRes.statusCode, sent: expiredRes.sent }));

        createToken(() => baseUrl, otherPath);
        assert(!readStore().expiredtok, 'createToken drops expired tokens from the store');

        const handler = readEditTextFileHandler(() => baseUrl);
        const editRes = mockRes();
        await handler({
            method: 'POST',
            query: {},
            body: {
                filePath: editTarget,
                replacements: [{ originalText: 'alpha', replacementText: 'beta' }]
            }
        }, editRes);
        await editRes.done;
        const editBody = String(editRes.sent || '');
        const fileUrlMatch = editBody.match(/File url:\s*(\S+)/);
        const diffUrlMatch = editBody.match(/Changed diff url:\s*(\S+)/);
        assert(editRes.statusCode === 200 && fileUrlMatch && diffUrlMatch, 'edit response includes both access URLs', JSON.stringify({ status: editRes.statusCode, body: editBody.slice(0, 240) }));
        const fileUrl = fileUrlMatch[1];
        const diffUrl = diffUrlMatch[1];
        assert(diffUrl === `${fileUrl}?diff=1`, 'edit response derives both URLs from one token', JSON.stringify({ fileUrl, diffUrl }));
        const editToken = tokenFromUrl(fileUrl);
        assert(Boolean(readStore()[editToken]) && Object.keys(readStore()).filter((key) => readStore()[key].filePath === editTarget).length === 1, 'edit response leaves exactly one active token for the file');

        const handlerPrimary = mockRes();
        await retrieveFile({ params: { token: editToken }, query: {} }, handlerPrimary);
        await handlerPrimary.done;
        assert(handlerPrimary.statusCode === 200 && String(handlerPrimary.sent).includes('beta'), 'primary URL from the edit response still works');
        const handlerDiff = mockRes();
        await retrieveFile({ params: { token: editToken }, query: { diff: '1' } }, handlerDiff);
        await handlerDiff.done;
        assert(handlerDiff.statusCode === 200 && String(handlerDiff.sent).includes('diff2html'), 'diff URL from the edit response still works');

        fs.writeFileSync(configPath, JSON.stringify({
            port,
            useLocalTunnel: false,
            productionDomain: baseUrl,
            authToken
        }, null, 2));
        const out = fs.openSync(logPath, 'a');
        server = spawn(process.execPath, ['main.js'], {
            cwd: root,
            env: { ...process.env, CONFIG_FILE_PATH: configPath },
            stdio: ['ignore', out, out]
        });
        await waitForServer(logPath);

        fs.writeFileSync(editTarget, 'live-before\n', 'utf8');
        const live = await request('POST', '/api/read-or-edit-file', {
            token: authToken,
            body: {
                filePath: editTarget,
                replacements: [{ originalText: 'live-before', replacementText: 'live-after' }]
            }
        });
        const liveFileUrl = (String(live.text).match(/File url:\s*(\S+)/) || [])[1];
        const liveDiffUrl = (String(live.text).match(/Changed diff url:\s*(\S+)/) || [])[1];
        assert(live.status === 200 && liveFileUrl && liveDiffUrl, 'live edit response includes both URLs', JSON.stringify({ status: live.status, text: String(live.text).slice(0, 240) }));
        assert(liveDiffUrl === `${liveFileUrl}?diff=1`, 'live edit response reuses one token for both URLs', JSON.stringify({ liveFileUrl, liveDiffUrl }));

        const livePrimary = await request('GET', liveFileUrl.replace(baseUrl, ''));
        const liveDiff = await request('GET', liveDiffUrl.replace(baseUrl, ''));
        assert(livePrimary.status === 200 && livePrimary.text.includes('live-after'), 'live primary URL returns the edited file', JSON.stringify({ status: livePrimary.status, text: livePrimary.text.slice(0, 80) }));
        assert(liveDiff.status === 200 && liveDiff.text.includes('diff2html'), 'live diff URL returns the html diff', JSON.stringify({ status: liveDiff.status }));

        const redacted = String(live.text)
            .replace(/\/access\/[a-f0-9]+/g, '/access/<redacted>')
            .replace(/\nFile content:[\s\S]*$/, '\nFile content: <omitted>');
        console.log('LIVE edit response (redacted):\n' + redacted.trim());
        console.log(`LIVE primary GET ${livePrimary.status} bytes=${Buffer.byteLength(livePrimary.text)}`);
        console.log(`LIVE diff GET ${liveDiff.status} includes=diff2html bytes=${Buffer.byteLength(liveDiff.text)}`);
    } finally {
        if (server) {
            server.kill('SIGTERM');
            await Promise.race([
                new Promise((resolve) => server.once('exit', resolve)),
                new Promise((resolve) => setTimeout(resolve, 3000))
            ]);
        }
        restoreTokenStore();
        try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
    }
})().catch((err) => {
    if (server) server.kill('SIGTERM');
    console.error(err.stack || err.message);
    process.exit(1);
});
