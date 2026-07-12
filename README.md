# AI Server Commander

[![CI](https://github.com/Jhacarreiro/ai-server-commander/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhacarreiro/ai-server-commander/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jhacarreiro/ai-server-commander)](https://github.com/Jhacarreiro/ai-server-commander/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

AI Server Commander is a self-hosted bridge that lets approved AI assistant clients run bounded terminal commands on a machine you control.

It exposes the same execution core through two client adapters:

- **REST/OpenAPI** for ChatGPT Custom GPT Actions and automation clients.
- **Remote MCP + OAuth** for Claude and other MCP-capable clients.

The server does not provide model access or credits. It receives authenticated tool calls, applies local policy and limits, executes the requested command on the host, and returns a structured result.

> [!CAUTION]
> AI Server Commander can execute real shell commands with the permissions of its operating-system user. It is **not a sandbox**. Run it as a dedicated unprivileged user, keep it behind HTTPS, enable `SAFE_MODE`, and expose it only to clients and users you trust.

## Features

- One bounded command executor shared by REST and MCP.
- Inline commands and multi-line script mode.
- Per-command timeouts and output limits.
- Independent activity IDs for concurrent commands.
- Targeted interruption by `activityId`.
- Optional `SAFE_MODE` denylist for obviously destructive commands.
- Process-group termination on timeout or interruption on POSIX hosts.
- Structured results with output, exit code, timeout, interruption, blocking and truncation metadata.
- Lightweight activity logs and scoped notices.
- Generated OpenAPI document at `/openapi.json`.
- Remote MCP endpoint at `/mcp`.
- OAuth discovery, dynamic client registration, authorization code + PKCE, access tokens and refresh tokens.
- MCP tool title, input/output schemas, risk annotations, OAuth security schemes and structured content.
- Backward-compatible legacy REST endpoint for existing Custom GPT Actions.

## Architecture

```text
ChatGPT Custom GPT / REST client
              │ HTTPS + Bearer token
              ▼
        REST / OpenAPI adapter ─────┐
                                    │
Claude / remote MCP client          ├── shared bounded executor ── host shell
              │ HTTPS + OAuth       │             │
              ▼                     │             ├── SAFE_MODE
          MCP adapter ──────────────┘             ├── timeout/output caps
                                                   ├── activity log
                                                   └── notices
```

See [docs/architecture.md](./docs/architecture.md) for request flows, trust boundaries and the module map.

## Requirements

- Node.js **20 or newer**.
- Linux, macOS or another host with a compatible shell.
- A public HTTPS URL for ChatGPT or remote MCP clients.
- A dedicated, minimally privileged operating-system account for production use.

Windows may work for basic commands, but process-group termination is POSIX-specific.

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/Jhacarreiro/ai-server-commander.git
cd ai-server-commander
npm install
```

### 2. Create configuration

The first `npm start` launches an interactive setup and writes `config.json`.

```bash
npm start
```

For non-interactive deployment:

```bash
cp config.example.json config.json
chmod 600 config.json
```

Minimal configuration:

```json
{
  "port": 3000,
  "useLocalTunnel": false,
  "productionDomain": "https://commander.example.com",
  "authToken": "replace-with-a-long-random-secret",
  "mcpToken": "replace-with-a-separate-long-random-secret"
}
```

Generate tokens with a cryptographically secure tool:

```bash
openssl rand -hex 32
```

### 3. Start with safer defaults

```bash
SAFE_MODE=true npm start
```

Local checks:

```bash
curl http://127.0.0.1:3000/openapi.json
npm run check
npm test
```

### 4. Put it behind HTTPS

Use a reverse proxy such as Nginx, Caddy or a managed tunnel. Forward the original host and scheme so OAuth metadata contains the correct public URL.

See [docs/deployment.md](./docs/deployment.md) for systemd, Nginx, upgrades and rollback.

## Configuration

### `config.json`

| Key | Required | Purpose |
|---|---:|---|
| `port` | Yes | Local TCP port used by the Node server. |
| `useLocalTunnel` | Yes | Starts the legacy LocalTunnel integration when `true`. Prefer a maintained reverse proxy or tunnel for production. |
| `localTunnelSubdomain` | When LocalTunnel is enabled | Requested LocalTunnel subdomain. |
| `productionDomain` | Recommended | Exact public origin, such as `https://commander.example.com`. Required for correct remote OAuth metadata behind a proxy. |
| `authToken` | Yes | Bearer token for REST and approval code for the built-in OAuth consent page. |
| `mcpToken` | No | Separate pre-shared token for MCP clients that support token auth. Falls back to `authToken` when omitted. |

`config.json` contains secrets and is ignored by Git. Keep it mode `600` and never paste it into issues or logs.

### Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `SAFE_MODE` | `false` | Enables the built-in destructive-command denylist. Recommended for production. |
| `COMMAND_TIMEOUT_MS` | `120000` | Server-wide maximum command duration. Client requests can ask for less, not more. |
| `MAX_OUTPUT_CHARS` | `12000` | Server-wide maximum returned output. |
| `MAX_SCRIPT_BODY_BYTES` | `524288` | Maximum script/request body size. |
| `SHELL` | Host default | Shell used for inline execution and as script-mode fallback. |
| `NODE_ENV` | unset | Standard Node environment label. |

See [.env.example](./.env.example). The application does not automatically load `.env`; set variables through your shell, process manager or service unit.

## ChatGPT Custom GPT Actions

Custom GPT Actions use the REST/OpenAPI adapter and remain the most broadly compatible ChatGPT path.

1. Deploy AI Server Commander on a public HTTPS origin.
2. In the Custom GPT builder, add an Action.
3. Import `https://commander.example.com/openapi.json`.
4. Configure API-key authentication as a Bearer token.
5. Use the `authToken` value from `config.json`.
6. Add or adapt [prompt.md](./prompt.md) as the GPT instructions.
7. Test first with a read-only command such as `pwd && hostname`.

Legacy GET request:

```http
GET /api/runTerminalScript?command=pwd%20%26%26%20hostname
Authorization: Bearer <authToken>
```

Preferred POST request:

```http
POST /v1/commands/execute
Authorization: Bearer <authToken>
Content-Type: application/json

{
  "mode": "inline",
  "command": "pwd && hostname",
  "cwd": "/srv/project",
  "timeoutMs": 45000,
  "maxOutputChars": 12000
}
```

## Remote MCP clients

The remote MCP endpoint is:

```text
https://commander.example.com/mcp
```

The primary tool is `run_terminal_command`.

| Field | Type | Notes |
|---|---|---|
| `command` | string | Exact command for inline mode. |
| `script` | string | Multi-line script body. Supplying it defaults the mode to `script`. |
| `mode` | `inline` or `script` | Optional explicit mode. |
| `cwd` | string | Must be an existing readable directory. Invalid paths are rejected. |
| `shell` | string | Script-mode shell, for example `/bin/sh`. |
| `timeoutMs` | integer | Requested timeout, capped by server policy. |
| `maxOutputChars` | integer | Requested output limit, capped by server policy. |

### OAuth discovery

The server publishes:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
/.well-known/openid-configuration
/oauth/register
/oauth/authorize
/oauth/token
```

The built-in flow supports dynamic client registration, authorization code + PKCE and refresh tokens. The authorization page asks for the server `authToken` as the approval code.

> [!IMPORTANT]
> OAuth clients, authorization codes and tokens are currently stored in process memory. Restarting the server invalidates them and connected MCP clients may need to reconnect. Persistent OAuth state is planned, not yet implemented.

### ChatGPT MCP readiness

The MCP descriptor includes OAuth security schemes, a compatibility mirror in `_meta`, risk annotations, an output schema and `structuredContent`. Whether a specific ChatGPT account or surface can add a custom remote MCP server depends on the current ChatGPT plan and client capabilities. Keep the REST Action path available until the target workflow is validated.

## Command modes

### Inline

```bash
curl -sS \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"mode":"inline","command":"pwd && hostname","timeoutMs":5000}' \
  https://commander.example.com/v1/commands/execute
```

### Multi-line script

```bash
curl -sS \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "mode":"script",
    "shell":"/bin/sh",
    "script":"set -e\npwd\nhostname\n",
    "timeoutMs":5000
  }' \
  https://commander.example.com/v1/commands/execute
