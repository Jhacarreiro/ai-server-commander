const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const runtimeDir = path.join(__dirname, '..', 'runtime');
const activityRoot = path.join(runtimeDir, 'activity');
const legacyLogPath = path.join(runtimeDir, 'activity.jsonl');
const legacyStatusPath = path.join(runtimeDir, 'status.json');
const globalLogPath = path.join(activityRoot, 'global.jsonl');
const globalStatusPath = path.join(activityRoot, 'status.json');
const contextsPath = path.join(activityRoot, 'contexts.json');
const MAX_TEXT = 500;
const MAX_CONTEXTS = Math.max(1, Number.parseInt(process.env.MAX_ACTIVITY_CONTEXTS || '500', 10) || 500);
const MAX_ACTIVITY_LOG_BYTES = Math.max(64 * 1024, Number.parseInt(process.env.MAX_ACTIVITY_LOG_BYTES || String(8 * 1024 * 1024), 10) || (8 * 1024 * 1024));
const SECRET_PATTERN = /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~+\/-]+|\b[A-Za-z0-9_]{0,80}(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]{0,80}\s*[=:]\s*[^\s'";]+)/gi;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function ensureRuntimeDir() { ensureDir(runtimeDir); ensureDir(activityRoot); ensureDir(path.join(activityRoot, 'conversations')); ensureDir(path.join(activityRoot, 'tasks')); }
function redact(value) { return String(value || '').replace(SECRET_PATTERN, '[REDACTED]'); }
function preview(value, max = MAX_TEXT) { const raw = String(value || ''); const sampleLimit = Math.max(max * 8, 4096); const sample = raw.length > sampleLimit ? raw.slice(0, sampleLimit) : raw; const text = redact(sample).replace(/\s+/g, ' ').trim(); return raw.length > sample.length || text.length > max ? text.slice(0, max) + '…' : text; }
function hashText(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12); }
function safeId(value, fallback = 'unknown') {
    const raw = String(value || '').trim() || fallback;
    // Drop path separators and lone . / .. so join(activityRoot, 'conversations', id)
    // cannot climb out of the conversations/tasks trees.
    let safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    if (!safe || safe === '.' || safe === '..' || safe.includes('..')) {
        safe = `${fallback}_${hashText(raw)}`.slice(0, 96);
    } else if (safe.length < raw.length || safe !== raw) {
        safe = `${safe}_${hashText(raw)}`.slice(0, 96);
    }
    return safe;
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (fs.existsSync(file)) console.error('[activityLog] unreadable state file, using default:', file, err && err.message ? err.message : err); return fallback; } }
// Atomic tmp+rename+fsync: a torn write would otherwise silently wipe all
// conversation mappings (readJson falls back to defaults with no error).
function writeJson(file, value) {
    ensureDir(path.dirname(file));
    const tmpPath = file + '.tmp-' + process.pid + '-' + Date.now();
    const payload = JSON.stringify(value, null, 2) + '\n';
    let fd = null;
    try {
        fd = fs.openSync(tmpPath, 'w', 0o600);
        fs.writeFileSync(fd, payload, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, file);
        fs.chmodSync(file, 0o600);
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
    }
}
function loadContexts() { return readJson(contextsPath, { version: 1, conversations: {} }); }
function saveContexts(contexts) { writeJson(contextsPath, contexts); }
function pruneContexts(contexts) {
    const conversations = contexts.conversations || {};
    const keys = Object.keys(conversations);
    if (keys.length <= MAX_CONTEXTS) return contexts;
    keys.sort((a, b) => {
        const ta = Date.parse(conversations[a]?.updatedAt || 0) || 0;
        const tb = Date.parse(conversations[b]?.updatedAt || 0) || 0;
        return ta - tb;
    });
    const drop = keys.slice(0, keys.length - MAX_CONTEXTS);
    for (const key of drop) {
        const dropped = conversations[key];
        delete conversations[key];
        // Conversation dirs are keyed by conversationKey. Task dirs are
        // keyed by the independent taskKey — only remove a task dir when
        // no remaining conversation still references it.
        try { fs.rmSync(path.join(activityRoot, 'conversations', key), { recursive: true, force: true }); } catch { /* best-effort */ }
        const taskKey = dropped && dropped.taskKey;
        if (taskKey && !Object.values(conversations).some((record) => record && record.taskKey === taskKey)) {
            try { fs.rmSync(path.join(activityRoot, 'tasks', taskKey), { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
    contexts.conversations = conversations;
    return contexts;
}
function firstValue(...values) { for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim(); return null; }

function getActivityContext(req, overrides = {}) {
    const body = req && typeof req.body === 'object' ? req.body : {};
    const query = req && typeof req.query === 'object' ? req.query : {};
    const headers = req && typeof req.headers === 'object' ? req.headers : {};
    const conversationId = firstValue(overrides.conversationId, query.conversationId, query.conversation_id, body.conversationId, body.conversation_id, headers['openai-conversation-id'], headers['x-conversation-id']) || 'unknown';
    const conversationKey = safeId(conversationId, 'unknown');
    const contexts = loadContexts();
    const saved = contexts.conversations[conversationKey] || {};
    const taskId = firstValue(overrides.taskId, query.taskId, query.task_id, body.taskId, body.task_id, saved.taskId) || 'default';
    const taskTitle = firstValue(overrides.taskTitle, query.taskTitle, query.task_title, body.taskTitle, body.task_title, saved.taskTitle) || null;
    const taskKey = safeId(taskId, 'default');
    return { conversationId, conversationKey, taskId, taskKey, taskTitle };
}

function eventPaths(context) {
    const paths = [{ log: globalLogPath, status: globalStatusPath }, { log: legacyLogPath, status: legacyStatusPath }];
    if (context && context.conversationKey) { const dir = path.join(activityRoot, 'conversations', context.conversationKey); paths.push({ log: path.join(dir, 'activity.jsonl'), status: path.join(dir, 'status.json') }); }
    if (context && context.taskKey) { const dir = path.join(activityRoot, 'tasks', context.taskKey); paths.push({ log: path.join(dir, 'activity.jsonl'), status: path.join(dir, 'status.json') }); }
    return paths;
}

function rotateLogIfNeeded(logPath) {
    try {
        const st = fs.statSync(logPath);
        if (!st.isFile() || st.size < MAX_ACTIVITY_LOG_BYTES) return;
        const rotated = `${logPath}.1`;
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(logPath, rotated);
    } catch (error) {
        if (error && error.code !== 'ENOENT') {
            console.error('[activity-log] rotate failed', error.message || error);
        }
    }
}
function appendActivity(event, context = null) {
    try {
        ensureRuntimeDir();
        const safe = { ts: new Date().toISOString(), conversationId: context?.conversationId || 'unknown', conversationKey: context?.conversationKey || 'unknown', taskId: context?.taskId || 'default', taskKey: context?.taskKey || 'default', ...(context?.taskTitle ? { taskTitle: context.taskTitle } : {}), ...event };
        if (context && context.conversationKey) {
            const contexts = loadContexts();
            contexts.version = 1;
            contexts.conversations = contexts.conversations || {};
            contexts.conversations[context.conversationKey] = { conversationId: context.conversationId, conversationKey: context.conversationKey, taskId: context.taskId, taskKey: context.taskKey, taskTitle: context.taskTitle, updatedAt: new Date().toISOString() };
            pruneContexts(contexts);
            saveContexts(contexts);
        }
        for (const p of eventPaths(context || safe)) { ensureDir(path.dirname(p.log)); rotateLogIfNeeded(p.log); fs.appendFileSync(p.log, JSON.stringify(safe) + '\n', { mode: 0o600 }); writeJson(p.status, safe); }
    } catch (error) { console.error('[activity-log] failed', error && error.message ? error.message : error); }
}

function readLastLines(file, limit) {
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const stat = fs.fstatSync(fd);
            const size = stat.size;
            if (size <= 0) return [];
            // Read only a trailing window — never pull multi-GB logs into memory.
            const window = Math.min(size, Math.max(64 * 1024, limit * 4096));
            const buf = Buffer.alloc(window);
            fs.readSync(fd, buf, 0, window, size - window);
            let text = buf.toString('utf8');
            if (window < size) {
                const firstNl = text.indexOf('\n');
                text = firstNl >= 0 ? text.slice(firstNl + 1) : text;
            }
            return text.trim().split(/\n/).filter(Boolean).slice(-limit).map((line) => {
                try { return JSON.parse(line); } catch { return { raw: line }; }
            });
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return [];
    }
}
function readStatus(file) { return readJson(file, null); }
function scopedPaths(req) { const scope = String(req.query.scope || 'global'); const context = getActivityContext(req); if (scope === 'conversation') { const dir = path.join(activityRoot, 'conversations', context.conversationKey); return { scope, context, logPath: path.join(dir, 'activity.jsonl'), statusPath: path.join(dir, 'status.json') }; } if (scope === 'task') { const dir = path.join(activityRoot, 'tasks', context.taskKey); return { scope, context, logPath: path.join(dir, 'activity.jsonl'), statusPath: path.join(dir, 'status.json') }; } return { scope: 'global', context, logPath: globalLogPath, statusPath: globalStatusPath }; }
function listScope(root) { try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => { const dir = path.join(root, d.name); return { key: d.name, status: readStatus(path.join(dir, 'status.json')) }; }); } catch { return []; } }
function setCors(res) { res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id, x-conversation-id'); res.setHeader('Access-Control-Allow-Credentials', true); }

function activityHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const limit = Math.max(1, Math.min(Number(req.query.limit || 50) || 50, 200)); const s = scopedPaths(req); return res.status(200).json({ ok: true, scope: s.scope, context: s.context, events: readLastLines(s.logPath, limit) }); }
function activityStatusHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const s = scopedPaths(req); return res.status(200).json({ ok: true, scope: s.scope, context: s.context, status: readStatus(s.statusPath) }); }
function activityIndexHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); ensureRuntimeDir(); return res.status(200).json({ ok: true, global: readStatus(globalStatusPath), contexts: loadContexts(), conversations: listScope(path.join(activityRoot, 'conversations')), tasks: listScope(path.join(activityRoot, 'tasks')) }); }
function activityContextHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const context = getActivityContext(req, req.body || {}); const contexts = loadContexts(); contexts.version = 1; contexts.conversations = contexts.conversations || {}; contexts.conversations[context.conversationKey] = { conversationId: context.conversationId, conversationKey: context.conversationKey, taskId: context.taskId, taskKey: context.taskKey, taskTitle: context.taskTitle, updatedAt: new Date().toISOString() }; pruneContexts(contexts); saveContexts(contexts); appendActivity({ type: 'context_set' }, context); return res.status(200).json({ ok: true, context: contexts.conversations[context.conversationKey] }); }

module.exports = { appendActivity, activityHandler, activityStatusHandler, activityIndexHandler, activityContextHandler, getActivityContext, preview, hashText, redact, safeId };
