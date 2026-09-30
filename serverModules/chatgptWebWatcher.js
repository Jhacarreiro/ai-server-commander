const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, 'runtime', 'chatgpt-web-state.json');
const MAX_RECENT_FINGERPRINTS = 64;

function bool(value, fallback = false) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const v = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
}

function int(value, fallback, min = 250, max = 300000) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function conversationIdFromUrl(value) {
    try {
        const match = new URL(String(value || '')).pathname.match(/\/c\/([^/?#]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

function cdpEndpoint(value) {
    const raw = String(value || 'http://127.0.0.1:9223').trim().replace(/\/$/, '');
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error('chatgptWeb.cdpEndpoint must be a valid HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('chatgptWeb.cdpEndpoint must use HTTP or HTTPS.');
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase())) {
        throw new Error('MVP1 requires chatgptWeb.cdpEndpoint to use a loopback host.');
    }
    return raw;
}

function approvalDomain(config = {}, env = process.env) {
    const raw = String(env.CHATGPT_WEB_APPROVAL_DOMAIN ?? config.productionDomain ?? '').trim();
    if (!raw) return null;
    try {
        const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
        return parsed.hostname.toLowerCase();
    } catch {
        return null;
    }
}

function conversationUrl(value) {
    if (value == null || String(value).trim() === '') return null;
    let parsed;
    try { parsed = new URL(String(value).trim()); } catch { throw new Error('chatgptWeb.conversationUrl must be a valid URL.'); }
    if (parsed.protocol !== 'https:' || !['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname.toLowerCase())) {
        throw new Error('chatgptWeb.conversationUrl must be an HTTPS chatgpt.com URL.');
    }
    if (!conversationIdFromUrl(parsed.toString())) throw new Error('chatgptWeb.conversationUrl must contain /c/<conversation-id>.');
    return parsed.toString();
}

function resolveChatGPTWebConfig(config = {}, env = process.env) {
    const local = config && typeof config.chatgptWeb === 'object' && !Array.isArray(config.chatgptWeb) ? config.chatgptWeb : {};
    const stateRaw = env.CHATGPT_WEB_STATE_PATH ?? local.statePath ?? DEFAULT_STATE_PATH;
    return {
        enabled: bool(env.CHATGPT_WEB_ENABLED ?? local.enabled, false),
        cdpEndpoint: cdpEndpoint(env.CHATGPT_WEB_CDP_ENDPOINT ?? local.cdpEndpoint),
        conversationUrl: conversationUrl(env.CHATGPT_WEB_CONVERSATION_URL ?? local.conversationUrl),
        stableMs: int(env.CHATGPT_WEB_STABLE_MS ?? local.stableMs, 4000),
        primeMs: int(env.CHATGPT_WEB_PRIME_MS ?? local.primeMs, 20000),
        pollMs: int(env.CHATGPT_WEB_POLL_MS ?? local.pollMs, 5000),
        statePath: path.isAbsolute(String(stateRaw)) ? String(stateRaw) : path.resolve(PROJECT_ROOT, String(stateRaw)),
        emitInitial: bool(env.CHATGPT_WEB_EMIT_INITIAL ?? local.emitInitial, false),
        approvalDomain: approvalDomain(config, env)
    };
}

function fingerprint(conversationId, text) {
    return crypto.createHash('sha256').update(String(conversationId || 'unknown')).update('\0').update(String(text || '')).digest('hex');
}

function blankState() {
    return {
        version: 3,
        status: 'idle',
        reason: 'not_polled',
        updatedAt: null,
        currentConversationId: null,
        conversationSince: null,
        conversationSawGenerating: false,
        primedConversationId: null,
        candidateFingerprint: null,
        candidateSince: null,
        lastCompletedFingerprint: null,
        lastCompletedAt: null,
        recentFingerprints: [],
        latest: null,
        pendingFingerprint: null,
        pendingSince: null,
        ackedAt: null,
        accountPrimedAt: null,
        accountConversationVersions: {},
        followUpConversationId: null,
        followUpSince: null,
        lastError: null
    };
}

function normalizeRecentFingerprints(value) {
    const input = Array.isArray(value) ? value : [];
    const out = [];
    for (const item of input) {
        const fp = String(item || '').trim();
        if (!fp) continue;
        const existing = out.indexOf(fp);
        if (existing >= 0) out.splice(existing, 1);
        out.push(fp);
    }
    return out.slice(-MAX_RECENT_FINGERPRINTS);
}

function rememberFingerprint(state, fp) {
    return normalizeRecentFingerprints([...(state.recentFingerprints || []), fp]);
}

function readState(filePath) {
    try {
        const state = { ...blankState(), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
        state.version = 3;
        state.recentFingerprints = normalizeRecentFingerprints(state.recentFingerprints);
        state.accountConversationVersions = state.accountConversationVersions && typeof state.accountConversationVersions === 'object' && !Array.isArray(state.accountConversationVersions)
            ? state.accountConversationVersions
            : {};
        return state;
    } catch { return blankState(); }
}

function writeStateAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
}

function publicStatus(settings, state) {
    return {
        enabled: settings.enabled,
        status: settings.enabled ? state.status : 'disabled',
        reason: settings.enabled ? state.reason : 'disabled',
        updatedAt: state.updatedAt,
        currentConversationId: state.currentConversationId,
        configuredConversationId: conversationIdFromUrl(settings.conversationUrl),
        mode: settings.conversationUrl ? 'conversation' : 'attention',
        pollMs: settings.pollMs,
        stableMs: settings.stableMs,
        primeMs: settings.primeMs,
        latest: state.latest ? {
            conversationId: state.latest.conversationId,
            fingerprint: state.latest.fingerprint,
            chars: state.latest.chars,
            completedAt: state.latest.completedAt,
            pending: state.pendingFingerprint === state.latest.fingerprint
        } : null,
        lastError: state.lastError
    };
}

function selectCdpTarget(targets, settings) {
    const pages = (Array.isArray(targets) ? targets : []).filter((target) => {
        if (target?.type !== 'page' || !target?.webSocketDebuggerUrl) return false;
        try {
            const parsed = new URL(String(target.url || ''));
            return ['chatgpt.com', 'www.chatgpt.com'].includes(parsed.hostname.toLowerCase());
        } catch { return false; }
    });
    const configuredId = conversationIdFromUrl(settings.conversationUrl);
    if (configuredId) {
        const exact = pages.find((target) => conversationIdFromUrl(target.url) === configuredId);
        if (exact) return exact;
    }
    const conversationPages = pages.filter((target) => conversationIdFromUrl(target.url));
    if (conversationPages.length) return conversationPages[conversationPages.length - 1];
    return pages[pages.length - 1] || null;
}

async function fetchCdpTargets(settings) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(`${settings.cdpEndpoint}/json/list`, { signal: controller.signal });
        if (!response.ok) throw new Error(`CDP target list failed with HTTP ${response.status}.`);
        const body = await response.json();
        if (!Array.isArray(body)) throw new Error('CDP target list returned an invalid payload.');
        return body;
    } finally {
        clearTimeout(timer);
    }
}

async function connectCdpSession(webSocketDebuggerUrl, timeoutMs = 10000) {
    const WebSocket = require('ws');
    const socket = new WebSocket(webSocketDebuggerUrl);
    let nextId = 1;
    let closed = false;
    const pending = new Map();

    const rejectPending = (error) => {
        for (const { reject, timer } of pending.values()) {
            clearTimeout(timer);
            reject(error);
        }
        pending.clear();
    };

    socket.on('message', (raw) => {
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        if (!message?.id || !pending.has(message.id)) return;
        const item = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(`CDP ${item.method} failed: ${message.error.message || 'unknown error'}`));
        else item.resolve(message.result || {});
    });
    socket.on('close', () => {
        closed = true;
        rejectPending(new Error('CDP WebSocket closed.'));
    });
    socket.on('error', (error) => {
        rejectPending(error instanceof Error ? error : new Error('CDP WebSocket error.'));
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error('CDP WebSocket connection timed out.'));
        }, timeoutMs);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });

    return {
        async command(method, params = {}) {
            if (closed || socket.readyState !== WebSocket.OPEN) throw new Error('CDP WebSocket is not open.');
            const id = nextId++;
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`CDP ${method} timed out.`));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer, method });
                socket.send(JSON.stringify({ id, method, params }), (error) => {
                    if (!error) return;
                    const item = pending.get(id);
                    if (!item) return;
                    pending.delete(id);
                    clearTimeout(item.timer);
                    reject(error);
                });
            });
        },
        async close() {
            if (closed) return;
            closed = true;
            rejectPending(new Error('CDP session closed.'));
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 500);
                socket.once('close', () => { clearTimeout(timer); resolve(); });
                try { socket.close(); } catch { clearTimeout(timer); resolve(); }
            });
        }
    };
}

