const path = require('path');
const { stringifyError } = require('../serverModules/stringifyError');
const { getLog } = require('../serverModules/logger');
const readEditTextFileHandler = require('../api/readEditTextFile2Handler');

function assert(condition, label, details = '') {
    if (!condition) throw new Error(`${label}${details ? ': ' + details : ''}`);
    console.log(`PASS ${label}`);
}

function parseClientError(payload) {
    const raw = payload && payload.error;
    assert(typeof raw === 'string', 'client error payload is a JSON string', typeof raw);
    return JSON.parse(raw);
}

function serializedLogsSince(startLength) {
    return JSON.stringify({ logs: getLog().slice(startLength) });
}

function mockRes() {
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    return {
        statusCode: 200,
        body: undefined,
        done,
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(payload) {
            this.body = payload;
            settle(this);
            return this;
        },
        json(payload) {
            this.body = payload;
            settle(this);
            return this;
        },
        type() {
            return this;
        }
    };
}

function payloadFromError(message, extra) {
    const err = new Error(message);
    if (extra) Object.assign(err, extra);
    err.stack = `Error: ${message}\n    at Object.<anonymous> (/srv/secret/app/handler.js:10:1)\n    at Module._compile (node:internal/modules/cjs/loader:1:1)`;
    return JSON.parse(stringifyError(err));
}

function assertNoStack(payload, label) {
    assert(!('stack' in payload), `${label} omits stack`);
    const text = JSON.stringify(payload);
    assert(!/at Object\./.test(text), `${label} has no stack frames`, text);
    assert(!/handler\.js:\d+/.test(text), `${label} has no code locations`, text);
}

function assertPathRedacted(payload, leaks, label) {
    const text = JSON.stringify(payload);
    assert(payload.message.includes('[path]'), `${label} replaces path with [path]`, payload.message);
    for (const leak of leaks) {
        assert(!text.includes(leak), `${label} does not leak ${leak}`, text);
    }
}

const posixSpaced = '/srv/ai server/mission control.js';
const windowsSpaced = 'C:\\Program Files\\My App\\file.js';
const windowsForward = 'C:/Users/name/Documents/file.js';
const windowsMixed = 'C:/Program Files/My App/file.js';
const posixPlain = '/home/user/project/file.js';

let payload = payloadFromError(`ENOENT: no such file or directory, open '${posixSpaced}'`, { code: 'ENOENT' });
assert(payload.name === 'Error', 'preserves error name');
assert(payload.code === 'ENOENT', 'preserves string error code');
assertNoStack(payload, 'posix spaced path');
assertPathRedacted(payload, ['/srv/', 'ai server', 'mission control'], 'posix spaced path');

payload = payloadFromError(`ENOENT: no such file or directory, open '${windowsSpaced}'`, { code: 'ENOENT' });
assertNoStack(payload, 'windows backslash spaced path');
assertPathRedacted(payload, ['Program Files', 'My App', 'C:\\\\Program'], 'windows backslash spaced path');

payload = payloadFromError(`ENOENT: no such file or directory, open '${windowsForward}'`);
assertNoStack(payload, 'windows forward-slash path');
assertPathRedacted(payload, ['C:/Users', '/Users/name', 'Documents'], 'windows forward-slash path');

payload = payloadFromError(`failed to open ${windowsMixed}: EACCES`);
assertNoStack(payload, 'windows mixed slashes with spaces');
assertPathRedacted(payload, ['Program Files', 'C:/Program', '/My App'], 'windows mixed slashes with spaces');

payload = payloadFromError(`stat ${posixPlain} failed`);
assertNoStack(payload, 'posix path without spaces');
assertPathRedacted(payload, ['/home/user', 'project/file.js'], 'posix path without spaces');

const posixComma = '/srv/build,private/release.js';
payload = payloadFromError(`ENOENT: no such file or directory, open '${posixComma}'`, { code: 'ENOENT' });
assertNoStack(payload, 'posix path with comma');
assertPathRedacted(payload, ['/srv/', 'build,private', 'release.js'], 'posix path with comma');

const posixColon = '/srv/build:private/release.js';
payload = payloadFromError(`ENOENT: no such file or directory, open '${posixColon}'`, { code: 'ENOENT' });
assertNoStack(payload, 'posix path with colon');
assertPathRedacted(payload, ['/srv/', 'build:private', 'release.js'], 'posix path with colon');

const long = new Error('x'.repeat(400));
const truncated = JSON.parse(stringifyError(long));
assert(truncated.message.length === 300, 'message is capped at 300 characters', String(truncated.message.length));

const withNumericCode = new Error('disk full');
withNumericCode.code = 28;
assert(JSON.parse(stringifyError(withNumericCode)).code === 28, 'preserves numeric error code');

let threw = false;
try {
    stringifyError('not-an-error');
} catch (err) {
    threw = err instanceof TypeError;
}
assert(threw, 'stringifyError rejects non-Error values');

const handler = readEditTextFileHandler(() => 'http://127.0.0.1:9');
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
console.error = () => {};
console.log = () => {};

(async () => {
    try {
        const spacedPath = path.join(process.env.HOME || process.cwd(), 'asc-pr29 missing dir', 'mission control.js');
        const beforeSpaced = getLog().length;
        const spacedRes = mockRes();
        await handler({
            method: 'POST',
            query: {},
            body: {
                filePath: spacedPath,
                replacements: [{ originalText: 'search', replacementText: 'replace' }]
            }
        }, spacedRes);
        await spacedRes.done;
        console.log = originalConsoleLog;
        const spacedPayload = parseClientError(spacedRes.body);
        assert(spacedRes.statusCode === 500, 'missing parent directory is HTTP 500', String(spacedRes.statusCode));
        assertNoStack(spacedPayload, 'spaced path response');
        assertPathRedacted(spacedPayload, ['asc-pr29 missing dir', 'mission control'], 'spaced path response');

        const failedEntry = getLog().slice(beforeSpaced).find((args) => args[0] === 'read-or-edit-file failed');
        assert(failedEntry, 'read-or-edit-file failed is logged');
        assert(typeof failedEntry[1] === 'string' && !failedEntry[1].includes(spacedPath),
            'logged diagnostic is the redacted payload', String(failedEntry[1]).slice(0, 240));
        assert(!String(failedEntry[1]).includes('at ') && !String(failedEntry[1]).includes('readEditTextFile2Handler.js'),
            'logged diagnostic does not include the stack', String(failedEntry[1]));
        assert(!serializedLogsSince(beforeSpaced).includes('readEditTextFile2Handler.js'),
            'shared log buffer does not contain handler stack frames', serializedLogsSince(beforeSpaced));
        const newEntries = getLog().slice(beforeSpaced);
        for (const args of newEntries) {
            const list = Array.isArray(args) ? args : [args];
            for (const arg of list) {
                assert(!(arg instanceof Error), 'shared log entries contain no Error instances');
            }
        }
    } finally {
        console.error = originalConsoleError;
        console.log = originalConsoleLog;
    }
})().catch((err) => {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    console.error(err.stack || err.message);
    process.exit(1);
});
