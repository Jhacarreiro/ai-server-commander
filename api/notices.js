const crypto = require('crypto');
const { appendActivity, preview, getActivityContext } = require('./activityLog');

const notices = [];
const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_NOTICES = 100;
const LEVELS = new Set(['info', 'warning', 'error', 'interrupt']);

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id, x-conversation-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
}

function nowIso() { return new Date().toISOString(); }
function isExpired(notice, now = Date.now()) { return notice.expiresAtMs && notice.expiresAtMs <= now; }
function firstValue(...values) { for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim(); return null; }
function hasExplicit(value) { return typeof value === 'string' && value.trim().length > 0; }

function pruneExpired() {
    const now = Date.now();
    for (let i = notices.length - 1; i >= 0; i--) {
        if (notices[i].ackedAt || isExpired(notices[i], now)) notices.splice(i, 1);
    }
    while (notices.length > MAX_NOTICES) notices.shift();
}

function getNoticeTarget(req, body = {}) {
    const query = req && typeof req.query === 'object' ? req.query : {};
    const headers = req && typeof req.headers === 'object' ? req.headers : {};
    const explicitConversationId = firstValue(body.conversationId, body.conversation_id, query.conversationId, query.conversation_id, headers['openai-conversation-id'], headers['x-conversation-id']);
    const explicitTaskId = firstValue(body.taskId, body.task_id, query.taskId, query.task_id);
    const context = getActivityContext(req, body);
    const targetConversationKey = hasExplicit(explicitConversationId) && context.conversationKey !== 'unknown' ? context.conversationKey : null;
    const targetTaskKey = hasExplicit(explicitTaskId) && context.taskKey !== 'default' ? context.taskKey : null;
    let scope = 'global';
    if (targetConversationKey && targetTaskKey) scope = 'conversation_task';
    else if (targetConversationKey) scope = 'conversation';
    else if (targetTaskKey) scope = 'task';
    return { context, scope, targetConversationKey, targetTaskKey, targetConversationId: targetConversationKey ? context.conversationId : null, targetTaskId: targetTaskKey ? context.taskId : null, targetTaskTitle: targetTaskKey ? context.taskTitle : null };
}

function noticeMatches(notice, context = null) {
    if (!notice.targetConversationKey && !notice.targetTaskKey) return true;
    const ctx = context || {};
    if (notice.targetConversationKey && notice.targetConversationKey !== ctx.conversationKey) return false;
    if (notice.targetTaskKey && notice.targetTaskKey !== ctx.taskKey) return false;
    return true;
}

function publicNotice(notice) {
    return {
        id: notice.id,
        level: notice.level,
        source: notice.source,
        text: notice.text,
        scope: notice.scope || 'global',
        targetConversationId: notice.targetConversationId || null,
        targetConversationKey: notice.targetConversationKey || null,
        targetTaskId: notice.targetTaskId || null,
        targetTaskKey: notice.targetTaskKey || null,
        targetTaskTitle: notice.targetTaskTitle || null,
        createdAt: notice.createdAt,
        expiresAt: notice.expiresAt,
        deliveredAt: notice.deliveredAt || null,
        deliveredCount: notice.deliveredCount || 0
    };
}

function getPendingNotices(context = null) {
    pruneExpired();
    const deliveredAt = nowIso();
    return notices
        .filter((notice) => !notice.ackedAt && !isExpired(notice) && noticeMatches(notice, context))
        .map((notice) => {
            notice.deliveredAt = deliveredAt;
            notice.deliveredCount = (notice.deliveredCount || 0) + 1;
            return publicNotice(notice);
        });
}

function createNoticeHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return res.status(400).json({ message: 'Notice text is required.' });

    const requestedLevel = typeof body.level === 'string' ? body.level.toLowerCase() : 'info';
    const level = LEVELS.has(requestedLevel) ? requestedLevel : 'info';
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'external';
    const ttlSeconds = Number.isFinite(Number(body.ttlSeconds)) && Number(body.ttlSeconds) > 0 ? Math.min(Number(body.ttlSeconds), 24 * 60 * 60) : DEFAULT_TTL_SECONDS;
    const target = getNoticeTarget(req, body);

    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + ttlSeconds * 1000;
    const notice = {
        id: `notice_${createdAtMs}_${crypto.randomBytes(4).toString('hex')}`,
        level,
        source,
        text,
        scope: target.scope,
        targetConversationId: target.targetConversationId,
        targetConversationKey: target.targetConversationKey,
        targetTaskId: target.targetTaskId,
        targetTaskKey: target.targetTaskKey,
        targetTaskTitle: target.targetTaskTitle,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        deliveredAt: null,
        deliveredCount: 0,
        ackedAt: null
    };

    notices.push(notice);
    pruneExpired();
    appendActivity({ type: 'notice_created', id: notice.id, level, source, scope: notice.scope, targetConversationKey: notice.targetConversationKey, targetTaskKey: notice.targetTaskKey, textPreview: preview(text, 240), ttlSeconds }, target.context);
    return res.status(201).json({ message: 'Notice queued.', notice: publicNotice(notice) });
}

function pendingNoticesHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    const context = getActivityContext(req);
    const pending = getPendingNotices(context);
    appendActivity({ type: 'notices_listed', count: pending.length }, context);
    return res.status(200).json({ context, notices: pending });
}

function ackNoticeHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    const notice = notices.find((item) => item.id === req.params.id && !item.ackedAt);
    if (!notice) return res.status(404).json({ message: 'Notice not found.' });
    const context = getActivityContext(req);
    notice.ackedAt = nowIso();
    appendActivity({ type: 'notice_acked', id: req.params.id, level: notice.level, source: notice.source, scope: notice.scope }, context);
    pruneExpired();
    return res.status(200).json({ message: 'Notice acknowledged.', id: req.params.id });
}

module.exports = { createNoticeHandler, pendingNoticesHandler, ackNoticeHandler, getPendingNotices };
