const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeBounded, parseRequest } = require('../api/terminal');
const { getActiveCommandIds, interruptCommand } = require('../serverModules/commandExecutor');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid(file) {
    try { return parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch { return 0; }
}

function withDeadline(promise, ms, label) {
    return Promise.race([
        promise,
        delay(ms).then(() => { throw new Error(label + ' exceeded ' + ms + 'ms'); })
    ]);
}

(async () => {
    assert(typeof executeBounded === 'function', 'executeBounded export exists');
    assert(typeof parseRequest === 'function', 'parseRequest export exists');

    const ok = await executeBounded({ command: 'printf executor_ok', cwd: process.cwd(), timeoutMs: 5000, maxOutputChars: 12000, shell: '/bin/sh' });
    assert(ok.exitCode === 0 && ok.output === 'executor_ok', 'executeBounded captures stdout', JSON.stringify(ok));

    const fail = await executeBounded({ command: 'exit 7', cwd: process.cwd(), timeoutMs: 5000, maxOutputChars: 12000, shell: '/bin/sh' });
    assert(fail.exitCode === 7, 'executeBounded preserves non-zero exit', JSON.stringify(fail));

    const truncated = await executeBounded({ command: 'printf 1234567890', cwd: process.cwd(), timeoutMs: 5000, maxOutputChars: 5, shell: '/bin/sh' });
    assert(truncated.outputTruncated && truncated.limitedOutput === '12345', 'executeBounded truncates output', JSON.stringify(truncated));

    const parsedScript = parseRequest({ method: 'POST', body: { mode: 'script', script: 'echo hi' }, query: {} });
    assert(parsedScript.mode === 'script' && parsedScript.script === 'echo hi', 'parseRequest script mode');

    const parsedGet = parseRequest({ method: 'GET', query: { command: 'pwd', cwd: '/tmp', timeoutMs: '5000', maxOutputChars: '99' }, body: {} });
    assert(parsedGet.cwd === '/tmp' && parsedGet.timeoutMs === 5000 && parsedGet.maxOutputChars === 99, 'parseRequest GET options');

    const invalidCwd = parseRequest({ method: 'POST', body: { command: 'pwd', cwd: '/definitely/missing' }, query: {} });
    assert(invalidCwd.error && invalidCwd.status === 400, 'parseRequest rejects invalid cwd');

    const postQueryOnly = parseRequest({
        method: 'POST',
        query: { command: 'pwd', cwd: '/tmp', timeoutMs: '5000', maxOutputChars: '99' },
        body: {}
    });
    assert(
        postQueryOnly.cwd === '/tmp' && postQueryOnly.timeoutMs === 5000 && postQueryOnly.maxOutputChars === 99,
        'parseRequest POST honors query-only option fallbacks'
    );

    const postBodyWins = parseRequest({
        method: 'POST',
        query: { command: 'pwd', cwd: process.cwd(), timeoutMs: '1111', maxOutputChars: '11' },
        body: { command: 'pwd', cwd: '/tmp', timeoutMs: 2222, maxOutputChars: 22 }
    });
    assert(
        postBodyWins.cwd === '/tmp' && postBodyWins.timeoutMs === 2222 && postBodyWins.maxOutputChars === 22,
        'parseRequest POST body options override query fallbacks'
    );

    const defaults = parseRequest({ method: 'POST', body: { command: 'pwd' }, query: {} });
    const headNoQueryFallback = parseRequest({
        method: 'HEAD',
        query: { command: 'pwd', cwd: '/tmp', timeoutMs: '123', maxOutputChars: '99' },
        body: {}
    });
    assert(
        headNoQueryFallback.cwd === defaults.cwd &&
            headNoQueryFallback.timeoutMs === defaults.timeoutMs &&
            headNoQueryFallback.maxOutputChars === defaults.maxOutputChars,
        'parseRequest does not merge query option fallbacks for non-POST methods'
    );

    const first = executeBounded({ activityId: 'test_first', command: 'sleep 5', cwd: process.cwd(), timeoutMs: 10000, shell: '/bin/sh' });
    const second = executeBounded({ activityId: 'test_second', command: 'sleep 5', cwd: process.cwd(), timeoutMs: 10000, shell: '/bin/sh' });
    await delay(150);
    assert(getActiveCommandIds().length === 2, 'multiple commands tracked independently');
    const ambiguous = interruptCommand();
    assert(ambiguous.reason === 'ambiguous' && ambiguous.activeIds.length === 2, 'interrupt requires id when concurrent');
    assert(interruptCommand('test_first').interrupted, 'interrupt first command by id');
    assert(interruptCommand('test_second').interrupted, 'interrupt second command by id');
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert(firstResult.interrupted && secondResult.interrupted, 'interruption state preserved per command');

    const trapPidFile = path.join(os.tmpdir(), 'asc-trap-' + process.pid + '.pid');
    const trapStarted = Date.now();
    const trap = await withDeadline(executeBounded({
        activityId: 'test_trap_term',
        command: 'trap "" TERM; echo $$ > "' + trapPidFile + '"; while true; do sleep 1; done',
        cwd: process.cwd(),
        timeoutMs: 400,
        shell: '/bin/sh'
    }), 8000, 'trapped SIGTERM');
    const trapElapsed = Date.now() - trapStarted;
    assert(trap.timedOut, 'trapped SIGTERM still times out', JSON.stringify(trap));
    assert(trapElapsed < 4000, 'trapped SIGTERM escalates to SIGKILL', String(trapElapsed));
    await delay(100);
    const trapPid = readPid(trapPidFile);
    assert(trapPid > 0 && !pidAlive(trapPid), 'trapped SIGTERM process is gone', String(trapPid));
    try { fs.unlinkSync(trapPidFile); } catch { /* ignore */ }

    const descPidFile = path.join(os.tmpdir(), 'asc-desc-' + process.pid + '.pid');
    const descPromise = executeBounded({
        activityId: 'test_desc_leader',
        command: '(trap "" HUP TERM; echo $$ > "' + descPidFile + '"; while true; do sleep 1; done) & wait',
        cwd: process.cwd(),
        timeoutMs: 20000,
        shell: '/bin/sh'
    });
    await delay(250);
    assert(readPid(descPidFile) > 0 && pidAlive(readPid(descPidFile)), 'descendant started before interrupt');
    assert(interruptCommand('test_desc_leader').interrupted, 'interrupt descendant-leader command');
    await withDeadline(descPromise, 8000, 'descendant-leader interrupt');
    await delay(1800);
    const descPid = readPid(descPidFile);
    assert(descPid > 0 && !pidAlive(descPid), 'descendant is killed after leader exits', String(descPid));
    try { fs.unlinkSync(descPidFile); } catch { /* ignore */ }

    const rptPidFile = path.join(os.tmpdir(), 'asc-rpt-' + process.pid + '.pid');
    const rptStarted = Date.now();
    const rptPromise = executeBounded({
        activityId: 'test_repeat_int',
        command: 'trap "" TERM; echo $$ > "' + rptPidFile + '"; while true; do sleep 1; done',
        cwd: process.cwd(),
        timeoutMs: 20000,
        shell: '/bin/sh'
    });
    await delay(200);
    assert(interruptCommand('test_repeat_int').interrupted, 'first interrupt of trap command');
    await delay(800);
    assert(interruptCommand('test_repeat_int').interrupted, 'second interrupt does not fail');
    const rpt = await withDeadline(rptPromise, 8000, 'repeat interrupt');
    const rptElapsed = Date.now() - rptStarted;
    assert(rpt.interrupted, 'repeat interrupt still completes', JSON.stringify(rpt));
    assert(rptElapsed < 2500, 'second interrupt does not restart the SIGKILL grace window', String(rptElapsed));
    assert(getActiveCommandIds().indexOf('test_repeat_int') === -1, 'repeat interrupt clears tracking');
    await delay(100);
    const rptPid = readPid(rptPidFile);
    assert(rptPid > 0 && !pidAlive(rptPid), 'repeat interrupt leaves no survivor', String(rptPid));
    try { fs.unlinkSync(rptPidFile); } catch { /* ignore */ }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
