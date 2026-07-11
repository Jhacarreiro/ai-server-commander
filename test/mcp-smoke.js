const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 33100);
const token = process.env.TEST_TOKEN || 'test-token';
const configPath = path.join(root, 'config.json');
const backupPath = path.join(root, 'config.json.test-backup');
let server;

function writeTestConfig() {
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
    fs.writeFileSync(configPath, JSON.stringify({
        port,
        useLocalTunnel: false,
        productionDomain: `http://localhost:${port}`,
        authToken: token,
        localTunnelSubdomain: null
    }, null, 2) + '\n');
}

function restoreConfig() {
    if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
    } else if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
    }
}

function rpc(message) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(message);
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/mcp?token=${encodeURIComponent(token)}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 12000
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let body = text;
                try { body = JSON.parse(text); } catch (_) {}
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function waitForServer(logPath) {
    const started = Date.now();
    while (Date.now() - started < 10000) {
        if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('Server running')) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'server log missing');
}

function assert(condition, label, details = '') {
    if (!condition) throw new Error(`${label}${details ? ': ' + details : ''}`);
    console.log(`PASS ${label}`);
}

(async () => {
    const logPath = '/tmp/asc-mcp-smoke.log';
    writeTestConfig();
    fs.rmSync(logPath, { force: true });
    const out = fs.openSync(logPath, 'a');
    server = spawn('node', ['main.js'], {
        cwd: root,
        env: { ...process.env, SAFE_MODE: 'true' },
        stdio: ['ignore', out, out]
    });

    try {
        await waitForServer(logPath);

        let response = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
        assert(response.status === 200 && response.body.result.serverInfo.version, 'MCP initialize');

        response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const schema = response.body.result.tools[0].inputSchema;
        assert(schema.properties.script && schema.properties.cwd && schema.properties.timeoutMs, 'MCP schema exposes bounded script options');

        response = await rpc({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'run_terminal_command', arguments: { command: 'printf mcp_ok', timeoutMs: 5000 } }
        });
        const inlineText = response.body.result.content[0].text;
        assert(response.body.result.isError === false && inlineText.includes('mcp_ok') && inlineText.includes('activityId:'), 'MCP inline execution uses shared executor');

        response = await rpc({
            jsonrpc: '2.0', id: 4, method: 'tools/call',
            params: { name: 'run_terminal_command', arguments: { mode: 'script', script: 'echo mcp_line1\necho mcp_line2', shell: '/bin/sh' } }
        });
        const scriptText = response.body.result.content[0].text;
        assert(response.body.result.isError === false && scriptText.includes('mcp_line1') && scriptText.includes('mcp_line2'), 'MCP script execution');

        response = await rpc({
            jsonrpc: '2.0', id: 5, method: 'tools/call',
            params: { name: 'run_terminal_command', arguments: { command: 'pwd', cwd: '/definitely/missing' } }
        });
        assert(response.body.error && response.body.error.code === -32602, 'MCP rejects invalid cwd');

        response = await rpc({
            jsonrpc: '2.0', id: 6, method: 'tools/call',
            params: { name: 'run_terminal_command', arguments: { command: 'reboot' } }
        });
        const blockedText = response.body.result.content[0].text;
        assert(response.body.result.isError === true && blockedText.includes('blocked: true'), 'MCP enforces SAFE_MODE');
    } finally {
        if (server) server.kill('SIGTERM');
        restoreConfig();
    }
})().catch((err) => {
    if (server) server.kill('SIGTERM');
    restoreConfig();
    console.error(err.stack || err.message);
    process.exit(1);
});
