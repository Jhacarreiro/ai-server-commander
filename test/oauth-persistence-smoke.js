const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { OAuthStore, hashSecret } = require('../serverModules/oauthStore');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-oauth-'));
const configPath = path.join(temp, 'config.json');
const statePath = path.join(temp, 'oauth-state.json');
const logPath = path.join(temp, 'server.log');
const port = 33104;
const authToken = 'a'.repeat(64);
const mcpToken = 'b'.repeat(64);
let server = null;

fs.writeFileSync(configPath, JSON.stringify({
    port,
    useLocalTunnel: false,
    productionDomain: `http://127.0.0.1:${port}`,
    authToken,
    mcpToken
}, null, 2));

function request(method, requestPath, { body, form, token } = {}) {
    return new Promise((resolve, reject) => {
        let payload = null;
        let contentType = null;
        if (form) {
            payload = new URLSearchParams(form).toString();
            contentType = 'application/x-www-form-urlencoded';
        } else if (typeof body !== 'undefined') {
            payload = JSON.stringify(body);
            contentType = 'application/json';
        }
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(payload ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) } : {})
            },
            timeout: 8000
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let parsed = text;
                try { parsed = JSON.parse(text); } catch (_) {}
                resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function waitForServer() {
    const started = Date.now();
    while (Date.now() - started < 10000) {
        try {
            const response = await request('GET', '/openapi.json');
            if (response.status === 200) return;
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'server did not start');
}

async function startServer() {
    const output = fs.openSync(logPath, 'a');
    server = spawn(process.execPath, ['main.js'], {
        cwd: root,
        env: {
            ...process.env,
            CONFIG_FILE_PATH: configPath,
            OAUTH_STATE_PATH: statePath,
            SAFE_MODE: 'true'
        },
        stdio: ['ignore', output, output]
    });
    await waitForServer();
}

async function stopServer() {
    if (!server) return;
    const child = server;
    server = null;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
}

function pkceChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function readState(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertHashedRecord(section, rawValue, present, label) {
    const hashed = hashSecret(rawValue);
    const record = section[hashed];
    if (present) assert.ok(record, label);
    else assert.strictEqual(record, undefined, label);
}

function runChildStoreScript(statePath, source) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', source], {
            cwd: root,
            env: { ...process.env, OAUTH_STATE_PATH: statePath },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`child store script exited ${code}: ${stderr || stdout}`));
        });
    });
}

