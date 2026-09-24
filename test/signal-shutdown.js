// SIGTERM and SIGINT shut the server down like /api/restart: running
// commands are interrupted, their responses are delivered, and no command
// outlives the process. A second signal while draining exits immediately.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33108);
const token = process.env.TEST_TOKEN || 't'.repeat(64);
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
const logPath = '/tmp/asc-signal-shutdown.log';
const pidPath = `/tmp/asc-signal-shutdown-${process.pid}.pid`;
let server;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// A killed orphan can linger as a zombie when PID 1 does not reap (common in
// containers); it is dead, so do not count it as a survivor.
function alive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch { return false; }
    try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}

function post(pathName, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request({
            hostname: '127.0.0.1', port, path: pathName, method: 'POST',
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

async function startServer() {
    fs.rmSync(logPath, { force: true });
    const out = fs.openSync(logPath, 'a');
    server = spawn(process.execPath, ['main.js'], { cwd: root, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    const exited = new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
    const started = Date.now();
    while (Date.now() - started < 10000) {
        // Wrapped: returning the promise itself would make the caller wait for the exit.
        if (fs.readFileSync(logPath, 'utf8').includes('Server running')) return { exited };
        await delay(100);
    }
    throw new Error(fs.readFileSync(logPath, 'utf8') || 'server did not start');
}

// Starts a command that ignores SIGTERM, so stopping it needs the SIGKILL escalation.
async function startTrappedCommand() {
    fs.rmSync(pidPath, { force: true });
    const response = post('/v1/commands/execute', { command: `trap "" TERM; echo $$ > ${pidPath}; while true; do sleep 1; done`, timeoutMs: 60000 });
    // A forced exit resets the connection before the caller awaits the
    // response; mark the rejection handled so it is not reported as unhandled.
    response.catch(() => {});
    for (let i = 0; i < 40 && !fs.existsSync(pidPath); i++) await delay(50);
    return { response, pid: Number(fs.readFileSync(pidPath, 'utf8')) };
}

function withDeadline(promise, ms) {
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

(async () => {
    writeTestConfig();
    try {
        // SIGTERM with a running command: the command is interrupted, its
        // response is delivered, and the process exits cleanly.
        let { exited } = await startServer();
        let command = await startTrappedCommand();
        server.kill('SIGTERM');
        const drained = await command.response;
        const drainedAt = Date.now();
        assert(drained.status === 200 && drained.body.interrupted === true, 'SIGTERM interrupts the running command and still delivers its response', JSON.stringify(drained.body));
        let exit = await withDeadline(exited, 10000);
        assert(exit && exit.code === 0 && exit.at - drainedAt < 3000, 'SIGTERM exits with status 0 once in-flight requests drain', JSON.stringify(exit));
        await delay(100);
        assert(!alive(command.pid), 'no command process survives SIGTERM', String(command.pid));

        // SIGINT (Ctrl-C) on an idle server exits promptly.
        ({ exited } = await startServer());
        const sent = Date.now();
        server.kill('SIGINT');
        exit = await withDeadline(exited, 5000);
        assert(exit && exit.code === 0 && exit.at - sent < 2000, 'SIGINT on an idle server exits promptly with status 0', JSON.stringify(exit));

        // A second signal while draining does not wait for the SIGKILL grace period.
        ({ exited } = await startServer());
        command = await startTrappedCommand();
        server.kill('SIGTERM');
        await delay(100);
        const second = Date.now();
        server.kill('SIGTERM');
        exit = await withDeadline(exited, 5000);
        assert(exit && exit.code === 1 && exit.at - second < 1000, 'a second signal exits immediately with status 1', JSON.stringify(exit));
        await delay(100);
        assert(!alive(command.pid), 'no command process survives the forced exit', String(command.pid));
    } finally {
        fs.rmSync(pidPath, { force: true });
        if (server && server.exitCode === null) server.kill('SIGKILL');
        restoreConfig();
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    if (fs.existsSync(logPath)) console.error(fs.readFileSync(logPath, 'utf8'));
    process.exit(1);
});
