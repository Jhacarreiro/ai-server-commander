const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const runtimeDir = path.join(__dirname, '..', 'runtime');
const logPath = path.join(runtimeDir, 'activity.jsonl');
const statusPath = path.join(runtimeDir, 'status.json');
const MAX_TEXT = 500;
const SECRET_PATTERN = /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~+\/-]+|[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*\s*[=:]\s*[^\s'";]+)/gi;

function ensureRuntimeDir() {
    fs.mkdirSync(runtimeDir, { recursive: true });
}

function redact(value) {
    return String(value || '').replace(SECRET_PATTERN, '[REDACTED]');
}

function preview(value, max = MAX_TEXT) {
    const text = redact(value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '…' : text;
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function appendActivity(event) {
    try {
        ensureRuntimeDir();
        const safe = { ts: new Date().toISOString(), ...event };
        fs.appendFileSync(logPath, JSON.stringify(safe) + '\n', { mode: 0o600 });
        fs.writeFileSync(statusPath, JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
    } catch (error) {
        console.error('[activity-log] failed', error && error.message ? error.message : error);
    }
}

function readLastLines(file, limit) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.trim().split(/\n/).filter(Boolean).slice(-limit).map((line) => {
            try { return JSON.parse(line); } catch { return { raw: line }; }
        });
    } catch {
        return [];
    }
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
}

/**
 * @openapi
 * /api/activity:
 *   get:
 *     summary: List recent Server Commander activity events.
 *     description: Returns recent command and notice lifecycle events from a local JSONL activity log. Command output is represented as a redacted/truncated outputPreview, never full stdout/stderr.
 *     operationId: listActivity
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *     responses:
 *       '200':
 *         description: Recent activity events.
 */
function activityHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50) || 50, 200));
    return res.status(200).json({ ok: true, logPath, statusPath, events: readLastLines(logPath, limit) });
}

/**
 * @openapi
 * /api/activity/status:
 *   get:
 *     summary: Return the latest Server Commander activity event.
 *     operationId: getActivityStatus
 *     responses:
 *       '200':
 *         description: Latest activity event.
 */
function activityStatusHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    let status = null;
    try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    return res.status(200).json({ ok: true, logPath, statusPath, status });
}

module.exports = { appendActivity, activityHandler, activityStatusHandler, preview, hashText, redact };
