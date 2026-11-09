---
name: commander-terminal
description: Use an existing AI Server Commander MCP connection for short, verifiable terminal commands and scripts on a user-controlled server.
---

# AI Server Commander terminal

Use the existing `commander` MCP connection and its `run_terminal_command` tool. Do not install another terminal daemon, change the host's configuration, or bypass its existing authentication and server policies.

- Show the exact command or script being executed and report the actual output, exit status, timeout and blocked/interrupted flags. Do not treat a submitted command as a successful execution.
- For a one-line command send `command` (mode `inline`). For multi-line instructions send `script` (mode `script`). Supply `cwd`, `timeoutMs` and `maxOutputChars` as needed.
- Prefer short, bounded diagnostics. If a command may exceed the remote execution limit, divide it into verifiable steps rather than launching an uncontrolled background job.
- Preserve the server's existing authorization rules. A plugin does not grant extra privileges; user instructions must still respect applicable restrictions and protected paths.
- Use a unique `operationId` for each mutating request where supported. Retry a potentially uncertain request only with the identical `operationId` and payload; never use a new ID to blindly repeat a mutation.
- Follow relevant project documentation as the source of truth before touching services or configuration. Never assume the layout of a remote host.
- Avoid printing secrets or private infrastructure in public artifacts. Keep deployment-specific values in private configuration.
- When no MCP tool is available or authentication fails, say so. Do not invent terminal output or claim that the server was modified.

This skill uses the same Commander backend as REST/OpenAPI Custom GPT Actions. The plugin is a client packaging evolution, not a replacement server.
