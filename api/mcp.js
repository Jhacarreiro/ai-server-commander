const { executeCommand, parseRequest } = require('./terminal');
const { getActivityContext } = require('./activityLog');

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
    const error = { code, message };
    if (typeof data !== 'undefined') error.data = data;
    return { jsonrpc: '2.0', id: id ?? null, error };
}

function commandToText(result) {
    const parts = [
        `activityId: ${result.activityId}`,
        `mode: ${result.mode}`,
        `exitCode: ${result.exitCode}`,
        `timedOut: ${result.timedOut}`,
        `interrupted: ${result.interrupted}`,
        `blocked: ${result.blocked}`,
        `outputTruncated: ${result.outputTruncated}`
    ];
    if (result.output) parts.push(`\noutput:\n${result.output}`);
    if (Array.isArray(result.notices) && result.notices.length) {
        parts.push(`\nnotices:\n${JSON.stringify(result.notices)}`);
    }
    return parts.join('\n').trim();
}

module.exports = function createMcpHandler() {
    const packageVersion = (() => {
        try { return require('../package.json').version || '0.0.0'; }
        catch (_) { return '0.0.0'; }
    })();

    const tool = {
        name: 'run_terminal_command',
        description: 'Run a bounded shell command or multi-line script on the AI Server Commander host. Use only when the user explicitly asks for remote terminal execution. Returns output, exit code, timeout, interruption, SAFE_MODE and truncation status.',
        inputSchema: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    enum: ['inline', 'script'],
                    description: 'Execution mode. Defaults to inline, or script when script is provided.'
                },
                command: {
                    type: 'string',
                    description: 'The exact shell command to execute in inline mode.'
                },
                script: {
                    type: 'string',
                    description: 'A multi-line shell script body for script mode.'
                },
                cwd: {
                    type: 'string',
                    description: 'Existing working directory. Invalid paths are rejected.'
                },
                shell: {
                    type: 'string',
                    description: 'Shell executable for script mode, for example /bin/sh.'
                },
                timeoutMs: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Requested timeout in milliseconds, capped by server policy.'
                },
                maxOutputChars: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Requested output limit in characters, capped by server policy.'
                }
            },
            oneOf: [
                { required: ['command'] },
                { required: ['script'] }
            ],
            additionalProperties: false
        }
    };

    async function handleRequest(message, req) {
        if (!message || message.jsonrpc !== '2.0') {
            return jsonRpcError(null, -32600, 'Invalid JSON-RPC request');
        }
        if (typeof message.id === 'undefined') return null;

        const id = message.id;
        const method = message.method;
        const params = message.params || {};

        if (method === 'initialize') {
            return jsonRpcResult(id, {
                protocolVersion: params.protocolVersion || '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'gallivanter-terminal', version: packageVersion },
                instructions: 'This MCP server exposes bounded remote terminal execution on Gallivanter. Use run_terminal_command only with explicit user approval and prefer short, verifiable commands. Multi-line scripts are supported with mode=script.'
            });
        }
        if (method === 'ping') return jsonRpcResult(id, {});
        if (method === 'tools/list') return jsonRpcResult(id, { tools: [tool] });
        if (method === 'resources/list') return jsonRpcResult(id, { resources: [] });
        if (method === 'prompts/list') return jsonRpcResult(id, { prompts: [] });

        if (method === 'tools/call') {
            if (!params || params.name !== tool.name) return jsonRpcError(id, -32602, 'Unknown tool');

            const args = params.arguments && typeof params.arguments === 'object' ? { ...params.arguments } : {};
            if (!args.mode && typeof args.script === 'string') args.mode = 'script';
            const parsed = parseRequest({ method: 'POST', body: args, query: {} });
            if (parsed.error) return jsonRpcError(id, -32602, parsed.message);

            try {
                const context = getActivityContext(req, { conversationId: 'mcp' });
                const outcome = await executeCommand(parsed, context, 'mcp');
                const result = outcome.result;
                return jsonRpcResult(id, {
                    content: [{ type: 'text', text: commandToText(result) || '(no output)' }],
                    isError: outcome.status >= 400 || result.exitCode !== 0 || result.timedOut || result.interrupted || result.blocked
                });
            } catch (error) {
                console.error('[mcp] tool execution failed:', error.message);
                return jsonRpcError(id, -32603, 'Tool execution failed');
            }
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
        if (!body) return res.status(400).json(jsonRpcError(null, -32700, 'Missing JSON body'));

        const messages = Array.isArray(body) ? body : [body];
        const responses = [];
        for (const message of messages) {
            const response = await handleRequest(message, req);
            if (response) responses.push(response);
        }

        if (responses.length === 0) return res.status(202).end();
        res.type('application/json');
        return res.status(200).json(Array.isArray(body) ? responses : responses[0]);
    };
};
