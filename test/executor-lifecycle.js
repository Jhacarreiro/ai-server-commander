// Process lifecycle of the bounded executor: timeouts, interrupts and
// restart must stop the whole process group, not only the shell.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    KILL_GRACE_MS,
    executeBounded,
    getActiveCommandIds,
    interruptCommand,
    killPendingNow,
    terminateAll
} = require('../serverModules/commandExecutor');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-lifecycle-'));
const pidFile = (name) => path.join(tmp, name + '.pid');
const readPid = (file) => { try { return parseInt(fs.readFileSync(file, 'utf8'), 10) || 0; } catch { return 0; } };
// A killed orphan can linger as a zombie when PID 1 does not reap (common in
// containers); it is dead, so do not count it as a survivor.
function alive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); } catch { return false; }
    try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}
const run = (command, extra = {}) => executeBounded({ command, shell: '/bin/sh', cwd: tmp, timeoutMs: 20000, ...extra });

// The deadline timer is cleared once the promise settles, so it does not keep
// the test process alive after the last assertion.
function withDeadline(promise, ms, label) {
    let timer;
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' exceeded ' + ms + 'ms')), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function waitForPid(file) {
    for (let i = 0; i < 40 && !readPid(file); i++) await delay(50);
    return readPid(file);
}

(async () => {
    try {
        // A pipeline keeps the output pipe open after the shell dies; the
        // timeout must still end the request and every process in it.
        const pipeFile = pidFile('pipe');
        let started = Date.now();
        const pipe = await withDeadline(run(`sh -c 'echo $$ > ${pipeFile}; exec sleep 30' | cat`, { timeoutMs: 500 }), 5000, 'pipeline timeout');
        assert(pipe.timedOut && Date.now() - started < 3000, 'timed-out pipeline resolves promptly', String(Date.now() - started));
        await delay(100);
        assert(!alive(readPid(pipeFile)), 'no process of the timed-out pipeline survives');

        // A command that ignores SIGTERM is killed after the grace period.
        const trapFile = pidFile('trap');
        started = Date.now();
        const trapped = await withDeadline(run(`trap "" TERM; echo $$ > ${trapFile}; while true; do sleep 1; done`, { timeoutMs: 300 }), 8000, 'trapped timeout');
        assert(trapped.timedOut && Date.now() - started < 300 + KILL_GRACE_MS + 1500, 'SIGTERM-trapping command is escalated to SIGKILL', String(Date.now() - started));
        await delay(100);
        assert(!alive(readPid(trapFile)), 'SIGTERM-trapping command is gone');

        // Interrupting a leader also kills a descendant that ignores SIGTERM.
        const descFile = pidFile('desc');
        const descendant = run(`(trap "" HUP TERM; echo $$ > ${descFile}; while true; do sleep 1; done) & wait`, { activityId: 'lifecycle_desc' });
        assert(alive(await waitForPid(descFile)), 'descendant started');
        assert(interruptCommand('lifecycle_desc').interrupted, 'interrupt descendant leader');
        const descResult = await withDeadline(descendant, 8000, 'descendant interrupt');
        await delay(100);
        assert(descResult.interrupted && !alive(readPid(descFile)), 'descendant is killed with its leader');

        // A repeated interrupt must not postpone the SIGKILL deadline.
        const repeatFile = pidFile('repeat');
        started = Date.now();
        const repeated = run(`trap "" TERM; echo $$ > ${repeatFile}; while true; do sleep 1; done`, { activityId: 'lifecycle_repeat' });
        await waitForPid(repeatFile);
        interruptCommand('lifecycle_repeat');
        await delay(800);
        assert(interruptCommand('lifecycle_repeat').interrupted, 'second interrupt is accepted');
        await withDeadline(repeated, 8000, 'repeated interrupt');
        assert(Date.now() - started < KILL_GRACE_MS + 1500, 'second interrupt keeps the original SIGKILL deadline', String(Date.now() - started));
        assert(!getActiveCommandIds().includes('lifecycle_repeat'), 'interrupted command is no longer tracked');

        // Runaway output is stopped instead of running until the timeout.
        started = Date.now();
        const flood = await withDeadline(run('yes', { maxOutputChars: 1000, timeoutMs: 20000 }), 8000, 'output flood');
        assert(flood.outputTruncated && flood.output.includes('maxBuffer length exceeded') && Date.now() - started < 5000, 'output beyond the buffer stops the command', String(Date.now() - started));

        // terminateAll interrupts everything (used by /api/restart).
        const allFile = pidFile('all');
        const all = run(`trap "" TERM; echo $$ > ${allFile}; while true; do sleep 1; done`, { activityId: 'lifecycle_all' });
        await waitForPid(allFile);
        assert(terminateAll() === 1, 'terminateAll reports the running command');
        const allResult = await withDeadline(all, KILL_GRACE_MS + 2000, 'terminateAll');
        await delay(100);
        assert(allResult.interrupted && !alive(readPid(allFile)), 'terminateAll leaves no survivor');

        // killPendingNow does not wait for the grace period.
        const nowFile = pidFile('now');
        const pending = run(`trap "" TERM; echo $$ > ${nowFile}; while true; do sleep 1; done`, { activityId: 'lifecycle_now' });
        await waitForPid(nowFile);
        terminateAll();
        started = Date.now();
        killPendingNow();
        await withDeadline(pending, 1000, 'killPendingNow');
        assert(Date.now() - started < 1000 && !alive(readPid(nowFile)), 'killPendingNow kills without waiting for the grace period');

        // Concurrency cap: executor rejection and 429 without consuming an operationId.
        const capScript = `
            const { executeBounded } = require('./serverModules/commandExecutor');
            const { executeCommand, parseRequest } = require('./api/terminal');
            (async () => {
                const first = executeBounded({ command: 'sleep 1', shell: '/bin/sh', cwd: process.cwd(), timeoutMs: 5000 });
                let capError = null;
                try { await executeBounded({ command: 'true', shell: '/bin/sh', cwd: process.cwd(), timeoutMs: 5000 }); } catch (error) { capError = error; }
                const parsed = parseRequest({ method: 'POST', body: { command: 'true', operationId: 'cap-op' }, query: {} });
                const rejected = await executeCommand(parsed);
                await first;
                const retried = await executeCommand(parsed);
                process.stdout.write(JSON.stringify({ code: capError && capError.code, status: rejected.status, state: rejected.result.operationState, retry: retried.status, replayed: retried.result.replayed }));
            })().catch((error) => { console.error(error); process.exit(1); });`;
        const cap = spawnSync(process.execPath, ['-e', capScript], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, MAX_CONCURRENT_COMMANDS: '1', COMMAND_OPERATIONS_PATH: path.join(tmp, 'ops.json') },
            encoding: 'utf8',
            timeout: 20000
        });
        const capResult = JSON.parse(cap.stdout.trim().split('\n').pop() || '{}');
        assert(capResult.code === 'TOO_MANY_CONCURRENT_COMMANDS', 'executor rejects commands above MAX_CONCURRENT_COMMANDS', cap.stderr);
        assert(capResult.status === 429 && capResult.state === 'not_executed', 'a request above the cap gets 429 and keeps its operationId', JSON.stringify(capResult));
        assert(capResult.retry === 200 && capResult.replayed === false, 'the same operationId runs once capacity is free', JSON.stringify(capResult));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
