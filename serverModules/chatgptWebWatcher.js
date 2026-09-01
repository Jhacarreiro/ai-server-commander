const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, 'runtime', 'chatgpt-web-state.json');

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
        pollMs: int(env.CHATGPT_WEB_POLL_MS ?? local.pollMs, 5000),
        statePath: path.isAbsolute(String(stateRaw)) ? String(stateRaw) : path.resolve(PROJECT_ROOT, String(stateRaw)),
        emitInitial: bool(env.CHATGPT_WEB_EMIT_INITIAL ?? local.emitInitial, false)
    };
}

function fingerprint(conversationId, text) {
    return crypto.createHash('sha256').update(String(conversationId || 'unknown')).update('\0').update(String(text || '')).digest('hex');
}

function blankState() {
    return {
        version: 1,
        status: 'idle',
        reason: 'not_polled',
        updatedAt: null,
        currentConversationId: null,
        candidateFingerprint: null,
        candidateSince: null,
        lastCompletedFingerprint: null,
        lastCompletedAt: null,
        latest: null,
        pendingFingerprint: null,
        pendingSince: null,
        ackedAt: null,
        lastError: null
    };
}

function readState(filePath) {
    try { return { ...blankState(), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) }; }
    catch { return blankState(); }
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
        pollMs: settings.pollMs,
        stableMs: settings.stableMs,
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

async function readSnapshot(settings) {
    const { CDPBridge } = await import('@jackwener/opencli/browser/cdp');
    const bridge = new CDPBridge();
    const page = await bridge.connect({ cdpEndpoint: settings.cdpEndpoint, timeout: 10 });
    try {
        return await page.evaluate(`(async () => {
            const session = await fetch('/api/auth/session', { credentials: 'include' })
                .then(async r => ({ ok: r.ok, status: r.status, body: r.ok ? await r.json().catch(() => null) : null }))
                .catch(() => ({ ok: false, status: 0, body: null }));
            const body = session.body;
            const authenticated = Boolean(session.ok && body && typeof body === 'object' && Object.keys(body).length > 0);
            const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
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
            return { url: location.href, authenticated, authStatus: session.status, assistantText, assistantCount: nodes.length, generating };
        })()`);
    } finally {
        await bridge.close();
    }
}

class ChatGPTWebWatcher {
    constructor({ settings, snapshotReader, now } = {}) {
        this.settings = settings || resolveChatGPTWebConfig();
        this.snapshotReader = snapshotReader || (() => readSnapshot(this.settings));
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

    async poll() {
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
        const common = { ...state, updatedAt: nowIso, currentConversationId: currentId, lastError: null };
        const finish = (patch, extra = {}) => {
            state = { ...common, ...patch };
            this.save(state);
            return { ...publicStatus(this.settings, state), newResponse: false, ...extra };
        };

        if (!snap.authenticated) return finish({ status: 'needs_human', reason: 'authentication_required', candidateFingerprint: null, candidateSince: null });
        if (configuredId && currentId !== configuredId) return finish({ status: 'needs_human', reason: 'configured_conversation_not_open', candidateFingerprint: null, candidateSince: null });
        if (!currentId) return finish({ status: 'idle', reason: 'conversation_not_open', candidateFingerprint: null, candidateSince: null });
        if (snap.generating) return finish({ status: 'generating', reason: 'assistant_generating', candidateFingerprint: null, candidateSince: null });

        const text = String(snap.assistantText || '').trim();
        if (!text) return finish({ status: 'idle', reason: 'no_assistant_response', candidateFingerprint: null, candidateSince: null });

        const fp = fingerprint(currentId, text);
        if (state.candidateFingerprint !== fp) return finish({ status: 'stabilizing', reason: 'response_candidate_changed', candidateFingerprint: fp, candidateSince: nowIso });
        const since = Date.parse(state.candidateSince || '');
        if (!Number.isFinite(since) || nowMs - since < this.settings.stableMs) return finish({ status: 'stabilizing', reason: 'waiting_for_stability' });

        const first = !state.lastCompletedFingerprint;
        const changed = state.lastCompletedFingerprint !== fp;
        const newResponse = changed && (!first || this.settings.emitInitial);
        if (changed) {
            state = {
                ...common,
                status: 'completed',
                reason: first && !this.settings.emitInitial ? 'baseline_recorded' : 'new_response',
                lastCompletedFingerprint: fp,
                lastCompletedAt: nowIso,
                latest: { conversationId: currentId, url: snap.url, fingerprint: fp, text, chars: text.length, completedAt: nowIso },
                pendingFingerprint: newResponse ? fp : state.pendingFingerprint,
                pendingSince: newResponse ? nowIso : state.pendingSince,
                ackedAt: newResponse ? null : state.ackedAt
            };
        } else {
            state = { ...common, status: 'completed', reason: 'response_already_seen' };
        }
        this.save(state);
        return { ...publicStatus(this.settings, state), newResponse, baseline: changed && first && !this.settings.emitInitial };
    }
}

module.exports = { ChatGPTWebWatcher, conversationIdFromUrl, fingerprint, readState, resolveChatGPTWebConfig, writeStateAtomic };
