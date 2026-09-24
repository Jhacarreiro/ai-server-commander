const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { positiveInteger } = require('./commandExecutor');

const DEFAULT_STORE_PATH = path.join(__dirname, '..', 'runtime', 'command-operations.json');
const STORE_PATH = process.env.COMMAND_OPERATIONS_PATH || DEFAULT_STORE_PATH;
const MAX_OPERATION_RECORDS = 512;
// Operation IDs are only a recovery aid for lost responses. After this window
// a reused ID is treated as new instead of silently skipping the command.
const OPERATION_TTL_MS = positiveInteger(process.env.COMMAND_OPERATION_TTL_SECONDS, 24 * 60 * 60) * 1000;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateOperationId(value) {
    if (value === undefined || value === null || value === '') return { operationId: null };
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 128 || !OPERATION_ID_PATTERN.test(value)) {
        return { error: 'operationId must be 1-128 characters using letters, digits, dot, underscore, colon, or hyphen.' };
    }
    return { operationId: value };
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// IDs are namespaced by client adapter so a REST client and an MCP client that
// happen to pick the same ID cannot replay or block each other's operations.
function operationKey(scope, operationId) {
    return hash(String(scope || 'default') + '\0' + operationId);
}

function fingerprintCommand(parsed) {
    const payload = parsed.mode === 'script' ? parsed.script : parsed.command;
    return hash(JSON.stringify({
        mode: parsed.mode,
        payload,
        cwd: parsed.cwd,
        shell: parsed.mode === 'script' ? parsed.shell : null,
        timeoutMs: parsed.timeoutMs,
        maxOutputChars: parsed.maxOutputChars
    }));
}

function isExpired(record, nowMs = Date.now()) {
    const updatedMs = Date.parse(record && record.updatedAt);
    return Number.isFinite(updatedMs) && nowMs - updatedMs > OPERATION_TTL_MS;
}

// Fail closed: an unreadable store must not be mistaken for "no operations",
// otherwise the next write would drop every record and allow re-execution.
function readStore() {
    let raw;
    try {
        raw = fs.readFileSync(STORE_PATH, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return { version: 1, operations: {} };
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        throw new Error('Command operation state is not valid JSON: ' + STORE_PATH);
    }
    if (!parsed || parsed.version !== 1 || !parsed.operations || typeof parsed.operations !== 'object' || Array.isArray(parsed.operations)) {
        throw new Error('Command operation state has an unexpected shape: ' + STORE_PATH);
    }
    return parsed;
}

function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const nowMs = Date.now();
    const records = Object.entries(store.operations || {})
        .filter(([, record]) => !isExpired(record, nowMs))
        .sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')))
        .slice(0, MAX_OPERATION_RECORDS);
    const bounded = { version: 1, operations: Object.fromEntries(records) };
    const tmp = `${STORE_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
    try { fs.chmodSync(STORE_PATH, 0o600); } catch (_) {}
}

function findRecord(store, scope, operationId) {
    const record = store.operations[operationKey(scope, operationId)];
    if (!record || record.operationId !== operationId || isExpired(record)) return null;
    return record;
}

function getOperation({ scope, operationId }) {
    if (!operationId) return null;
    return findRecord(readStore(), scope, operationId);
}

function claimOperation({ scope, operationId, fingerprint, activityId, mode }) {
    if (!operationId) return { claimed: true, record: null };
    const store = readStore();
    const existing = findRecord(store, scope, operationId);
    if (existing) {
        if (existing.fingerprint !== fingerprint) return { claimed: false, conflict: true, record: existing };
        return { claimed: false, duplicate: true, record: existing };
    }

    const now = new Date().toISOString();
    const record = {
        operationId,
        scope,
        fingerprint,
        activityId,
        mode,
        state: 'accepted',
        startedAt: now,
        updatedAt: now
    };
    store.operations[operationKey(scope, operationId)] = record;
    writeStore(store);
    return { claimed: true, record };
}

function finishOperation({ scope, operationId }, result) {
    if (!operationId) return;
    const store = readStore();
    const record = findRecord(store, scope, operationId);
    if (!record) return;
    const now = new Date().toISOString();
    store.operations[operationKey(scope, operationId)] = {
        ...record,
        state: 'finished',
        finishedAt: now,
        updatedAt: now,
        result: {
            exitCode: result.exitCode,
            timedOut: Boolean(result.timedOut),
            interrupted: Boolean(result.interrupted),
            blocked: Boolean(result.blocked),
            outputTruncated: Boolean(result.outputTruncated),
            mode: result.mode
        }
    };
    writeStore(store);
}

// A request rejected before anything ran (policy block, failed spawn setup)
// gives the ID back so the client can retry with the same key.
function releaseOperation({ scope, operationId, activityId }) {
    if (!operationId) return false;
    const store = readStore();
    const record = findRecord(store, scope, operationId);
    if (!record || record.state !== 'accepted' || record.activityId !== activityId) return false;
    delete store.operations[operationKey(scope, operationId)];
    writeStore(store);
    return true;
}

function getOperationStatus({ scope, operationId }, activeIds = []) {
    const record = getOperation({ scope, operationId });
    if (!record) return { operationId, state: 'unknown' };
    let state = record.state;
    if (state !== 'finished') state = activeIds.includes(record.activityId) ? 'running' : 'indeterminate';
    return {
        operationId,
        state,
        activityId: record.activityId,
        mode: record.mode,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt || null,
        result: record.result || null
    };
}

module.exports = {
    OPERATION_TTL_MS,
    claimOperation,
    fingerprintCommand,
    finishOperation,
    getOperationStatus,
    releaseOperation,
    validateOperationId
};