```

### Response

```json
{
  "message": "Command executed successfully.",
  "activityId": "cmd_...",
  "output": "...",
  "exitCode": 0,
  "timedOut": false,
  "interrupted": false,
  "blocked": false,
  "outputTruncated": false,
  "maxOutputChars": 12000,
  "mode": "inline",
  "notices": []
}
```

### Interrupt a command

When exactly one command is active:

```http
POST /api/interrupt
Authorization: Bearer <authToken>
```

When several commands may be active, target one explicitly:

```http
POST /api/interrupt
Authorization: Bearer <authToken>
Content-Type: application/json

{
  "activityId": "cmd_..."
}
```

## Activity log and notices

Activity endpoints:

```text
GET  /api/activity
GET  /api/activity/status
GET  /api/activity/index
POST /api/activity/context
```

Notice endpoints:

```text
POST /api/notices
GET  /api/notices/pending
POST /api/notices/:id/ack
```

Activity records use command hashes, byte counts and redacted previews rather than complete script bodies by default. Treat generated `runtime/` data as potentially sensitive operational metadata.

## Security model

AI Server Commander provides controls, not isolation:

- Authentication gates the HTTP interfaces.
- The shared executor caps duration and returned output.
- `SAFE_MODE` blocks a small set of obviously destructive patterns.
- Invalid working directories fail closed.
- Temporary script files are mode-restricted and deleted after execution.
- Activity previews redact common token and secret patterns.
- MCP risk annotations tell compatible clients that terminal execution may be destructive and open-world.

It does **not** provide:

- a container or VM sandbox;
- a complete shell parser or comprehensive command policy;
- per-user operating-system isolation;
- a path allowlist;
- protection from every form of command composition or shell indirection;
- durable OAuth state;
- rate limiting.

Recommended production controls:

1. Run as a dedicated unprivileged user.
2. Do not add the service user to `docker`, `sudo` or other privileged groups unless explicitly required.
3. Enable `SAFE_MODE=true`, but do not treat it as a sandbox.
4. Restrict network exposure with a firewall, access proxy or VPN where client requirements permit.
5. Use separate high-entropy `authToken` and `mcpToken` values.
6. Rotate tokens after accidental disclosure.
7. Review activity and system service logs.
8. Require human confirmation for commands that write, delete, restart services, change permissions or access credentials.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## Testing

```bash
npm run check
npm test
```

The smoke suite covers:

- bounded executor behavior;
- REST GET/POST compatibility;
- multi-line scripts and request-size limits;
- invalid working directories;
- concurrency and targeted interruption;
- MCP initialization, metadata and execution;
- OAuth metadata and challenge behavior;
- `SAFE_MODE` results;
- OpenAPI generation and version alignment.

CI runs checks on supported Node versions for every push and pull request.

## Troubleshooting

### Public URLs use `http://` or the wrong hostname

