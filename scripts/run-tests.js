// Runs every test/*.js file one after another and prints a summary.
// Test files are discovered, so a new one cannot be left out of `npm test`.
// Arguments filter by name: `npm test -- mcp oauth` runs the files whose
// name contains "mcp" or "oauth".
//
// Files run sequentially because several of them share config.json and
// listen on fixed ports. Each runs in its own process group, so a file that
// exceeds TEST_TIMEOUT_MS is killed together with any server it started.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');
const timeoutMs = Number(process.env.TEST_TIMEOUT_MS) || 120000;
const filters = process.argv.slice(2);
let current = null;

// Server tests swap in their own config.json and restore it in a `finally`
// block, which does not run when the file is killed. Restore it here.
const configPath = path.join(root, 'config.json');
const configBackupPath = path.join(root, 'config.json.test-backup');
const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;

function restoreConfig() {
    if (originalConfig) fs.writeFileSync(configPath, originalConfig);
    else fs.rmSync(configPath, { force: true });
    fs.rmSync(configBackupPath, { force: true });
}

const files = fs.readdirSync(testDir)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
    .sort();

if (files.length === 0) {
    console.error(`No test files match: ${filters.join(', ')}`);
    process.exit(1);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function groupAlive(pgid) {
    try { process.kill(-pgid, 0); return true; } catch { return false; }
}

// SIGTERM first, so a server the test started shuts down and stops its own
// commands (they run in separate process groups); SIGKILL whatever is left.
async function stopGroup(pgid) {
    try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
    for (let waited = 0; waited < 5000 && groupAlive(pgid); waited += 100) await delay(100);
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
}

function runFile(name) {
    return new Promise((resolve) => {
        const started = Date.now();
        // stdin is not inherited: a detached (background) group reading the
        // terminal would be stopped by SIGTTIN.
        const child = spawn(process.execPath, [path.join('test', name)], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
        current = child;
        let stopping = null;
        let settled = false;
        const timer = setTimeout(() => { stopping = stopGroup(child.pid); }, timeoutMs);
        const finish = async (ok, reason, killed) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (stopping) await stopping;
            if (killed) restoreConfig();
            resolve({ name, ok, ms: Date.now() - started, reason });
        };
        child.on('error', (error) => finish(false, error.message, false));
        child.on('exit', (code, signal) => {
            if (stopping) return finish(false, `timed out after ${timeoutMs} ms`, true);
            finish(code === 0, signal ? `killed by ${signal}` : `exit code ${code}`, Boolean(signal));
        });
    });
}

// The test's process group does not receive the terminal's Ctrl-C, so
// forward it instead of leaving the test and its servers running.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (current && current.exitCode === null) {
            try { process.kill(-current.pid, 'SIGTERM'); } catch { /* already gone */ }
            restoreConfig();
        }
        process.exit(1);
    });
}

(async () => {
    const results = [];
    for (const name of files) {
        console.log(`\n=== test/${name}`);
        results.push(await runFile(name));
    }

    const failed = results.filter((result) => !result.ok);
    console.log('\nSummary');
    for (const result of results) {
        console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.ms} ms)${result.ok ? '' : ' - ' + result.reason}`);
    }
    console.log(`${results.length - failed.length} of ${results.length} test files passed`);
    process.exit(failed.length ? 1 : 0);
})();
