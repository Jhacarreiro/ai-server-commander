const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-preflight-'));
const release = path.join(fixture, 'releases', 'current');
const state = path.join(fixture, 'state');
const runtime = path.join(state, 'runtime');
const config = path.join(state, 'config.json');
const cli = path.resolve(__dirname, '../scripts/check-installation.js');
const root = path.resolve(__dirname, '..');
let server;
function run(extra = []) {
    const result = spawnSync(process.execPath, [cli, '--release', release, '--config', config, '--runtime', runtime, '--require-oauth-state', ...extra], { encoding: 'utf8', env: { ...process.env, OAUTH_STATE_PATH: '' } });
    return { status: result.status, data: JSON.parse(result.stdout), output: result.stdout + result.stderr };
}
(async () => {
    try {
        fs.mkdirSync(release, { recursive: true });
        fs.mkdirSync(runtime, { recursive: true });
        for (const directory of ['api', 'serverModules']) fs.cpSync(path.join(root, directory), path.join(release, directory), { recursive: true });
        fs.copyFileSync(path.join(root, 'main.js'), path.join(release, 'main.js'));
        fs.writeFileSync(path.join(release, 'package.json'), '{"dependencies":{}}');
        fs.writeFileSync(config, '{"port":3000,"authToken":"synthetic-preflight-private-value"}');
        const oauth = '{"version":1,"clients":{},"authCodes":{},"accessTokens":{},"refreshTokens":{}}\n';
        const activity = '{"event":"synthetic retained record"}\n';
        fs.writeFileSync(path.join(runtime, 'oauth-state.json'), oauth);
        fs.writeFileSync(path.join(runtime, 'activity.jsonl'), activity);
        fs.symlinkSync(config, path.join(release, 'config.json'));
        fs.symlinkSync(runtime, path.join(release, 'runtime'));
        assert.strictEqual(run().status, 0);
        assert.strictEqual(fs.readFileSync(path.join(runtime, 'oauth-state.json'), 'utf8'), oauth);
        assert.strictEqual(fs.readFileSync(path.join(runtime, 'activity.jsonl'), 'utf8'), activity);
        assert(!run().output.includes('synthetic-preflight-private-value'));
        assert(!run().output.includes(fixture));

        server = http.createServer((_, response) => response.end('healthy'));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        fs.unlinkSync(path.join(release, 'api', 'terminal.js'));
        const missing = run();
        assert.strictEqual(missing.status, 1);
        assert(missing.data.checks.some(check => check.name === 'source:api/terminal.js' && !check.ok));
        assert.strictEqual((await fetch(`http://127.0.0.1:${server.address().port}`)).status, 200);
        fs.copyFileSync(path.join(root, 'api', 'terminal.js'), path.join(release, 'api', 'terminal.js'));
        assert.strictEqual(run(['--node', path.join(fixture, 'missing-node')]).status, 1);
        fs.writeFileSync(path.join(runtime, 'oauth-state.json'), '{invalid synthetic-preflight-private-value');
        const corrupt = run();
        assert.strictEqual(corrupt.status, 1);
        assert(!corrupt.output.includes('synthetic-preflight-private-value'));
        assert.strictEqual(fs.readFileSync(path.join(runtime, 'oauth-state.json'), 'utf8'), '{invalid synthetic-preflight-private-value');
        fs.unlinkSync(path.join(runtime, 'oauth-state.json'));
        assert.strictEqual(run().status, 1, 'required OAuth state must not be silently recreated');
        console.log('PASS disk preflight detects missing code despite healthy HTTP, detects missing Node/corrupt OAuth, and never rewrites or reveals state');
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        fs.rmSync(fixture, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
