# Changelog

All notable public changes to AI Server Commander are documented here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/) and uses semantic versioning where practical. The `Unreleased` section tracks changes that are on `main` but not yet attached to a GitHub release.

## Unreleased

### Changed

- REST and MCP requests that supply both `command` and `script` are rejected (`400` / `-32602`) instead of silently running one of them.
- REST requests with a `script` and no `mode` run in script mode, matching MCP. Inline commands and scripts share one default shell: `SHELL`, else `/bin/bash`, else `/bin/sh` (script mode previously fell back to `/bin/sh` while inline used `/bin/bash`).
- A wrong-typed `command` or `script` is reported as a type error instead of "required", and a present `command` in the body is no longer replaced by `?command=`. Whitespace-only scripts are rejected.
- MCP `tools/call` without a tool name returns `tool name is required`; an unknown tool is named in the error.
- Truncated command output and activity previews never end in half of a UTF-16 surrogate pair, which strict JSON consumers reject.
- `/api/restart` interrupts running commands, stops accepting connections and waits for in-flight responses before exiting, bounded by `RESTART_FORCE_EXIT_MS` (default 30 seconds), instead of exiting after a fixed 500 ms and leaving commands running.
- Commands now run in their own process group (`exec()` had silently ignored `detached`). Timeouts and interrupts therefore reach pipelines and background children, and escalate from SIGTERM to SIGKILL after 1.5 seconds. Previously a timed-out pipeline such as `sleep 300 | cat` kept the request open until the pipeline ended on its own. Commands no longer inherit an open stdin, and output beyond the capture buffer stops the command instead of letting it run until the timeout.
- At most `MAX_CONCURRENT_COMMANDS` (default 8) commands run at once; further requests get `429`.
- `/api/read-or-edit-file` no longer leaves an empty file behind when an edit of a missing file fails, and never creates a file for a read. Creating a file with an empty `originalText` still works; a newly created file that fails the JavaScript syntax check is removed.
- MCP `initialize` always advertises protocol version `2025-03-26` instead of echoing the client's requested version. Clients that cannot use `2025-03-26` disconnect during negotiation. This server does not implement other protocol versions.
- An empty JSON-RPC batch (`[]`) on `/mcp` now returns HTTP 400 with JSON-RPC `-32600` instead of HTTP 202 with no body. Notification-only POSTs still return HTTP 202.
- Replaced the `firebase-admin` runtime dependency with the direct `@google-cloud/firestore` client used by the application, removing the unused Google Cloud Storage dependency chain and its remaining runtime advisories.

### Security

- `SAFE_MODE` blocks `rm` on the filesystem root in every flag order and spelling (`-fr`, `-f -r`, `--recursive --force`, `--no-preserve-root`), with globs or chaining after the slash, and inside command substitution; `dd` writing to a device node; fork bombs with any function name; and `passwd` as a command word. Reading `/etc/passwd` and `dd` to regular files, `/dev/null` or `/dev/shm` are no longer blocked. `SAFE_MODE` remains a denylist, not a sandbox.
- REST bearer tokens and the MCP `?token=` query token are now compared in constant time.
- Startup rejects the documented example secrets as `authToken` or `mcpToken`. The previous long placeholders met the 32-character minimum, so an unedited copy of `config.example.json` started with a publicly known token. The example now uses short, invalid placeholders.
- Firebase app view/edit pages HTML-escape the stored app name and description.
- Unauthenticated OAuth client registration is bounded by `MAX_OAUTH_CLIENTS` (default 200). Idle clients without live grants are evicted first, so throwaway registrations cannot lock out clients that are in use. Stored `client_name` values are capped by `MAX_CLIENT_NAME_CHARS`.
- OAuth and `.well-known` responses send `Cache-Control: no-store`.
- Inline commands are logged through the redacting, length-bounded preview instead of verbatim.
- File-edit error responses no longer include stack traces; the error message is kept.
- `HEAD` on `/api/runTerminalScript` returns `405` with `Allow: GET, POST` instead of executing the `?command=` through the GET handler.
- Inline commands are capped by `MAX_INLINE_COMMAND_BYTES` (default 64 KiB, `413` above it), notice text and source by `MAX_NOTICE_TEXT` / `MAX_NOTICE_SOURCE`, stored conversation/task identifiers by `MAX_ACTIVITY_FIELD`, and `/mcp` batches by `MAX_MCP_BATCH` (default 64).
- `/api/read-or-edit-file` resolves paths (including symlinks) and rejects targets outside the workspace directory. `GET` is now a pure read that returns the raw file content without minting access tokens, syntax-checking, beautifying or rewriting the file.

### Removed

- Removed the unused Socket.IO integration (`serverModules/socketSetup.js` was required but never called) together with the `socket.io` runtime dependency, the orphaned `public/whisper.html` demo page and its `public/socketSetup.js` / `public/whisperWorker.js` scripts, and the unused `diff` runtime dependency.
- Removed leftover debug output (`debugger`, per-character fuzzy-search logging, the startup dump of the full OpenAPI document). The in-memory log returned by `/api/logs` now keeps the most recent 2000 entries instead of growing without bound.
- Removed the unregistered `api/sentenceVector.js` and `api/transformers.js` modules, including a leftover captured browser request (cookies and a CSRF token) in `transformers.js`, and the unused `initDB` import in `apiRoutes.js`. Firebase initialization remains in `pluginServer.js`.

### Added

- Added MCP smoke coverage for server protocol-version negotiation and empty-batch rejection.
- Added optional `operationId` idempotency keys for REST and MCP command execution, plus `GET /v1/commands/operations/{operationId}` to probe REST operations after a lost response. Records are scoped per adapter, expire after `COMMAND_OPERATION_TTL_SECONDS` (default 24 hours), and requests rejected before execution release their `operationId` (`operationState: "not_executed"`). An unreadable operation store fails closed instead of being reset.

