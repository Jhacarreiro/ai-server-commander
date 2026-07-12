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

function request(method, requestPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = typeof body === 'undefined' || body === null ? null : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            method,
            headers: {
                ...headers,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            },
            timeout: 12000
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let parsed = text;
                try { parsed = JSON.parse(text); } catch (_) {}
                resolve({ status: res.statusCode, body: parsed, headers: res.headers });
            });
        });
        req.on('timeout', () => req.destroy(new Error('request timeout')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
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

        let response = await request('GET', '/.well-known/oauth-protected-resource/mcp');
        assert(response.status === 200 && response.body.scopes_supported.includes('terminal') && response.body.resource.endsWith('/mcp'), 'OAuth protected-resource metadata');
        assert(response.body.resource_documentation.includes('github.com/Jhacarreiro/ai-server-commander'), 'OAuth metadata has public documentation');

        response = await request('GET', '/.well-known/oauth-authorization-server');
        assert(response.status === 200 && response.body.scopes_supported.includes('terminal') && response.body.registration_endpoint.endsWith('/oauth/register'), 'OAuth authorization-server metadata');

        response = await request('POST', '/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
        assert(response.status === 401 && String(response.headers['www-authenticate']).includes('resource_metadata=') && String(response.headers['www-authenticate']).includes('scope="terminal"'), 'MCP unauthorized challenge advertises OAuth metadata and scope');

        response = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
        assert(response.status === 200 && response.body.result.serverInfo.version && response.body.result.serverInfo.name === 'ai-server-commander', 'MCP initialize');

        response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        const listedTool = response.body.result.tools[0];
        const schema = listedTool.inputSchema;
        assert(schema.properties.script && schema.properties.cwd && schema.properties.timeoutMs, 'MCP schema exposes bounded script options');
        assert(listedTool.title === 'Run terminal command', 'MCP tool has a human-readable title');
        assert(listedTool.outputSchema && listedTool.outputSchema.properties.activityId, 'MCP tool declares output schema');
        assert(listedTool.outputSchema.additionalProperties === false && listedTool.outputSchema.required.includes('notices'), 'MCP output schema is exact and complete');
        assert(listedTool.annotations && listedTool.annotations.readOnlyHint === false && listedTool.annotations.destructiveHint === true && listedTool.annotations.openWorldHint === true && listedTool.annotations.idempotentHint === false, 'MCP tool declares risk annotations');
        assert(Array.isArray(listedTool.securitySchemes) && listedTool.securitySchemes[0].type === 'oauth2' && listedTool.securitySchemes[0].scopes.includes('terminal'), 'MCP tool declares OAuth security scheme');
        assert(listedTool._meta && JSON.stringify(listedTool._meta.securitySchemes) === JSON.stringify(listedTool.securitySchemes), 'MCP tool mirrors security scheme in _meta');

        response = await rpc({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: 'run_terminal_command', arguments: { command: 'printf mcp_ok', timeoutMs: 5000 } }
        });
        const inlineText = response.body.result.content[0].text;
        const inlineStructured = response.body.result.structuredContent;
        assert(response.body.result.isError === false && inlineText.includes('mcp_ok') && inlineText.includes('activityId:'), 'MCP inline execution uses shared executor');
        assert(inlineStructured && inlineStructured.output === 'mcp_ok' && inlineStructured.exitCode === 0 && inlineStructured.activityId, 'MCP inline execution returns structured content');
        assert(Object.keys(inlineStructured).sort().join(',') === listedTool.outputSchema.required.slice().sort().join(','), 'MCP structured result matches declared output keys');

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
        const blockedStructured = response.body.result.structuredContent;
        assert(response.body.result.isError === true && blockedText.includes('blocked: true'), 'MCP enforces SAFE_MODE');
        assert(blockedStructured && blockedStructured.blocked === true && blockedStructured.exitCode === 126, 'MCP SAFE_MODE result remains structured');
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
