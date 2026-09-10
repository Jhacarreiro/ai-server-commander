const { spawnSync } = require('child_process');
const path = require('path');
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

    const repoRoot = path.join(__dirname, '..');
    const childScript = [
        "const { executeBounded } = require('./serverModules/commandExecutor');",
        "const { executeCommand, parseRequest } = require('./api/terminal');",
        "function assert(cond, label, details) {",
        "    if (!cond) throw new Error(label + (details ? ': ' + details : ''));",
        "    console.log('PASS ' + label);",
        "}",
        "(async () => {",
        "    const first = executeBounded({ command: 'sleep 2', cwd: process.cwd(), timeoutMs: 5000, shell: '/bin/sh' });",
        "    first.catch(() => {});",
        "    let capErr = null;",
        "    try {",
        "        await executeBounded({ command: 'sleep 2', cwd: process.cwd(), timeoutMs: 5000, shell: '/bin/sh' });",
        "    } catch (err) {",
        "        capErr = err;",
        "    }",
        "    assert(capErr && capErr.code === 'TOO_MANY_CONCURRENT_COMMANDS', 'executeBounded cap rejection has code', capErr && capErr.code);",
        "    assert(capErr && String(capErr.message).includes('max 1'), 'executeBounded cap rejection mentions max 1', capErr && capErr.message);",
        "    await first;",
        "    const parsed = parseRequest({ method: 'POST', body: { command: 'sleep 2' }, query: {} });",
        "    const firstCmd = executeCommand(parsed);",
        "    firstCmd.catch(() => {});",
        "    await new Promise((resolve) => setTimeout(resolve, 150));",
        "    const secondCmd = await executeCommand(parsed);",
        "    assert(secondCmd.status === 429, 'executeCommand returns 429 at cap', JSON.stringify(secondCmd));",
        "    assert(secondCmd.result && String(secondCmd.result.message).includes('Too many concurrent commands'), 'executeCommand 429 message', secondCmd.result && secondCmd.result.message);",
        "    await firstCmd;",
        "})().catch((err) => {",
        "    console.error(err.stack || err.message);",
        "    process.exit(1);",
        "});"
    ].join('\n');
    const child = spawnSync(process.execPath, ['-e', childScript], {
        cwd: repoRoot,
        env: Object.assign({}, process.env, { MAX_CONCURRENT_COMMANDS: '1' }),
        encoding: 'utf8',
        timeout: 20000
    });
    assert(child.status === 0, 'concurrent cap rejection exposed to clients', (child.stderr || '') + '\n' + (child.stdout || ''));
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
