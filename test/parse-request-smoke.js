// Request validation shared by REST and MCP (api/terminal.js parseRequest)
// plus the executor helpers it depends on.
process.env.MAX_INLINE_COMMAND_BYTES = '64';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseRequest } = require('../api/terminal');
const { executeBounded, sliceText } = require('../serverModules/commandExecutor');
const { preview } = require('../api/activityLog');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const post = (body, query = {}) => parseRequest({ method: 'POST', body, query });
const MISSING_COMMAND = 'Command parameter is required for inline mode.';
const MISSING_SCRIPT = 'Script body is required for script mode and must be a string.';

(async () => {
    // Missing, empty and valid values.
    assert(post({ mode: 'inline' }).message === MISSING_COMMAND, 'inline: missing command');
    assert(post({ mode: 'inline', command: '  ' }).message === MISSING_COMMAND, 'inline: blank command');
    assert(post({ mode: 'inline', command: 'ls' }).command === 'ls', 'inline: valid command');
    assert(post({ mode: 'script' }).message === MISSING_SCRIPT, 'script: missing body');
    assert(post({ mode: 'script', script: ' \t\n ' }).message === MISSING_SCRIPT, 'script: whitespace-only body');
    assert(post({ mode: 'script', script: 'echo hi' }).script === 'echo hi', 'script: valid body');

    // Wrong types are reported instead of looking like a missing field.
    for (const bad of [0, false, NaN, [], {}]) {
        const inline = post({ mode: 'inline', command: bad });
        assert(inline.status === 400 && inline.message === 'Command parameter must be a string, got ' + typeof bad + '.', 'inline: ' + JSON.stringify(bad) + ' is a type error', JSON.stringify(inline));
        const script = post({ mode: 'script', script: bad });
        assert(script.status === 400 && script.message === 'Script body must be a string, got ' + typeof bad + '.', 'script: ' + JSON.stringify(bad) + ' is a type error', JSON.stringify(script));
    }
    const noSubstitution = post({ mode: 'inline', command: 0 }, { command: 'ls' });
    assert(noSubstitution.message === 'Command parameter must be a string, got number.', 'a wrong-typed body command is not replaced by the query command');
    assert(post({}, { command: 'pwd' }).command === 'pwd', 'an absent body command still falls back to the query');

    // command and script are alternatives.
    const both = post({ command: 'printf a', script: 'printf b' });
    assert(both.status === 400 && both.message === 'Provide either command or script, not both.', 'command and script together are rejected', JSON.stringify(both));

    // Script mode is detected from a script-only body, like MCP.
    const auto = post({ script: 'echo hi' });
    assert(auto.mode === 'script' && auto.script === 'echo hi', 'script-only body selects script mode');

    // Inline size cap (set to 64 bytes for this test).
    const over = post({ mode: 'inline', command: 'x'.repeat(65) });
    assert(over.status === 413 && over.message.includes('64'), 'inline command over MAX_INLINE_COMMAND_BYTES is 413', JSON.stringify(over));
    const overGet = parseRequest({ method: 'GET', query: { command: 'y'.repeat(65) }, body: {} });
    assert(overGet.status === 413, 'GET inline command over the cap is 413');
    assert(!post({ mode: 'script', script: 'z'.repeat(200) }).error, 'script mode is not limited by the inline cap');

    // One default shell for inline and script, with and without SHELL set.
    const env = { ...process.env };
    delete env.SHELL;
    const resolved = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("./serverModules/commandExecutor").DEFAULT_SHELL)'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    assert(resolved === (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'), 'DEFAULT_SHELL prefers /bin/bash when SHELL is unset', resolved);

    // Truncation never leaves a lone UTF-16 high surrogate.
    assert(sliceText('ab\u{1F600}', 3) === 'ab', 'sliceText drops a split surrogate pair');
    assert(sliceText('ab\u{1F600}', 4) === 'ab\u{1F600}', 'sliceText keeps a complete pair');
    const emoji = await executeBounded({ command: "printf 'a\\360\\237\\230\\200b'", shell: '/bin/sh', cwd: process.cwd(), timeoutMs: 5000, maxOutputChars: 2 });
    assert(emoji.outputTruncated && emoji.limitedOutput === 'a', 'truncated command output does not end in a lone surrogate', JSON.stringify(emoji.limitedOutput));
    const shortPreview = preview('x'.repeat(9) + '\u{1F600}', 10);
    assert(shortPreview === 'x'.repeat(9) + '…', 'activity preview does not end in a lone surrogate', JSON.stringify(shortPreview));
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