(async () => {
    const corruptPath = path.join(temp, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{not-json', { mode: 0o600 });
    assert.throws(() => new OAuthStore(corruptPath), /Unable to read OAuth state/);
    console.log('PASS corrupt OAuth state fails closed');

    const expiryDir = path.join(temp, 'expiry-read');
    fs.mkdirSync(expiryDir, { recursive: true });
    for (const kind of ['authCodes', 'accessTokens', 'refreshTokens']) {
        let now = 1_000;
        const filePath = path.join(expiryDir, `${kind}.json`);
        const store = new OAuthStore(filePath, () => now);
        const live = `${kind}-live`;
        const expired = `${kind}-expired`;
        const liveRecord = { client_id: 'expiry-client', expires_at: 5_000 };
        const expiredRecord = { client_id: 'expiry-client', expires_at: 1_500 };
        if (kind === 'authCodes') {
            store.setAuthCode(live, liveRecord);
            store.setAuthCode(expired, expiredRecord);
            now = 2_000;
            assert.strictEqual(store.getAuthCode(expired), null);
            assert.ok(store.getAuthCode(live));
        } else if (kind === 'accessTokens') {
            store.setAccessToken(live, liveRecord);
            store.setAccessToken(expired, expiredRecord);
            now = 2_000;
            assert.strictEqual(store.getAccessToken(expired), null);
            assert.ok(store.getAccessToken(live));
        } else {
            store.setRefreshToken(live, liveRecord);
            store.setRefreshToken(expired, expiredRecord);
            now = 2_000;
            assert.strictEqual(store.getRefreshToken(expired), null);
            assert.ok(store.getRefreshToken(live));
        }
        const persisted = readState(filePath);
        assertHashedRecord(persisted[kind], expired, false, `${kind} expired hash removed from disk`);
        assertHashedRecord(persisted[kind], live, true, `${kind} live hash remains on disk`);
        assert.ok(!JSON.stringify(persisted).includes(expired), `${kind} raw expired value is not persisted`);
        assert.ok(!JSON.stringify(persisted).includes(live), `${kind} raw live value is not persisted`);
        console.log(`PASS expired ${kind} removed from disk after getter`);
    }

    const sharedPath = path.join(temp, 'shared-oauth-state.json');
    let sharedNow = 10_000;
    const writer = new OAuthStore(sharedPath, () => sharedNow);
    writer.setAccessToken('keep-access', { client_id: 'shared-client', expires_at: 80_000 });
    writer.setAccessToken('revoke-access', { client_id: 'shared-client', expires_at: 80_000 });
    writer.setRefreshToken('keep-refresh', { client_id: 'shared-client', expires_at: 80_000 });
    writer.setRefreshToken('rotate-old', { client_id: 'shared-client', expires_at: 80_000 });
    writer.setAuthCode('soon-expired-code', { client_id: 'shared-client', expires_at: 10_500 });

    const stale = new OAuthStore(sharedPath, () => sharedNow);
    writer.revokeToken('revoke-access', 'shared-client');
    writer.rotateRefreshToken(
        'rotate-old',
        'rotated-access',
        { client_id: 'shared-client', expires_at: 80_000 },
        'rotate-new',
        { client_id: 'shared-client', expires_at: 80_000 }
    );
    writer.setAccessToken('writer-new-access', { client_id: 'shared-client', expires_at: 80_000 });

    sharedNow = 11_000;
    assert.strictEqual(stale.getAuthCode('soon-expired-code'), null);

    const afterStaleRead = readState(sharedPath);
    assertHashedRecord(afterStaleRead.accessTokens, 'revoke-access', false, 'revoked access stays deleted after stale prune');
    assertHashedRecord(afterStaleRead.refreshTokens, 'rotate-old', false, 'rotated-away refresh stays deleted after stale prune');
    assertHashedRecord(afterStaleRead.accessTokens, 'keep-access', true, 'unrelated access survives stale prune');
    assertHashedRecord(afterStaleRead.refreshTokens, 'keep-refresh', true, 'unrelated refresh survives stale prune');
    assertHashedRecord(afterStaleRead.accessTokens, 'writer-new-access', true, 'newer access from other instance survives stale prune');
    assertHashedRecord(afterStaleRead.refreshTokens, 'rotate-new', true, 'rotated-in refresh survives stale prune');
    assert.strictEqual(stale.getAccessToken('revoke-access'), null);
    assert.strictEqual(stale.getRefreshToken('rotate-old'), null);
    assert.ok(stale.getAccessToken('writer-new-access'));
    assert.ok(stale.getRefreshToken('rotate-new'));
    console.log('PASS stale read-prune does not restore revoked or rotated tokens');
    console.log('PASS newer tokens from the other instance survive stale read-prune');

    const racePath = path.join(temp, 'race-oauth-state.json');
    const storeModule = path.join(root, 'serverModules', 'oauthStore.js');
    const childScript = (rawToken) => `
        const { OAuthStore } = require(${JSON.stringify(storeModule)});
        const store = new OAuthStore(${JSON.stringify(racePath)});
        store.setAccessToken(${JSON.stringify(rawToken)}, {
            client_id: 'race-client',
            expires_at: Date.now() + 60_000
        });
        process.stdout.write('wrote');
    `;
    await Promise.all([
        runChildStoreScript(racePath, childScript('race-token-a')),
        runChildStoreScript(racePath, childScript('race-token-b'))
    ]);
    const raced = readState(racePath);
    assertHashedRecord(raced.accessTokens, 'race-token-a', true, 'concurrent writer A token survived');
    assertHashedRecord(raced.accessTokens, 'race-token-b', true, 'concurrent writer B token survived');
    assert.ok(!JSON.stringify(raced).includes('race-token-a'));
    assert.ok(!JSON.stringify(raced).includes('race-token-b'));
    console.log('PASS concurrent writers keep both new tokens');

    await startServer();

    let response = await request('POST', '/oauth/register', {
        body: {
            redirect_uris: ['http://localhost.evil.example/callback'],
            client_name: 'Invalid redirect client'
        }
    });
    assert.strictEqual(response.status, 400, response.text);
    assert.strictEqual(response.body.error, 'invalid_redirect_uri');
    console.log('PASS deceptive localhost redirect URI is rejected');

    response = await request('POST', '/oauth/register', {
        body: {
            redirect_uris: ['http://127.0.0.1/callback'],
            token_endpoint_auth_method: 'client_secret_post',
            client_name: 'Persistence smoke client',
            scope: 'terminal'
        }
    });
    assert.strictEqual(response.status, 201, response.text);
    const clientId = response.body.client_id;
    const clientSecret = response.body.client_secret;
    assert.ok(clientId && clientSecret);
    console.log('PASS confidential OAuth client registered');

    let persisted = fs.readFileSync(statePath, 'utf8');
    assert.ok(!persisted.includes(clientSecret));
    assert.ok(persisted.includes('client_secret_hash'));
    assert.strictEqual(fs.statSync(statePath).mode & 0o777, 0o600);
    console.log('PASS client secret is hashed and state file is mode 600');

    response = await request('POST', '/oauth/register', {
        body: {
            redirect_uris: ['http://localhost/public-callback'],
            client_name: 'Public connector smoke client',
            scope: 'terminal'
        }
    });
    assert.strictEqual(response.status, 201, response.text);
    assert.strictEqual(response.body.token_endpoint_auth_method, 'none');
    assert.strictEqual(typeof response.body.client_secret, 'undefined');
    const publicClientId = response.body.client_id;
    const publicVerifier = crypto.randomBytes(32).toString('base64url');
    const publicRedirect = 'http://localhost/public-callback';
    response = await request('POST', '/oauth/authorize', {
        form: {
            client_id: publicClientId,
            redirect_uri: publicRedirect,
            response_type: 'code',
            code_challenge: pkceChallenge(publicVerifier),
            code_challenge_method: 'S256',
            approval_code: authToken,
            resource: `http://127.0.0.1:${port}/mcp`,
            scope: 'terminal'
        }
    });
    const publicCode = new URL(response.headers.location).searchParams.get('code');
    response = await request('POST', '/oauth/token', {
        body: {
            grant_type: 'authorization_code',
            client_id: publicClientId,
            code: publicCode,
            redirect_uri: publicRedirect,
            code_verifier: publicVerifier
        }
    });
    assert.strictEqual(response.status, 200, response.text);
    response = await request('POST', '/mcp', {
        token: response.body.access_token,
        body: { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }
    });
    assert.strictEqual(response.status, 200, response.text);
    console.log('PASS public PKCE client remains compatible without a client secret');

    const verifier = crypto.randomBytes(32).toString('base64url');
    const redirectUri = 'http://127.0.0.1/callback';
    response = await request('POST', '/oauth/authorize', {
        form: {
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            code_challenge: pkceChallenge(verifier),
            code_challenge_method: 'S256',
            approval_code: authToken,
            resource: `http://127.0.0.1:${port}/mcp`,
            scope: 'terminal',
            state: 'smoke-state'
        }
    });
    assert.strictEqual(response.status, 302, response.text);
    const redirect = new URL(response.headers.location);
    const code = redirect.searchParams.get('code');
    assert.ok(code);

    response = await request('POST', '/oauth/token', {
        body: {
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier
        }
    });
    assert.strictEqual(response.status, 200, response.text);
    const firstAccess = response.body.access_token;
    const firstRefresh = response.body.refresh_token;
    assert.ok(firstAccess && firstRefresh);

    persisted = fs.readFileSync(statePath, 'utf8');
    assert.ok(!persisted.includes(code));
    assert.ok(!persisted.includes(firstAccess));
    assert.ok(!persisted.includes(firstRefresh));
    console.log('PASS authorization code and tokens persist only as hashes');

    response = await request('POST', '/mcp', {
        token: firstAccess,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    });
    assert.strictEqual(response.status, 200, response.text);
    console.log('PASS access token authorizes MCP before restart');

    await stopServer();
    await startServer();

    response = await request('POST', '/mcp', {
        token: firstAccess,
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    });
    assert.strictEqual(response.status, 200, response.text);
    console.log('PASS access token survives server restart');

    response = await request('POST', '/oauth/token', {
        body: {
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: firstRefresh
        }
    });
    assert.strictEqual(response.status, 200, response.text);
    const secondAccess = response.body.access_token;
    const secondRefresh = response.body.refresh_token;
    assert.ok(secondAccess && secondRefresh && secondRefresh !== firstRefresh);
    console.log('PASS refresh token survives restart and rotates');

    response = await request('POST', '/oauth/token', {
        body: {
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: firstRefresh
        }
    });
    assert.strictEqual(response.status, 400, response.text);
    assert.strictEqual(response.body.error, 'invalid_grant');
    console.log('PASS rotated refresh token cannot be reused');

    response = await request('POST', '/oauth/revoke', {
        body: { client_id: clientId, client_secret: clientSecret, token: secondAccess }
    });
    assert.strictEqual(response.status, 200, response.text);
    response = await request('POST', '/mcp', {
        token: secondAccess,
        body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }
    });
    assert.strictEqual(response.status, 401, response.text);
    console.log('PASS access-token revocation is enforced');

    response = await request('POST', '/oauth/revoke', {
        body: { client_id: clientId, client_secret: clientSecret, token: secondRefresh }
    });
    assert.strictEqual(response.status, 200, response.text);
    response = await request('POST', '/oauth/token', {
        body: {
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: secondRefresh
        }
    });
    assert.strictEqual(response.status, 400, response.text);
    console.log('PASS refresh-token revocation is enforced');

    await stopServer();
    fs.rmSync(temp, { recursive: true, force: true });
})().catch(async (error) => {
    await stopServer();
    console.error(error.stack || error.message);
    console.error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '');
    fs.rmSync(temp, { recursive: true, force: true });
    process.exit(1);
});
