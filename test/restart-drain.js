const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33106);
const token = process.env.TEST_TOKEN || 't'.repeat(64);
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
const logPath = '/tmp/asc-restart-drain.log';
const pidPath = `/tmp/asc-restart-drain-${process.pid}.pid`;
let server;

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

function writeTestConfig() {
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
    fs.writeFileSync(configPath, JSON.stringify({ port, productionDomain: `http://localhost:${port}`, authToken: token }, null, 2) + '\n');
}

function restoreConfig() {
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
    } else if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
    }
}

function post(agent, pathName, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request({
            hostname: '127.0.0.1', port, path: pathName, method: 'POST', agent,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function waitForServer() {
    const started = Date.now();
    while (Date.now() - started < 10000) {
        if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('Server running')) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'server log missing');
}

(async () => {
    writeTestConfig();
    fs.rmSync(logPath, { force: true });
    const out = fs.openSync(logPath, 'a');
    server = spawn('node', ['main.js'], { cwd: root, env: { ...process.env, RESTART_FORCE_EXIT_MS: '20000' }, stdio: ['ignore', out, out] });
    const exited = new Promise((resolve) => server.once('exit', () => resolve(Date.now())));
    try {
        await waitForServer();
        // Keep-alive clients hold their sockets open after a response, which is
        // what would otherwise stall the drain until the keep-alive timeout.
        const agent = new http.Agent({ keepAlive: true });
        // The running command ignores SIGTERM, so it also exercises the SIGKILL escalation.
        fs.rmSync(pidPath, { force: true });
        const inFlight = post(agent, '/v1/commands/execute', { command: `trap "" TERM; echo $$ > ${pidPath}; while true; do sleep 1; done`, timeoutMs: 60000 });
        for (let i = 0; i < 40 && !fs.existsSync(pidPath); i++) await new Promise((r) => setTimeout(r, 50));
        const commandPid = Number(fs.readFileSync(pidPath, 'utf8'));

        const restart = await post(agent, '/api/restart');
        assert(restart.status === 200, 'restart is acknowledged');

        const drained = await inFlight;
        const drainedAt = Date.now();
        assert(drained.status === 200 && drained.body.interrupted === true, 'running command is interrupted and its response is still delivered', JSON.stringify(drained.body));

        const exitedAt = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15000))]);
        assert(exitedAt !== null && exitedAt - drainedAt < 3000, 'process exits promptly once in-flight requests drain', exitedAt === null ? 'did not exit' : `${exitedAt - drainedAt}ms`);
        let survivor = false;
        try { process.kill(commandPid, 0); survivor = !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${commandPid}/stat`, 'utf8')); } catch { survivor = false; }
        assert(!survivor, 'no command process survives the restart', String(commandPid));
        agent.destroy();
    } finally {
        fs.rmSync(pidPath, { force: true });
        if (server && server.exitCode === null) server.kill('SIGTERM');
        restoreConfig();
    }
})().catch((error) => {
    if (server && server.exitCode === null) server.kill('SIGTERM');
    restoreConfig();
    console.error(error.stack || error.message);
    process.exit(1);
});
