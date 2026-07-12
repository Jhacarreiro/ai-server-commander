# Changelog

All notable public changes to AI Server Commander are documented here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/) and uses semantic versioning where practical. The `Unreleased` section tracks changes that are on `main` but not yet attached to a GitHub release.

## Unreleased

No unreleased changes yet.

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
