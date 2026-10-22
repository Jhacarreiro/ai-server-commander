const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { executeBounded, resolveCwd } = require('../serverModules/commandExecutor');
const { parseRequest, executeCommand } = require('../api/terminal');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-execution-defaults-'));
const marker = path.join(fixture, 'unexpected-write');
const missing = path.join(fixture, 'missing');
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const options = { cwd: fixture, shell: '/bin/bash', timeoutMs: 5000 };
const originalCwd = process.env.COMMAND_DEFAULT_CWD;

(async () => {
    try {
        const failedCd = await executeBounded({ ...options, command: `cd ${quote(missing)}; printf damaged > ${quote(marker)}` });
        assert.notStrictEqual(failedCd.exitCode, 0);
        assert(!fs.existsSync(marker), 'a failed directory change must prevent the following write');
        const pipeline = await executeBounded({ ...options, command: `false | true; printf damaged > ${quote(marker)}` });
        assert.notStrictEqual(pipeline.exitCode, 0);
        assert(!fs.existsSync(marker), 'Bash pipeline failures must prevent subsequent writes');
        const handled = await executeBounded({ ...options, command: 'false || true; printf handled' });
        assert.strictEqual(handled.exitCode, 0);
        assert.strictEqual(handled.output, 'handled');

        const script = parseRequest({ method: 'POST', query: {}, body: {
            mode: 'script', shell: '/bin/sh', cwd: fixture,
            script: `cd ${quote(missing)}\nprintf damaged > ${quote(marker)}`
        } });
        const scriptResult = await executeCommand(script);
        assert.notStrictEqual(scriptResult.result.exitCode, 0);
        assert(!fs.existsSync(marker), 'script mode must pass errexit to the script interpreter itself');

        delete process.env.COMMAND_DEFAULT_CWD;
        const implicit = await executeBounded({ command: 'pwd', shell: '/bin/sh', timeoutMs: 5000 });
        assert.strictEqual(implicit.exitCode, 0);
        const workspace = fs.realpathSync(implicit.output.trim());
        assert(workspace.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
        assert.notStrictEqual(workspace, fs.realpathSync(os.homedir()));
        assert.notStrictEqual(workspace, fs.realpathSync(path.resolve(__dirname, '..')));
        assert.strictEqual(fs.statSync(workspace).mode & 0o777, 0o700);
        const restarted = spawnSync(process.execPath, ['-e',
            'process.stdout.write(require(process.argv[1]).resolveCwd().cwd)',
            require.resolve('../serverModules/commandExecutor')], { encoding: 'utf8', env: process.env });
        assert.strictEqual(restarted.status, 0);
        assert.strictEqual(fs.realpathSync(restarted.stdout), workspace, 'restart must not change implicit cwd and operation fingerprints');
        process.env.COMMAND_DEFAULT_CWD = missing;
        await assert.rejects(executeBounded({ command: `printf damaged > ${quote(marker)}` }), /COMMAND_DEFAULT_CWD/);
        assert(parseRequest({ method: 'POST', query: {}, body: { command: 'pwd' } }).error);
        assert(!fs.existsSync(marker));
        process.env.COMMAND_DEFAULT_CWD = fixture;
        assert.strictEqual(resolveCwd().cwd, fixture);

        const executor = require.resolve('../serverModules/commandExecutor');
        const legacy = spawnSync(process.execPath, ['-e',
            'const {executeBounded}=require(process.argv[1]);executeBounded({command:"false; printf legacy",cwd:process.argv[2],shell:"/bin/sh"}).then(r=>{process.stdout.write(r.output);process.exitCode=r.exitCode})',
            executor, fixture], { encoding: 'utf8', env: { ...process.env, COMMAND_FAIL_FAST: 'false' } });
        assert.strictEqual(legacy.status, 0);
        assert.strictEqual(legacy.stdout, 'legacy');
        console.log('PASS failed commands and scripts stop before writes; default workspace is private; explicit error handling and legacy opt-out work');
    } finally {
        if (originalCwd === undefined) delete process.env.COMMAND_DEFAULT_CWD;
        else process.env.COMMAND_DEFAULT_CWD = originalCwd;
        fs.rmSync(fixture, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
