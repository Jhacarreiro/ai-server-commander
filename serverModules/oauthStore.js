const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const stores = new Map();

function hashSecret(value) {
    return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

function safeEqualHash(rawValue, expectedHash) {
    if (!rawValue || !expectedHash) return false;
    const actual = Buffer.from(hashSecret(rawValue));
    const expected = Buffer.from(String(expectedHash));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function dictionary(value = {}) {
    return Object.assign(Object.create(null), value);
}

function emptyState() {
    return {
        version: STORE_VERSION,
        clients: dictionary(),
        authCodes: dictionary(),
        accessTokens: dictionary(),
        refreshTokens: dictionary()
    };
}

function validateSection(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`OAuth state section ${name} must be an object.`);
    }
    return dictionary(value);
}

function normalizeState(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('OAuth state must be a JSON object.');
    }
    if (parsed.version !== STORE_VERSION) {
        throw new Error(`Unsupported OAuth state version: ${parsed.version}`);
    }
    return {
        version: STORE_VERSION,
        clients: validateSection(parsed.clients, 'clients'),
        authCodes: validateSection(parsed.authCodes, 'authCodes'),
        accessTokens: validateSection(parsed.accessTokens, 'accessTokens'),
        refreshTokens: validateSection(parsed.refreshTokens, 'refreshTokens')
    };
}

function resolveStatePath(config = {}) {
    const configured = process.env.OAUTH_STATE_PATH || config.oauthStatePath;
    return path.resolve(configured || path.join(__dirname, '..', 'runtime', 'oauth-state.json'));
}

class OAuthStore {
    constructor(statePath, now = () => Date.now()) {
        this.statePath = path.resolve(statePath);
        this.now = now;
        this.data = this.load();
        this.pruneExpired();
    }

    load() {
        if (!fs.existsSync(this.statePath)) return emptyState();
        const metadata = fs.lstatSync(this.statePath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error(`OAuth state path must be a regular file, not a symlink or special file: ${this.statePath}`);
        }
        fs.chmodSync(this.statePath, 0o600);
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        } catch (error) {
            throw new Error(`Unable to read OAuth state at ${this.statePath}: ${error.message}`);
        }
        return normalizeState(parsed);
    }

    persist() {
        const directory = path.dirname(this.statePath);
        fs.mkdirSync(directory, { recursive: true });
        const temporaryPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        const payload = JSON.stringify({
            ...this.data,
            updatedAt: new Date(this.now()).toISOString()
        }, null, 2) + '\n';

        let fd;
        try {
            fd = fs.openSync(temporaryPath, 'wx', 0o600);
            fs.writeFileSync(fd, payload, 'utf8');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temporaryPath, this.statePath);
            fs.chmodSync(this.statePath, 0o600);
            try {
                const dirFd = fs.openSync(directory, 'r');
                try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
            } catch (error) {
                if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EISDIR'].includes(error.code)) throw error;
            }
        } finally {
            if (typeof fd === 'number') fs.closeSync(fd);
            if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        }
    }

    pruneExpired() {
        const now = this.now();
        let changed = false;
        for (const section of ['authCodes', 'accessTokens', 'refreshTokens']) {
            for (const [key, record] of Object.entries(this.data[section])) {
                if (!record || typeof record.expires_at !== 'number' || record.expires_at <= now) {
                    delete this.data[section][key];
                    changed = true;
                }
            }
        }
        if (changed) this.persist();
        return changed;
    }

    getClient(clientId) {
        return this.data.clients[clientId] || null;
    }

    setClient(client) {
        this.data.clients[client.client_id] = { ...client };
        this.persist();
    }

    getAuthCode(rawCode) {
        return this.data.authCodes[hashSecret(rawCode)] || null;
    }

    setAuthCode(rawCode, record) {
        this.data.authCodes[hashSecret(rawCode)] = { ...record };
        this.persist();
    }

    deleteAuthCode(rawCode) {
        const key = hashSecret(rawCode);
        if (!this.data.authCodes[key]) return false;
        delete this.data.authCodes[key];
        this.persist();
        return true;
    }

    getAccessToken(rawToken) {
        return this.data.accessTokens[hashSecret(rawToken)] || null;
    }

    setAccessToken(rawToken, record, persist = true) {
        this.data.accessTokens[hashSecret(rawToken)] = { ...record };
        if (persist) this.persist();
    }

    deleteAccessToken(rawToken, persist = true) {
        const key = hashSecret(rawToken);
        const existed = Boolean(this.data.accessTokens[key]);
        delete this.data.accessTokens[key];
        if (existed && persist) this.persist();
        return existed;
    }

    getRefreshToken(rawToken) {
        return this.data.refreshTokens[hashSecret(rawToken)] || null;
    }

    setRefreshToken(rawToken, record, persist = true) {
        this.data.refreshTokens[hashSecret(rawToken)] = { ...record };
        if (persist) this.persist();
    }

    deleteRefreshToken(rawToken, persist = true) {
        const key = hashSecret(rawToken);
        const existed = Boolean(this.data.refreshTokens[key]);
        delete this.data.refreshTokens[key];
        if (existed && persist) this.persist();
        return existed;
    }

    issueTokenPair(accessToken, accessRecord, refreshToken, refreshRecord) {
        this.setAccessToken(accessToken, accessRecord, false);
        this.setRefreshToken(refreshToken, refreshRecord, false);
        this.persist();
    }

    exchangeAuthorizationCode(rawCode, accessToken, accessRecord, refreshToken, refreshRecord) {
        delete this.data.authCodes[hashSecret(rawCode)];
        this.setAccessToken(accessToken, accessRecord, false);
        this.setRefreshToken(refreshToken, refreshRecord, false);
        this.persist();
    }

    rotateRefreshToken(oldRefreshToken, accessToken, accessRecord, refreshToken, refreshRecord) {
        this.deleteRefreshToken(oldRefreshToken, false);
        this.setAccessToken(accessToken, accessRecord, false);
        this.setRefreshToken(refreshToken, refreshRecord, false);
        this.persist();
    }

    revokeToken(rawToken, clientId) {
        let changed = false;
        const accessKey = hashSecret(rawToken);
        const refreshKey = hashSecret(rawToken);
        const access = this.data.accessTokens[accessKey];
        const refresh = this.data.refreshTokens[refreshKey];
        if (access && access.client_id === clientId) {
            delete this.data.accessTokens[accessKey];
            changed = true;
        }
        if (refresh && refresh.client_id === clientId) {
            delete this.data.refreshTokens[refreshKey];
            changed = true;
        }
        if (changed) this.persist();
        return changed;
    }
}

function getOAuthStore(config = {}) {
    const statePath = resolveStatePath(config);
    if (!stores.has(statePath)) stores.set(statePath, new OAuthStore(statePath));
    return stores.get(statePath);
}

function resetOAuthStoresForTests() {
    stores.clear();
}

module.exports = {
    OAuthStore,
    getOAuthStore,
    hashSecret,
    resetOAuthStoresForTests,
    resolveStatePath,
    safeEqualHash
};