async function readSnapshot(settings) {
    const targets = await fetchCdpTargets(settings);
    const target = selectCdpTarget(targets, settings);
    if (!target) throw new Error('No ChatGPT page is available on the configured CDP endpoint.');
    const page = await connectCdpSession(target.webSocketDebuggerUrl, 10000);
    try {
        const expression = `(() => (async () => {
            let authenticated = false;
            let authStatus = 0;
            try {
                const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
                authStatus = response.status;
                const text = await response.text();
                if (text.length <= 262144) {
                    let body = null;
                    try { body = JSON.parse(text); } catch {}
                    authenticated = response.ok && body && typeof body === 'object' && Object.keys(body).length > 0;
                }
            } catch {}
            const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]'));
            const latest = nodes.length ? nodes[nodes.length - 1] : null;
            const assistantText = latest ? (latest.innerText || latest.textContent || '').trim() : '';
            const visible = el => {
                if (!(el instanceof HTMLElement)) return false;
                const s = getComputedStyle(el), r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            };
            const generating = Array.from(document.querySelectorAll('button')).some(button => {
                if (!visible(button)) return false;
                if (button.matches('[data-testid="stop-button"]')) return true;
                const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.innerText, button.textContent].filter(Boolean).join(' ');
                return /stop generating|stop streaming/i.test(label);
            });
            return { url: location.href, assistantText, assistantCount: nodes.length, generating, authenticated, authStatus };
        })())()`;
        const evaluated = await page.command('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false
        });
        if (evaluated?.exceptionDetails) throw new Error('ChatGPT DOM evaluation failed.');
        const value = evaluated?.result?.value;
        if (!value || typeof value !== 'object') throw new Error('ChatGPT DOM evaluation returned no value.');
        return value;
    } finally {
        await page.close();
    }
}

function allowTargetMessageId(actions) {
    const action = (Array.isArray(actions) ? actions : [])
        .find((item) => item?.name === 'allow' && (item?.allow?.target_message_id || item?.allow_once?.target_message_id));
    const target = action?.allow?.target_message_id || action?.allow_once?.target_message_id;
    return target ? String(target) : null;
}

