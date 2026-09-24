const { redactPaths, stringifyError } = require('../serverModules/stringifyError');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const cases = [
    ["ENOENT: no such file or directory, open '/root/work dir/x.txt'", "ENOENT: no such file or directory, open '[path]'"],
    ['EACCES: permission denied, mkdir /srv/app/runtime', 'EACCES: permission denied, mkdir [path]'],
    ['EISDIR: illegal operation on a directory, read', 'EISDIR: illegal operation on a directory, read'],
    ['cannot open C:\\Users\\me\\notes.txt now', 'cannot open [path] now'],
    ['fatal: not a git repository (or any parent up to mount point /home)', 'fatal: not a git repository (or any parent up to mount point [path])']
];
for (const [input, expected] of cases) {
    assert(redactPaths(input) === expected, 'redacts ' + JSON.stringify(input), redactPaths(input));
}

const untouched = [
    'mergeText was not empty, but no conflict blocks were found, they are checked using regex like this /<<<<<<< HEAD[\\s\\S]*?>>>>>>> [\\w-]+/g Check what you send and try again',
    'see https://example.com/docs/errors for details',
    'src/app.js and lib/util.js were skipped',
    'ratio 3 / 4 and read/write access'
];
for (const text of untouched) {
    assert(redactPaths(text) === text, 'keeps ' + JSON.stringify(text.slice(0, 50)), redactPaths(text));
}

const error = Object.assign(new Error("ENOENT: no such file or directory, open '/home/commander/app/secret.txt'"), { code: 'ENOENT' });
const payload = JSON.parse(stringifyError(error));
assert(payload.message === "ENOENT: no such file or directory, open '[path]'" && payload.code === 'ENOENT' && !('stack' in payload), 'client error JSON has no absolute path or stack', JSON.stringify(payload));
