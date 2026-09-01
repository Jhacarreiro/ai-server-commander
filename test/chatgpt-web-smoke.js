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

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-cgpt-'));
    const statePath = path.join(dir, 'state.json');
    let now = Date.parse('2026-09-01T08:00:00Z');
    let current = snap();
    const settings = { enabled: true, cdpEndpoint: 'http://127.0.0.1:9223', conversationUrl: null, stableMs: 1000, pollMs: 5000, statePath, emitInitial: false };
    const watcher = new ChatGPTWebWatcher({ settings, snapshotReader: async () => current, now: () => now });

    let r = await watcher.poll();
    assert.strictEqual(r.status, 'stabilizing');
    now += 1000;
    r = await watcher.poll();
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.baseline, true);
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(fs.statSync(statePath).mode & 0o777, 0o600);

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
    const pending = watcher.getPending();
    assert.strictEqual(pending.pending.text, 'Answer B complete');
    assert.strictEqual(pending.pending.fingerprint, watcher.getLatest().latest.fingerprint);

    const restarted = new ChatGPTWebWatcher({ settings, snapshotReader: async () => current, now: () => now + 1000 });
    r = await restarted.poll();
    assert.strictEqual(r.reason, 'response_already_seen');
    assert.strictEqual(r.newResponse, false);
    assert.strictEqual(restarted.getLatest().latest.text, 'Answer B complete');
    assert.strictEqual(restarted.getPending().pending.text, 'Answer B complete');
    const wrongAck = restarted.ack('wrong');
    assert.strictEqual(wrongAck.acked, false);
    assert.strictEqual(wrongAck.reason, 'fingerprint_mismatch');
    const goodAck = restarted.ack(restarted.getPending().pending.fingerprint);
    assert.strictEqual(goodAck.acked, true);
    assert.strictEqual(restarted.getPending().pending, null);

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

    console.log('PASS chatgpt-web watcher baseline, stability, durable pending/ack, dedup, restart and needs_human behavior');
})().catch(error => { console.error(error); process.exit(1); });
