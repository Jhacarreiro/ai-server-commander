const { ChatGPTWebWatcher, resolveChatGPTWebConfig } = require('../serverModules/chatgptWebWatcher');

let singleton = null;
let singletonKey = null;
let pollTimer = null;
let pollInFlight = false;

function watcherFor(config) {
    const settings = resolveChatGPTWebConfig(config);
    const key = JSON.stringify(settings);
    if (!singleton || singletonKey !== key) {
        singleton = new ChatGPTWebWatcher({ settings });
        singletonKey = key;
    }
    ensureBackgroundPolling(singleton);
    return singleton;
}

function ensureBackgroundPolling(watcher) {
    if (!watcher.settings.enabled || pollTimer) return;
    const cycle = async () => {
        if (pollInFlight) return;
        pollInFlight = true;
        try {
            const result = await watcher.poll();
            if (result.newResponse) {
                console.log('ChatGPT Web response pending', {
                    conversationId: result.currentConversationId,
                    fingerprint: result.latest && result.latest.fingerprint,
                    chars: result.latest && result.latest.chars
                });
            }
        } catch (error) {
            console.error('ChatGPT Web background poll failed:', error && error.message ? error.message : error);
        } finally {
            pollInFlight = false;
        }
    };
    const initial = setTimeout(cycle, 100);
    if (typeof initial.unref === 'function') initial.unref();
    pollTimer = setInterval(cycle, watcher.settings.pollMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

function disabled(res, watcher) {
    if (watcher.settings.enabled) return false;
    res.status(503).json({ enabled: false, status: 'disabled', reason: 'disabled' });
    return true;
}

/**
 * @openapi
 * /api/chatgpt-web/status:
 *   get:
 *     summary: Get read-only ChatGPT Web watcher status
 *     responses:
 *       '200': { description: Watcher status }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/latest:
 *   get:
 *     summary: Get the latest completed assistant response
 *     responses:
 *       '200': { description: Latest completed response }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/pending:
 *   get:
 *     summary: Get the unacknowledged completed assistant response, if any
 *     responses:
 *       '200': { description: Pending response or null }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/ack:
 *   post:
 *     summary: Acknowledge a pending response fingerprint
 *     responses:
 *       '200': { description: Pending response acknowledged }
 *       '400': { description: Fingerprint required }
 *       '409': { description: Fingerprint mismatch or nothing pending }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/poll:
 *   post:
 *     summary: Perform one deterministic read-only poll
 *     responses:
 *       '200': { description: Poll result }
 *       '503': { description: Watcher disabled }
 */
function createChatGPTWebHandlers(config) {
    const watcher = watcherFor(config);
    return {
        statusHandler: async (req, res) => {
            if (!disabled(res, watcher)) res.json(watcher.getStatus());
        },
        latestHandler: async (req, res) => {
            if (!disabled(res, watcher)) res.json(watcher.getLatest());
        },
        pendingHandler: async (req, res) => {
            if (!disabled(res, watcher)) res.json(watcher.getPending());
        },
        ackHandler: async (req, res) => {
            if (disabled(res, watcher)) return;
            const result = watcher.ack(req.body && req.body.fingerprint);
            if (result.acked) return res.json(result);
            if (result.reason === 'fingerprint_required') return res.status(400).json(result);
            return res.status(409).json(result);
        },
        pollHandler: async (req, res) => {
            if (!disabled(res, watcher)) res.json(await watcher.poll());
        }
    };
}

module.exports = { createChatGPTWebHandlers };