async function readAccountActivity(settings, knownVersions = {}, followUpConversationId = null) {
    const targets = await fetchCdpTargets(settings);
    const target = selectCdpTarget(targets, settings);
    if (!target) throw new Error('No ChatGPT page is available on the configured CDP endpoint.');
    const page = await connectCdpSession(target.webSocketDebuggerUrl, 10000);
    try {
        const knownJson = JSON.stringify(knownVersions && typeof knownVersions === 'object' ? knownVersions : {});
        const followUpJson = JSON.stringify(followUpConversationId || null);
        const approvalDomainJson = JSON.stringify(settings.approvalDomain || null);
        const expression = `(() => (async () => {
            const known = ${knownJson};
            const followUpConversationId = ${followUpJson};
            const approvalDomain = ${approvalDomainJson};
            const anchor = document.querySelector('a[href*="/c/"]');
            const row = anchor && (anchor.closest('[role="group"].sidebar-item') || anchor.parentElement);
            const fiberKey = row && Object.keys(row).find(key => key.startsWith('__reactFiber$'));
            let fiber = fiberKey ? row[fiberKey] : null;
            let source = null;
            for (let depth = 0; fiber && depth < 60; depth += 1, fiber = fiber.return) {
                if (fiber.memoizedProps && fiber.memoizedProps.chatGptSource) {
                    source = fiber.memoizedProps.chatGptSource;
                    break;
                }
            }
            if (!source || !Array.isArray(source.chatTargets)) {
                return { authenticated: true, authStatus: 200, conversations: [], changed: null, sourceAvailable: false };
            }
            const conversations = source.chatTargets.map(item => ({
                id: String(item.conversationId || item.conversation?.id || ''),
                title: String(item.conversation?.title || ''),
                attentionState: String(item.attentionState || 'idle'),
                recencyAt: Number(item.recencyAt || 0),
                route: String(item.route || ''),
                latestAssistantTurnCreatedAt: item.conversation?.latest_assistant_turn_created_at || null,
                version: String(item.attentionState || 'idle') + '|' + String(item.recencyAt || 0)
            })).filter(item => item.id);
            const followUp = followUpConversationId
                ? conversations.find(item => item.id === followUpConversationId) || null
                : null;
            const active = conversations
                .filter(item => (item.attentionState === 'waiting' || item.attentionState === 'unread') && known[item.id] !== item.version)
                .sort((a, b) => {
                    const ap = a.attentionState === 'waiting' ? 0 : 1;
                    const bp = b.attentionState === 'waiting' ? 0 : 1;
                    return ap - bp || b.recencyAt - a.recencyAt;
                });
            const recovery = conversations
                .filter(item => item.attentionState === 'idle'
                    && item.route.startsWith('/g/')
                    && !item.latestAssistantTurnCreatedAt
                    && known[item.id]
                    && known[item.id] !== item.version)
                .sort((a, b) => b.recencyAt - a.recencyAt)[0] || null;
            const changedItem = followUp
                ? { ...followUp, followUp: true }
                : (active[0] || (recovery ? { ...recovery, recovery: true } : null));
            if (!changedItem) return { authenticated: true, authStatus: 200, conversations, changed: null, sourceAvailable: true };

            const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
            const session = await sessionResponse.json().catch(() => null);
            const token = session && session.accessToken;
            if (!sessionResponse.ok || !token) {
                return { authenticated: false, authStatus: sessionResponse.status || 0, conversations, changed: changedItem, sourceAvailable: true };
            }
            const headers = { Authorization: 'Bearer ' + token };
            const detailResponse = await fetch('/backend-api/conversation/' + encodeURIComponent(changedItem.id), { headers, cache: 'no-store' });
            if (!detailResponse.ok) {
                return { authenticated: true, authStatus: sessionResponse.status, conversations, changed: { ...changedItem, detailStatus: detailResponse.status, completion: null, consent: null }, sourceAvailable: true };
            }
            const detail = await detailResponse.json();
            const mapping = detail && detail.mapping && typeof detail.mapping === 'object' ? detail.mapping : {};
            let nodeId = detail && detail.current_node;
            let completion = null;
            let consent = null;
            let sawInProgress = false;
            let steps = 0;
            while (nodeId && mapping[nodeId] && steps < 512) {
                const node = mapping[nodeId];
                const message = node && node.message;
                const fromServer = message?.metadata?.jit_plugin_data?.from_server;
                if (message?.status === 'in_progress') sawInProgress = true;
                if (!consent && (changedItem.attentionState === 'waiting' || changedItem.recovery === true)
                    && fromServer?.type === 'confirm_action'
                    && approvalDomain
                    && String(fromServer?.body?.domain || '').toLowerCase() === approvalDomain
                    && fromServer?.body?.operation === 'runTerminalScript') {
                    const targetMessageId = allowTargetMessageId(fromServer?.body?.actions);
                    if (targetMessageId) {
                        const resolved = (Array.isArray(node.children) ? node.children : []).some(childId => {
                            const child = mapping[childId]?.message;
                            const fromClient = child?.metadata?.jit_plugin_data?.from_client;
                            const resolvedTarget = fromClient?.target_message_id || fromClient?.user_action?.target_message_id;
                            const resolvedType = fromClient?.type || fromClient?.user_action?.data?.type;
                            return String(resolvedTarget || '') === targetMessageId
                                && ['allow', 'deny', 'always_allow'].includes(String(resolvedType || ''));
                        });
                        if (!resolved) {
                            consent = {
                                conversationId: String(detail?.conversation_id || detail?.id || changedItem.id),
                                confirmMessageId: String(message?.id || nodeId),
                                targetMessageId,
                                authorRole: String(message?.author?.role || 'tool'),
                                authorName: String(message?.author?.name || ''),
                                modelSlug: String(message?.metadata?.model_slug || detail?.default_model_slug || ''),
                                gizmoId: String(detail?.gizmo_id || ''),
                                domain: String(fromServer?.body?.domain || ''),
                                operation: String(fromServer?.body?.operation || ''),
                                requestId: String(message?.metadata?.request_id || '')
                            };
                        }
                    }
                }
                if (!completion && (changedItem.attentionState === 'unread' || changedItem.followUp === true)
                    && message && message.author && message.author.role === 'assistant'
                    && message.recipient === 'all'
                    && message.content && message.content.content_type === 'text'
                    && message.status === 'finished_successfully'
                    && message.end_turn === true) {
                    const parts = Array.isArray(message.content.parts) ? message.content.parts : [];
                    const text = parts.filter(part => typeof part === 'string').join('').trim();
                    if (text) {
                        completion = {
                            messageId: String(message.id || nodeId),
                            text,
                            chars: text.length,
                            completedAt: message.update_time || message.create_time || null
                        };
                    }
                }
                if (message && message.author && message.author.role === 'user') break;
                nodeId = node && node.parent;
                steps += 1;
            }
            return {
                authenticated: true,
                authStatus: sessionResponse.status,
                conversations,
                changed: { ...changedItem, detailStatus: detailResponse.status, completion, consent, sawInProgress },
                sourceAvailable: true
            };
        })())()`;
        const evaluated = await page.command('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false
        });
        if (evaluated?.exceptionDetails) throw new Error('ChatGPT attention evaluation failed.');
        const value = evaluated?.result?.value;
        if (!value || typeof value !== 'object') throw new Error('ChatGPT attention evaluation returned no value.');
        return value;
    } finally {
        await page.close();
    }
}

