const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-startup-'));
try {
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ port: 3000, productionDomain: 'http://localhost:3000', authToken: 'short' }));
    const result = spawnSync(process.execPath, ['main.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, CONFIG_FILE_PATH: configPath },
        encoding: 'utf8',
        timeout: 10000
    });
    const output = (result.stdout || '') + (result.stderr || '');
    assert(result.status === 1, 'an invalid configuration exits with status 1', output);
    assert(output.includes('Failed to start server: authToken must contain at least 32 characters.'), 'the startup error is reported in one line', output);
    assert(!/\n\s+at /.test(output), 'no raw stack trace is printed', output);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
