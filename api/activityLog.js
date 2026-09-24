const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sliceText } = require('../serverModules/commandExecutor');

const runtimeDir = path.join(__dirname, '..', 'runtime');
const activityRoot = process.env.ACTIVITY_LOG_DIR ? path.resolve(process.env.ACTIVITY_LOG_DIR) : path.join(runtimeDir, 'activity');
const legacyLogPath = path.join(runtimeDir, 'activity.jsonl');
const legacyStatusPath = path.join(runtimeDir, 'status.json');
const globalLogPath = path.join(activityRoot, 'global.jsonl');
const globalStatusPath = path.join(activityRoot, 'status.json');
const contextsPath = path.join(activityRoot, 'contexts.json');
const MAX_TEXT = 500;
const MAX_ACTIVITY_FIELD = Math.max(1, Number.parseInt(process.env.MAX_ACTIVITY_FIELD || '256', 10) || 256);
function boundField(value) { return value == null ? value : sliceText(String(value), MAX_ACTIVITY_FIELD); }
// Caps for per-conversation/per-task state and for each JSONL log file.
const MAX_CONTEXTS = Math.max(1, Number.parseInt(process.env.MAX_ACTIVITY_CONTEXTS || '500', 10) || 500);
const MAX_ACTIVITY_LOG_BYTES = Math.max(64 * 1024, Number.parseInt(process.env.MAX_ACTIVITY_LOG_BYTES || String(8 * 1024 * 1024), 10) || 8 * 1024 * 1024);
const SECRET_PATTERN = /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~+\/-]+|\b[A-Za-z0-9_]{0,80}(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]{0,80}\s*[=:]\s*[^\s'";]+)/gi;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function ensureRuntimeDir() { ensureDir(runtimeDir); ensureDir(activityRoot); ensureDir(path.join(activityRoot, 'conversations')); ensureDir(path.join(activityRoot, 'tasks')); }
function redact(value) { return String(value || '').replace(SECRET_PATTERN, '[REDACTED]'); }
function preview(value, max = MAX_TEXT) { const raw = String(value || ''); const sampleLimit = Math.max(max * 8, 4096); const sample = sliceText(raw, sampleLimit); const text = redact(sample).replace(/\s+/g, ' ').trim(); return raw.length > sample.length || text.length > max ? sliceText(text, max) + '…' : text; }
function hashText(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12); }
// "." and ".." would resolve outside the conversations/tasks directories.
function safeId(value, fallback = 'unknown') { const raw = String(value || '').trim() || fallback; const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80); if (!safe || /^\.+$/.test(safe)) return `${fallback}_${hashText(raw)}`; return safe !== raw ? `${safe}_${hashText(raw)}`.slice(0, 96) : safe; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error && error.code !== 'ENOENT') console.error('[activity-log] unreadable state file, using default:', path.basename(file), error.message); return fallback; } }
// Write through a temporary file and rename so readers never see a torn file.
function writeJson(file, value) { ensureDir(path.dirname(file)); const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`; try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed */ } } }
// Any valid JSON used to be accepted; a legacy or foreign shape without a
// conversations object crashed every activity endpoint with a TypeError.
function loadContexts() { const data = readJson(contextsPath, null); return data && typeof data === 'object' && data.conversations && typeof data.conversations === 'object' && !Array.isArray(data.conversations) ? data : { version: 1, conversations: {} }; }
function pruneContexts(contexts) { const entries = Object.entries(contexts.conversations); if (entries.length <= MAX_CONTEXTS) return contexts; entries.sort((a, b) => String(b[1] && b[1].updatedAt || '').localeCompare(String(a[1] && a[1].updatedAt || ''))); contexts.conversations = Object.fromEntries(entries.slice(0, MAX_CONTEXTS)); return contexts; }
// Keep at most MAX_CONTEXTS conversation (or task) directories: before a new
// one is created, drop the least recently written ones.
function pruneScopeDirs(root) { let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => { const dir = path.join(root, d.name); let mtime = 0; try { mtime = fs.statSync(dir).mtimeMs; } catch { /* vanished */ } return { dir, mtime }; }); } catch { return; } if (dirs.length < MAX_CONTEXTS) return; dirs.sort((a, b) => a.mtime - b.mtime); for (const { dir } of dirs.slice(0, dirs.length - MAX_CONTEXTS + 1)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } }
function rotateLogIfNeeded(logPath) { try { if (fs.statSync(logPath).size >= MAX_ACTIVITY_LOG_BYTES) fs.renameSync(logPath, `${logPath}.1`); } catch (error) { if (error && error.code !== 'ENOENT') console.error('[activity-log] rotate failed', error.message); } }
function saveContexts(contexts) { writeJson(contextsPath, contexts); }
function firstValue(...values) { for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim(); return null; }

function getActivityContext(req, overrides = {}) {
    const body = req && typeof req.body === 'object' ? req.body : {};
    const query = req && typeof req.query === 'object' ? req.query : {};
    const headers = req && typeof req.headers === 'object' ? req.headers : {};
    const conversationId = boundField(firstValue(overrides.conversationId, query.conversationId, query.conversation_id, body.conversationId, body.conversation_id, headers['openai-conversation-id'], headers['x-conversation-id']) || 'unknown');
    const conversationKey = safeId(conversationId, 'unknown');
    const contexts = loadContexts();
    const saved = contexts.conversations[conversationKey] || {};
    const taskId = boundField(firstValue(overrides.taskId, query.taskId, query.task_id, body.taskId, body.task_id, saved.taskId) || 'default');
    const taskTitle = boundField(firstValue(overrides.taskTitle, query.taskTitle, query.task_title, body.taskTitle, body.task_title, saved.taskTitle) || null);
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
        for (const p of eventPaths(context || safe)) { const dir = path.dirname(p.log); if (!fs.existsSync(dir)) { pruneScopeDirs(path.dirname(dir)); ensureDir(dir); } rotateLogIfNeeded(p.log); fs.appendFileSync(p.log, JSON.stringify(safe) + '\n', { mode: 0o600 }); writeJson(p.status, safe); }
    } catch (error) { console.error('[activity-log] failed', error && error.message ? error.message : error); }
}

// Read only a trailing window of the log instead of the whole file.
function readLastLines(file, limit) { let fd; try { fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size; if (size <= 0) return []; const length = Math.min(size, Math.max(64 * 1024, limit * 4096)); const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, size - length); let text = buffer.toString('utf8'); if (length < size) text = text.slice(text.indexOf('\n') + 1); return text.trim().split(/\n/).filter(Boolean).slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } }); } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); } }
function readStatus(file) { return readJson(file, null); }
function scopedPaths(req) { const scope = String(req.query.scope || 'global'); const context = getActivityContext(req); if (scope === 'conversation') { const dir = path.join(activityRoot, 'conversations', context.conversationKey); return { scope, context, logPath: path.join(dir, 'activity.jsonl'), statusPath: path.join(dir, 'status.json') }; } if (scope === 'task') { const dir = path.join(activityRoot, 'tasks', context.taskKey); return { scope, context, logPath: path.join(dir, 'activity.jsonl'), statusPath: path.join(dir, 'status.json') }; } return { scope: 'global', context, logPath: globalLogPath, statusPath: globalStatusPath }; }
function listScope(root) { try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => { const dir = path.join(root, d.name); return { key: d.name, status: readStatus(path.join(dir, 'status.json')) }; }); } catch { return []; } }
function setCors(res) { res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id, x-conversation-id'); res.setHeader('Access-Control-Allow-Credentials', true); }

function activityHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const limit = Math.max(1, Math.min(Number(req.query.limit || 50) || 50, 200)); const s = scopedPaths(req); return res.status(200).json({ ok: true, scope: s.scope, context: s.context, events: readLastLines(s.logPath, limit) }); }
function activityStatusHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const s = scopedPaths(req); return res.status(200).json({ ok: true, scope: s.scope, context: s.context, status: readStatus(s.statusPath) }); }
function activityIndexHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); ensureRuntimeDir(); return res.status(200).json({ ok: true, global: readStatus(globalStatusPath), contexts: loadContexts(), conversations: listScope(path.join(activityRoot, 'conversations')), tasks: listScope(path.join(activityRoot, 'tasks')) }); }
function activityContextHandler(req, res) { setCors(res); if (req.method === 'OPTIONS') return res.status(200).end(); const context = getActivityContext(req, req.body || {}); const contexts = loadContexts(); contexts.version = 1; contexts.conversations = contexts.conversations || {}; contexts.conversations[context.conversationKey] = { conversationId: context.conversationId, conversationKey: context.conversationKey, taskId: context.taskId, taskKey: context.taskKey, taskTitle: context.taskTitle, updatedAt: new Date().toISOString() }; saveContexts(pruneContexts(contexts)); appendActivity({ type: 'context_set' }, context); return res.status(200).json({ ok: true, context: contexts.conversations[context.conversationKey] }); }

module.exports = { appendActivity, activityHandler, activityStatusHandler, activityIndexHandler, activityContextHandler, getActivityContext, preview, hashText, redact, safeId };