Set `productionDomain` to the exact external HTTPS origin and forward `Host` and `X-Forwarded-Proto` from the reverse proxy.

### The MCP client asks to reconnect after a restart

OAuth state is currently in memory. Re-run the connector authorization flow.

### A command runs in the wrong directory

Pass an explicit `cwd`. It must exist and be readable by the service user.

### A request times out earlier than expected

The effective timeout is the lower of the client request and `COMMAND_TIMEOUT_MS`.

### Output is incomplete

Check `outputTruncated`. Increase the requested `maxOutputChars` and, if needed, the server-wide `MAX_OUTPUT_CHARS` cap. Prefer commands that filter output before returning it.

### OAuth discovery fails

Check these URLs from outside your network:

```bash
curl -i https://commander.example.com/.well-known/oauth-protected-resource/mcp
curl -i https://commander.example.com/.well-known/oauth-authorization-server
curl -i https://commander.example.com/mcp
```

The unauthenticated `/mcp` request should return `401` with a `WWW-Authenticate` challenge pointing to protected-resource metadata.

## Documentation

- [Architecture](./docs/architecture.md)
- [Deployment and upgrades](./docs/deployment.md)
- [Changelog](./CHANGELOG.md)
- [Roadmap](./ROADMAP.md)
- [Custom GPT instruction starter](./prompt.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Support](./SUPPORT.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Attribution](./NOTICE.md)

## Project status

AI Server Commander is a small self-hosted project maintained on a best-effort basis. The command-execution surface is intentionally narrow. New capabilities should normally be implemented once in shared core code and exposed through both REST and MCP adapters with matching safety semantics.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Do not include deployment secrets, private hostnames, personal paths, access tokens, logs or production state.

## License

Licensed under the [MIT License](./LICENSE). See [NOTICE.md](./NOTICE.md) for project attribution.
