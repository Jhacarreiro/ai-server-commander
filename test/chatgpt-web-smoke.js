const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatGPTWebWatcher, conversationIdFromUrl, readState, resolveChatGPTWebConfig, selectCdpTarget } = require('../serverModules/chatgptWebWatcher');

const snap = (overrides = {}) => ({
    url: 'https://chatgpt.com/c/conv-1', authenticated: true, assistantText: 'Answer A', generating: false, ...overrides
});

(async () => {
    assert.strictEqual(conversationIdFromUrl('https://chatgpt.com/c/abc'), 'abc');
    assert.strictEqual(resolveChatGPTWebConfig({}, {}).enabled, false);
    assert.strictEqual(resolveChatGPTWebConfig({}, {}).primeMs, 20000);
    const selected = selectCdpTarget([
        { type: 'page', url: 'https://chatgpt.com/c/other', webSocketDebuggerUrl: 'ws://other' },
        { type: 'page', url: 'https://chatgpt.com/c/conv-1', webSocketDebuggerUrl: 'ws://wanted' }
    ], { conversationUrl: 'https://chatgpt.com/c/conv-1' });
    assert.strictEqual(selected.webSocketDebuggerUrl, 'ws://wanted');
    const preferredConversation = selectCdpTarget([
        { type: 'page', url: 'https://chatgpt.com/c/conv-2', webSocketDebuggerUrl: 'ws://conversation' },
        { type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://home' }
    ], { conversationUrl: null });
    assert.strictEqual(preferredConversation.webSocketDebuggerUrl, 'ws://conversation');


    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-cgpt-'));
    const statePath = path.join(dir, 'state.json');
    let now = Date.parse('2026-09-01T08:00:00Z');
    let current = snap();
    const settings = {
        enabled: true,
        cdpEndpoint: 'http://127.0.0.1:9223',
        conversationUrl: null,
        stableMs: 1000,
        primeMs: 2000,
        pollMs: 5000,
        statePath,
        emitInitial: false
    };
    const watcher = new ChatGPTWebWatcher({ settings, snapshotReader: async () => current, now: () => now });

    // Opening an existing conversation is always primed as baseline first.
    let r = await watcher.poll();
    assert.strictEqual(r.status, 'stabilizing');
    assert.strictEqual(r.reason, 'conversation_changed');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_candidate_changed');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.reason, 'baseline_recorded');
    assert.strictEqual(r.baseline, true);
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.strictEqual(watcher.getPending().pending, null);

    // A genuine generation in the already-primed conversation is emitted.
    current = snap({ generating: true, assistantText: 'Answer B partial' });
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.status, 'generating');

    current = snap({ assistantText: 'Answer B complete' });
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.status, 'stabilizing');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.newResponse, true);
    assert.strictEqual(r.reason, 'new_response');
    const firstPending = watcher.getPending().pending;
    assert.strictEqual(firstPending.text, 'Answer B complete');

    // Pending survives restart and ACK is durable.
    const restarted = new ChatGPTWebWatcher({ settings, snapshotReader: async () => current, now: () => now + 1000 });
    r = await restarted.poll();
    assert.strictEqual(r.reason, 'response_seen_before');
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(restarted.getPending().pending.text, 'Answer B complete');
    const wrongAck = restarted.ack('wrong');
    assert.strictEqual(wrongAck.acked, false);
    assert.strictEqual(wrongAck.reason, 'fingerprint_mismatch');
    const goodAck = restarted.ack(firstPending.fingerprint);
    assert.strictEqual(goodAck.acked, true);
    assert.strictEqual(restarted.getPending().pending, null);

    // Regression: lazy-load oscillation A -> B -> A never re-emits an already seen fingerprint.
    current = snap({ assistantText: 'Answer A' });
    now += 2000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_candidate_changed');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_seen_before');
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(watcher.getPending().pending, null);

    current = snap({ assistantText: 'Answer B complete' });
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_candidate_changed');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_seen_before');
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(watcher.getPending().pending, null);

    current = snap({ assistantText: 'Answer A' });
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_candidate_changed');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_seen_before');
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(watcher.getPending().pending, null);

    // Regression: switching to another existing conversation records a baseline, not a notification.
    current = snap({ url: 'https://chatgpt.com/c/conv-2', assistantText: 'Old answer in conv 2' });
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'conversation_changed');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'response_candidate_changed');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.reason, 'baseline_recorded');
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(watcher.getPending().pending, null);

    // Regression: a brand-new conversation with no assistant response primes immediately,
    // so the first stable assistant response emits even if the busy state was not observed.
    const newChatState = path.join(dir, 'new-chat.json');
    let newChatNow = Date.parse('2026-01-01T01:00:00.000Z');
    let newChatCurrent = snap({ url: 'https://chatgpt.com/c/new-chat', assistantText: '' });
    const newChatWatcher = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: newChatState, primeMs: 20000 },
        snapshotReader: async () => newChatCurrent,
        now: () => newChatNow
    });
    let newChatResult = await newChatWatcher.poll();
    assert.strictEqual(newChatResult.reason, 'conversation_changed');
    assert.strictEqual(readState(newChatState).primedConversationId, 'new-chat');
    newChatCurrent = snap({ url: 'https://chatgpt.com/c/new-chat', assistantText: 'First answer' });
    newChatNow += 1000;
    newChatResult = await newChatWatcher.poll();
    assert.strictEqual(newChatResult.reason, 'response_candidate_changed');
    newChatNow += 1000;
    newChatResult = await newChatWatcher.poll();
    assert.strictEqual(newChatResult.reason, 'new_response');
    assert.strictEqual(newChatResult.newResponse, true);
    assert.strictEqual(newChatWatcher.getPending().pending.text, 'First answer');

    // New response in conv-2 still emits normally after priming.
    current = snap({ url: 'https://chatgpt.com/c/conv-2', generating: true, assistantText: 'New conv 2 partial' });
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.status, 'generating');
    current = snap({ url: 'https://chatgpt.com/c/conv-2', assistantText: 'New conv 2 complete' });
    now += 1000;
    await watcher.poll();
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.newResponse, true);
    assert.strictEqual(watcher.getPending().pending.text, 'New conv 2 complete');

    // Needs-human behavior remains unchanged.
    current = snap({ authenticated: false });
    now += 2000;
    r = await watcher.poll();
    assert.strictEqual(r.status, 'needs_human');
    assert.strictEqual(r.reason, 'authentication_required');

    const mismatch = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: path.join(dir, 'mismatch.json'), conversationUrl: 'https://chatgpt.com/c/expected' },
        snapshotReader: async () => snap({ url: 'https://chatgpt.com/c/other' }), now: () => now
    });
    r = await mismatch.poll();
    assert.strictEqual(r.reason, 'configured_conversation_not_open');

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(persisted.version, 3);
    assert.ok(Array.isArray(persisted.recentFingerprints));
    assert.ok(persisted.recentFingerprints.length >= 3);
    assert.ok(persisted.recentFingerprints.length <= 64);

    // Account mode: baseline existing recent conversations without notifying,
    // observe an in-progress update, then emit exactly once when the same
    // conversation acquires a terminal assistant reply.
    const accountStatePath = path.join(dir, 'account-state.json');
    let accountNow = Date.parse('2026-09-30T13:00:00Z');
    let accountStep = 0;
    const accountReader = async (knownVersions) => {
        accountStep += 1;
        if (accountStep === 1) {
            return {
                authenticated: true,
                authStatus: 200,
                listStatus: 200,
                conversations: [
                    { id: 'acct-1', version: 'v1|', updateTime: 'v1', asyncStatus: null },
                    { id: 'acct-2', version: 'v1|', updateTime: 'v1', asyncStatus: null }
                ],
                changed: { id: 'acct-2', version: 'v1|', detailStatus: 200, sawInProgress: false, completion: { messageId: 'old', text: 'Old answer', chars: 10 } }
            };
        }
        if (accountStep === 2) {
            assert.strictEqual(knownVersions['acct-1'], 'v1|');
            return {
                authenticated: true,
                authStatus: 200,
                listStatus: 200,
                conversations: [
                    { id: 'acct-1', version: 'v2|3', updateTime: 'v2', asyncStatus: 3 },
                    { id: 'acct-2', version: 'v1|', updateTime: 'v1', asyncStatus: null }
                ],
                changed: { id: 'acct-1', version: 'v2|3', detailStatus: 200, sawInProgress: true, completion: null }
            };
        }
        if (accountStep === 3) {
            assert.strictEqual(knownVersions['acct-1'], 'v2|3');
            return {
                authenticated: true,
                authStatus: 200,
                listStatus: 200,
                conversations: [
                    { id: 'acct-1', version: 'v3|', updateTime: 'v3', asyncStatus: null },
                    { id: 'acct-2', version: 'v1|', updateTime: 'v1', asyncStatus: null }
                ],
                changed: {
                    id: 'acct-1',
                    version: 'v3|',
                    detailStatus: 200,
                    sawInProgress: false,
                    completion: { messageId: 'msg-final', text: 'Finished answer', chars: 15, completedAt: 1790773200 }
                }
            };
        }
        return {
            authenticated: true,
            authStatus: 200,
            listStatus: 200,
            conversations: [
                { id: 'acct-1', version: 'v3|', updateTime: 'v3', asyncStatus: null },
                { id: 'acct-2', version: 'v1|', updateTime: 'v1', asyncStatus: null }
            ],
            changed: null
        };
    };
    const accountWatcher = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: accountStatePath, conversationUrl: null },
        accountReader,
        now: () => accountNow
    });
    let accountResult = await accountWatcher.poll();
    assert.strictEqual(accountResult.reason, 'account_baseline_recorded');
    assert.strictEqual(accountResult.newResponse, false);
    assert.strictEqual(accountWatcher.getPending().pending, null);
    accountNow += 5000;
    accountResult = await accountWatcher.poll();
    assert.strictEqual(accountResult.reason, 'account_response_in_progress');
    assert.strictEqual(accountResult.status, 'generating');
    accountNow += 5000;
    accountResult = await accountWatcher.poll();
    assert.strictEqual(accountResult.reason, 'new_response');
    assert.strictEqual(accountResult.newResponse, true);
    const accountPending = accountWatcher.getPending().pending;
    assert.strictEqual(accountPending.conversationId, 'acct-1');
    assert.strictEqual(accountPending.text, 'Finished answer');
    assert.strictEqual(accountWatcher.ack(accountPending.fingerprint).acked, true);
    accountNow += 5000;
    accountResult = await accountWatcher.poll();
    assert.strictEqual(accountResult.reason, 'account_no_changes');
    assert.strictEqual(accountWatcher.getPending().pending, null);

    console.log('PASS chatgpt-web exact-once tab + account watcher behavior');
})().catch(error => { console.error(error); process.exit(1); });
