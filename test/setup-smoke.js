const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-setup-'));
const bootstrapPath = path.join(root, 'bootstrap.json');
fs.writeFileSync(bootstrapPath, JSON.stringify({
    port: 3000,
    useLocalTunnel: false,
    productionDomain: 'https://commander.example.com',
    authToken: 'a'.repeat(64),
    mcpToken: 'b'.repeat(64)
}));
process.env.CONFIG_FILE_PATH = bootstrapPath;

const {
    createConfig,
    loadConfigFile,
    validateConfig
} = require('../serverModules/configHandler');

(async () => {
    const loaded = loadConfigFile(bootstrapPath);
    assert.strictEqual(loaded.port, 3000);
    assert.strictEqual(loaded.productionDomain, 'https://commander.example.com');
    assert.strictEqual(loaded.useLocalTunnel, false);
    console.log('PASS existing configuration loads and normalizes');

    const bomPath = path.join(root, 'bom-config.json');
    const bomSource = {
        port: 3200,
        useLocalTunnel: false,
        productionDomain: 'https://bom.example.com',
        authToken: 'c'.repeat(64),
        mcpToken: 'd'.repeat(64)
    };
    fs.writeFileSync(bomPath, Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(JSON.stringify(bomSource), 'utf8')
    ]));
    const bomBytes = fs.readFileSync(bomPath);
    assert.ok(bomBytes[0] === 0xEF && bomBytes[1] === 0xBB && bomBytes[2] === 0xBF);
    assert.throws(() => JSON.parse(bomBytes.toString('utf8')));
    const bomLoaded = loadConfigFile(bomPath);
    assert.strictEqual(bomLoaded.port, 3200);
    assert.strictEqual(bomLoaded.productionDomain, 'https://bom.example.com');
    assert.strictEqual(bomLoaded.useLocalTunnel, false);
    assert.strictEqual(bomLoaded.authToken, bomSource.authToken);
    assert.strictEqual(bomLoaded.mcpToken, bomSource.mcpToken);
    console.log('PASS UTF-8 BOM-prefixed configuration loads and preserves validated settings');

    assert.throws(() => validateConfig({
        port: 3000,
        useLocalTunnel: true,
        productionDomain: 'https://commander.example.com',
        authToken: 'a'.repeat(64)
    }), /LocalTunnel support was removed/);
    console.log('PASS legacy LocalTunnel configuration fails with migration guidance');

    const createdPath = path.join(root, 'created.json');
    const answers = ['4100', 'https://new.example.com/'];
    const created = await createConfig({
        configPath: createdPath,
        ask: async () => answers.shift()
    });
    assert.strictEqual(created.port, 4100);
    assert.strictEqual(created.productionDomain, 'https://new.example.com');
    assert.strictEqual(created.authToken.length, 64);
    assert.strictEqual(created.mcpToken.length, 64);
    assert.strictEqual(fs.statSync(createdPath).mode & 0o777, 0o600);
    console.log('PASS native setup writes separate 64-character tokens with mode 600');

    fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
