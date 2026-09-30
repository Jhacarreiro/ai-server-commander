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

function nextPollDelay(watcher, result) {
    const accountMode = !watcher.settings.conversationUrl;
    const base = accountMode ? Math.max(watcher.settings.pollMs, 15000) : watcher.settings.pollMs;
    if (result && result.reason === 'conversation_list_failed' && /429/.test(String(result.lastError || ''))) {
        return Math.max(base, 60000);
    }
    return base;
}

function ensureBackgroundPolling(watcher) {
    if (!watcher.settings.enabled || pollTimer) return;
    const schedule = (delayMs) => {
        pollTimer = setTimeout(async () => {
            pollTimer = null;
            if (pollInFlight) {
                schedule(nextPollDelay(watcher, null));
                return;
            }
            pollInFlight = true;
            let result = null;
            try {
                result = await watcher.poll();
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
                schedule(nextPollDelay(watcher, result));
            }
        }, delayMs);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
    };
    schedule(100);
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
 *     operationId: getChatGPTWebStatus
 *     summary: Get read-only ChatGPT Web watcher status
 *     responses:
 *       '200': { description: Watcher status }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/latest:
 *   get:
 *     operationId: getChatGPTWebLatest
 *     summary: Get the latest completed assistant response
 *     responses:
 *       '200': { description: Latest completed response }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/pending:
 *   get:
 *     operationId: getChatGPTWebPending
 *     summary: Get the unacknowledged completed assistant response, if any
 *     responses:
 *       '200': { description: Pending response or null }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/ack:
 *   post:
 *     operationId: ackChatGPTWebPending
 *     summary: Acknowledge a pending response fingerprint
 *     responses:
 *       '200': { description: Pending response acknowledged }
 *       '400': { description: Fingerprint required }
 *       '409': { description: Fingerprint mismatch or nothing pending }
 *       '503': { description: Watcher disabled }
 * /api/chatgpt-web/poll:
 *   post:
 *     operationId: pollChatGPTWeb
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

module.exports = { createChatGPTWebHandlers, nextPollDelay };
