# Roadmap — AI Server Commander

## Product direction

AI Server Commander should expose the same operational capabilities to every supported assistant client with as little feature drift as possible.

Supported client surfaces:

- ChatGPT Actions / Custom GPTs through the existing REST API and OpenAPI schema.
- Claude remote MCP through the `/mcp` endpoint and OAuth flow.
- Future MCP-capable clients through the same MCP endpoint when possible.

The product model should be capability-first, not client-first. A feature should normally be implemented once in the server core and exposed through both REST and MCP adapters.

## Current baseline

Version: `1.0.3`

Implemented:

- REST command execution: `GET /api/runTerminalScript?command=...`
- REST command execution: `POST /api/runTerminalScript` with `{ "command": "..." }`
- Remote MCP endpoint: `POST /mcp`
- MCP OAuth discovery, dynamic client registration, authorization code + PKCE, token and refresh endpoints
- MCP tool: `run_terminal_command`

Current limitation:

- The Claude MCP surface exposes only one generic terminal tool.
- The ChatGPT REST surface is also effectively one generic terminal action plus the older file/read-edit APIs.
- Safety is mostly authentication + operator discipline; command-level policy is still minimal.

## Cross-client parity principles

1. **One capability, two adapters.** Implement execution, policy, logging and response shaping in shared modules. REST and MCP should call the same core logic.
2. **Same safety semantics.** A command blocked for Claude must also be blocked for ChatGPT. A dry-run in Claude must behave like a dry-run in ChatGPT.
3. **Same names where practical.** MCP tool names and REST operation IDs should map predictably:
   - `run_terminal_command` ↔ `runTerminalScript`
   - `read_file` ↔ `readFile`
   - `write_file` ↔ `writeFile`
4. **Client differences stay at the edge.** OAuth belongs to MCP/Claude; Bearer auth and OpenAPI belong to ChatGPT. Core features should not fork because of transport.
5. **Secure defaults, explicit expansion.** Start with narrow tools and allowlists. Add broader capabilities only with config-backed policy and audit logging.
6. **Human-operable diagnostics.** Every feature must have a curl smoke test and a simple chat prompt test for both ChatGPT and Claude.

## Roadmap

### v1.0.4 — MCP/REST safety floor

Goal: make generic command execution auditable and harder to misuse before adding more tools.

Planned work:

- Add a shared command execution core used by both `/api/runTerminalScript` and MCP `run_terminal_command`.
- Add structured audit logging for every command/tool call:
  - timestamp
  - client surface (`rest`, `mcp`, unknown)
  - tool/action name
  - command hash
  - sanitized command preview
  - cwd
  - duration
  - exit code
  - timed-out flag
  - blocked flag and matched rule, when blocked
- Add sensitive-key redaction for audit input objects:
  - `token`
  - `password`
  - `secret`
  - `key`
  - `authorization`
  - `cookie`
- Add command blocklist with config defaults.
- Add optional command allowlist / allowed path policy.
- Add `dry_run` support to command execution.
- Add output caps that are shared by REST and MCP.
- Add a `GET /health` endpoint showing version, enabled surfaces, dry-run mode and tool names.

Suggested initial blocked command substrings:

```yaml
blocked_commands:
  - "rm -rf /"
  - "mkfs"
  - "dd if="
  - ":(){"
  - "shutdown"
  - "reboot"
  - "poweroff"
  - "halt"
  - "passwd"
  - "userdel"
  - "groupdel"
  - "chmod -R 777 /"
  - "chown -R"
```

REST parity:

```json
{
  "command": "docker ps",
  "dry_run": false,
  "cwd": "/srv"
}
```

MCP parity:

```json
{
  "command": "docker ps",
  "dry_run": false,
  "cwd": "/srv"
}
```

### v1.0.5 — Safer first-class tools

Goal: reduce pressure to use arbitrary shell commands for routine diagnostics.

Add tools/actions that call shared safe helpers:

- `server_status`
- `list_directory`
- `read_file`
- `git_status`
- `docker_logs`
- `process_status`

Design rule:

- Every new MCP tool should have either a matching REST endpoint or a clear OpenAPI action mapping.
- The generic shell tool remains available, but routine work should prefer safer typed tools.

Example parity map:

| Capability | MCP tool | REST/OpenAPI operation |
|---|---|---|
| command execution | `run_terminal_command` | `runTerminalScript` |
| server health | `server_status` | `getServerStatus` |
| list files | `list_directory` | `listDirectory` |
| read file | `read_file` | `readFile` |
| git status | `git_status` | `gitStatus` |
| docker logs | `docker_logs` | `dockerLogs` |

