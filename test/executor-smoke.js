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

    function classifySafeMode(commands) {
        const classifier = `
            process.env.SAFE_MODE = 'true';
            const { findBlockedPattern } = require(${JSON.stringify(path.join(__dirname, '..', 'serverModules', 'commandExecutor.js'))});
            const commands = ${JSON.stringify(commands)};
            process.stdout.write(JSON.stringify(commands.map((command) => Boolean(findBlockedPattern(command)))));
        `;
        const result = spawnSync(process.execPath, ['-e', classifier], { encoding: 'utf8' });
        assert(result.status === 0, 'SAFE_MODE classifier runs', result.stderr || result.stdout);
        return JSON.parse(result.stdout);
    }

    const mustBlock = [
        'rm -rf /',
        'rm -rf / *',
        'rm -rf /\nfoo',
        'rm -rf / extra',
        'rm --recursive --force /',
        'rm --force --recursive /',
        'rm --force --recursive / *',
        'dd if=/dev/zero of=/dev/sda',
        'dd if=/dev/zero of="/dev/sda"',
        "dd if=/dev/zero of='/dev/sda'",
        'dd of=/dev/sda if=/dev/zero'
    ];
    const mustAllow = [
        'rm -rf /tmp/build',
        'rm --recursive --force /tmp/build',
        'dd if=/dev/zero of=/tmp/disk.img'
    ];
    const classified = classifySafeMode(mustBlock.concat(mustAllow));
    mustBlock.forEach((command, index) => {
        assert(classified[index] === true, 'SAFE_MODE blocks ' + JSON.stringify(command));
    });
    mustAllow.forEach((command, index) => {
        assert(classified[mustBlock.length + index] === false, 'SAFE_MODE allows ' + JSON.stringify(command));
    });
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
