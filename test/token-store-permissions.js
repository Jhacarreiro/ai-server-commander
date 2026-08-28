const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createToken } = require('../serverModules/fileAccessHandler');

const root = path.resolve(__dirname, '..');
const storePath = path.join(root, 'tokenStore.json');
const backupPath = path.join(root, 'tokenStore.json.test-backup');

(async () => {
    if (fs.existsSync(storePath)) fs.copyFileSync(storePath, backupPath);
    try {
        // Fresh-store creation path: with no tokenStore.json present,
        // createToken must create it directly with mode 0600.
        if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
        createToken(() => 'http://127.0.0.1:1', '/tmp/fresh-store.txt');
        assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o600, 'freshly created token store is private (0600)');
        const freshStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        assert.strictEqual(Object.keys(freshStore).length, 1, 'token persisted to fresh store');
        console.log('PASS fresh tokenStore.json created with mode 0600');

        // Simulate a pre-existing permissive token store from before the
        // 0600 fix: writeFileSync mode only applies on creation.
        fs.writeFileSync(storePath, '{}', { encoding: 'utf8', mode: 0o644 });
        fs.chmodSync(storePath, 0o644);
        assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o644, 'precondition: store starts permissive');

        createToken(() => 'http://127.0.0.1:1', '/tmp/example.txt');

        assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o600, 'existing token store tightened to 0600 after write');
        const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        assert.strictEqual(Object.keys(store).length, 1, 'token persisted to store');
        console.log('PASS existing tokenStore.json tightened to 0600');

        // A second write keeps the tightened mode.
        createToken(() => 'http://127.0.0.1:1', '/tmp/example2.txt');
        assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o600, 'mode stays 0600 across subsequent writes');
        console.log('PASS mode stays 0600 across subsequent writes');

        const { spawnSync } = require('child_process');
        const check = (name) => spawnSync('git', ['-C', root, 'check-ignore', '-q', name]).status === 0;
        assert.strictEqual(check('tokenStore.json'), true, 'tokenStore.json is ignored');
        assert.strictEqual(check('tokenStore.json.test-backup'), true, 'tokenStore.json.test-backup is ignored');
        assert.strictEqual(check('tokenStore.json.1234.abcd.tmp'), true, 'atomic tmp sidecar is ignored');
        console.log('PASS tokenStore.json and sidecars are gitignored');
    } finally {
        if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, storePath);
            fs.unlinkSync(backupPath);
        } else if (fs.existsSync(storePath)) {
            fs.unlinkSync(storePath);
        }
    }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