function buildJitAllowPayload(consent) {
    const messageId = crypto.randomUUID();
    return {
        action: 'next',
        conversation_id: consent.conversationId,
        parent_message_id: consent.targetMessageId,
        model: consent.modelSlug || undefined,
        gizmo_id: consent.gizmoId || undefined,
        conversation_mode: consent.gizmoId ? { kind: 'gizmo_interaction', gizmo_id: consent.gizmoId } : undefined,
        timezone_offset_min: new Date().getTimezoneOffset(),
        history_and_training_disabled: false,
        force_paragen: false,
        force_rate_limit: false,
        supported_encodings: ['v1'],
        messages: [{
            id: messageId,
            author: { metadata: {}, name: 'api_tool.call_tool', role: 'tool' },
            channel: null,
            content: { content_type: 'text', parts: [''] },
            create_time: Date.now() / 1000,
            end_turn: null,
            metadata: {
                jit_plugin_data: {
                    from_client: {
                        remember_answer: false,
                        target_message_id: consent.targetMessageId,
                        type: 'allow'
                    }
                }
            },
            recipient: 'all',
            status: 'finished_successfully',
            update_time: null,
            weight: 1
        }]
    };
}

function sentinelRuntimeSource() {
    return String.raw`
      const sentinelEncode = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
      const sentinelRandomItem = (items) => items.length ? items[Math.floor(Math.random() * items.length)] : '';
      const sentinelFingerprint = () => {
        const memory = performance.memory;
        let navKey = 'navigator';
        try {
          const keys = Object.keys(Object.getPrototypeOf(navigator));
          if (keys.length) navKey = sentinelRandomItem(keys);
        } catch {}
        let navValue = '';
        try { navValue = String(navigator[navKey]); } catch { navValue = navKey; }
        return [
          screen?.width + screen?.height,
          String(new Date()),
          memory?.jsHeapSizeLimit ?? null,
          Math.random(),
          navigator.userAgent,
          sentinelRandomItem(Array.from(document.scripts || []).map((element) => element?.src).filter(Boolean)),
          (Array.from(document.scripts || []).map((element) => element?.src?.match('c/[^/]*/_')).filter((value) => value?.length)[0] ?? [])[0]
            ?? document.documentElement.getAttribute('data-build'),
          navigator.language,
          navigator.languages?.join(','),
          Math.random(),
          navKey + '−' + navValue,
          sentinelRandomItem(Object.keys(document)),
          sentinelRandomItem(Object.keys(window)),
          performance.now(),
          {},
          [...new URLSearchParams(location.search).keys()].join(','),
          navigator.hardwareConcurrency,
          performance.timeOrigin,
          Number('ai' in window),
          Number('createPRNG' in window),
          Number('cache' in window),
          Number('data' in window),
          Number('solana' in window),
          Number('dump' in window),
          Number('InstallTrigger' in window)
        ];
      };
      const sentinelInitialProof = () => {
        const startedAt = performance.now();
        const value = sentinelFingerprint();
        value[3] = 1;
        value[9] = performance.now() - startedAt;
        return 'gAAAAAC' + sentinelEncode(value);
      };
      const sentinelHash = (value) => {
        let hash = 0x811c9dc5;
        for (let i = 0; i < value.length; i += 1) {
          hash ^= value.charCodeAt(i);
          hash = Math.imul(hash, 0x1000193) >>> 0;
        }
        hash ^= hash >>> 16;
        hash = Math.imul(hash, 0x85ebca6b) >>> 0;
        hash ^= hash >>> 13;
        hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
        return ((hash ^ (hash >>> 16)) >>> 0).toString(16).padStart(8, '0');
      };
      const sentinelProofOfWork = (seed, difficulty) => {
        const startedAt = performance.now();
        const value = sentinelFingerprint();
        for (let i = 0; i < 500000; i += 1) {
          value[3] = i;
          value[9] = Math.round(performance.now() - startedAt);
          const encoded = sentinelEncode(value);
          if (sentinelHash(seed + encoded).substring(0, difficulty.length) <= difficulty) return 'gAAAAAB' + encoded + '~S';
        }
        return null;
      };
      const sentinelTurnstile = async (dx, key) => {
        const store = new Map();
        let count = 0;
        const xor = (value, mask) => {
          let result = '';
          for (let i = 0; i < value.length; i += 1) result += String.fromCharCode(value.charCodeAt(i) ^ mask.charCodeAt(i % mask.length));
          return result;
        };
        const run = async () => {
          while ((store.get(9) || []).length > 0) {
            const [op, ...args] = (store.get(9) || []).shift() || [];
            const fn = store.get(op);
            const result = fn?.(...args);
            if (result && typeof result.then === 'function') await Promise.resolve(result);
            count += 1;
          }
        };
        return await new Promise((resolve, reject) => {
          store.clear();
          store.set(0, (value) => sentinelTurnstile(value, String(store.get(16))));
          store.set(1, (out, mask) => store.set(out, xor(String(store.get(out)), String(store.get(mask)))));
          store.set(2, (out, value) => store.set(out, value));
          store.set(5, (out, value) => { const current = store.get(out); Array.isArray(current) ? current.push(store.get(value)) : store.set(out, current + store.get(value)); });
          store.set(27, (out, value) => { const current = store.get(out); Array.isArray(current) ? current.splice(current.indexOf(store.get(value)), 1) : store.set(out, current - store.get(value)); });
          store.set(29, (out, left, right) => store.set(out, Number(store.get(left)) < Number(store.get(right))));
          store.set(33, (out, left, right) => store.set(out, Number(store.get(left)) * Number(store.get(right))));
          store.set(35, (out, left, right) => { const divisor = Number(store.get(right)); store.set(out, divisor === 0 ? 0 : Number(store.get(left)) / divisor); });
          store.set(6, (out, object, prop) => { const value = store.get(object); store.set(out, value[String(store.get(prop))]); });
          store.set(7, (fn, ...args) => store.get(fn)(...args.map((arg) => store.get(arg))));
          store.set(17, (out, fn, ...args) => { try { const value = store.get(fn)(...args.map((arg) => store.get(arg))); if (value && typeof value.then === 'function') return value.then((resolved) => store.set(out, resolved)).catch((error) => store.set(out, String(error))); store.set(out, value); } catch (error) { store.set(out, String(error)); } });
          store.set(13, (out, fn, ...args) => { try { store.get(fn)(...args.map((arg) => store.get(arg))); } catch (error) { store.set(out, String(error)); } });
          store.set(8, (out, value) => store.set(out, store.get(value)));
          store.set(10, window);
          store.set(11, (out, pattern) => store.set(out, (Array.from(document.scripts || []).map((script) => script?.src?.match(String(store.get(pattern)))).filter((value) => value?.length)[0] ?? [])[0] ?? null));
          store.set(12, (out) => store.set(out, store));
          store.set(14, (out, value) => store.set(out, JSON.parse(String(store.get(value)))));
          store.set(15, (out, value) => store.set(out, JSON.stringify(store.get(value))));
          store.set(18, (value) => store.set(value, atob(String(store.get(value)))));
          store.set(19, (value) => store.set(value, btoa(String(store.get(value)))));
          store.set(20, (left, right, fn, ...args) => store.get(left) === store.get(right) ? store.get(fn)(...args) : null);
          store.set(21, (left, right, delta, fn, ...args) => Math.abs(Number(store.get(left)) - Number(store.get(right))) > Number(store.get(delta)) ? store.get(fn)(...args) : null);
          store.set(23, (value, fn, ...args) => typeof store.get(value) !== 'undefined' ? store.get(fn)(...args) : null);
          store.set(24, (out, object, prop) => { const value = store.get(object); const fn = value[String(store.get(prop))]; store.set(out, fn.bind(value)); });
          store.set(34, (out, value) => Promise.resolve(store.get(value)).then((resolved) => store.set(out, resolved)));
          store.set(22, (out, queue) => { const old = [...store.get(9)]; store.set(9, [...queue]); return run().catch((error) => store.set(out, String(error))).finally(() => store.set(9, old)); });
          store.set(28, () => {});
          store.set(26, () => {});
          store.set(25, () => {});
          store.set(16, key);
          let done = false;
          const timer = setTimeout(() => { if (!done) { done = true; resolve(String(count)); } }, 500);
          store.set(3, (value) => { if (!done) { done = true; clearTimeout(timer); resolve(btoa(String(value))); } });
          store.set(4, (value) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(btoa(String(value)))); } });
          store.set(30, (out, target, slots, queue) => {
            const arrayMode = Array.isArray(queue);
            const slotIds = arrayMode ? slots : [];
            const ops = (arrayMode ? queue : slots) ?? [];
            store.set(out, (...values) => {
              if (done) return;
              const old = [...store.get(9)];
              if (arrayMode) for (let i = 0; i < slotIds.length; i += 1) store.set(slotIds[i], values[i]);
              store.set(9, [...ops]);
              return run().then(() => store.get(target)).catch((error) => String(error)).finally(() => store.set(9, old));
            });
          });
          try {
            store.set(9, JSON.parse(xor(atob(dx), String(store.get(16)))));
            run().catch((error) => resolve(btoa(count + ': ' + String(error))));
          } catch (error) {
            resolve(btoa(count + ': ' + String(error)));
          }
        });
      };
    `;
}

