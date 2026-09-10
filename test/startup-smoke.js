const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-startup-'));
const configPath = path.join(temp, 'config.json');
const port = Number(process.env.TEST_PORT || 33126);
const occupant = http.createServer();

function runMain() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['main.js'], {
            cwd: root,
            env: {
                ...process.env,
                CONFIG_FILE_PATH: configPath,
                SAFE_MODE: 'true'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`startup process did not exit:\n${output}`));
        }, 10000);
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output });
        });
    });
}

(async () => {
    fs.writeFileSync(configPath, JSON.stringify({
        port,
        useLocalTunnel: false,
        productionDomain: `http://127.0.0.1:${port}`,
        authToken: 'a'.repeat(64),
        mcpToken: 'b'.repeat(64)
    }, null, 2));

    await new Promise((resolve, reject) => {
        occupant.once('error', reject);
        occupant.listen(port, resolve);
    });

    try {
        const result = await runMain();
        assert.strictEqual(result.code, 1, result.output);
        assert.match(result.output, /Failed to start server:/);
        assert.match(result.output, /EADDRINUSE|address already in use/i);
        console.log('startup diagnostic output:');
        console.log(result.output.trim());
        console.log('PASS forced listen bind failure rejects startup with diagnostic output');
    } finally {
        await new Promise((resolve) => occupant.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    occupant.close();
    fs.rmSync(temp, { recursive: true, force: true });
    console.error(error.stack || error.message);
    process.exit(1);
});
