const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const SECTIONS = ['clients', 'authCodes', 'accessTokens', 'refreshTokens'];
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
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

function recordKey(section, key) {
    return `${section}:${key}`;
}

function pidIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function sleepMs(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
        const end = Date.now() + ms;
        while (Date.now() < end) { /* lock backoff */ }
    }
}

function lockDirFor(statePath) {
    return `${statePath}.lock`;
}

function tryStealStaleLock(lockDir) {
    let pid = null;
    try {
        pid = Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), 10);
    } catch (_) {
        pid = null;
    }
    if (pidIsAlive(pid)) return false;
    if (Number.isInteger(pid) && pid > 0) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        return true;
    }
    let mtimeMs;
    try {
        mtimeMs = fs.statSync(lockDir).mtimeMs;
    } catch (_) {
        return false;
    }
    if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
}

function acquireStateLock(statePath) {
    const lockDir = lockDirFor(statePath);
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
        try {
            fs.mkdirSync(lockDir);
            fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`, { mode: 0o600 });
            return lockDir;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            tryStealStaleLock(lockDir);
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for OAuth state lock at ${lockDir}`);
            }
            sleepMs(20);
        }
    }
}

function releaseStateLock(lockDir) {
    fs.rmSync(lockDir, { recursive: true, force: true });
}

