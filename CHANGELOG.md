# Changelog

All notable public changes to AI Server Commander are documented here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/) and uses semantic versioning where practical. The `Unreleased` section tracks changes that are on `main` but not yet attached to a GitHub release.

## Unreleased

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
