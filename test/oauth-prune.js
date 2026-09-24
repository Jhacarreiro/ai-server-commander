const fs = require('fs');
const os = require('os');
const path = require('path');
const { OAuthStore } = require('../serverModules/oauthStore');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-oauth-prune-'));
try {
    let now = 1_000_000;
    const statePath = path.join(tmp, 'oauth-state.json');
    const store = new OAuthStore(statePath, () => now);
    store.setAccessToken('old-token', { client_id: 'c', scope: 'terminal', expires_at: now + 1000 });
    store.setRefreshToken('old-refresh', { client_id: 'c', scope: 'terminal', expires_at: now + 1000 });
    store.setAccessToken('live-token', { client_id: 'c', scope: 'terminal', expires_at: now + 10 * 60 * 1000 });

    now += 30 * 1000;
    store.getAccessToken('live-token');
    assert(Object.keys(store.data.accessTokens).length === 2, 'reads within the prune interval do not rewrite state');

    now += 60 * 1000;
    assert(store.getAccessToken('live-token'), 'live tokens are still returned');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert(Object.keys(store.data.accessTokens).length === 1 && Object.keys(store.data.refreshTokens).length === 0, 'expired grants that were never presented are pruned on a later read');
    assert(Object.keys(persisted.accessTokens).length === 1 && Object.keys(persisted.refreshTokens).length === 0, 'the pruned state is persisted');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
