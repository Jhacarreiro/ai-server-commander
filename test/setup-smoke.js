const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-setup-'));
const bootstrapPath = path.join(root, 'bootstrap.json');
fs.writeFileSync(bootstrapPath, JSON.stringify({
    port: 3000,
    host: '127.0.0.1',
    useLocalTunnel: false,
    productionDomain: 'https://commander.example.com',
    authToken: 'a'.repeat(64),
    mcpToken: 'b'.repeat(64)
}));
process.env.CONFIG_FILE_PATH = bootstrapPath;

const {
    createConfig,
    formatListenUrl,
    loadConfigFile,
    validateConfig
} = require('../serverModules/configHandler');

function baseConfig(overrides = {}) {
    return {
        port: 3000,
        host: '127.0.0.1',
        useLocalTunnel: false,
        productionDomain: 'https://commander.example.com',
        authToken: 'a'.repeat(64),
        ...overrides
    };
}

function requestListen(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, text }));
        }).on('error', reject);
    });
}

async function listenAndRequest(host) {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, resolve);
    });
    try {
        const port = server.address().port;
        const url = formatListenUrl(host, port);
        const response = await requestListen(url);
        assert.strictEqual(response.status, 200, url);
        assert.strictEqual(response.text, 'ok', url);
        return url;
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function waitForLog(logPath, needle, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (fs.existsSync(logPath)) {
            const text = fs.readFileSync(logPath, 'utf8');
            if (text.includes(needle)) return text;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : `missing log waiting for ${needle}`);
}

(async () => {
    const loaded = loadConfigFile(bootstrapPath);
    assert.strictEqual(loaded.port, 3000);
    assert.strictEqual(loaded.host, '127.0.0.1');
    assert.strictEqual(loaded.productionDomain, 'https://commander.example.com');
    assert.strictEqual(loaded.useLocalTunnel, false);
    console.log('PASS existing configuration loads and normalizes');

    const bomPath = path.join(root, 'bom-config.json');
    const bomSource = {
        port: 3200,
        host: '127.0.0.1',
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

    assert.throws(() => validateConfig(baseConfig({ host: undefined })), /host is required.*bound all interfaces/);
    assert.throws(() => validateConfig(baseConfig({ host: '' })), /host is required/);
    const hostlessPath = path.join(root, 'hostless.json');
    fs.writeFileSync(hostlessPath, JSON.stringify(baseConfig({ host: undefined })));
    assert.throws(() => loadConfigFile(hostlessPath), /host is required.*0\.0\.0\.0/);
    console.log('PASS hostless configuration fails with migration guidance');

    const ipv6 = validateConfig(baseConfig({ host: '::1' }));
    assert.strictEqual(ipv6.host, '::1');
    const allInterfaces = validateConfig(baseConfig({ host: '0.0.0.0' }));
    assert.strictEqual(allInterfaces.host, '0.0.0.0');
    console.log('PASS explicit loopback, IPv6 and all-interface hosts are accepted');

    assert.strictEqual(formatListenUrl('127.0.0.1', 3000), 'http://127.0.0.1:3000');
    assert.strictEqual(formatListenUrl('localhost', 3000), 'http://localhost:3000');
    assert.strictEqual(formatListenUrl('::1', 3000), 'http://[::1]:3000');
    assert.strictEqual(formatListenUrl('::', 3000), 'http://[::]:3000');
    assert.strictEqual(formatListenUrl('[::1]', 3000), 'http://[::1]:3000');
    console.log('PASS listen URLs wrap IPv6 literals');

    const ipv4Url = await listenAndRequest('127.0.0.1');
    assert.ok(ipv4Url.startsWith('http://127.0.0.1:'));
    const ipv6Url = await listenAndRequest('::1');
    assert.ok(ipv6Url.startsWith('http://[::1]:'));
    console.log('PASS live bind and request succeed for IPv4 and IPv6 listen URLs');

    const createdPath = path.join(root, 'created.json');
    const answers = ['4100', 'https://new.example.com/'];
    const created = await createConfig({
        configPath: createdPath,
        ask: async () => answers.shift()
    });
    assert.strictEqual(created.port, 4100);
    assert.strictEqual(created.host, '127.0.0.1');
    assert.strictEqual(created.productionDomain, 'https://new.example.com');
    assert.strictEqual(created.authToken.length, 64);
    assert.strictEqual(created.mcpToken.length, 64);
    assert.strictEqual(fs.statSync(createdPath).mode & 0o777, 0o600);
    assert.strictEqual(JSON.parse(fs.readFileSync(createdPath, 'utf8')).host, '127.0.0.1');
    console.log('PASS native setup writes host 127.0.0.1 and separate 64-character tokens with mode 600');

    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-listen-'));
    const liveConfig = path.join(liveDir, 'config.json');
    const liveLog = path.join(liveDir, 'server.log');
    const livePort = 33120;
    fs.writeFileSync(liveConfig, JSON.stringify({
        port: livePort,
        host: '::1',
        useLocalTunnel: false,
        productionDomain: `http://127.0.0.1:${livePort}`,
        authToken: 'c'.repeat(64),
        mcpToken: 'd'.repeat(64)
    }));
    const liveOut = fs.openSync(liveLog, 'a');
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'main.js')], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, CONFIG_FILE_PATH: liveConfig },
        stdio: ['ignore', liveOut, liveOut]
    });
    try {
        const startupLog = await waitForLog(liveLog, 'Server running on ');
        assert.ok(startupLog.includes('Server running on http://[::1]:' + livePort), startupLog);
        const openapi = await requestListen(`http://[::1]:${livePort}/openapi.json`);
        assert.strictEqual(openapi.status, 200, openapi.text.slice(0, 200));
        console.log('PASS live IPv6 startup log and OpenAPI request');
    } finally {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
            child.once('exit', resolve);
            setTimeout(resolve, 2000);
        });
        fs.closeSync(liveOut);
        fs.rmSync(liveDir, { recursive: true, force: true });
    }

    fs.rmSync(root, { recursive: true, force: true });
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
