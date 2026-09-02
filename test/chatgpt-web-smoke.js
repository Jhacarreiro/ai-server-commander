const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatGPTWebWatcher, conversationIdFromUrl, resolveChatGPTWebConfig } = require('../serverModules/chatgptWebWatcher');

const snap = (overrides = {}) => ({
    url: 'https://chatgpt.com/c/conv-1', authenticated: true, assistantText: 'Answer A', generating: false, ...overrides
});

(async () => {
    assert.strictEqual(conversationIdFromUrl('https://chatgpt.com/c/abc'), 'abc');
    assert.strictEqual(resolveChatGPTWebConfig({}, {}).enabled, false);
    assert.strictEqual(resolveChatGPTWebConfig({}, {}).primeMs, 20000);

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
    assert.strictEqual(persisted.version, 2);
    assert.ok(Array.isArray(persisted.recentFingerprints));
    assert.ok(persisted.recentFingerprints.length >= 3);
    assert.ok(persisted.recentFingerprints.length <= 64);

    console.log('PASS chatgpt-web exact-once history, per-conversation priming, stability, durable pending/ack, restart and needs_human behavior');
})().catch(error => { console.error(error); process.exit(1); });
