const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatGPTWebWatcher, allowTargetMessageId, approveJitConsent, buildJitAllowPayload, conversationIdFromUrl, readState, resolveChatGPTWebConfig, selectCdpTarget } = require('../serverModules/chatgptWebWatcher');
const { nextPollDelay } = require('../api/chatgptWeb');

const snap = (overrides = {}) => ({
    url: 'https://chatgpt.com/c/conv-1', authenticated: true, assistantText: 'Answer A', generating: false, ...overrides
});

(async () => {
    assert.strictEqual(conversationIdFromUrl('https://chatgpt.com/c/abc'), 'abc');
    assert.strictEqual(resolveChatGPTWebConfig({}, {}).enabled, false);
    assert.strictEqual(resolveChatGPTWebConfig({}, {}).primeMs, 20000);
    assert.strictEqual(resolveChatGPTWebConfig({ productionDomain: 'https://terminal.example.com' }, {}).approvalDomain, 'terminal.example.com');
    assert.strictEqual((await approveJitConsent({ approvalDomain: 'terminal.example.com' }, { domain: 'other.example.com', operation: 'runTerminalScript' })).reason, 'approval_domain_mismatch');
    assert.strictEqual((await approveJitConsent({ approvalDomain: 'terminal.example.com' }, { domain: 'terminal.example.com', operation: 'otherOperation' })).reason, 'approval_operation_mismatch');
    assert.strictEqual(allowTargetMessageId([
        { name: 'deny', deny: { target_message_id: 'deny-target' } },
        { name: 'allow', allow: { target_message_id: 'allow-target' } }
    ]), 'allow-target');
    assert.strictEqual(allowTargetMessageId([
        { name: 'allow', allow_once: { target_message_id: 'once-target' } }
    ]), 'once-target');
    const allowPayload = buildJitAllowPayload({
        conversationId: 'conv-jit',
        confirmMessageId: 'confirm-jit',
        targetMessageId: 'target-jit',
        modelSlug: 'model-jit',
        gizmoId: 'gizmo-jit'
    });
    assert.strictEqual(allowPayload.conversation_id, 'conv-jit');
    assert.strictEqual(allowPayload.parent_message_id, 'target-jit');
    assert.strictEqual(allowPayload.messages[0].author.role, 'tool');
    assert.strictEqual(allowPayload.messages[0].author.name, 'api_tool.call_tool');
    assert.strictEqual(allowPayload.messages[0].metadata.jit_plugin_data.from_client.type, 'allow');
    assert.strictEqual(allowPayload.messages[0].metadata.jit_plugin_data.from_client.target_message_id, 'target-jit');
    assert.strictEqual(allowPayload.messages[0].metadata.jit_plugin_data.from_client.remember_answer, false);
    assert.strictEqual(nextPollDelay({ settings: { conversationUrl: null, pollMs: 5000 } }, null), 5000);
    assert.strictEqual(nextPollDelay({ settings: { conversationUrl: 'https://chatgpt.com/c/x', pollMs: 5000 } }, null), 5000);
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

    // Attention mode: idle baseline does no detail work; waiting triggers a narrowly
    // allowlisted JIT approval; unread triggers completion delivery exactly once.
    const accountStatePath = path.join(dir, 'attention-state.json');
    let accountNow = Date.parse('2026-09-30T13:00:00Z');
    let attentionStep = 0;
    let approvalCalls = 0;
    const consent = {
        conversationId: 'acct-1',
        confirmMessageId: 'confirm-1',
        targetMessageId: 'target-1',
        authorRole: 'tool',
        authorName: 'terminal-tool',
        modelSlug: 'model-x',
        gizmoId: 'gizmo-x',
        domain: 'terminal.example.com',
        operation: 'runTerminalScript',
        requestId: 'req-1'
    };
    const attentionReader = async (knownVersions) => {
        attentionStep += 1;
        if (attentionStep === 1) {
            return {
                authenticated: true,
                authStatus: 200,
                sourceAvailable: true,
                conversations: [
                    { id: 'acct-1', title: 'One', attentionState: 'idle', recencyAt: 1, route: '/c/acct-1', version: 'idle|1' },
                    { id: 'acct-2', title: 'Two', attentionState: 'idle', recencyAt: 1, route: '/c/acct-2', version: 'idle|1' }
                ],
                changed: null
            };
        }
        if (attentionStep === 2) {
            assert.strictEqual(knownVersions['acct-1'], 'idle|1');
            return {
                authenticated: true,
                authStatus: 200,
                sourceAvailable: true,
                conversations: [
                    { id: 'acct-1', title: 'One', attentionState: 'waiting', recencyAt: 2, route: '/c/acct-1', version: 'waiting|2' },
                    { id: 'acct-2', title: 'Two', attentionState: 'idle', recencyAt: 1, route: '/c/acct-2', version: 'idle|1' }
                ],
                changed: { id: 'acct-1', attentionState: 'waiting', recencyAt: 2, route: '/c/acct-1', version: 'waiting|2', detailStatus: 200, consent, completion: null }
            };
        }
        if (attentionStep === 3) {
            assert.strictEqual(knownVersions['acct-1'], 'waiting|2');
            return {
                authenticated: true,
                authStatus: 200,
                sourceAvailable: true,
                conversations: [
                    { id: 'acct-1', title: 'One', attentionState: 'unread', recencyAt: 3, route: '/c/acct-1', version: 'unread|3' },
                    { id: 'acct-2', title: 'Two', attentionState: 'idle', recencyAt: 1, route: '/c/acct-2', version: 'idle|1' }
                ],
                changed: {
                    id: 'acct-1',
                    attentionState: 'unread',
                    recencyAt: 3,
                    route: '/c/acct-1',
                    version: 'unread|3',
                    detailStatus: 200,
                    consent: null,
                    completion: { messageId: 'msg-final', text: 'Finished answer', chars: 15, completedAt: 1790773200 }
                }
            };
        }
        return {
            authenticated: true,
            authStatus: 200,
            sourceAvailable: true,
            conversations: [
                { id: 'acct-1', title: 'One', attentionState: 'unread', recencyAt: 3, route: '/c/acct-1', version: 'unread|3' },
                { id: 'acct-2', title: 'Two', attentionState: 'idle', recencyAt: 1, route: '/c/acct-2', version: 'idle|1' }
            ],
            changed: null
        };
    };
    const accountWatcher = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: accountStatePath, conversationUrl: null, approvalDomain: 'terminal.example.com' },
        accountReader: attentionReader,
        consentApprover: async value => {
            approvalCalls += 1;
            assert.deepStrictEqual(value, consent);
            return { ok: true, status: 200, reason: 'allowed' };
        },
        now: () => accountNow
    });
    let accountResult = await accountWatcher.poll();
    assert.strictEqual(accountResult.reason, 'attention_baseline_recorded');
    assert.strictEqual(accountResult.newResponse, false);
    assert.strictEqual(approvalCalls, 0);
    accountNow += 5000;
    accountResult = await accountWatcher.poll();
    assert.strictEqual(accountResult.reason, 'jit_consent_allowed');
    assert.strictEqual(accountResult.status, 'generating');
    assert.strictEqual(approvalCalls, 1);
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
    assert.strictEqual(accountResult.reason, 'attention_idle');
    assert.strictEqual(accountWatcher.getPending().pending, null);

    // Regression: after a JIT allow, the sidebar may return to idle and never show unread.
    // Follow only that approved conversation until its terminal assistant response appears.
    const followPath = path.join(dir, 'attention-followup.json');
    let followStep = 0;
    let followNow = Date.parse('2026-09-30T14:00:00Z');
    let followApprovals = 0;
    const followConsent = { ...consent, conversationId: 'acct-follow', confirmMessageId: 'confirm-follow', targetMessageId: 'target-follow' };
    const followReader = async (knownVersions, followUpConversationId) => {
        followStep += 1;
        if (followStep === 1) {
            return {
                authenticated: true, authStatus: 200, sourceAvailable: true,
                conversations: [{ id: 'acct-follow', attentionState: 'idle', recencyAt: 1, route: '/g/g-x/c/acct-follow', latestAssistantTurnCreatedAt: null, version: 'idle|1' }],
                changed: null
            };
        }
        if (followStep === 2) {
            assert.strictEqual(followUpConversationId, null);
            return {
                authenticated: true, authStatus: 200, sourceAvailable: true,
                conversations: [{ id: 'acct-follow', attentionState: 'waiting', recencyAt: 2, route: '/g/g-x/c/acct-follow', latestAssistantTurnCreatedAt: null, version: 'waiting|2' }],
                changed: { id: 'acct-follow', attentionState: 'waiting', recencyAt: 2, route: '/g/g-x/c/acct-follow', version: 'waiting|2', detailStatus: 200, consent: followConsent, completion: null, sawInProgress: true }
            };
        }
        if (followStep === 3) {
            assert.strictEqual(followUpConversationId, 'acct-follow');
            return {
                authenticated: true, authStatus: 200, sourceAvailable: true,
                conversations: [{ id: 'acct-follow', attentionState: 'idle', recencyAt: 3, route: '/g/g-x/c/acct-follow', latestAssistantTurnCreatedAt: null, version: 'idle|3' }],
                changed: { id: 'acct-follow', attentionState: 'idle', recencyAt: 3, route: '/g/g-x/c/acct-follow', version: 'idle|3', detailStatus: 200, consent: null, completion: null, sawInProgress: true, followUp: true }
            };
        }
        assert.strictEqual(followUpConversationId, 'acct-follow');
        return {
            authenticated: true, authStatus: 200, sourceAvailable: true,
            conversations: [{ id: 'acct-follow', attentionState: 'idle', recencyAt: 4, route: '/g/g-x/c/acct-follow', latestAssistantTurnCreatedAt: null, version: 'idle|4' }],
            changed: {
                id: 'acct-follow', attentionState: 'idle', recencyAt: 4, route: '/g/g-x/c/acct-follow', version: 'idle|4', detailStatus: 200,
                consent: null, sawInProgress: false, followUp: true,
                completion: { messageId: 'follow-final', text: 'Follow-up finished', chars: 18, completedAt: 1790776800 }
            }
        };
    };
    const followWatcher = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: followPath, conversationUrl: null, approvalDomain: 'terminal.example.com' },
        accountReader: followReader,
        consentApprover: async value => {
            followApprovals += 1;
            assert.deepStrictEqual(value, followConsent);
            return { ok: true, status: 200, reason: 'allowed' };
        },
        now: () => followNow
    });
    assert.strictEqual((await followWatcher.poll()).reason, 'attention_baseline_recorded');
    followNow += 5000;
    assert.strictEqual((await followWatcher.poll()).reason, 'jit_consent_allowed');
    assert.strictEqual(followApprovals, 1);
    assert.strictEqual(readState(followPath).followUpConversationId, 'acct-follow');
    followNow += 5000;
    const followProgress = await followWatcher.poll();
    assert.strictEqual(followProgress.reason, 'consent_followup_in_progress');
    assert.strictEqual(followProgress.status, 'generating');
    followNow += 5000;
    const followDone = await followWatcher.poll();
    assert.strictEqual(followDone.reason, 'new_response');
    assert.strictEqual(followDone.newResponse, true);
    assert.strictEqual(followWatcher.getPending().pending.text, 'Follow-up finished');
    assert.strictEqual(readState(followPath).followUpConversationId, null);

    // Recovery: a recent idle GPT conversation with no assistant turn gets one backend check.
    const recoveryPath = path.join(dir, 'attention-recovery.json');
    let recoveryStep = 0;
    const recoveryWatcher = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: recoveryPath, conversationUrl: null, approvalDomain: 'terminal.example.com' },
        accountReader: async (knownVersions, followUpConversationId) => {
            recoveryStep += 1;
            if (recoveryStep === 1) {
                return { authenticated: true, authStatus: 200, sourceAvailable: true, conversations: [{ id: 'acct-r', attentionState: 'idle', recencyAt: 1, route: '/g/g-x/c/acct-r', latestAssistantTurnCreatedAt: null, version: 'idle|1' }], changed: null };
            }
            if (recoveryStep === 2) {
                assert.strictEqual(followUpConversationId, null);
                assert.strictEqual(knownVersions['acct-r'], 'idle|1');
                return { authenticated: true, authStatus: 200, sourceAvailable: true, conversations: [{ id: 'acct-r', attentionState: 'idle', recencyAt: 2, route: '/g/g-x/c/acct-r', latestAssistantTurnCreatedAt: null, version: 'idle|2' }], changed: { id: 'acct-r', attentionState: 'idle', recencyAt: 2, route: '/g/g-x/c/acct-r', version: 'idle|2', recovery: true, detailStatus: 200, consent: null, completion: null, sawInProgress: true } };
            }
            assert.strictEqual(followUpConversationId, 'acct-r');
            return { authenticated: true, authStatus: 200, sourceAvailable: true, conversations: [{ id: 'acct-r', attentionState: 'idle', recencyAt: 3, route: '/g/g-x/c/acct-r', latestAssistantTurnCreatedAt: null, version: 'idle|3' }], changed: { id: 'acct-r', attentionState: 'idle', recencyAt: 3, route: '/g/g-x/c/acct-r', version: 'idle|3', followUp: true, detailStatus: 200, consent: null, sawInProgress: false, completion: { messageId: 'r-final', text: 'Recovered response', chars: 18, completedAt: 1790776900 } } };
        },
        now: () => followNow
    });
    assert.strictEqual((await recoveryWatcher.poll()).reason, 'attention_baseline_recorded');
    followNow += 5000;
    assert.strictEqual((await recoveryWatcher.poll()).reason, 'consent_followup_in_progress');
    assert.strictEqual(readState(recoveryPath).followUpConversationId, 'acct-r');
    followNow += 5000;
    assert.strictEqual((await recoveryWatcher.poll()).reason, 'new_response');
    assert.strictEqual(recoveryWatcher.getPending().pending.text, 'Recovered response');

    // Regression: recovery may find the terminal answer immediately, without an intermediate in-progress poll.
    const recoveryDonePath = path.join(dir, 'attention-recovery-done.json');
    let recoveryDoneStep = 0;
    const recoveryDoneWatcher = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: recoveryDonePath, conversationUrl: null, approvalDomain: 'terminal.example.com' },
        accountReader: async () => {
            recoveryDoneStep += 1;
            if (recoveryDoneStep === 1) {
                return { authenticated: true, authStatus: 200, sourceAvailable: true, conversations: [{ id: 'acct-rd', attentionState: 'idle', recencyAt: 1, route: '/g/g-x/c/acct-rd', latestAssistantTurnCreatedAt: null, version: 'idle|1' }], changed: null };
            }
            return { authenticated: true, authStatus: 200, sourceAvailable: true, conversations: [{ id: 'acct-rd', attentionState: 'idle', recencyAt: 2, route: '/g/g-x/c/acct-rd', latestAssistantTurnCreatedAt: null, version: 'idle|2' }], changed: { id: 'acct-rd', attentionState: 'idle', recencyAt: 2, route: '/g/g-x/c/acct-rd', version: 'idle|2', recovery: true, detailStatus: 200, consent: null, sawInProgress: false, completion: { messageId: 'rd-final', text: 'Recovered immediately', chars: 21, completedAt: 1790777000 } } };
        },
        now: () => followNow
    });
    assert.strictEqual((await recoveryDoneWatcher.poll()).reason, 'attention_baseline_recorded');
    followNow += 5000;
    const recoveryDone = await recoveryDoneWatcher.poll();
    assert.strictEqual(recoveryDone.reason, 'new_response');
    assert.strictEqual(recoveryDone.newResponse, true);
    assert.strictEqual(recoveryDoneWatcher.getPending().pending.text, 'Recovered immediately');

    const unmatchedPath = path.join(dir, 'attention-unmatched.json');
    let unmatchedStep = 0;
    const unmatchedWatcher = new ChatGPTWebWatcher({
        settings: { ...settings, statePath: unmatchedPath, conversationUrl: null, approvalDomain: 'terminal.example.com' },
        accountReader: async () => {
            unmatchedStep += 1;
            if (unmatchedStep === 1) {
                return {
                    authenticated: true, authStatus: 200, sourceAvailable: true,
                    conversations: [{ id: 'acct-x', attentionState: 'idle', recencyAt: 1, route: '/c/acct-x', version: 'idle|1' }], changed: null
                };
            }
            return {
                authenticated: true, authStatus: 200, sourceAvailable: true,
                conversations: [{ id: 'acct-x', attentionState: 'waiting', recencyAt: 2, route: '/c/acct-x', version: 'waiting|2' }],
                changed: { id: 'acct-x', attentionState: 'waiting', recencyAt: 2, route: '/c/acct-x', version: 'waiting|2', detailStatus: 200, consent: null, completion: null }
            };
        },
        consentApprover: async () => { throw new Error('must not approve unmatched waiting state'); },
        now: () => accountNow
    });
    assert.strictEqual((await unmatchedWatcher.poll()).reason, 'attention_baseline_recorded');
    const unmatchedResult = await unmatchedWatcher.poll();
    assert.strictEqual(unmatchedResult.status, 'needs_human');
    assert.strictEqual(unmatchedResult.reason, 'attention_waiting_unmatched');

    assert.strictEqual(nextPollDelay({ settings: { pollMs: 5000 } }, null), 5000);

    console.log('PASS chatgpt-web exact-once tab + account watcher behavior');
})().catch(error => { console.error(error); process.exit(1); });
