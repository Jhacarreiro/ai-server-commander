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

    assert.strictEqual(normalizePort('00001'), 1);
    assert.strictEqual(normalizePort('09999'), 9999);
    assert.strictEqual(normalizePort('3000'), 3000);
    assert.strictEqual(normalizePort(3000), 3000);
    assert.strictEqual(normalizePort(' 08080 '), 8080);
    assert.strictEqual(normalizePort('65535'), 65535);
    console.log('PASS malformed ports such as 3000abc are rejected; zero-padded decimals remain valid');

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

    const legacyPortPath = path.join(root, 'legacy-port.json');
    fs.writeFileSync(legacyPortPath, JSON.stringify({
        port: '3000abc',
        useLocalTunnel: false,
        productionDomain: 'https://legacy.example.com',
        authToken: 'e'.repeat(64),
        mcpToken: 'f'.repeat(64)
    }));
    const repaired = loadConfigFile(legacyPortPath);
    assert.strictEqual(repaired.port, 3000);
    assert.strictEqual(repaired.productionDomain, 'https://legacy.example.com');
    assert.strictEqual(repaired.authToken, 'e'.repeat(64));
    const persisted = JSON.parse(fs.readFileSync(legacyPortPath, 'utf8'));
    assert.strictEqual(persisted.port, 3000);
    console.log('PASS legacy persisted port is repaired to 3000 without dropping secrets');

        const retryPath = path.join(root, 'retry.json');
    const retryAnswers = [
        '3000abc', 'https://retry.example.com',
        'notaport', 'https://retry.example.com',
        '4200', '',
        '4200', 'https://retry.example.com/'
    ];
    const retryErrors = [];
    const originalError = console.error;
    console.error = (...args) => {
        retryErrors.push(args.map(String).join(' '));
    };
    let retried;
    try {
        retried = await createConfig({
            configPath: retryPath,
            ask: async () => {
                assert.strictEqual(fs.existsSync(retryPath), false, 'must not write config before valid input');
                if (retryAnswers.length === 0) {
                    throw new Error('ask exhausted before valid answers');
                }
                return retryAnswers.shift();
            }
        });
    } finally {
        console.error = originalError;
    }
    assert.strictEqual(retried.port, 4200);
    assert.strictEqual(retried.productionDomain, 'https://retry.example.com');
    assert.ok(fs.existsSync(retryPath));
    assert.ok(retryErrors.some((line) => /Invalid input:.*integer between 1 and 65535/.test(line)));
    assert.ok(retryErrors.some((line) => /Invalid input:.*valid HTTP or HTTPS URL/.test(line)));
    assert.ok(retryErrors.some((line) => line === 'Please try again.'));
    assert.strictEqual(retryAnswers.length, 0);
    console.log('PASS wizard retries malformed port and empty origin and writes only after success');

    const cancelPath = path.join(root, 'cancelled.json');
    const abortOnFirst = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
    });
    await assert.rejects(
        () => createConfig({
            configPath: cancelPath,
            ask: async () => {
                throw abortOnFirst;
            }
        }),
        (error) => error.message === 'Setup cancelled.' && error.code === 'SETUP_CANCELLED' && error.name !== 'AbortError'
    );
    assert.strictEqual(fs.existsSync(cancelPath), false);

    const abortOnSecond = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
    });
    let secondPrompt = 0;
    await assert.rejects(
        () => createConfig({
            configPath: cancelPath,
            ask: async () => {
                secondPrompt += 1;
                if (secondPrompt === 1) {
                    return '3000';
                }
                throw abortOnSecond;
            }
        }),
        (error) => error.message === 'Setup cancelled.' && error.code === 'SETUP_CANCELLED'
    );
    assert.strictEqual(secondPrompt, 2);
    assert.strictEqual(fs.existsSync(cancelPath), false);
    console.log('PASS wizard treats Ctrl-D/EOF AbortError as a clean cancellation without writing config');

    fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
