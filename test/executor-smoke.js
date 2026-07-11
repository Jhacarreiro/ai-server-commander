const { executeBounded, parseRequest } = require('../api/terminal');
const { getActiveCommandIds, interruptCommand } = require('../serverModules/commandExecutor');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
