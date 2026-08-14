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
    for (const bad of ['3000abc', '1e3', '3000.7', 3000.7, '0', 0, '65536', '-1', '0x10', '', '   ']) {
        assert.throws(
            () => normalizePort(bad),
            /Configuration port must be an integer between 1 and 65535/
        );
    }
    console.log('PASS malformed ports such as 3000abc are rejected; zero-padded decimals remain valid');

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
