const { exec } = require('child_process');

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
    const error = { code, message };
    if (typeof data !== 'undefined') error.data = data;
    return { jsonrpc: '2.0', id: id ?? null, error };
}

function commandToText(result) {
    const parts = [];
    parts.push(`exitCode: ${result.exitCode}`);
    parts.push(`timedOut: ${result.timedOut}`);
    if (result.stdout) parts.push(`\nstdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`\nstderr:\n${result.stderr}`);
    if (result.errorMessage) parts.push(`\nerror:\n${result.errorMessage}`);
    return parts.join('\n').trim();
}

function runCommand(command) {
    return new Promise((resolve) => {
        exec(command, {
            shell: process.env.SHELL || '/bin/bash',
            cwd: process.env.HOME || process.cwd(),
            timeout: 45000,
            maxBuffer: 1024 * 1024
        }, (error, stdout, stderr) => {
            resolve({
                stdout: (stdout || '').trimEnd(),
                stderr: (stderr || '').trimEnd(),
                exitCode: error && typeof error.code !== 'undefined' ? error.code : 0,
                timedOut: Boolean(error && error.killed),
                errorMessage: error ? error.message : null
            });
        });
    });
}

module.exports = function createMcpHandler(config) {
    const packageVersion = (() => {
        try { return require('../package.json').version || '0.0.0'; }
        catch (_) { return '0.0.0'; }
    })();

    const tool = {
        name: 'run_terminal_command',
        description: 'Run a shell command on the Gallivanter ServerCommander host. Use only when the user explicitly asks for remote terminal execution. Returns stdout, stderr, exit code and timeout status.',
        inputSchema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The exact shell command to execute.'
                }
            },
            required: ['command'],
            additionalProperties: false
        }
    };

    async function handleRequest(message) {
        if (!message || message.jsonrpc !== '2.0') {
            return jsonRpcError(null, -32600, 'Invalid JSON-RPC request');
        }

        if (typeof message.id === 'undefined') {
            return null;
        }

        const id = message.id;
        const method = message.method;
        const params = message.params || {};

        if (method === 'initialize') {
            return jsonRpcResult(id, {
                protocolVersion: params.protocolVersion || '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: {
                    name: 'gallivanter-terminal',
                    version: packageVersion
                },
                instructions: 'This MCP server exposes remote terminal execution on Gallivanter. Use run_terminal_command only with explicit user approval and prefer short, verifiable commands.'
            });
        }

        if (method === 'ping') {
            return jsonRpcResult(id, {});
        }

        if (method === 'tools/list') {
            return jsonRpcResult(id, { tools: [tool] });
        }

        if (method === 'resources/list') {
            return jsonRpcResult(id, { resources: [] });
        }

        if (method === 'prompts/list') {
            return jsonRpcResult(id, { prompts: [] });
        }

        if (method === 'tools/call') {
            if (!params || params.name !== tool.name) {
                return jsonRpcError(id, -32602, 'Unknown tool');
            }

            const command = params.arguments && params.arguments.command;
            if (typeof command !== 'string' || !command.trim()) {
                return jsonRpcError(id, -32602, 'Tool argument command is required');
            }

            const result = await runCommand(command);
            const text = commandToText(result) || '(no output)';
            return jsonRpcResult(id, {
                content: [{ type: 'text', text }],
                isError: result.exitCode !== 0 || result.timedOut
            });
        }

        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }

    return async function mcpHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');

        if (req.method === 'GET' || req.method === 'DELETE') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ error: 'MCP endpoint supports POST only; SSE is not implemented.' });
        }

        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ error: 'Method not allowed.' });
        }

        const body = req.body;
        if (!body) {
            return res.status(400).json(jsonRpcError(null, -32700, 'Missing JSON body'));
        }

        const messages = Array.isArray(body) ? body : [body];
        const responses = [];

        for (const message of messages) {
            const response = await handleRequest(message);
            if (response) responses.push(response);
        }

        if (responses.length === 0) {
            return res.status(202).end();
        }

        res.type('application/json');
        return res.status(200).json(Array.isArray(body) ? responses : responses[0]);
    };
};
