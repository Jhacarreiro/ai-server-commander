# AI Server Commander

AI Server Commander is a self-hosted bridge that lets approved assistant clients run terminal commands and use server-side tools on a machine you control.

It started as a Custom GPT Actions server and now also exposes a remote MCP endpoint for Claude and other MCP-capable clients. The goal is one controlled server-side capability layer with multiple client adapters: REST/OpenAPI for ChatGPT Actions and MCP/OAuth for Claude.

## What it can do

- Run terminal commands through a REST API for Custom GPT Actions.
- Run terminal commands through a remote MCP endpoint for Claude and other MCP clients.
- Preserve a compatible legacy GET action while adding safer POST execution modes.
- Execute single-line commands or multi-line script envelopes with bounded timeouts and output limits.
- Return structured command results: output, exit code, timeout state, truncation metadata and notices.
- Expose a generated OpenAPI schema at `/openapi.json`.
- Keep lightweight activity metadata without storing full script bodies.
- Support local tunnel / public HTTPS deployments so assistant clients can reach the server.

## Latest updates

The current `main` includes command execution hardening:

- `POST /api/runTerminalScript` for JSON command execution requests.
- `POST /v1/commands/execute` as a versioned command execution endpoint.
- `mode: "script"` for multi-line commands and fragile shell quoting cases.
- Smoke tests for executor behavior, routes and OpenAPI schema.
- README, ROADMAP and CHANGELOG updates for the renamed AI Server Commander project.

See [CHANGELOG.md](./CHANGELOG.md) for release notes and [ROADMAP.md](./ROADMAP.md) for planned milestones.

## Client model

AI Server Commander does not provide model credits or model hosting. The assistant work happens in the client you connect:

- ChatGPT calls the REST/OpenAPI endpoints from a Custom GPT Action.
- Claude calls the MCP endpoint from a connector / MCP-capable client.
- The server receives approved tool calls and executes them on your machine.
- Third-party APIs, paid services or commands invoked by your scripts remain your responsibility.

When a capability is added, it should normally be exposed with matching safety rules across REST/OpenAPI and MCP.

## Requirements

- Node.js 18 or newer.
- A machine that can run the Node server.
- A reachable HTTPS URL for ChatGPT or remote MCP clients. Local-only testing can use `localhost`; production use normally needs a reverse proxy, tunnel or public server URL.

## Install and run

Clone the repository and install dependencies:

```bash
git clone https://github.com/Jhacarreiro/ai-server-commander.git
cd ai-server-commander
npm install
```

Start the server:

```bash
npm run start
```

On first run, the interactive setup asks for:

- the port to listen on;
- whether to use LocalTunnel;
- the public server URL when not using LocalTunnel.

It writes a local `config.json` with an `authToken`. Treat that token as a secret. Do not commit it.

A minimal local-style config looks like this:

```json
{
  "port": 3000,
  "useLocalTunnel": false,
  "productionDomain": "https://your-server.example.com",
  "authToken": "replace-with-a-random-secret"
}
```

Then start again with:

```bash
npm run start
```

Useful local checks:

```bash
npm run check
npm test
```

## Use with ChatGPT Actions

1. Start AI Server Commander and make it reachable over HTTPS.
2. Open your Custom GPT builder.
3. Add the instructions from [prompt.md](./prompt.md) or adapt them for your GPT.
4. Import the OpenAPI schema from your server:

```text
https://your-server.example.com/openapi.json
```

5. Configure Action authentication as Bearer token auth.
6. Use the `authToken` from `config.json` as the Bearer token.

The legacy action endpoint remains available:

```http
GET /api/runTerminalScript?command=pwd%20%26%26%20hostname
Authorization: Bearer <authToken>
```

## Use with Claude / MCP

AI Server Commander exposes a remote MCP endpoint:

```text
https://your-server.example.com/mcp
```

OAuth discovery endpoints are exposed automatically under:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/oauth/register
/oauth/authorize
/oauth/token
```

MCP clients that support remote MCP + OAuth discovery can use the MCP endpoint directly. The main tool currently exposed over MCP is:

```text
run_terminal_command
```

For simple setups, the MCP endpoint also supports token-based access using the same server token where supported by the client.

## Command execution API

### GET inline, legacy-compatible

```http
GET /api/runTerminalScript?command=pwd%20%26%26%20hostname
Authorization: Bearer <authToken>
```

### POST inline

```http
POST /api/runTerminalScript
Authorization: Bearer <authToken>
Content-Type: application/json

{
  "command": "pwd && hostname",
  "mode": "inline",
  "cwd": "/srv/project",
  "timeoutMs": 45000,
  "maxOutputChars": 12000
}
```

### POST script mode

Use script mode for multi-line commands, nested quotes, JSON/YAML edits or commands that are fragile as a single URL/query string.

```http
POST /api/runTerminalScript
Authorization: Bearer <authToken>
Content-Type: application/json

{
  "mode": "script",
  "script": "set -e\npwd\nhostname\n",
  "shell": "/bin/sh",
  "cwd": "/srv/project",
  "timeoutMs": 45000,
  "maxOutputChars": 12000
}
```

The versioned endpoint accepts the same POST body:

```http
POST /v1/commands/execute
```

### Response shape

```json
{
  "message": "Command executed successfully.",
  "output": "...",
  "exitCode": 0,
  "timedOut": false,
  "outputTruncated": false,
  "maxOutputChars": 12000,
  "mode": "inline",
  "notices": []
}
```

## Activity log and notices

AI Server Commander can keep lightweight operational metadata for command and notice lifecycle events. It is designed for visibility, not full transcript storage.

Activity endpoints:

```http
GET /api/activity?limit=50
GET /api/activity/status
GET /api/activity?scope=global&limit=50
GET /api/activity?scope=conversation&conversationId=...
GET /api/activity?scope=task&taskId=...
GET /api/activity/index
POST /api/activity/context
```

Notice endpoints:

```http
POST /api/notices
POST /api/notices/{id}/ack
```

Notice scoping rules:

```text
no conversationId/taskId -> global notice
conversationId only      -> visible only to that conversation
taskId only              -> visible only to that task
both                     -> visible only when both match
```

## Safety notes

- Keep `config.json` and `authToken` private.
- Put the server behind HTTPS before connecting remote clients.
- Use short, explicit commands when possible.
- Prefer POST script mode when quoting becomes fragile.
- Timeouts are enforced; `COMMAND_TIMEOUT_MS` caps command execution.
- Output is truncated at `MAX_OUTPUT_CHARS`.
- Script bodies are capped by `MAX_SCRIPT_BODY_BYTES`.
- Script temp files are cleaned up after execution.
- Activity logs record metadata such as hash, byte length and previews rather than full script bodies.
- Destructive operations should require explicit human approval.

## Project files

- [CHANGELOG.md](./CHANGELOG.md) — release notes and latest user-visible changes.
- [ROADMAP.md](./ROADMAP.md) — planned milestones and parity goals.
- [prompt.md](./prompt.md) — starter Custom GPT instructions.
- [todo.md](./todo.md) — legacy task list.

## Contributing

Contributions are welcome. Please keep changes generic and avoid committing secrets, personal deployment details, logs or local configuration.

## License

The project is licensed under the MIT License.
