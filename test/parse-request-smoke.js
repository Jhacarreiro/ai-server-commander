// Regression tests for parseRequest parameter extraction (api/terminal.js).
// Covers the finding that `body.command || query.command` discarded falsy
// non-string values (0 / false / NaN / [] / {}) before the typeof check,
// and that a query fallback (?command=ls) silently substituted a valid value.
// Style follows the repo's other smoke suites: plain node asserts, PASS prints.

const { parseRequest } = require('../api/terminal');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

function postInline(body, query = {}) {
    return parseRequest({ method: 'POST', body: Object.assign({ mode: 'inline' }, body), query });
}

function postScript(body, query = {}) {
    return parseRequest({ method: 'POST', body: Object.assign({ mode: 'script' }, body), query });
}

const TYPE_MSG = (param, got) => param + ' must be a string, got ' + got + '.';
const CMD_TYPE_MSG = (got) => TYPE_MSG('Command parameter', got);
const SCRIPT_TYPE_MSG = (got) => TYPE_MSG('Script body', got);
const MISSING_MSG = 'Command parameter is required for inline mode.';
const SCRIPT_MISSING_MSG = 'Script body is required for script mode and must be a string.';

(async () => {
    assert(typeof parseRequest === 'function', 'parseRequest export exists');

    // --- command: existing matrix (missing, empty, valid string) ---
    assert(postInline({}).error && postInline({}).message === MISSING_MSG, 'inline: missing command -> missing message');
    assert(postInline({ command: '' }).error && postInline({ command: '' }).message === MISSING_MSG, 'inline: empty command -> missing message');
    const valid = postInline({ command: 'ls' });
    assert(!valid.error && valid.command === 'ls', 'inline: valid string command parsed');

    // --- command: falsy wrong-typed values must reach the typeof check ---
    for (const bad of [0, false, NaN, [], {}]) {
        const res = postInline({ command: bad });
        assert(res.error && res.status === 400 && res.message === CMD_TYPE_MSG(typeof bad),
            'inline: command ' + JSON.stringify(bad) + ' -> type error, got ' + typeof bad, JSON.stringify(res));
    }

    // --- command: no silent query fallback substitution on falsy body value ---
    const noSub = postInline({ command: 0 }, { command: 'ls' });
    assert(noSub.error && noSub.message === CMD_TYPE_MSG('number'),
        'inline: body command 0 not substituted by query command', JSON.stringify(noSub));

    // --- command: GET extraction still works and validates types ---
    const getOk = parseRequest({ method: 'GET', query: { command: 'pwd' }, body: {} });
    assert(!getOk.error && getOk.command === 'pwd', 'GET: valid query command parsed');
    const getBad = parseRequest({ method: 'GET', query: { command: 0 }, body: {} });
    assert(getBad.error && getBad.message === CMD_TYPE_MSG('number'), 'GET: query command 0 -> type error');

    // --- script: existing matrix (missing, empty, valid string) ---
    assert(postScript({}).error && postScript({}).message === SCRIPT_MISSING_MSG, 'script: missing body -> missing message');
    assert(postScript({ script: '' }).error && postScript({ script: '' }).message === SCRIPT_MISSING_MSG, 'script: empty body -> missing message');
    const scriptOk = postScript({ script: 'echo hi' });
    assert(!scriptOk.error && scriptOk.script === 'echo hi', 'script: valid string body parsed');

    // --- script: falsy wrong-typed values must reach the typeof check ---
    for (const bad of [0, false, NaN, [], {}]) {
        const res = postScript({ script: bad });
        assert(res.error && res.status === 400 && res.message === SCRIPT_TYPE_MSG(typeof bad),
            'script: body ' + JSON.stringify(bad) + ' -> type error, got ' + typeof bad, JSON.stringify(res));
    }

    console.log('All parse-request regression checks passed.');
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
