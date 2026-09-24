const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-oauth-limits-'));
process.env.OAUTH_STATE_PATH = path.join(tmp, 'oauth-state.json');
process.env.MAX_OAUTH_CLIENTS = '2';
process.env.MAX_CLIENT_NAME_CHARS = '8';

const express = require('express');
const { addOAuthRoutes } = require('../api/oauth');
const { getOAuthStore } = require('../serverModules/oauthStore');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

function post(port, pathName, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path: pathName, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const registration = (name) => ({ redirect_uris: ['https://client.example/callback'], client_name: name, scope: 'terminal' });

(async () => {
    const app = express();
    app.use(express.json());
    const config = { productionDomain: 'http://127.0.0.1', authToken: 't'.repeat(64) };
    addOAuthRoutes(app, config);
    const store = getOAuthStore(config);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;

    try {
        const first = await post(port, '/oauth/register', registration('first-client-name'));
        assert(first.status === 201, 'registration succeeds under the cap', JSON.stringify(first.body));
        assert(first.headers['cache-control'] === 'no-store', 'registration response is not cacheable', first.headers['cache-control']);
        assert(first.body.client_name === 'first-cl', 'client_name is truncated to MAX_CLIENT_NAME_CHARS', first.body.client_name);

        const second = await post(port, '/oauth/register', registration('second'));
        assert(second.status === 201, 'second registration fills the cap');

        // Both clients are idle (no codes or tokens): the oldest one makes room.
        store.data.clients[first.body.client_id].client_id_issued_at -= 10;
        const third = await post(port, '/oauth/register', registration('third'));
        assert(third.status === 201 && store.getClientCount() === 2, 'an idle client is evicted instead of rejecting', JSON.stringify(third.body));
        assert(!store.getClient(first.body.client_id), 'the oldest idle client is the one evicted');

        const grant = { client_id: '', resource: 'http://127.0.0.1/mcp', scope: 'terminal', expires_at: Date.now() + 60000 };
        store.setAccessToken('token-second', { ...grant, client_id: second.body.client_id });
        store.setAccessToken('token-third', { ...grant, client_id: third.body.client_id });
        const rejected = await post(port, '/oauth/register', registration('fourth'));
        assert(rejected.status === 429 && rejected.body.error === 'too_many_clients', 'registration is refused when every client holds a live grant', JSON.stringify(rejected.body));
        assert(store.getClient(second.body.client_id) && store.getClient(third.body.client_id), 'clients with live grants are never evicted');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