async function approveJitConsent(settings, consent) {
    if (!consent || !settings.approvalDomain) return { ok: false, reason: 'approval_not_configured' };
    if (String(consent.domain || '').toLowerCase() !== settings.approvalDomain) return { ok: false, reason: 'approval_domain_mismatch' };
    if (consent.operation !== 'runTerminalScript') return { ok: false, reason: 'approval_operation_mismatch' };
    const targets = await fetchCdpTargets(settings);
    const target = selectCdpTarget(targets, settings);
    if (!target) return { ok: false, reason: 'chatgpt_page_unavailable' };
    const page = await connectCdpSession(target.webSocketDebuggerUrl, 10000);
    try {
        const payloadJson = JSON.stringify(buildJitAllowPayload(consent));
        const expression = `(() => (async () => {
            const payload = ${payloadJson};
            ${sentinelRuntimeSource()}
            const sessionResponse = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
            const session = await sessionResponse.json().catch(() => null);
            const token = session?.accessToken;
            const accountId = session?.account?.id || session?.account?.account_id || session?.account?.accountId || null;
            if (!sessionResponse.ok || !token) return { ok: false, status: sessionResponse.status || 0, reason: 'authentication_required' };
            const requirementsKey = sentinelInitialProof();
            const prepareHeaders = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
            if (accountId) prepareHeaders['ChatGPT-Account-ID'] = accountId;
            const prepareResponse = await fetch('/backend-api/sentinel/chat-requirements/prepare', {
              method: 'POST', headers: prepareHeaders, body: JSON.stringify({ p: requirementsKey }), credentials: 'include'
            });
            const requirements = await prepareResponse.json().catch(() => null);
            if (!prepareResponse.ok || !requirements || requirements.force_login) {
              return { ok: false, status: prepareResponse.status, reason: requirements?.force_login ? 'force_login' : 'integrity_prepare_http_' + prepareResponse.status };
            }
            const proof = requirements?.proofofwork?.required
              ? sentinelProofOfWork(requirements.proofofwork.seed, requirements.proofofwork.difficulty)
              : null;
            const turnstile = requirements?.turnstile?.required
              ? await sentinelTurnstile(requirements.turnstile.dx, requirementsKey)
              : null;
            const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'text/event-stream' };
            if (accountId) headers['ChatGPT-Account-ID'] = accountId;
            if (requirements.token) headers['OpenAI-Sentinel-Chat-Requirements-Token'] = requirements.token;
            else if (requirements.prepare_token) headers['OpenAI-Sentinel-Chat-Requirements-Prepare-Token'] = requirements.prepare_token;
            if (proof) headers['OpenAI-Sentinel-Proof-Token'] = proof;
            if (turnstile) headers['OpenAI-Sentinel-Turnstile-Token'] = turnstile;
            const response = await fetch('/backend-api/f/conversation', {
              method: 'POST', headers, body: JSON.stringify(payload), credentials: 'include'
            });
            return { ok: response.ok, status: response.status, reason: response.ok ? 'allowed' : 'approval_http_' + response.status };
        })())()`;
        const evaluated = await page.command('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false
        });
        if (evaluated?.exceptionDetails) return { ok: false, reason: 'approval_evaluation_failed' };
        const value = evaluated?.result?.value;
        return value && typeof value === 'object' ? value : { ok: false, reason: 'approval_no_result' };
    } finally {
        await page.close();
    }
}


