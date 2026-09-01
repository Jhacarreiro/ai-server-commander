# Architecture

## Overview

AI Server Commander is a single Node.js service whose current production capability is a shared bounded command-execution core exposed through two authenticated protocol adapters.

```text
REST/OpenAPI client ── Bearer token ── REST routes ──┐
                                                     ├── command executor ── shell
Remote MCP client ── OAuth/token ───── MCP route ────┘          │
                                                                ├── policy
                                                                ├── activity log
                                                                └── notices
```

The target architecture keeps that production path intact while allowing optional typed capability adapters to sit beside the command executor:

```text
REST/OpenAPI ─┐
              ├── auth + capability routing ──┬── command executor ── host shell
Remote MCP ───┤                               │
              │                               ├── read-only host tools
Future client ┘                               │
                                              └── browser/session adapters
                                                       │
                                                       └── explicitly configured authenticated session
```

Capabilities should not depend on a particular UI. Telegram relays, OpenClaw agents and future mobile/PWA clients consume typed state and operations from Commander; they do not become part of the execution core.

## Trust boundaries

1. **Public network to reverse proxy.** TLS termination, optional IP/access policy and request forwarding live here.
2. **Reverse proxy to Node service.** The service should normally bind to loopback or a private interface.
3. **Authenticated request to command executor.** Authentication proves possession of a token; it does not make the requested command safe.
4. **Service process to host operating system.** Commands inherit the service account's filesystem, process and network permissions.
5. **Generated runtime state.** Activity and notice data can reveal operational context and should be protected accordingly.
6. **Optional authenticated browser/session boundary.** A browser profile can contain cookies and account state. Profiles and credentials remain outside the repository, are explicitly configured by the operator and must never be exposed as ordinary API output.

## Request flows

### REST

1. The client sends a Bearer-authenticated GET or POST request.
2. `serverModules/auth.js` validates `authToken`.
3. `api/terminal.js` validates mode, path, shell, size and requested limits.
4. `serverModules/commandExecutor.js` applies server caps and starts the process.
5. Activity and notice metadata are attached to the structured JSON response.

### MCP

1. The client discovers protected-resource and authorization-server metadata.
2. It authenticates with OAuth or a configured pre-shared MCP token.
3. `api/mcp.js` advertises MCP protocol version `2025-03-26`, rejects empty JSON-RPC batches, and exposes `run_terminal_command` with input/output schemas, annotations and security metadata.
4. Tool arguments pass through the same parser and executor as REST.
5. The result contains both text content for backward compatibility and `structuredContent` matching `outputSchema`.

### Planned browser/session capability

The first planned browser capability is a read-only watcher for an explicitly selected web conversation:

1. An operator configures a persistent, already-authenticated browser profile outside the repository.
2. The adapter attaches to or launches the browser through a narrow browser-control boundary.
3. A deterministic watcher inspects one selected conversation without using an LLM for polling.
4. The watcher classifies state such as `idle`, `generating`, `completed` or `needs_human`.
5. A durable response fingerprint prevents duplicate new-response events across restarts.
6. REST/MCP clients can request status or the latest completed response.
7. If login, CAPTCHA, consent or an unexpected UI state blocks safe observation, the adapter returns `needs_human` and stops autonomous recovery.

MVP1 is intentionally read-only. Sending messages or performing account-changing browser actions belongs to a later milestone with explicit confirmation semantics.

## Main modules

| Path | Responsibility |
|---|---|
| `main.js` | Process entry point. |
| `serverModules/pluginServer.js` | Express and Socket.IO server lifecycle. |
| `serverModules/apiRoutes.js` | Route registration and authentication boundaries. |
| `serverModules/auth.js` | REST token and MCP token/OAuth validation. |
| `serverModules/commandExecutor.js` | Process tracking, timeout, output caps and interruption. |
| `api/terminal.js` | Shared request parsing and command result shaping. |
| `api/mcp.js` | MCP JSON-RPC adapter and tool descriptor. |
| `api/oauth.js` | OAuth metadata, registration, consent, token rotation and revocation endpoints. |
| `serverModules/oauthStore.js` | Atomic persistent OAuth state with hashed secrets and tokens. |
| `api/activityLog.js` | Redacted activity records and context. |
| `api/notices.js` | Scoped operational notices. |
| `serverModules/swaggerSetup.js` | OpenAPI generation. |
| `serverModules/chatgptWebWatcher.js` | Disabled-by-default read-only ChatGPT Web snapshot, stability and dedup state. |
| `api/chatgptWeb.js` | REST handlers for watcher status, latest response and explicit polling. |

Browser/session code lives behind a dedicated adapter boundary rather than importing site-specific selectors into the command executor or protocol adapters. MVP1 uses OpenCLI CDP plumbing and keeps ChatGPT-specific observation in `chatgptWebWatcher.js`.

## Execution lifecycle

Each command receives an `activityId`.

```text
validate request
    ↓
record command_started
    ↓
apply SAFE_MODE denylist
    ↓
spawn detached process group on POSIX
    ↓
collect bounded output
    ↓
timeout / interrupt / normal exit
    ↓
record command_finished
    ↓
return REST JSON or MCP result
```

Timeouts and explicit interruption target the process group on POSIX hosts to reduce orphaned subprocesses.

## State

Persistent application state is intentionally small:

- `config.json`: deployment configuration and secrets;
- `runtime/activity/`: activity logs and indexes;
- `runtime/notices/`: notice state where applicable;
- `runtime/oauth-state.json`: persistent OAuth clients plus hashed authorization codes, access tokens and refresh tokens.

Optional adapters may add narrowly scoped runtime state, for example response fingerprints or watch subscriptions. Sensitive browser profile data, cookies, account credentials and private conversation archives are not repository content and should remain in operator-controlled runtime storage.

OAuth mutations use an atomic temporary-file-and-rename sequence. The state file is mode `600`; raw client secrets and token values are never written to disk. A malformed or symlinked OAuth state file fails closed at startup. Refresh tokens rotate on use and both access and refresh tokens can be explicitly revoked.

## Extension rule

New operational capabilities should normally be implemented in a shared typed module and then exposed through thin REST and MCP adapters. Client-specific authentication, transport, presentation and conversational behavior should remain at the edge.

For browser/session integrations, site-specific DOM logic belongs in a replaceable adapter. Watchers should emit deterministic state and content; summarization, reply suggestions and workflow decisions belong to the consuming agent or client. This keeps a future Telegram relay and PWA interchangeable without coupling either to browser selectors or Commander internals.
