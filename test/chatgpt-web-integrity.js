const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatGPTWebWatcher, fingerprint, readState, resolveChatGPTWebConfig, writeStateAtomic } = require('../serverModules/chatgptWebWatcher');
const { createChatGPTWebHandlers } = require('../api/chatgptWeb');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function response() {
    return { statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-watcher-integrity-'));
    try {
        const settings = resolveChatGPTWebConfig({ chatgptWeb: { enabled: true, statePath: path.join(dir, 'state.json') } }, {});
        assert.strictEqual(resolveChatGPTWebConfig({}, {}).enabled, false);
        assert.strictEqual(resolveChatGPTWebConfig({ chatgptWeb: { enabled: true } }, { CHATGPT_WEB_ENABLED: 'false' }).enabled, false);
        assert.strictEqual(resolveChatGPTWebConfig({ chatgptWeb: { enabled: false } }, { CHATGPT_WEB_ENABLED: 'true' }).enabled, true);
        for (const flag of ['off', 'no', '0', false]) {
            assert.strictEqual(resolveChatGPTWebConfig({ chatgptWeb: { enabled: flag } }, {}).enabled, false);
        }
        for (const flag of ['on', 'yes', '1', true]) {
            assert.strictEqual(resolveChatGPTWebConfig({ chatgptWeb: { enabled: flag } }, {}).enabled, true);
        }
        assert.throws(() => resolveChatGPTWebConfig({ chatgptWeb: { enabled: 'flase' } }, {}), /must be true or false/);
        assert.throws(() => resolveChatGPTWebConfig({ chatgptWeb: { enabled: null } }, {}), /must be true or false/);
        assert.throws(() => resolveChatGPTWebConfig({}, { CHATGPT_WEB_ENABLED: '' }), /must be true or false/);
        assert.throws(() => resolveChatGPTWebConfig({}, { CHATGPT_WEB_ENABLED: 'invalid' }), /must be true or false/);
        assert.throws(() => resolveChatGPTWebConfig({ chatgptWeb: true }, {}), /configuration object/);

        const now = Date.parse('2026-10-01T13:00:00Z');
        const iso = new Date(now).toISOString();
        const initial = readState(settings.statePath);
        assert.strictEqual(initial.version, 3); // Missing state initializes a first run.
        assert.deepStrictEqual(initial.recentFingerprints, []);
        const conversations = [{ id: 'account-1', version: 'unread|2', attentionState: 'unread' }];
        const completion = { messageId: 'message-1', text: 'Completed fixture answer' };
        const completedFingerprint = fingerprint('account-1', `${completion.messageId}\0${completion.text}`);
        const activity = { authenticated: true, sourceAvailable: true, conversations,
            changed: { id: 'account-1', version: 'unread|2', attentionState: 'unread', detailStatus: 200, completion } };
        writeStateAtomic(settings.statePath, { ...initial, accountPrimedAt: iso, accountConversationVersions: { 'account-1': 'idle|1' } });

        // Two simultaneous manual/background polls cannot emit the same response.
        // The ACK submitted while the first browser read is blocked waits for it.
        const entered = deferred();
        const release = deferred();
        let reads = 0;
        const watcher = new ChatGPTWebWatcher({ settings, now: () => now,
            accountReader: async () => { reads += 1; entered.resolve(); await release.promise; return activity; } });
        const firstPoll = watcher.poll();
        await entered.promise;
        const secondPoll = watcher.poll();
        let acknowledged = false;
        const queuedAck = watcher.ack(completedFingerprint).then(result => { acknowledged = true; return result; });
        await Promise.resolve();
        assert.strictEqual(reads, 1);
        assert.strictEqual(acknowledged, false);
        release.resolve();
        const [first, second, ack] = await Promise.all([firstPoll, secondPoll, queuedAck]);
        assert.deepStrictEqual([first.newResponse, second.newResponse], [true, false]);
        assert.strictEqual(reads, 1);
        assert.strictEqual(ack.acked, true);
        assert.strictEqual(watcher.getPending().pending, null);
        assert.strictEqual((await watcher.poll()).newResponse, false);
        assert.strictEqual(watcher.getPending().pending, null);

        // A tab poll must not resurrect an ACK with its pre-await state snapshot.
        const tabPath = path.join(dir, 'tab.json');
        const tabFingerprint = fingerprint('tab-1', 'Tab answer');
        writeStateAtomic(tabPath, { ...initial, currentConversationId: 'tab-1', primedConversationId: 'tab-1',
            candidateFingerprint: tabFingerprint, candidateSince: iso, recentFingerprints: [tabFingerprint],
            latest: { conversationId: 'tab-1', fingerprint: tabFingerprint, text: 'Tab answer' },
            pendingFingerprint: tabFingerprint, pendingSince: iso });
        const tabEntered = deferred();
        const tabRelease = deferred();
        const tabWatcher = new ChatGPTWebWatcher({ settings: { ...settings, statePath: tabPath }, now: () => now + 10000,
            snapshotReader: async () => { tabEntered.resolve(); await tabRelease.promise;
                return { authenticated: true, url: 'https://chatgpt.com/c/tab-1', assistantText: 'Tab answer', generating: false }; } });
        const tabPoll = tabWatcher.poll();
        await tabEntered.promise;
        const tabAck = tabWatcher.ack(tabFingerprint);
        tabRelease.resolve();
        assert.strictEqual((await tabPoll).newResponse, false);
        assert.strictEqual((await tabAck).acked, true);
        assert.strictEqual(readState(tabPath).pendingFingerprint, null);

        // Concurrent polls also serialize consent actions, before either saves.
        const consentPath = path.join(dir, 'consent.json');
        writeStateAtomic(consentPath, { ...initial, accountPrimedAt: iso, accountConversationVersions: { 'account-1': 'idle|1' } });
        let approvals = 0;
        const approvalEntered = deferred();
        const approvalRelease = deferred();
        const consentWatcher = new ChatGPTWebWatcher({ settings: { ...settings, statePath: consentPath }, now: () => now,
            accountReader: async known => ({ authenticated: true, sourceAvailable: true,
                conversations: [{ id: 'account-1', version: 'waiting|2', attentionState: 'waiting' }],
                changed: known['account-1'] === 'waiting|2' ? null
                    : { id: 'account-1', attentionState: 'waiting', detailStatus: 200, consent: { fixture: true } } }),
            consentApprover: async () => { approvals += 1; approvalEntered.resolve(); await approvalRelease.promise; return { ok: true }; } });
        const approvalPoll = consentWatcher.poll();
        await approvalEntered.promise;
        const queuedApprovalPoll = consentWatcher.poll();
        approvalRelease.resolve();
        await Promise.all([approvalPoll, queuedApprovalPoll]);
        assert.strictEqual(approvals, 1);

        // Corruption and I/O faults block browser access and never replace state.
        const corruptPath = path.join(dir, 'corrupt.json');
        let browserCalls = 0;
        const corruptWatcher = new ChatGPTWebWatcher({ settings: { ...settings, statePath: corruptPath },
            accountReader: async () => { browserCalls += 1; return activity; },
            consentApprover: async () => { throw new Error('must not approve with corrupt state'); } });
        const invalidStates = ['{"private":"do not expose this",', 'null', '[]', '{}',
            JSON.stringify({ ...initial, recentFingerprints: null }),
            JSON.stringify({ ...initial, accountConversationVersions: [] }),
            JSON.stringify({ ...initial, pendingFingerprint: 'missing-response' }),
            JSON.stringify({ ...initial, status: { private: 'invalid status' } }),
            JSON.stringify({ ...initial, accountPrimedAt: 'not-a-date' }),
            JSON.stringify({ ...initial, version: 99 })];
        for (const raw of invalidStates) {
            fs.writeFileSync(corruptPath, raw);
            assert.throws(() => readState(corruptPath), /Watcher state is invalid/);
            const fault = await corruptWatcher.poll();
            assert.strictEqual(fault.reason, 'state_invalid');
            assert.strictEqual(fault.newResponse, false);
            assert.strictEqual(corruptWatcher.getStatus().status, 'error');
            assert.strictEqual(corruptWatcher.getLatest().latest, null);
            assert.strictEqual(corruptWatcher.getPending().pending, null);
            assert.strictEqual((await corruptWatcher.ack('some-fingerprint')).reason, 'state_invalid');
            assert.ok(!JSON.stringify(fault).includes('do not expose this'));
            assert.strictEqual(fs.readFileSync(corruptPath, 'utf8'), raw);
        }
        assert.strictEqual(browserCalls, 0);
        const unreadableWatcher = new ChatGPTWebWatcher({ settings: { ...settings, statePath: dir },
            accountReader: async () => { throw new Error('must not read browser'); } });
        assert.strictEqual((await unreadableWatcher.poll()).reason, 'state_unreadable');

        // Restore the same valid state to recover without losing dedup or ACK.
        writeStateAtomic(corruptPath, readState(settings.statePath));
        assert.strictEqual((await corruptWatcher.poll()).newResponse, false);
        assert.strictEqual(corruptWatcher.getStatus().status, 'completed');
        assert.strictEqual(browserCalls, 1);
        writeStateAtomic(path.join(dir, 'legacy.json'), { version: 1, lastCompletedFingerprint: 'legacy-fingerprint' });
        assert.strictEqual(readState(path.join(dir, 'legacy.json')).lastCompletedFingerprint, 'legacy-fingerprint');

        // An unexpected failure does not prevent subsequent queued polls.
        let failOnce = true;
        const recoverQueue = new ChatGPTWebWatcher({ settings: { ...settings, statePath: path.join(dir, 'queue-recovery.json') },
            now: () => { if (failOnce) { failOnce = false; throw new Error('fixture failure'); } return now; },
            accountReader: async () => ({ authenticated: true, sourceAvailable: true, conversations: [], changed: null }) });
        await assert.rejects(recoverQueue.poll(), /fixture failure/);
        assert.strictEqual((await recoverQueue.poll()).reason, 'attention_baseline_recorded');

        // Disabled means no browser actions, no state I/O, and no destructive ACK.
        const beforeDisable = fs.readFileSync(settings.statePath);
        const disabledWatcher = new ChatGPTWebWatcher({ settings: { ...settings, enabled: false },
            accountReader: async () => { throw new Error('disabled browser read'); },
            consentApprover: async () => { throw new Error('disabled approval'); } });
        assert.strictEqual((await disabledWatcher.poll()).status, 'disabled');
        assert.strictEqual((await disabledWatcher.ack(completedFingerprint)).reason, 'disabled');
        assert.strictEqual(disabledWatcher.getStatus().status, 'disabled');
        assert.strictEqual(disabledWatcher.getLatest().latest, null);
        assert.strictEqual(disabledWatcher.getPending().pending, null);
        assert.deepStrictEqual(fs.readFileSync(settings.statePath), beforeDisable);
        const disabledCorrupt = new ChatGPTWebWatcher({ settings: { ...settings, enabled: false, statePath: dir } });
        assert.strictEqual((await disabledCorrupt.poll()).status, 'disabled');
        const enabledAgain = new ChatGPTWebWatcher({ settings, accountReader: async () => activity });
        assert.strictEqual((await enabledAgain.poll()).newResponse, false);

        // REST preserves the ACK contract and returns a recoverable 503 on faults.
        fs.writeFileSync(corruptPath, '{');
        const handlers = createChatGPTWebHandlers({ chatgptWeb: { enabled: true, statePath: corruptPath } });
        const ackRes = response();
        await handlers.ackHandler({ body: { fingerprint: 'fixture' } }, ackRes);
        assert.strictEqual(ackRes.statusCode, 503);
        assert.strictEqual(ackRes.body.reason, 'state_invalid');
        writeStateAtomic(corruptPath, readState(settings.statePath));
        const stored = readState(corruptPath);
        writeStateAtomic(corruptPath, { ...stored, pendingFingerprint: stored.latest.fingerprint });
        const goodAckRes = response();
        await handlers.ackHandler({ body: { fingerprint: stored.latest.fingerprint } }, goodAckRes);
        assert.strictEqual(goodAckRes.statusCode, 200);
        assert.strictEqual(goodAckRes.body.acked, true);
        const offHandlers = createChatGPTWebHandlers({ chatgptWeb: { enabled: false, statePath: corruptPath } });
        for (const handler of Object.values(offHandlers)) {
            const res = response();
            await handler({ body: {} }, res);
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.body.reason, 'disabled');
        }

        console.log('PASS watcher concurrency, state integrity, and enable/disable configuration');
    } finally {
        if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected fixture directory');
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
