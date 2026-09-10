process.env.MAX_INLINE_COMMAND_BYTES = '64';

const { parseRequest } = require('../api/terminal');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

(async () => {
    const overCap = parseRequest({ method: 'POST', body: { mode: 'inline', command: 'x'.repeat(65) }, query: {} });
    assert(overCap.error === true && overCap.status === 413 && String(overCap.message).includes('64'), 'POST inline over cap is 413', JSON.stringify(overCap));

    const underCap = parseRequest({ method: 'POST', body: { mode: 'inline', command: 'printf ok' }, query: {} });
    assert(!underCap.error && underCap.command === 'printf ok', 'POST inline under cap still parses', JSON.stringify(underCap));

    const overCapGet = parseRequest({ method: 'GET', query: { command: 'y'.repeat(65), cwd: '/tmp' }, body: {} });
    assert(overCapGet.error === true && overCapGet.status === 413, 'GET inline over cap is 413', JSON.stringify(overCapGet));

    const scriptMode = parseRequest({ method: 'POST', body: { mode: 'script', script: 'echo hi' }, query: {} });
    assert(!scriptMode.error && scriptMode.script === 'echo hi', 'script mode is not capped by inline limit', JSON.stringify(scriptMode));
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
