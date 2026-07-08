// Swagger/OpenAPI Documentation Setup
const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.1.0',
        info: {
            title: 'AI Server Commander',
            version: '1.0.4',
        },
        components: {
            schemas: {
                InlineRequest: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'Shell command to execute' },
                        mode: { type: 'string', enum: ['inline'], default: 'inline' },
                        cwd: { type: 'string', description: 'Working directory' },
                        timeoutMs: { type: 'integer', description: 'Timeout in ms' },
                        maxOutputChars: { type: 'integer', description: 'Max output characters' }
                    },
                    required: ['command']
                },
                ScriptRequest: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string', enum: ['script'] },
                        script: { type: 'string', description: 'Multi-line shell script body' },
                        shell: { type: 'string', description: 'Shell path, e.g. /bin/sh' },
                        cwd: { type: 'string', description: 'Working directory' },
                        timeoutMs: { type: 'integer', description: 'Timeout in ms' },
                        maxOutputChars: { type: 'integer', description: 'Max output characters' }
                    },
                    required: ['mode', 'script']
                },
                CommandResponse: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        output: { type: 'string' },
                        exitCode: { type: ['integer', 'null'] },
                        timedOut: { type: 'boolean' },
                        outputTruncated: { type: 'boolean' },
                        maxOutputChars: { type: 'integer' },
                        mode: { type: 'string', enum: ['inline', 'script'] },
                        blocked: { type: 'boolean' },
                        notices: { type: 'array', items: { type: 'object' } }
                    }
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

openapiSpecification.paths = {
    ...(openapiSpecification.paths || {}),
    '/api/runTerminalScript': {
        ...(openapiSpecification.paths && openapiSpecification.paths['/api/runTerminalScript'] || {}),
        get: {
            summary: 'Execute an inline terminal command using the legacy Custom GPT contract',
            parameters: [
                { name: 'command', in: 'query', required: true, schema: { type: 'string' } },
                { name: 'cwd', in: 'query', required: false, schema: { type: 'string' } },
                { name: 'timeoutMs', in: 'query', required: false, schema: { type: 'integer' } },
                { name: 'maxOutputChars', in: 'query', required: false, schema: { type: 'integer' } }
            ],
            responses: { '200': commandResponse }
        },
        post: {
            summary: 'Execute an inline command or script envelope',
            requestBody: commandRequestBody,
            responses: { '200': commandResponse, '400': { description: 'Invalid request' } }
        }
    },
    '/v1/commands/execute': {
        post: {
            summary: 'Execute an inline command or script envelope',
            requestBody: commandRequestBody,
            responses: { '200': commandResponse, '400': { description: 'Invalid request' } }
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
        console.log(openapiSpecification);
        expressApp.get('/openapi.json', (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.send(openapiSpecification);
        });
    }
};