class ChatGPTWebWatcher {
    constructor({ settings, snapshotReader, accountReader, consentApprover, now } = {}) {
        this.settings = settings || resolveChatGPTWebConfig();
        this.snapshotReader = snapshotReader || (() => readSnapshot(this.settings));
        this.accountReader = accountReader || ((knownVersions, followUpConversationId) => readAccountActivity(this.settings, knownVersions, followUpConversationId));
        this.consentApprover = consentApprover || ((consent) => approveJitConsent(this.settings, consent));
        this.useAccountMode = !this.settings.conversationUrl && !snapshotReader;
        this.now = now || (() => Date.now());
    }

    getState() { return readState(this.settings.statePath); }
    getStatus() { return publicStatus(this.settings, this.getState()); }
    getLatest() {
        const state = this.getState();
        return {
            enabled: this.settings.enabled,
            status: this.settings.enabled ? state.status : 'disabled',
            latest: state.latest ? { ...state.latest, pending: state.pendingFingerprint === state.latest.fingerprint } : null
        };
    }
    getPending() {
        const state = this.getState();
        const pending = state.pendingFingerprint && state.latest && state.latest.fingerprint === state.pendingFingerprint
            ? { ...state.latest, pendingSince: state.pendingSince }
            : null;
        return { enabled: this.settings.enabled, status: this.settings.enabled ? state.status : 'disabled', pending };
    }
    ack(fingerprintValue) {
        const requested = String(fingerprintValue || '').trim();
        if (!requested) return { acked: false, reason: 'fingerprint_required' };
        const state = this.getState();
        if (!state.pendingFingerprint) return { acked: false, reason: 'nothing_pending' };
        if (state.pendingFingerprint !== requested) return { acked: false, reason: 'fingerprint_mismatch', pendingFingerprint: state.pendingFingerprint };
        const nowIso = new Date(this.now()).toISOString();
        state.pendingFingerprint = null;
        state.pendingSince = null;
        state.ackedAt = nowIso;
        state.updatedAt = nowIso;
        this.save(state);
        return { acked: true, fingerprint: requested, ackedAt: nowIso };
    }
    save(state) { writeStateAtomic(this.settings.statePath, state); return state; }