class OAuthStore {
    constructor(statePath, now = () => Date.now()) {
        this.statePath = path.resolve(statePath);
        this.now = now;
        this._dirty = new Set();
        // Local deletions must win over a later disk merge so this process
        // cannot resurrect a token it just rotated, revoked, consumed, or pruned.
        this._tombstones = new Set();
        this._locked = false;
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

    _markDirty(section, key) {
        const id = recordKey(section, key);
        this._dirty.add(id);
        this._tombstones.delete(id);
    }

    _tombstone(section, key) {
        const id = recordKey(section, key);
        this._tombstones.add(id);
        this._dirty.delete(id);
    }

    _withStateLock(fn) {
        if (this._locked) return fn();
        const lockDir = acquireStateLock(this.statePath);
        this._locked = true;
        try {
            return fn();
        } finally {
            this._locked = false;
            releaseStateLock(lockDir);
        }
    }

    _mergeFromDisk(disk) {
        const merged = emptyState();
        for (const section of SECTIONS) {
            const diskSection = disk[section] || {};
            const memSection = this.data[section] || {};
            for (const [key, value] of Object.entries(diskSection)) {
                if (this._tombstones.has(recordKey(section, key))) continue;
                merged[section][key] = value;
            }
            for (const [key, value] of Object.entries(memSection)) {
                if (!this._dirty.has(recordKey(section, key))) continue;
                if (this._tombstones.has(recordKey(section, key))) continue;
                merged[section][key] = value;
            }
        }
        this.data = merged;
    }

    _applyDiskState() {
        this._mergeFromDisk(this.load());
    }

    _writeAtomic() {
        const directory = path.dirname(this.statePath);
        fs.mkdirSync(directory, { recursive: true });
        const temporaryPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        const payload = JSON.stringify({
            ...this.data,
            updatedAt: new Date(this.now()).toISOString()
        }, null, 2) + '\n';

        let fd;
        let replaced = false;
        try {
            fd = fs.openSync(temporaryPath, 'wx', 0o600);
            fs.writeFileSync(fd, payload, 'utf8');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temporaryPath, this.statePath);
            replaced = true;
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
        if (replaced) this._dirty.clear();
    }

    persist() {
        this._withStateLock(() => {
            this._applyDiskState();
            this._writeAtomic();
        });
    }

    pruneExpired() {
        const now = this.now();
        let changed = false;
        for (const section of ['authCodes', 'accessTokens', 'refreshTokens']) {
            for (const [key, record] of Object.entries(this.data[section])) {
                if (!record || typeof record.expires_at !== 'number' || record.expires_at <= now) {
                    delete this.data[section][key];
                    this._tombstone(section, key);
                    changed = true;
                }
            }
        }
        if (changed) this.persist();
        return changed;
    }

    getClient(clientId) {
        this._applyDiskState();
        return this.data.clients[clientId] || null;
    }

    setClient(client) {
        this.data.clients[client.client_id] = { ...client };
        this._markDirty('clients', client.client_id);
        this.persist();
    }

    getAuthCode(rawCode) {
        this._applyDiskState();
        return this.data.authCodes[hashSecret(rawCode)] || null;
    }

    setAuthCode(rawCode, record) {
        const key = hashSecret(rawCode);
        this.data.authCodes[key] = { ...record };
        this._markDirty('authCodes', key);
        this.persist();
    }

    deleteAuthCode(rawCode) {
        this._applyDiskState();
        const key = hashSecret(rawCode);
        if (!this.data.authCodes[key]) return false;
        delete this.data.authCodes[key];
        this._tombstone('authCodes', key);
        this.persist();
        return true;
    }

    getAccessToken(rawToken) {
        this._applyDiskState();
        return this.data.accessTokens[hashSecret(rawToken)] || null;
    }

    setAccessToken(rawToken, record, persist = true) {
        const key = hashSecret(rawToken);
        this.data.accessTokens[key] = { ...record };
        this._markDirty('accessTokens', key);
        if (persist) this.persist();
    }

    deleteAccessToken(rawToken, persist = true) {
        if (persist) this._applyDiskState();
        const key = hashSecret(rawToken);
        const existed = Boolean(this.data.accessTokens[key]);
        delete this.data.accessTokens[key];
        this._tombstone('accessTokens', key);
        if (existed && persist) this.persist();
        return existed;
    }

    getRefreshToken(rawToken) {
        this._applyDiskState();
        return this.data.refreshTokens[hashSecret(rawToken)] || null;
    }

    setRefreshToken(rawToken, record, persist = true) {
        const key = hashSecret(rawToken);
        this.data.refreshTokens[key] = { ...record };
        this._markDirty('refreshTokens', key);
        if (persist) this.persist();
    }

    deleteRefreshToken(rawToken, persist = true) {
        if (persist) this._applyDiskState();
        const key = hashSecret(rawToken);
        const existed = Boolean(this.data.refreshTokens[key]);
        delete this.data.refreshTokens[key];
        this._tombstone('refreshTokens', key);
        if (existed && persist) this.persist();
        return existed;
    }

    issueTokenPair(accessToken, accessRecord, refreshToken, refreshRecord) {
        this.setAccessToken(accessToken, accessRecord, false);
        this.setRefreshToken(refreshToken, refreshRecord, false);
        this.persist();
    }

    exchangeAuthorizationCode(rawCode, accessToken, accessRecord, refreshToken, refreshRecord) {
        const codeKey = hashSecret(rawCode);
        this._withStateLock(() => {
            this._applyDiskState();
            if (!this.data.authCodes[codeKey]) {
                throw new Error('Authorization code already consumed.');
            }
            delete this.data.authCodes[codeKey];
            this._tombstone('authCodes', codeKey);
            this.setAccessToken(accessToken, accessRecord, false);
            this.setRefreshToken(refreshToken, refreshRecord, false);
            this._writeAtomic();
        });
    }

    rotateRefreshToken(oldRefreshToken, accessToken, accessRecord, refreshToken, refreshRecord) {
        this._withStateLock(() => {
            this._applyDiskState();
            const oldKey = hashSecret(oldRefreshToken);
            if (!this.data.refreshTokens[oldKey]) {
                throw new Error('Refresh token already rotated or revoked.');
            }
            this.deleteRefreshToken(oldRefreshToken, false);
            this.setAccessToken(accessToken, accessRecord, false);
            this.setRefreshToken(refreshToken, refreshRecord, false);
            this._writeAtomic();
        });
    }

    revokeToken(rawToken, clientId) {
        return this._withStateLock(() => {
            this._applyDiskState();
            let changed = false;
            const accessKey = hashSecret(rawToken);
            const refreshKey = hashSecret(rawToken);
            const access = this.data.accessTokens[accessKey];
            const refresh = this.data.refreshTokens[refreshKey];
            if (access && access.client_id === clientId) {
                delete this.data.accessTokens[accessKey];
                this._tombstone('accessTokens', accessKey);
                changed = true;
            }
            if (refresh && refresh.client_id === clientId) {
                delete this.data.refreshTokens[refreshKey];
                this._tombstone('refreshTokens', refreshKey);
                changed = true;
            }
            if (changed) this._writeAtomic();
            return changed;
        });
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
