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
const SECRET_PATTERN = /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~+\/-]+|\b[A-Za-z0-9_]{0,80}(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]{0,80}\s*[=:]\s*[^\s'";]+)/gi;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function ensureRuntimeDir() { ensureDir(runtimeDir); ensureDir(activityRoot); ensureDir(path.join(activityRoot, 'conversations')); ensureDir(path.join(activityRoot, 'tasks')); }
function redact(value) { return String(value || '').replace(SECRET_PATTERN, '[REDACTED]'); }
function preview(value, max = MAX_TEXT) { const raw = String(value || ''); const sampleLimit = Math.max(max * 8, 4096); const sample = raw.length > sampleLimit ? raw.slice(0, sampleLimit) : raw; const text = redact(sample).replace(/\s+/g, ' ').trim(); return raw.length > sample.length || text.length > max ? text.slice(0, max) + '…' : text; }
function hashText(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12); }
function safeId(value, fallback = 'unknown') { const raw = String(value || '').trim() || fallback; const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || fallback; return safe.length < raw.length || safe !== raw ? `${safe}_${hashText(raw)}`.slice(0, 96) : safe; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function loadContexts() { return readJson(contextsPath, { version: 1, conversations: {} }); }
function saveContexts(contexts) { writeJson(contextsPath, contexts); }
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

function appendActivity(event, context = null) {
    try {
        ensureRuntimeDir();
        const safe = { ts: new Date().toISOString(), conversationId: context?.conversationId || 'unknown', conversationKey: context?.conversationKey || 'unknown', taskId: context?.taskId || 'default', taskKey: context?.taskKey || 'default', ...(context?.taskTitle ? { taskTitle: context.taskTitle } : {}), ...event };
        for (const p of eventPaths(context || safe)) { ensureDir(path.dirname(p.log)); fs.appendFileSync(p.log, JSON.stringify(safe) + '\n', { mode: 0o600 }); fs.writeFileSync(p.status, JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 }); }
    } catch (error) { console.error('[activity-log] failed', error && error.message ? error.message : error); }
}

function readLastLines(file, limit) { try { const text = fs.readFileSync(file, 'utf8'); return text.trim().split(/\n/).filter(Boolean).slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } }); } catch { return []; } }
function readStatus(file) { return readJson(file, null); }
function scopedPaths(req) { const scope = String(req.query.scope || 'global'); const context = getActivityContext(req); if (scope === 'conversation') { const dir = path.join(activityRoot, 'conversations', context.conversationKey); return { scope, context, logPath: path.join(dir, 'activity.jsonl'), statusPath: path.join(dir, 'status.json') }; } if (scope === 'task') { const dir = path.join(activityRoot, 'tasks', context.taskKey); return { scope, context, logPath: path.join(dir, 'activity.jsonl'), statusPath: path.join(dir, 'status.json') }; } return { scope: 'global', context, logPath: globalLogPath, statusPath: globalStatusPath }; }
function listScope(root) { try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => { const dir = path.join(root, d.name); return { key: d.name, status: readStatus(path.join(dir, 'status.json')) }; }); } catch { return []; } }
function setCors(res) { res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id, x-conversation-id'); res.setHeader('Access-Control-Allow-Credentials', true); }

function activityHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const limit = Math.max(1, Math.min(Number(req.query.limit || 50) || 50, 200)); const s = scopedPaths(req); return res.status(200).json({ ok: true, scope: s.scope, context: s.context, logPath: s.logPath, statusPath: s.statusPath, events: readLastLines(s.logPath, limit) }); }
function activityStatusHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const s = scopedPaths(req); return res.status(200).json({ ok: true, scope: s.scope, context: s.context, logPath: s.logPath, statusPath: s.statusPath, status: readStatus(s.statusPath) }); }
function activityIndexHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); ensureRuntimeDir(); return res.status(200).json({ ok: true, global: readStatus(globalStatusPath), contexts: loadContexts(), conversations: listScope(path.join(activityRoot, 'conversations')), tasks: listScope(path.join(activityRoot, 'tasks')) }); }
function activityContextHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const context = getActivityContext(req, req.body || {}); const contexts = loadContexts(); contexts.version = 1; contexts.conversations = contexts.conversations || {}; contexts.conversations[context.conversationKey] = { conversationId: context.conversationId, conversationKey: context.conversationKey, taskId: context.taskId, taskKey: context.taskKey, taskTitle: context.taskTitle, updatedAt: new Date().toISOString() }; saveContexts(contexts); appendActivity({ type: 'context_set' }, context); return res.status(200).json({ ok: true, context: contexts.conversations[context.conversationKey] }); }

module.exports = { appendActivity, activityHandler, activityStatusHandler, activityIndexHandler, activityContextHandler, getActivityContext, preview, hashText, redact, safeId };
