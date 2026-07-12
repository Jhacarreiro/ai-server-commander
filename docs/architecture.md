# Architecture

## Overview

AI Server Commander is a single Node.js process with two authenticated protocol adapters and one shared command-execution core.

```text
REST/OpenAPI client ── Bearer token ── REST routes ──┐
                                                     ├── command executor ── shell
Remote MCP client ── OAuth/token ───── MCP route ────┘          │
                                                                ├── policy
                                                                ├── activity log
                                                                └── notices
```

## Trust boundaries

1. **Public network to reverse proxy.** TLS termination, optional IP/access policy and request forwarding live here.
2. **Reverse proxy to Node service.** The service should normally bind to loopback or a private interface.
3. **Authenticated request to command executor.** Authentication proves possession of a token; it does not make the requested command safe.
4. **Service process to host operating system.** Commands inherit the service account's filesystem, process and network permissions.
5. **Generated runtime state.** Activity and notice data can reveal operational context and should be protected accordingly.

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
3. `api/mcp.js` exposes `run_terminal_command` with input/output schemas, annotations and security metadata.
4. Tool arguments pass through the same parser and executor as REST.
5. The result contains both text content for backward compatibility and `structuredContent` matching `outputSchema`.

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

OAuth mutations use an atomic temporary-file-and-rename sequence. The state file is mode `600`; raw client secrets and token values are never written to disk. A malformed or symlinked OAuth state file fails closed at startup. Refresh tokens rotate on use and both access and refresh tokens can be explicitly revoked.

## Extension rule

New operational capabilities should normally be implemented in a shared module and then exposed through thin REST and MCP adapters. Client-specific authentication and transport behavior should remain at the edge.
