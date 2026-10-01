const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'linux') {
    console.log('SKIP Linux/GNU deployment symlink helper');
    return;
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-deploy-links-'));
const helper = path.resolve(__dirname, '../scripts/link-release-state.sh');
const releaseRoot = path.join(fixture, 'releases');
const state = path.join(fixture, 'state');
const config = path.join(state, 'config.json');
const runtime = path.join(state, 'runtime');
function run(release, sourceConfig = config, sourceRuntime = runtime) {
    const result = spawnSync('bash', [helper, release, sourceConfig, sourceRuntime], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
}
function makeRelease(name) {
    const dir = path.join(releaseRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

try {
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(config, '{"deploymentFixture":true}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(runtime, 'record.json'), 'persistent data');
    const old = makeRelease('old');
    const next = makeRelease('next');
    fs.symlinkSync(config, path.join(old, 'config.json'));
    fs.symlinkSync(runtime, path.join(old, 'runtime'));
    fs.symlinkSync(path.join(old, 'config.json'), path.join(next, 'config.json'));
    fs.symlinkSync(path.join(old, 'runtime'), path.join(next, 'runtime'));

    assert.strictEqual(run(next, path.join(old, 'config.json'), path.join(old, 'runtime')).status, 0);
    assert.strictEqual(fs.readlinkSync(path.join(next, 'config.json')), config);
    assert.strictEqual(fs.readlinkSync(path.join(next, 'runtime')), runtime);
    fs.rmSync(old, { recursive: true });
    assert.strictEqual(fs.readFileSync(path.join(next, 'config.json'), 'utf8'), '{"deploymentFixture":true}\n');
    assert.strictEqual(fs.readFileSync(path.join(next, 'runtime', 'record.json'), 'utf8'), 'persistent data');
    assert.strictEqual(run(next).status, 0);
    assert.strictEqual(fs.statSync(config).mode & 0o777, 0o600);
    console.log('PASS direct links survive deletion of the previous release and repeated invocation');

    const blocked = makeRelease('blocked');
    fs.symlinkSync(config, path.join(blocked, 'config.json'));
    fs.mkdirSync(path.join(blocked, 'runtime'));
    fs.writeFileSync(path.join(blocked, 'runtime', 'keep'), 'real state');
    assert.notStrictEqual(run(blocked).status, 0);
    assert.strictEqual(fs.readlinkSync(path.join(blocked, 'config.json')), config);
    assert.strictEqual(fs.readFileSync(path.join(blocked, 'runtime', 'keep'), 'utf8'), 'real state');
    fs.unlinkSync(path.join(blocked, 'config.json'));
    fs.writeFileSync(path.join(blocked, 'config.json'), 'real configuration');
    assert.notStrictEqual(run(blocked).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(blocked, 'config.json'), 'utf8'), 'real configuration');
    console.log('PASS existing real configuration and runtime are preserved without partial replacement');

    const unsafe = makeRelease('unsafe');
    const newRelease = makeRelease('new');
    fs.writeFileSync(path.join(unsafe, 'config.json'), '{}');
    fs.mkdirSync(path.join(unsafe, 'runtime'));
    assert.notStrictEqual(run(newRelease, path.join(unsafe, 'config.json')).status, 0);
    assert.notStrictEqual(run(newRelease, config, path.join(unsafe, 'runtime')).status, 0);
    assert.notStrictEqual(run(newRelease, path.join(state, 'missing')).status, 0);
    assert.notStrictEqual(run(newRelease, runtime, runtime).status, 0);
    assert.deepStrictEqual(fs.readdirSync(newRelease), []);
    console.log('PASS state inside releases, missing targets and wrong types fail before linking');
    assert(!fs.readdirSync(next).some((name) => name.startsWith('.state-links.')));
} finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}
