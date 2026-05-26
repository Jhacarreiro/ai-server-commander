const crypto = require('crypto');
const { appendActivity, preview } = require('./activityLog');

const notices = [];
const DEFAULT_TTL_SECONDS = 60 * 60;
const MAX_NOTICES = 100;
const LEVELS = new Set(['info', 'warning', 'error', 'interrupt']);

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
}

function nowIso() {
    return new Date().toISOString();
}

function isExpired(notice, now = Date.now()) {
    return notice.expiresAtMs && notice.expiresAtMs <= now;
}

function pruneExpired() {
    const now = Date.now();
    for (let i = notices.length - 1; i >= 0; i--) {
        if (notices[i].ackedAt || isExpired(notices[i], now)) {
            notices.splice(i, 1);
        }
    }
    while (notices.length > MAX_NOTICES) {
        notices.shift();
    }
}

function publicNotice(notice) {
    return {
        id: notice.id,
        level: notice.level,
        source: notice.source,
        text: notice.text,
        createdAt: notice.createdAt,
        expiresAt: notice.expiresAt,
        deliveredAt: notice.deliveredAt || null,
        deliveredCount: notice.deliveredCount || 0
    };
}

function getPendingNotices() {
    pruneExpired();
    const deliveredAt = nowIso();
    return notices
        .filter((notice) => !notice.ackedAt && !isExpired(notice))
        .map((notice) => {
            notice.deliveredAt = deliveredAt;
            notice.deliveredCount = (notice.deliveredCount || 0) + 1;
            return publicNotice(notice);
        });
}

/**
 * @openapi
 * /api/notices:
 *   post:
 *     summary: Create a pending notice for future command responses.
 *     description: Stores a small in-memory notice that will be attached to terminal command responses until it is acknowledged or expires.
 *     operationId: createNotice
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - text
 *             properties:
 *               text:
 *                 type: string
 *                 description: Notice text to show alongside future command responses.
 *               level:
 *                 type: string
 *                 enum: [info, warning, error, interrupt]
 *                 default: info
 *               source:
 *                 type: string
 *                 default: external
 *               ttlSeconds:
 *                 type: integer
 *                 default: 3600
 *     responses:
 *       '201':
 *         description: Notice queued.
 *       '400':
 *         description: Bad request.
 */
function createNoticeHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
        return res.status(400).json({ message: 'Notice text is required.' });
    }

    const requestedLevel = typeof body.level === 'string' ? body.level.toLowerCase() : 'info';
    const level = LEVELS.has(requestedLevel) ? requestedLevel : 'info';
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'external';
    const ttlSeconds = Number.isFinite(Number(body.ttlSeconds)) && Number(body.ttlSeconds) > 0
        ? Math.min(Number(body.ttlSeconds), 24 * 60 * 60)
        : DEFAULT_TTL_SECONDS;

    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + ttlSeconds * 1000;
    const notice = {
        id: `notice_${createdAtMs}_${crypto.randomBytes(4).toString('hex')}`,
        level,
        source,
        text,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        deliveredAt: null,
        deliveredCount: 0,
        ackedAt: null
    };

    notices.push(notice);
    pruneExpired();
    appendActivity({ type: 'notice_created', id: notice.id, level, source, textPreview: preview(text, 240), ttlSeconds });
    return res.status(201).json({ message: 'Notice queued.', notice: publicNotice(notice) });
}

/**
 * @openapi
 * /api/notices/pending:
 *   get:
 *     summary: List pending notices.
 *     description: Returns unacknowledged, non-expired notices and marks them as delivered.
 *     operationId: listPendingNotices
 *     responses:
 *       '200':
 *         description: Pending notices.
 */
function pendingNoticesHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    const pending = getPendingNotices();
    appendActivity({ type: 'notices_listed', count: pending.length });
    return res.status(200).json({ notices: pending });
}

/**
 * @openapi
 * /api/notices/{id}/ack:
 *   post:
 *     summary: Acknowledge a pending notice.
 *     description: Removes a notice from future command responses.
 *     operationId: acknowledgeNotice
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Notice acknowledged.
 *       '404':
 *         description: Notice not found.
 */
function ackNoticeHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const notice = notices.find((item) => item.id === req.params.id && !item.ackedAt);
    if (!notice) {
        return res.status(404).json({ message: 'Notice not found.' });
    }

    notice.ackedAt = nowIso();
    appendActivity({ type: 'notice_acked', id: req.params.id, level: notice.level, source: notice.source });
    pruneExpired();
    return res.status(200).json({ message: 'Notice acknowledged.', id: req.params.id });
}

module.exports = {
    createNoticeHandler,
    pendingNoticesHandler,
    ackNoticeHandler,
    getPendingNotices
};
