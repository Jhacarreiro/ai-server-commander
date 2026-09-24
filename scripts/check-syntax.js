// Syntax-checks every JavaScript file of the project with `node --check`, so
// a new module cannot be left out of the check by accident.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
// Dependencies, VCS data and runtime state are not project sources.
const SKIP_DIRS = new Set(['node_modules', 'runtime', 'coverage']);
const JS_FILE = /\.(?:js|mjs|cjs)$/;

function collect(dir, files) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full, files);
        else if (entry.isFile() && JS_FILE.test(entry.name)) files.push(full);
    }
    return files;
}

const files = collect(root, []).sort();
const failed = [];
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed.push(path.relative(root, file));
        process.stderr.write(result.stderr || result.error?.message || '');
    }
}

if (failed.length) {
    console.error(`Syntax check failed for ${failed.length} of ${files.length} files: ${failed.join(', ')}`);
    process.exit(1);
}
console.log(`Syntax OK: ${files.length} files`);
