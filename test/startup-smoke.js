const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

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
} catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
}

function get(port, token, pathName) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: pathName, headers: { Authorization: `Bearer ${token}` } }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }));
        }).on('error', reject);
    });
}

// An invalid optional watcher setting disables only the watcher; the server
// still starts and serves REST requests.
(async () => {
    const port = Number(process.env.TEST_PORT || 33109);
    const token = 't'.repeat(64);
    const configPath = path.join(tmp, 'watcher-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ port, productionDomain: `http://localhost:${port}`, authToken: token, chatgptWeb: { enabled: 'flase' } }));
    const server = spawn(process.execPath, ['main.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, CONFIG_FILE_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    server.stdout.on('data', (chunk) => { output += chunk; });
    server.stderr.on('data', (chunk) => { output += chunk; });
    try {
        for (let i = 0; i < 100 && !output.includes('Server running'); i++) await new Promise((r) => setTimeout(r, 100));
        assert(output.includes('Server running'), 'an invalid watcher flag does not stop the server from starting', output);
        assert(output.includes('ChatGPT Web watcher disabled by invalid configuration'), 'the watcher configuration error is logged', output);
        const rest = await get(port, token, '/api/server-url');
        assert(rest.status === 200, 'REST routes keep working', JSON.stringify(rest));
        const status = await get(port, token, '/api/chatgpt-web/status');
        assert(status.status === 503 && status.body.reason === 'invalid_configuration' && /true or false/.test(status.body.lastError),
            'the watcher reports invalid_configuration', JSON.stringify(status));
    } finally {
        server.kill('SIGKILL');
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