### v1.0.6 — Restricted HTTP proxy

Goal: allow agents to call approved APIs without exposing credentials in prompts.

Adapt the `fetch_external` idea with strict defaults:

- `fetch_external` tool/action for HTTP requests to allowlisted domains only.
- Server-side token injection by domain.
- No arbitrary internet proxy by default.
- Optional `pick` paths for JSON response shaping.
- Optional output format: `json`, `yaml`, `text`.

Configuration shape:

```yaml
http_proxy:
  enabled: false
  allowed_domains:
    - api.github.com
  token_map:
    api.github.com: GITHUB_TOKEN
```

Parity requirement:

- Same domain allowlist for Claude and ChatGPT.
- Same redaction and audit log behavior.

### v1.0.7 — Policy profiles

Goal: make one server useful across projects without giving every client all permissions everywhere.

Add named policy profiles:

```yaml
profiles:
  default:
    cwd: /srv
    allowed_paths:
      - /opt/ai-server-commander
      - /tmp
    denied_paths:
      - /path/to/protected/config
      - /path/to/protected/.env
  docs_readonly:
    cwd: /srv/project/openclaw-wiki
    allowed_paths:
      - /srv/project/openclaw-wiki
    denied_paths:
      - /path/to/protected/config
```

Desired behavior:

- A tool/action can request a profile.
- Unknown profile falls back to `default` or fails closed, depending on config.
- Protected paths are denied unless a profile explicitly allows them.
- Client surface does not change behavior: ChatGPT and Claude get the same profile rules.

### v1.0.8 — Human confirmation and risk classes

Goal: make risky actions explicit rather than relying only on prompt discipline.

Add command classification:

- `safe_read`
- `write_project_file`
- `service_restart`
- `protected_config_edit`
- `destructive`
- `unknown_risk`

Behavior options:

- allow
- deny
- dry-run only
- require explicit confirmation token

Example:

```json
{
  "command": "systemctl restart example-service",
  "risk": "service_restart",
  "requires_confirmation": true,
  "confirmation_hint": "Ask the human to confirm this exact command."
}
```

Parity requirement:

- Claude and ChatGPT should receive the same risk classification and same requirement to ask the human before execution.

### v1.0.9 — Remote machine adapters

Goal: support remote machines without exposing unrestricted SSH as the default.

Candidate tools:

- `remote_status`
- `remote_exec_powershell`
- `remote_exec_shell`

Guardrails:

- disabled by default
- named hosts only
- per-host command policy
- per-host timeout/output caps
- no raw private keys in repo
- same audit log as local commands

Do not add broad SSH execution until the local command policy and audit model are stable.

### v1.1.0 — Browser and UI automation bridge

Goal: support controlled manual debugging workflows, such as TradingView, without turning the server into a general browser bot.

Candidate capabilities:

- `browser_status`
- `browser_screenshot`
- `browser_click`
- `browser_type`
- `browser_hotkey`
- `browser_read_clipboard`
- `browser_write_clipboard`

Guardrails:

- disabled by default
- no public unauthenticated browser endpoints
- profile-specific browser sessions
- explicit confirmation for publish, account, payment, credential or trading actions
- screenshots stored in temporary paths with expiry

## Features deliberately not planned yet

- Public unauthenticated MCP endpoints.
- Unlimited arbitrary web proxying.
- Raw SSH access to arbitrary hosts.
- Persistent memory outside the existing operational wiki unless explicitly designed.
- Automatic execution of destructive commands based only on model judgment.

## Test matrix required for every milestone

Each milestone should include:

- REST smoke test with curl.
- MCP smoke test with JSON-RPC curl.
- ChatGPT prompt test.
- Claude prompt test.
- Unauthorized request test.
- Blocked command test when policy is involved.
- Audit log verification when logging is involved.

## Reference ideas adapted from Reacher

Useful patterns to adapt:

- Tool registration based on enabled config.
- Domain allowlist for API proxying.
- Server-side token injection.
- JSON response field picking.
- Command blocklists.
- Directory/path allowlists.
- Audit log with sensitive input redaction.
- Dry-run mode.
- Health endpoint.

Patterns not adopted as-is:

- Query-string token auth for Claude-facing MCP. This project uses OAuth for remote MCP compatibility.
- Broad SSH execution before local command policy is mature.
- A separate persistent knowledge base before evaluating overlap with the operational wiki.
