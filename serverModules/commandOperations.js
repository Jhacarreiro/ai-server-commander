const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_PATH = path.join(__dirname, '..', 'runtime', 'command-operations.json');
const STORE_PATH = process.env.COMMAND_OPERATIONS_PATH || DEFAULT_STORE_PATH;
const MAX_OPERATION_RECORDS = 512;
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

function readStore() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        if (parsed && parsed.version === 1 && parsed.operations && typeof parsed.operations === 'object') return parsed;
    } catch (_) {}
    return { version: 1, operations: {} };
}

function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const records = Object.entries(store.operations || {})
        .sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')))
        .slice(0, MAX_OPERATION_RECORDS);
    const bounded = { version: 1, operations: Object.fromEntries(records) };
    const tmp = `${STORE_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(bounded, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
    try { fs.chmodSync(STORE_PATH, 0o600); } catch (_) {}
}

function getOperation(operationId) {
    if (!operationId) return null;
    const record = readStore().operations[hash(operationId)];
    return record && record.operationId === operationId ? record : null;
}

function claimOperation({ operationId, fingerprint, activityId, mode }) {
    if (!operationId) return { claimed: true, record: null };
    const store = readStore();
    const key = hash(operationId);
    const existing = store.operations[key];
    if (existing && existing.operationId === operationId) {
        if (existing.fingerprint !== fingerprint) return { claimed: false, conflict: true, record: existing };
        return { claimed: false, duplicate: true, record: existing };
    }

    const now = new Date().toISOString();
    const record = {
        operationId,
        fingerprint,
        activityId,
        mode,
        state: 'accepted',
        startedAt: now,
        updatedAt: now
    };
    store.operations[key] = record;
    writeStore(store);
    return { claimed: true, record };
}

function finishOperation(operationId, result) {
    if (!operationId) return;
    const store = readStore();
    const key = hash(operationId);
    const record = store.operations[key];
    if (!record || record.operationId !== operationId) return;
    const now = new Date().toISOString();
    store.operations[key] = {
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

function getOperationStatus(operationId, activeIds = []) {
    const record = getOperation(operationId);
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
    claimOperation,
    fingerprintCommand,
    finishOperation,
    getOperationStatus,
    validateOperationId
};