## [1.0.8] - 2026-07-12

### Added

- Added atomic persistent OAuth state through `OAUTH_STATE_PATH`.
- Added refresh-token rotation and `/oauth/revoke` for access and refresh tokens.
- Added restart, public-client PKCE, confidential-client, rotation, revocation, corruption and file-mode regression tests.
- Added native first-run setup using Node's built-in readline APIs.
- Added Firebase Admin v13 compatibility tests with an injected mock repository.

### Changed

- OAuth clients, authorization codes, access tokens and refresh tokens are now keyed by SHA-256 hashes on disk; raw secret values are never persisted.
- OAuth state fails closed when malformed or presented through a symlink and is forced to mode `600` on supported POSIX systems.
- Upgraded Firebase Admin from v12 to the latest Node 20-compatible v13 release.
- Extended OAuth discovery metadata with the revocation endpoint.
- Updated deployment, architecture, configuration, troubleshooting and upgrade documentation for persistent OAuth state.

### Removed

- Removed LocalTunnel support and its vulnerable pinned Axios dependency chain.
- Removed Inquirer and replaced the setup flow with Node built-ins.

### Security

- Reduced runtime audit findings from 15 to 8, with zero high and zero critical findings.
- Added explicit access-token and refresh-token revocation.
- Added atomic state-file replacement, restrictive file permissions and raw-token non-persistence.

## [1.0.7] - 2026-07-12

### Added

- Added MCP tool title, exact output schema, OAuth security schemes, risk annotations and ChatGPT-compatible metadata mirrors.
- Added `structuredContent` to MCP tool results while retaining the existing text content for backward compatibility.
- Added MCP regression tests for tool metadata, structured success results and structured SAFE_MODE failures.
- Added complete open-source project documentation: architecture, deployment, contribution, security, support, code of conduct, attribution, configuration examples and Custom GPT instructions.
- Added GitHub Actions CI for Node 20 and 22, Dependabot configuration, issue forms and a pull request template.

### Changed

- Renamed public package metadata to `ai-server-commander`, declared Node 20+ support and added repository, issue and keyword metadata.
- Made MCP server identity and authorization-page copy deployment-neutral instead of host- or client-specific.
- Added protected-resource documentation and a scoped `WWW-Authenticate` challenge.
- Replaced the outdated roadmap and Custom GPT prompt with current capability, safety and parity guidance.
- Expanded the README with quick start, ChatGPT Action setup, MCP/OAuth setup, configuration, examples, security boundaries, testing and troubleshooting.

### Removed

- Removed tracked macOS, IDE and obsolete scratch files from the public repository.

### Security

- Documented that terminal execution is not a sandbox and provided a hardened unprivileged systemd deployment example.
- Added private vulnerability reporting guidance and explicit secret-handling rules for issues and pull requests.

## [1.0.6] - 2026-07-11

### Added

- Added bounded multi-line script execution to the MCP `run_terminal_command` tool while preserving the existing inline `command` contract.
- Added per-command activity IDs and independent tracking for concurrent executions.
- Added targeted interruption by `activityId`, with ambiguity protection when several commands are active.
- Added MCP smoke tests and expanded executor, REST and OpenAPI regression coverage.

### Changed

- Unified REST and MCP command execution through the same timeout, output-limit, SAFE_MODE, activity-log and notice policies.
- GET command options now honor `cwd`, `timeoutMs` and `maxOutputChars` from query parameters.
- Invalid working directories are rejected instead of silently falling back to another directory.
- Process interruption and timeout now terminate the spawned process group on POSIX systems.
- Increased the Express JSON body limit to match `MAX_SCRIPT_BODY_BYTES`.
- OpenAPI now reads the package version automatically and documents activity/interruption fields.
- Updated compatible runtime dependencies and removed the unused `swagger-autogen` package.

### Security

- Server startup logs now redact authentication material and expose only token-presence flags.
- HTTP 500 responses no longer return server stack traces to clients.
- MCP now enforces the same SAFE_MODE rules and bounded executor as REST.
- Activity previews sample large payloads before secret redaction, avoiding pathological processing of large script bodies.

## [1.0.5] - 2026-07-09

### Added

- Added bounded `POST /api/runTerminalScript` support for JSON command execution requests.
- Added `POST /v1/commands/execute` as a versioned command execution endpoint with the same request/response contract.
- Added `mode: "script"` for multi-line shell scripts, nested quoting, JSON/YAML edits and other commands that are fragile as one-line query strings.
- Added executor, route and OpenAPI smoke tests covering legacy GET, POST inline mode, script mode, non-zero exit codes and timeout behavior.

### Changed

- Fixed first-run setup so the configured public server URL is saved in `config.json`.
- Aligned package metadata with the MIT license file.
- Centralized terminal execution through a bounded executor that preserves exit code, timeout state, output truncation metadata and notices.
- Expanded the public OpenAPI schema with command request/response objects for GET, POST and versioned command execution.
- Updated README command execution examples and safety notes for script mode and bounded execution.

### Security

- Script bodies are size-limited and executed through temporary files that are cleaned up after the command finishes.
- Activity logging records command/script metadata such as hash, byte length and preview rather than storing full script bodies.
- Command execution remains bounded by timeout and output-size limits.

## [1.0.4] - 2026-06-06

### Added

- Restored the public main branch with working terminal execution support.
- Added MCP/OAuth support so Claude and other MCP-capable clients can use the same server-side bridge model.
- Documented the AI Server Commander product name and cross-client usage model.

### Changed

- Repaired the terminal handler so configurable command timeout, maximum output size and safe-mode behavior work as intended.
