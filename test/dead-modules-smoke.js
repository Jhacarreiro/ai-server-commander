const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// This branch owns deletion of the unregistered vector modules.
// Overlapping cleanup PR #7 edits api/sentenceVector.js and
// api/transformers.js in place (leaked request blob, getInstance
// return, undefined log()). Those in-place edits are superseded:
// the modules have zero requirers and are deleted here. Rebase #7
// and drop its changes to those two files.
const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33102);
const token = process.env.TEST_TOKEN || 't'.repeat(64);
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
const deletedModules = ['api/sentenceVector.js', 'api/transformers.js'];
// Distinctive working-tree markers from the deleted modules / leaked
// request blob. Do not reintroduce the cookie or token values.
const retiredMarkers = [
    'Xenova/bge-small-en',
    'js-ai-text-suggest-experiment',
    'handleSentenceVectors'
];
let server;

function writeTestConfig() {
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
    fs.writeFileSync(configPath, JSON.stringify({
        port,
        useLocalTunnel: false,
        productionDomain: `http://localhost:${port}`,
        authToken: token,
        localTunnelSubdomain: null
    }, null, 2) + '\n');
}

function restoreConfig() {
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
    } else if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
    }
}

function request(method, pathName, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathName,
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            },
            timeout: 12000
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let parsed = text;
                try { parsed = JSON.parse(text); } catch (_) {}
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function waitForServer(logPath) {
    const started = Date.now();
    while (Date.now() - started < 10000) {
        if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('Server running')) return;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'server log missing');
}

function pass(label) {
    console.log(`PASS ${label}`);
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full);
        if (entry.isDirectory()) {
            if (['.git', 'node_modules', 'runtime', '.claude-octopus'].includes(entry.name)) return [];
            return walk(full);
        }
        return [relative];
    });
}

(async () => {
    for (const relative of deletedModules) {
        assert.strictEqual(fs.existsSync(path.join(root, relative)), false, `${relative} must stay deleted`);
        pass(`${relative} is deleted`);
    }

    for (const relative of deletedModules) {
        const id = './' + relative.replace(/\.js$/, '');
        assert.throws(() => require(path.join(root, id)), (err) => err && err.code === 'MODULE_NOT_FOUND');
        pass(`require(${relative}) is MODULE_NOT_FOUND`);
    }

    const routesSrc = fs.readFileSync(path.join(root, 'serverModules/apiRoutes.js'), 'utf8');
    assert.strictEqual(/initDB/.test(routesSrc), false);
    assert.strictEqual(/sentenceVector/.test(routesSrc), false);
    assert.strictEqual(/transformers/.test(routesSrc), false);
    pass('apiRoutes does not import initDB or the deleted vector modules');

    const pluginSrc = fs.readFileSync(path.join(root, 'serverModules/pluginServer.js'), 'utf8');
    assert.match(pluginSrc, /require\(["']\.\/firebaseDB["']\)/);
    assert.match(pluginSrc, /initDB\s*\(/);
    pass('pluginServer still initializes Firebase via initDB');

    const textFiles = walk(root).filter((file) =>
        file !== 'test/dead-modules-smoke.js' &&
        /\.(?:md|js|json|yml|yaml|example)$/.test(file)
    );
    const markerHits = [];
    for (const relative of textFiles) {
        const text = fs.readFileSync(path.join(root, relative), 'utf8');
        for (const marker of retiredMarkers) {
            if (text.includes(marker)) markerHits.push(`${relative}: ${marker}`);
        }
    }
    assert.deepStrictEqual(markerHits, []);
    pass('retired vector-module markers are absent from the working tree');

    const logPath = '/tmp/asc-dead-modules-smoke.log';
    writeTestConfig();
    fs.rmSync(logPath, { force: true });
    const out = fs.openSync(logPath, 'a');
    server = spawn('node', ['main.js'], { cwd: root, stdio: ['ignore', out, out] });
    try {
        await waitForServer(logPath);
        const startupLog = fs.readFileSync(logPath, 'utf8');
        assert.match(startupLog, /Server running/);
        assert.doesNotMatch(startupLog, /sentenceVector|transformers\.js|Cannot find module/);
        pass('post-change server starts without the deleted modules');

        let r = await request('GET', '/api/runTerminalScript?command=printf%20hello_dead_modules');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.output, 'hello_dead_modules');
        assert.strictEqual(r.body.exitCode, 0);
        pass('registered route still works after dead-module deletion');

        r = await request('POST', '/api/sentence-vectors', { text: 'unused' });
        assert.strictEqual(r.status, 404);
        pass('unregistered sentence-vector path is 404');

        r = await request('POST', '/api/sentenceVector', { text: 'unused' });
        assert.strictEqual(r.status, 404);
        pass('camelCase sentenceVector path is 404');
    } finally {
        if (server) server.kill('SIGTERM');
        restoreConfig();
    }
})().catch((err) => {
    if (server) server.kill('SIGTERM');
    restoreConfig();
    console.error(err.stack || err.message);
    process.exit(1);
});
