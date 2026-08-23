const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(label) {
    console.log('PASS ' + label);
}

function request(port, method, pathName, { token, body, timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathName,
            method,
            agent: false,
            headers: {
                Authorization: `Bearer ${token}`,
                Connection: 'close',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            },
            timeout
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let parsed = text;
                try { parsed = JSON.parse(text); } catch (_) {}
                resolve({ status: res.statusCode, body: parsed, text });
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function probeAccept(port) {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/',
            method: 'GET',
            agent: false,
            timeout: 1000
        }, (res) => {
            res.resume();
            resolve({ accepted: true, status: res.statusCode });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ accepted: false, code: 'TIMEOUT' });
        });
        req.on('error', (err) => resolve({ accepted: false, code: err.code || 'ERROR', message: err.message }));
        req.end();
    });
}

async function testHandlerWaitsForClose() {
    const originalExit = process.exit;
    const exits = [];
    process.exit = () => { exits.push(Date.now()); };
    delete process.env.RESTART_FORCE_EXIT_MS;
    try {
        const handler = require('../api/exitApplicationHandler');
        let finish;
        const close = (cb) => { finish = cb; };
        const started = Date.now();
        handler(close)({}, { json() {} });
        await delay(650);
        assert.strictEqual(exits.length, 0, 'handler force-exited at 500ms while close was still pending');
        finish();
        await delay(20);
        assert.strictEqual(exits.length, 1, 'handler did not exit after close completed');
        assert.ok(exits[0] - started >= 100, 'handler exited before the response-flush delay');
        pass('handler waits for close instead of force-exiting at 500ms');
    } finally {
        process.exit = originalExit;
    }
}

async function testHandlerForceExitBound() {
    const originalExit = process.exit;
    const exits = [];
    process.exit = () => { exits.push(Date.now()); };
    process.env.RESTART_FORCE_EXIT_MS = '250';
    try {
        const handler = require('../api/exitApplicationHandler');
        const started = Date.now();
        handler(() => {})({}, { json() {} });
        await delay(650);
        assert.strictEqual(exits.length, 1, 'handler never applied the last-resort exit bound');
        const elapsed = exits[0] - started;
        assert.ok(elapsed >= 300, 'last-resort exit fired before close delay + bound: ' + elapsed);
        assert.ok(elapsed < 650, 'last-resort exit took too long: ' + elapsed);
        pass('handler last-resort exit bound still applies if close never finishes');
    } finally {
        delete process.env.RESTART_FORCE_EXIT_MS;
        process.exit = originalExit;
    }
}

async function testLiveRestartDrain() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-restart-'));
    const configPath = path.join(temp, 'config.json');
    const port = Number(process.env.TEST_PORT || 33141);
    const token = process.env.TEST_TOKEN || 't'.repeat(64);
    fs.writeFileSync(configPath, JSON.stringify({
        port,
        useLocalTunnel: false,
        productionDomain: `http://127.0.0.1:${port}`,
        authToken: token,
        mcpToken: 'm'.repeat(64)
    }, null, 2) + '\n');

    const child = spawn(process.execPath, ['main.js'], {
        cwd: root,
        env: {
            ...process.env,
            CONFIG_FILE_PATH: configPath,
            SAFE_MODE: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exitPromise = new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
    });

    const transcript = [];
    const mark = (line) => {
        transcript.push(line);
        console.log(line);
    };

    try {
        const readyDeadline = Date.now() + 10000;
        while (Date.now() < readyDeadline) {
            if (output.includes('Server running')) break;
            await delay(50);
        }
        if (!output.includes('Server running')) {
            throw new Error('server did not start:\n' + output);
        }
        mark('restart transcript:');
        const t0 = Date.now();
        const stamp = (label) => mark(`  t+${Date.now() - t0}ms ${label}`);

        const inFlight = request(port, 'POST', '/v1/commands/execute', {
            token,
            body: { mode: 'inline', command: 'sleep 1.2 && printf drain_ok', timeoutMs: 5000 },
            timeout: 8000
        }).then((result) => {
            stamp(`in-flight command completed status=${result.status} output=${JSON.stringify(result.body && result.body.output)}`);
            return result;
        }).catch((err) => {
            stamp(`in-flight command failed: ${err.code || err.message}`);
            throw err;
        });
        stamp('in-flight command started (sleep 1.2)');
        await delay(120);

        const restart = await request(port, 'POST', '/api/restart', { token, timeout: 3000 });
        stamp(`POST /api/restart -> ${restart.status} ${JSON.stringify(restart.body)}`);
        assert.strictEqual(restart.status, 200, JSON.stringify(restart.body));
        assert.strictEqual(restart.body && restart.body.message, 'Exiting application...');

        await delay(250);
        const probe = await probeAccept(port);
        stamp(`new-accept probe -> ${probe.accepted ? 'accepted status=' + probe.status : (probe.code || 'refused')}`);
        assert.strictEqual(probe.accepted, false, 'listener still accepted a new connection after close');

        await delay(400);
        assert.strictEqual(child.exitCode, null, 'server process already exited before the old 500ms hard-exit window elapsed');
        stamp('server process still alive after 500ms (past the old hard-exit window)');

        const inFlightResult = await inFlight;
        assert.strictEqual(inFlightResult.status, 200, JSON.stringify(inFlightResult.body));
        assert.strictEqual(inFlightResult.body && inFlightResult.body.output, 'drain_ok', JSON.stringify(inFlightResult.body));
        assert.strictEqual(inFlightResult.body.exitCode, 0, JSON.stringify(inFlightResult.body));

        const exited = await Promise.race([
            exitPromise,
            delay(4000).then(() => null)
        ]);
        assert.ok(exited, 'server process did not exit after in-flight drain');
        stamp(`server process exited code=${exited.code} signal=${exited.signal || 'none'}`);
        assert.strictEqual(exited.code, 0, `unexpected exit ${exited.code} ${exited.signal}\n${output}`);
        pass('live /api/restart closes listener, drains in-flight request, then exits');
    } finally {
        if (child.exitCode === null && !child.killed) {
            child.kill('SIGKILL');
            await exitPromise.catch(() => {});
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

(async () => {
    await testHandlerWaitsForClose();
    await testHandlerForceExitBound();
    await testLiveRestartDrain();
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
