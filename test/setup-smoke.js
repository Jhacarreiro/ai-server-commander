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
    normalizePort,
    validateConfig
} = require('../serverModules/configHandler');

(async () => {
    const loaded = loadConfigFile(bootstrapPath);
    assert.strictEqual(loaded.port, 3000);
    assert.strictEqual(loaded.productionDomain, 'https://commander.example.com');
    assert.strictEqual(loaded.useLocalTunnel, false);
    console.log('PASS existing configuration loads and normalizes');

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

    assert.strictEqual(normalizePort('00001'), 1);
    assert.strictEqual(normalizePort('09999'), 9999);
    assert.strictEqual(normalizePort('3000'), 3000);
    assert.strictEqual(normalizePort(3000), 3000);
    assert.strictEqual(normalizePort(' 08080 '), 8080);
    assert.strictEqual(normalizePort('65535'), 65535);
    console.log('PASS in-range decimal ports including zero-padded strings normalize');

    const paddedPath = path.join(root, 'padded.json');
    fs.writeFileSync(paddedPath, JSON.stringify({
        port: '00001',
        useLocalTunnel: false,
        productionDomain: 'https://commander.example.com',
        authToken: 'a'.repeat(64)
    }));
    assert.strictEqual(loadConfigFile(paddedPath).port, 1);
    assert.strictEqual(validateConfig({
        port: '09999',
        useLocalTunnel: false,
        productionDomain: 'https://commander.example.com',
        authToken: 'a'.repeat(64)
    }).port, 9999);
    console.log('PASS config file and validateConfig accept zero-padded port strings');

    const wizardPaddedPath = path.join(root, 'wizard-padded.json');
    const paddedAnswers = ['00001', 'https://wizard.example.com'];
    const paddedCreated = await createConfig({
        configPath: wizardPaddedPath,
        ask: async () => paddedAnswers.shift()
    });
    assert.strictEqual(paddedCreated.port, 1);
    console.log('PASS wizard accepts zero-padded port string');

    for (const bad of ['3000abc', '1e3', '3000.7', 3000.7, '0', 0, '65536', '-1', '0x10', '', '   ']) {
        assert.throws(
            () => normalizePort(bad),
            /Configuration port must be an integer between 1 and 65535/
        );
    }
    console.log('PASS malformed and out-of-range port values are rejected');

    fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
