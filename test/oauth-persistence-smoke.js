const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { OAuthStore } = require('../serverModules/oauthStore');

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

(async () => {
    const corruptPath = path.join(temp, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{not-json', { mode: 0o600 });
    assert.throws(() => new OAuthStore(corruptPath), /Unable to read OAuth state/);
    console.log('PASS corrupt OAuth state fails closed');

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
