# AI Server Commander

[![CI](https://github.com/Jhacarreiro/ai-server-commander/actions/workflows/ci.yml/badge.svg)](https://github.com/Jhacarreiro/ai-server-commander/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jhacarreiro/ai-server-commander)](https://github.com/Jhacarreiro/ai-server-commander/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

AI Server Commander is a self-hosted control plane that lets approved AI assistant clients use bounded capabilities on machines and authenticated local services you control. Its production core today is terminal execution; the project is designed to grow through optional capability adapters without turning client-specific behavior into core infrastructure. OpenAI/ChatGPT and Anthropic/Claude are first-class client families; additional clients and protocols are welcome when they do not compromise functionality, reliability, or performance for those two.

It exposes the same execution core through two primary client adapters:

- **REST/OpenAPI** for ChatGPT Custom GPT Actions and automation clients.
- **Remote MCP + OAuth** for Claude and other MCP-capable clients.

The server does not provide model access or credits. It receives authenticated requests, applies local policy and limits, invokes an explicitly enabled capability, and returns structured state or results. In v1.0.8 the production capability is the bounded host command executor.

The longer-term direction is broader than terminal access: Commander should remain a small, auditable control plane that can expose typed capabilities such as read-only filesystem operations, remote-host adapters and browser/session automation while keeping authentication, policy, activity state and client transports at clear boundaries. A future mobile or chat UI should consume these capabilities rather than become a dependency of the core server.

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

That diagram is the current production baseline. The extension model keeps REST/MCP and future clients thin while adding optional typed capabilities behind the same control-plane boundary. Planned examples include policy-aware read-only tools and an authenticated browser/session adapter for observing explicitly selected web conversations.

See [docs/architecture.md](./docs/architecture.md) for request flows, trust boundaries and the module map.

## Requirements

- Node.js **20 or newer**. CI tests Node 20, 22 and 24. Node 20 reached end of life in April 2026 and no longer receives security fixes, so run production on Node 22 or 24.
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
  "productionDomain": "https://commander.example.com",
  "authToken": "replace-me",
  "mcpToken": "replace-me-too"
}
```

The placeholder values shown above are invalid on purpose: the server rejects
placeholder secrets at startup instead of running with publicly-known
credentials. Generate tokens with a cryptographically secure tool:

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
| `productionDomain` | Yes | Exact public origin, such as `https://commander.example.com`. Required for correct remote OAuth metadata behind a proxy. |
| `authToken` | Yes | Bearer token for REST and approval code for the built-in OAuth consent page. |
| `mcpToken` | No | Separate pre-shared token for MCP clients that support token auth. Falls back to `authToken` when omitted. |

`config.json` contains secrets and is ignored by Git. Keep it mode `600` and never paste it into issues or logs.

LocalTunnel support was removed in v1.0.8 because its pinned HTTP dependency chain could not be updated safely. Existing configurations with `useLocalTunnel: true` now fail with migration guidance. Use a maintained HTTPS reverse proxy or tunnel and set `productionDomain` explicitly.

### Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `SAFE_MODE` | `false` | Enables the built-in destructive-command denylist. Recommended for production. |
| `COMMAND_TIMEOUT_MS` | `120000` | Server-wide maximum command duration. Client requests can ask for less, not more. |
| `MAX_OUTPUT_CHARS` | `12000` | Server-wide maximum returned output. |
| `MAX_SCRIPT_BODY_BYTES` | `524288` | Maximum script/request body size. |
| `COMMAND_OPERATIONS_PATH` | `runtime/command-operations.json` | Persistent `operationId` state used for idempotent recovery. |
| `COMMAND_OPERATION_TTL_SECONDS` | `86400` | How long a completed or accepted `operationId` is retained before it can be reused. |
| `OAUTH_STATE_PATH` | `runtime/oauth-state.json` | Persistent OAuth client and token-hash state. |
| `OAUTH_AUTH_CODE_TTL_SECONDS` | `300` | Authorization-code lifetime. |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access-token lifetime. |
| `OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh-token lifetime. |
| `MAX_OAUTH_CLIENTS` | `200` | Maximum persisted dynamically registered OAuth clients. At the limit, the oldest client without a live code or token is evicted; registration returns `429` only when every client holds an active grant. |
| `MAX_CLIENT_NAME_CHARS` | `128` | Maximum stored length of a registered OAuth `client_name`; longer names are truncated. |
| `RESTART_FORCE_EXIT_MS` | `30000` | Upper bound for `/api/restart` to wait for in-flight responses before the process exits anyway. Running commands are interrupted first. |
| `MAX_CONCURRENT_COMMANDS` | `8` | Maximum commands running at once across REST and MCP. Further requests get `429` and do not consume their `operationId`. |
| `MAX_INLINE_COMMAND_BYTES` | `65536` | Maximum inline command size in bytes; larger inline commands are rejected with `413`. Send larger payloads in script mode. |
| `MAX_NOTICE_TEXT` | `8192` | Maximum `/api/notices` text length; longer notices are rejected with `400`. |
| `MAX_NOTICE_SOURCE` | `256` | Maximum `/api/notices` source length; longer values are rejected with `400`. |
| `MAX_ACTIVITY_CONTEXTS` | `500` | Maximum saved conversation contexts, and maximum conversation and task activity directories; the least recently used ones are removed first. |
| `MAX_ACTIVITY_LOG_BYTES` | `8388608` | Size at which each activity log file is rotated to `<file>.1` (one previous file is kept). |
| `ACTIVITY_LOG_DIR` | `runtime/activity` | Directory for activity logs, status files and saved contexts. |
| `MAX_ACTIVITY_FIELD` | `256` | Conversation ID, task ID and task title values are truncated to this length before they are stored. |
| `MAX_MCP_BATCH` | `64` | Maximum JSON-RPC batch size on `/mcp`; larger batches are rejected with `400` / `-32600`. |
| `MAX_EDIT_FILE_BYTES` | `2097152` | Largest file `/api/read-or-edit-file` reads or edits; larger files get `413`. |
| `MAX_ACCESS_FILE_BYTES` | `8388608` | Largest file served or diffed through an `/access/<token>` share link; larger files get `413`. |
| `MAX_TOKEN_STORE_ENTRIES` | `500` | Maximum share-link tokens kept in `tokenStore.json`; the ones closest to expiry are dropped first. |
| `MAX_REPLACEMENTS` | `50` | Maximum replacements in one `/api/read-or-edit-file` request. |
| `MAX_FUZZY_QUERY_CHARS` / `MAX_FUZZY_HAYSTACK_CHARS` | `256` / `262144` | Above these sizes a search text that is not found exactly is reported as not found instead of fuzzy-matched. |
| `SHELL` | `/bin/bash` | Shell for inline commands and the script-mode default, for REST and MCP alike. When unset, `/bin/bash` is used, or `/bin/sh` if Bash is not installed. |
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
  "maxOutputChars": 12000,
  "operationId": "deploy-config-2026-09-23T0945Z"
}
```

## Remote MCP clients

The remote MCP endpoint is:

```text
https://commander.example.com/mcp
```

The server implements MCP protocol version `2025-03-26`. `initialize` always returns that version and does not echo a different client-requested version. Clients that cannot continue on `2025-03-26` disconnect during negotiation, which matches the MCP lifecycle rules.

An empty JSON-RPC batch (`[]`) is invalid and returns HTTP 400 with JSON-RPC `-32600`. A POST that contains only notifications (no `id`) still returns HTTP 202 with no body.

The primary tool is `run_terminal_command`.

| Field | Type | Notes |
|---|---|---|
| `command` | string | Exact command for inline mode. Mutually exclusive with `script`. |
| `script` | string | Multi-line script body. Supplying it defaults the mode to `script`. Mutually exclusive with `command`. |
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
/oauth/revoke
```

The built-in flow supports dynamic client registration, authorization code + PKCE, refresh-token rotation and RFC-style token revocation. The authorization page asks for the server `authToken` as the approval code.

OAuth state is persisted atomically at `OAUTH_STATE_PATH`. Client secrets, authorization codes, access tokens and refresh tokens are stored only as SHA-256 hashes; raw values are returned to the client only when issued. The state file is forced to mode `600` on supported POSIX filesystems. After upgrading from an in-memory-only release, existing clients must authorize once; credentials issued by v1.0.8 or later survive normal restarts.

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

### Reliable client workflow

Treat terminal execution as a sequence of bounded operations rather than one large request:

1. probe the current state;
2. stage a patch or temporary script when a change is complex;
3. execute the mutation with a short command;
4. validate syntax or schema;
5. run targeted tests;
6. run broader tests only when needed.

For multi-file changes, logical atomicity matters more than one-request-per-file: stage the complete patch or helper script, apply it once, then validate in separate calls.

If a transport, reverse-proxy, or WAF error occurs after a mutating request, do **not** automatically resend a payload that had no `operationId`. The request may have reached the origin even when the client did not receive the response. Probe state with a small read-only request first, then continue from the observed state. Requests that carried an `operationId` can be recovered safely as described in the next section.

Clients should also:

- avoid very large inline heredocs or JSON-encoded scripts when a staged file/script is practical;
- send a fresh `operationId` with every mutating request;
- keep execution separate from staging so a retry does not resend large content;
- bound output at the source with targeted `tail`, `grep`, or equivalent filters;
- collapse proxy/WAF HTML error pages into a short transport error instead of feeding the whole page back to the model.

A proxy-generated WAF page can be produced before the request reaches AI Server Commander, so normalization of that page belongs in the client/action layer rather than in the Commander origin.

### Idempotent recovery with `operationId`

For mutating POST requests, clients may provide an optional `operationId` (1-128 characters: letters, digits, `.`, `_`, `:`, `-`). Commander persists only a command fingerprint and bounded execution summary; it does not store stdout in the operation record.

Reusing the same `operationId` with the same command does not execute the command again while the record is retained. Reusing it with a different command returns HTTP `409`.

Operation records are kept for `COMMAND_OPERATION_TTL_SECONDS` (default 24 hours) and for at most 512 recent operations; after that the same `operationId` is treated as new. IDs are scoped per adapter, so REST and MCP clients cannot replay or block each other's operations. Generate a fresh, unique `operationId` for every distinct mutation.

If Commander rejects a request before anything runs (for example a `SAFE_MODE` block or a failure to start the process), the response reports `operationState: "not_executed"` and the `operationId` is released for a clean retry.

After a lost transport response, probe the operation before deciding whether to retry:

```http
GET /v1/commands/operations/deploy-config-2026-09-23T0945Z
Authorization: Bearer <authToken>
```

The probe covers REST operations. The returned state is one of `running`, `finished`, `indeterminate`, or `unknown`. MCP clients can recover by resending the same arguments with the same `operationId`: the result reports `replayed: true` and the operation state without running the command again. `indeterminate` is deliberately conservative: Commander accepted the operation previously, but the current process cannot prove whether it completed, so the client should inspect target state rather than resubmit blindly.

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
- Token-authorized `/access?...diff=1` requests discover the target file repository, read indexed blob data through bounded Git subprocesses, and compare isolated temporary snapshots with external diff/textconv execution disabled. Indexed and working-tree inputs are capped at 8 MiB each, and each Git subprocess is capped at 5 seconds; files or repositories that exceed those limits fail closed with an HTTP 500 response rather than falling back to unbounded Git behavior.

It does **not** provide:

- a container or VM sandbox;
- a complete shell parser or comprehensive command policy;
- per-user operating-system isolation;
- a path allowlist;
- protection from every form of command composition or shell indirection;
- encrypted OAuth metadata at rest (secret and token values are hashed, while non-secret client metadata remains readable);
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
- MCP initialization, advertised protocol version, empty-batch rejection and execution;
- OAuth metadata, PKCE, persistent state, restart continuity, refresh rotation and revocation;
- native setup and Firestore service-account compatibility;
- `SAFE_MODE` results;
- OpenAPI generation and version alignment.

CI runs checks on supported Node versions for every push and pull request.

## Troubleshooting

### Public URLs use `http://` or the wrong hostname

Set `productionDomain` to the exact external HTTPS origin and forward `Host` and `X-Forwarded-Proto` from the reverse proxy.

### A HEAD probe of the execute URL returns 405

That is expected. `/api/runTerminalScript` executes on GET and POST only; a `HEAD` request is rejected before it is parsed, because Express would otherwise route it to the GET handler and run the `?command=`. Probe `/openapi.json` for liveness instead.

### The MCP client asks to reconnect after an upgrade or restart

Confirm that every release uses the same `OAUTH_STATE_PATH` and that the service user can read and write it. Upgrading from v1.0.7 or earlier requires one new authorization because those releases kept OAuth state only in memory. A missing, moved or deleted state file also requires reauthorization.

### The MCP client disconnects during initialize

The server only implements MCP protocol version `2025-03-26` and always returns that version from `initialize`. A client that cannot continue on `2025-03-26` is expected to disconnect. Confirm the client supports that version rather than expecting the server to echo an older or newer request.

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