    async pollAccount() {
        let state = this.getState();
        const nowIso = new Date(this.now()).toISOString();
        if (!this.settings.enabled) return { ...publicStatus(this.settings, state), newResponse: false };
        if (state.pendingFingerprint) return { ...publicStatus(this.settings, state), newResponse: false };

        let activity;
        try { activity = await this.accountReader(state.accountConversationVersions || {}, state.followUpConversationId || null); }
        catch (error) {
            state = { ...state, status: 'error', reason: 'attention_snapshot_failed', updatedAt: nowIso, lastError: String(error?.message || error).slice(0, 500) };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }
        if (!activity.authenticated) {
            state = { ...state, status: 'needs_human', reason: 'authentication_required', updatedAt: nowIso, lastError: null };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }
        if (activity.sourceAvailable === false) {
            state = { ...state, status: 'error', reason: 'sidebar_attention_unavailable', updatedAt: nowIso, lastError: 'chatGptSource.chatTargets unavailable' };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }

        const conversations = Array.isArray(activity.conversations) ? activity.conversations : [];
        const versions = Object.fromEntries(conversations.map(item => [item.id, String(item.version || '')]).filter(([id]) => id));
        if (!state.accountPrimedAt) {
            const hasWaiting = conversations.some(item => item.attentionState === 'waiting' && state.accountConversationVersions?.[item.id] !== item.version);
            state = { ...state, version: 3, accountPrimedAt: nowIso, accountConversationVersions: versions, updatedAt: nowIso, lastError: null };
            if (!hasWaiting) {
                state.status = 'idle';
                state.reason = 'attention_baseline_recorded';
                this.save(state);
                return { ...publicStatus(this.settings, state), newResponse: false, baseline: true };
            }
            // Keep waiting items eligible for immediate approval on first run.
            for (const item of conversations) if (item.attentionState === 'waiting') delete state.accountConversationVersions[item.id];
        }

        if (!activity.changed) {
            const followUpStillPresent = state.followUpConversationId
                && conversations.some(item => item.id === state.followUpConversationId);
            state = {
                ...state,
                status: 'idle',
                reason: 'attention_idle',
                updatedAt: nowIso,
                accountConversationVersions: versions,
                followUpConversationId: followUpStillPresent ? state.followUpConversationId : null,
                followUpSince: followUpStillPresent ? state.followUpSince : null,
                lastError: null
            };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }

        const changed = activity.changed;
        if (changed.detailStatus && changed.detailStatus !== 200) {
            const retryVersions = { ...versions };
            delete retryVersions[changed.id];
            state = { ...state, status: 'error', reason: 'conversation_detail_failed', updatedAt: nowIso, accountConversationVersions: retryVersions, lastError: `conversation detail HTTP ${changed.detailStatus}` };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }

        if (changed.attentionState === 'waiting' || (changed.recovery && changed.consent)) {
            if (!changed.consent) {
                state = { ...state, status: 'needs_human', reason: 'attention_waiting_unmatched', updatedAt: nowIso, currentConversationId: changed.id, accountConversationVersions: versions, lastError: null };
                this.save(state);
                return { ...publicStatus(this.settings, state), newResponse: false };
            }
            const approval = await this.consentApprover(changed.consent).catch(error => ({ ok: false, reason: String(error?.message || error) }));
            if (!approval?.ok) {
                const retryVersions = { ...versions };
                delete retryVersions[changed.id];
                state = { ...state, status: 'error', reason: 'jit_consent_allow_failed', updatedAt: nowIso, currentConversationId: changed.id, accountConversationVersions: retryVersions, lastError: String(approval?.reason || 'approval_failed') };
                this.save(state);
                return { ...publicStatus(this.settings, state), newResponse: false, approval };
            }
            state = {
                ...state,
                status: 'generating',
                reason: 'jit_consent_allowed',
                updatedAt: nowIso,
                currentConversationId: changed.id,
                accountConversationVersions: versions,
                followUpConversationId: changed.id,
                followUpSince: nowIso,
                lastError: null
            };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false, approval };
        }

        const completion = changed.completion;
        if (!completion || !completion.text) {
            const shouldFollow = changed.followUp === true || (changed.recovery === true && changed.sawInProgress === true);
            state = {
                ...state,
                status: shouldFollow ? 'generating' : 'stabilizing',
                reason: shouldFollow ? 'consent_followup_in_progress' : (changed.recovery ? 'consent_recovery_clear' : 'unread_without_terminal_response'),
                updatedAt: nowIso,
                currentConversationId: changed.id,
                accountConversationVersions: versions,
                followUpConversationId: shouldFollow ? changed.id : null,
                followUpSince: shouldFollow ? (state.followUpSince || nowIso) : null,
                lastError: null
            };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }

        const fp = fingerprint(changed.id, `${completion.messageId || ''}\0${completion.text}`);
        if (normalizeRecentFingerprints(state.recentFingerprints).includes(fp)) {
            state = { ...state, status: 'completed', reason: 'response_seen_before', updatedAt: nowIso, currentConversationId: changed.id, accountConversationVersions: versions, lastCompletedFingerprint: fp, lastCompletedAt: nowIso, recentFingerprints: rememberFingerprint(state, fp), followUpConversationId: null, followUpSince: null, lastError: null };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }

        state = {
            ...state,
            version: 3,
            status: 'completed',
            reason: 'new_response',
            updatedAt: nowIso,
            currentConversationId: changed.id,
            accountConversationVersions: versions,
            lastCompletedFingerprint: fp,
            lastCompletedAt: nowIso,
            recentFingerprints: rememberFingerprint(state, fp),
            latest: {
                conversationId: changed.id,
                url: changed.route ? `https://chatgpt.com${changed.route}` : `https://chatgpt.com/c/${changed.id}`,
                fingerprint: fp,
                text: String(completion.text),
                chars: Number(completion.chars || String(completion.text).length),
                completedAt: completion.completedAt ? new Date(Number(completion.completedAt) * 1000).toISOString() : nowIso
            },
            pendingFingerprint: fp,
            pendingSince: nowIso,
            ackedAt: null,
            followUpConversationId: null,
            followUpSince: null,
            lastError: null
        };
        this.save(state);
        return { ...publicStatus(this.settings, state), newResponse: true, baseline: false };
    }

    async poll() {
        if (this.useAccountMode) return await this.pollAccount();
        let state = this.getState();
        const nowMs = this.now();
        const nowIso = new Date(nowMs).toISOString();
        if (!this.settings.enabled) return { ...publicStatus(this.settings, state), newResponse: false };

        let snap;
        try { snap = await this.snapshotReader(); }
        catch (error) {
            state = { ...state, status: 'error', reason: 'snapshot_failed', updatedAt: nowIso, lastError: String(error?.message || error).slice(0, 500) };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }

        const currentId = conversationIdFromUrl(snap.url);
        const configuredId = conversationIdFromUrl(this.settings.conversationUrl);
        const previousId = state.currentConversationId;
        const conversationChanged = Boolean(currentId && currentId !== previousId);
        const common = { ...state, version: 3, updatedAt: nowIso, currentConversationId: currentId, lastError: null };
        const finish = (patch, extra = {}) => {
            state = { ...common, ...patch };
            state.recentFingerprints = normalizeRecentFingerprints(state.recentFingerprints);
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false, ...extra };
        };
        const resetConversation = {
            candidateFingerprint: null,
            candidateSince: null,
            conversationSince: null,
            conversationSawGenerating: false,
            primedConversationId: null
        };

        if (!snap.authenticated) return finish({ status: 'needs_human', reason: 'authentication_required', ...resetConversation });
        if (configuredId && currentId !== configuredId) return finish({ status: 'needs_human', reason: 'configured_conversation_not_open', ...resetConversation });
        if (!currentId) return finish({ status: 'idle', reason: 'conversation_not_open', ...resetConversation });

        if (conversationChanged) {
            const hasAssistantResponse = Boolean(String(snap.assistantText || '').trim());
            return finish({
                status: 'stabilizing',
                reason: 'conversation_changed',
                candidateFingerprint: null,
                candidateSince: null,
                conversationSince: nowIso,
                conversationSawGenerating: false,
                primedConversationId: hasAssistantResponse ? null : currentId
            });
        }

        if (snap.generating) {
            return finish({
                status: 'generating',
                reason: 'assistant_generating',
                candidateFingerprint: null,
                candidateSince: null,
                conversationSince: state.conversationSince || nowIso,
                conversationSawGenerating: true
            });
        }

        const text = String(snap.assistantText || '').trim();
        if (!text) return finish({ status: 'idle', reason: 'no_assistant_response', candidateFingerprint: null, candidateSince: null });

        const fp = fingerprint(currentId, text);
        if (state.candidateFingerprint !== fp) return finish({ status: 'stabilizing', reason: 'response_candidate_changed', candidateFingerprint: fp, candidateSince: nowIso });
        const since = Date.parse(state.candidateSince || '');
        if (!Number.isFinite(since) || nowMs - since < this.settings.stableMs) return finish({ status: 'stabilizing', reason: 'waiting_for_stability' });

        const primed = state.primedConversationId === currentId;
        const sawGenerating = state.conversationSawGenerating === true;
        if (!primed && !sawGenerating) {
            let openedAt = Date.parse(state.conversationSince || '');
            if (!Number.isFinite(openedAt)) {
                return finish({ status: 'stabilizing', reason: 'conversation_warming_up', conversationSince: nowIso });
            }
            if (nowMs - openedAt < this.settings.primeMs) {
                return finish({ status: 'stabilizing', reason: 'conversation_warming_up' });
            }
            state = {
                ...common,
                status: 'completed',
                reason: 'baseline_recorded',
                primedConversationId: currentId,
                conversationSawGenerating: false,
                lastCompletedFingerprint: fp,
                lastCompletedAt: nowIso,
                recentFingerprints: rememberFingerprint(state, fp),
                latest: state.pendingFingerprint ? state.latest : { conversationId: currentId, url: snap.url, fingerprint: fp, text, chars: text.length, completedAt: nowIso }
            };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false, baseline: true };
        }

        const seenBefore = normalizeRecentFingerprints(state.recentFingerprints).includes(fp);
        if (seenBefore) {
            state = {
                ...common,
                status: 'completed',
                reason: 'response_seen_before',
                primedConversationId: currentId,
                conversationSawGenerating: false,
                lastCompletedFingerprint: fp,
                lastCompletedAt: nowIso,
                recentFingerprints: rememberFingerprint(state, fp)
            };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false };
        }

        state = {
            ...common,
            status: 'completed',
            reason: 'new_response',
            primedConversationId: currentId,
            conversationSawGenerating: false,
            lastCompletedFingerprint: fp,
            lastCompletedAt: nowIso,
            recentFingerprints: rememberFingerprint(state, fp),
            latest: { conversationId: currentId, url: snap.url, fingerprint: fp, text, chars: text.length, completedAt: nowIso },
            pendingFingerprint: fp,
            pendingSince: nowIso,
            ackedAt: null
        };
        this.save(state);
        return { ...publicStatus(this.settings, state), newResponse: true, baseline: false };
    }

}

module.exports = { ChatGPTWebWatcher, allowTargetMessageId, approveJitConsent, buildJitAllowPayload, conversationIdFromUrl, fingerprint, readAccountActivity, readSnapshot, readState, resolveChatGPTWebConfig, selectCdpTarget, writeStateAtomic };
