const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-readonly-'));
const release = path.join(fixture, 'release');
const modules = path.join(release, 'serverModules');
const state = path.join(fixture, 'state');
const store = path.join(state, 'tokenStore.json');
try {
    fs.mkdirSync(modules, { recursive: true });
    fs.mkdirSync(state);
    for (const file of ['fileAccessHandler.js', 'logger.js', 'stringifyError.js']) {
        fs.copyFileSync(path.join(__dirname, '..', 'serverModules', file), path.join(modules, file));
        fs.chmodSync(path.join(modules, file), 0o444);
    }
    const oauth = '{"version":1,"clients":{"synthetic-client":{}}}\n';
    const activity = '{"event":"synthetic retained activity"}\n';
    fs.writeFileSync(path.join(state, 'oauth-state.json'), oauth);
    fs.writeFileSync(path.join(state, 'activity.jsonl'), activity);
    fs.chmodSync(modules, 0o555);
    fs.chmodSync(release, 0o555);
    const result = spawnSync(process.execPath, ['-e',
        'require(process.argv[1]).createToken(()=>"https://example.invalid",process.argv[2])',
        path.join(modules, 'fileAccessHandler.js'), path.join(state, 'document.txt')
    ], { encoding: 'utf8', env: { ...process.env, TOKEN_STORE_PATH: store } });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(store))).length, 1);
    assert.strictEqual(fs.statSync(store).mode & 0o777, 0o600);
    assert(!fs.existsSync(path.join(release, 'tokenStore.json')));
    assert.strictEqual(fs.readFileSync(path.join(state, 'oauth-state.json'), 'utf8'), oauth);
    assert.strictEqual(fs.readFileSync(path.join(state, 'activity.jsonl'), 'utf8'), activity);
    console.log('PASS share-link state can be written outside a read-only installation without altering OAuth or activity data');
} finally {
    fs.chmodSync(release, 0o755);
    fs.chmodSync(modules, 0o755);
    fs.rmSync(fixture, { recursive: true, force: true });
}
