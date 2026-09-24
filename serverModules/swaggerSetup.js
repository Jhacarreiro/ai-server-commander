// Swagger/OpenAPI Documentation Setup
const swaggerJsdoc = require('swagger-jsdoc');
const packageVersion = require('../package.json').version;

const options = {
    definition: {
        openapi: '3.1.0',
        info: {
            title: 'AI Server Commander',
            version: packageVersion,
        },
        components: {
            schemas: {
                InlineRequest: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'Shell command to execute. Mutually exclusive with script. Limited to MAX_INLINE_COMMAND_BYTES (default 65536); send larger payloads as a script.' },
                        mode: { type: 'string', enum: ['inline'], default: 'inline' },
                        cwd: { type: 'string', description: 'Working directory' },
                        timeoutMs: { type: 'integer', description: 'Timeout in ms' },
                        maxOutputChars: { type: 'integer', description: 'Max output characters' },
                        operationId: { type: 'string', description: 'Optional idempotency key for safe retry/recovery. 1-128 characters: letters, digits, dot, underscore, colon, hyphen.' }
                    },
                    required: ['command']
                },
                ScriptRequest: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string', enum: ['script'], default: 'script', description: 'Script mode. May be omitted when script is provided (auto-detected).' },
                        script: { type: 'string', description: 'Multi-line shell script body. Mutually exclusive with command.' },
                        shell: { type: 'string', description: 'Shell path, e.g. /bin/bash' },
                        cwd: { type: 'string', description: 'Working directory' },
                        timeoutMs: { type: 'integer', description: 'Timeout in ms' },
                        maxOutputChars: { type: 'integer', description: 'Max output characters' },
                        operationId: { type: 'string', description: 'Optional idempotency key for safe retry/recovery. 1-128 characters: letters, digits, dot, underscore, colon, hyphen.' }
                    },
                    required: ['script']
                },
                CommandResponse: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        activityId: { type: 'string' },
                        operationId: { type: 'string' },
                        operationState: { type: 'string', enum: ['running', 'finished', 'indeterminate', 'unknown', 'not_executed'] },
                        replayed: { type: 'boolean' },
                        output: { type: 'string' },
                        exitCode: { type: ['integer', 'null'] },
                        timedOut: { type: 'boolean' },
                        interrupted: { type: 'boolean' },
                        outputTruncated: { type: 'boolean' },
                        maxOutputChars: { type: 'integer' },
                        mode: { type: 'string', enum: ['inline', 'script'] },
                        blocked: { type: 'boolean' },
                        notices: { type: 'array', items: { type: 'object' } }
                    }
                },
                ErrorMessage: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' }
                    },
                    required: ['message']
                },
                OperationStatus: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        operationId: { type: 'string' },
                        state: { type: 'string', enum: ['running', 'finished', 'indeterminate', 'unknown'] },
                        activityId: { type: 'string' },
                        mode: { type: 'string', enum: ['inline', 'script'] },
                        startedAt: { type: 'string', format: 'date-time' },
                        finishedAt: { type: ['string', 'null'], format: 'date-time' },
                        result: {
                            type: ['object', 'null'],
                            properties: {
                                exitCode: { type: ['integer', 'null'] },
                                timedOut: { type: 'boolean' },
                                interrupted: { type: 'boolean' },
                                blocked: { type: 'boolean' },
                                outputTruncated: { type: 'boolean' },
                                mode: { type: 'string', enum: ['inline', 'script'] }
                            }
                        }
                    },
                    required: ['ok', 'operationId', 'state']
                }
            }
        },
    },
    apis: ['./api/*.js'],
};
const openapiSpecification = swaggerJsdoc(options);


const commandRequestBody = {
    required: true,
    content: {
        'application/json': {
            schema: {
                oneOf: [
                    { $ref: '#/components/schemas/InlineRequest' },
                    { $ref: '#/components/schemas/ScriptRequest' }
                ]
            }
        }
    }
};

const commandResponse = {
    description: 'Command execution result',
    content: {
        'application/json': {
            schema: { $ref: '#/components/schemas/CommandResponse' }
        }
    }
};

const errorResponse = (description) => ({
    description,
    content: {
        'application/json': {
            schema: { $ref: '#/components/schemas/ErrorMessage' }
        }
    }
});

const commandResult = (description) => ({ ...commandResponse, description });

// Every status the execute routes return. 202/409 only occur with an
// operationId; 403 is a SAFE_MODE block; 429 means MAX_CONCURRENT_COMMANDS
// is reached; 500 means the command could not be started.
const commandResponses = {
    '200': commandResponse,
    '202': commandResult('operationId replay: the operation is still running and was not executed again'),
    '400': errorResponse('Invalid request'),
    '403': commandResult('Command blocked by SAFE_MODE'),
    '409': commandResult('operationId was used for a different command, or its earlier run cannot be confirmed'),
    '413': errorResponse('Inline command or request body too large'),
    '429': commandResult('Too many concurrent commands; retry later (the operationId is not consumed)'),
    '500': commandResult('The command could not be started')
};

openapiSpecification.paths = {
    ...(openapiSpecification.paths || {}),
    '/api/runTerminalScript': {
        ...(openapiSpecification.paths && openapiSpecification.paths['/api/runTerminalScript'] || {}),
        get: {
            operationId: 'runTerminalCommandGet',
            summary: 'Execute an inline terminal command using the legacy Custom GPT contract',
            parameters: [
                { name: 'command', in: 'query', required: true, schema: { type: 'string' } },
                { name: 'cwd', in: 'query', required: false, schema: { type: 'string' } },
                { name: 'timeoutMs', in: 'query', required: false, schema: { type: 'integer' } },
                { name: 'maxOutputChars', in: 'query', required: false, schema: { type: 'integer' } },
                { name: 'operationId', in: 'query', required: false, schema: { type: 'string' }, description: 'Optional idempotency key for safe retry/recovery' }
            ],
            responses: commandResponses
        },
        post: {
            operationId: 'runTerminalScript',
            summary: 'Execute an inline command or script envelope',
            requestBody: commandRequestBody,
            responses: commandResponses
        }
    },
    '/v1/commands/execute': {
        post: {
            operationId: 'executeCommand',
            summary: 'Execute an inline command or script envelope',
            requestBody: commandRequestBody,
            responses: commandResponses
        }
    },
    '/v1/commands/operations/{operationId}': {
        get: {
            operationId: 'getCommandOperation',
            summary: 'Probe the state of a previously submitted idempotent operation',
            description: 'Covers operations submitted through the REST routes. Records are kept for COMMAND_OPERATION_TTL_SECONDS (default 24 hours); an unknown or expired ID reports state "unknown".',
            parameters: [{ name: 'operationId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
                '200': {
                    description: 'Operation status',
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/OperationStatus' } } }
                },
                '400': errorResponse('Invalid operationId')
            }
        }
    }
};


module.exports = {
    setURL: (url) => {
        openapiSpecification.servers = [{
            url: url,
        }];
    },
    openapiSpecification: (expressApp, url) => {
        expressApp.get('/openapi.json', (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.send(openapiSpecification);
        });
    }
};
