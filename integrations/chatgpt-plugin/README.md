# ChatGPT plugin for AI Server Commander

This is an optional **client package** for an existing AI Server Commander instance.
It reuses the current OAuth-protected `/mcp` endpoint and the same bounded terminal
executor, policies, audit records, and idempotency behavior as REST/OpenAPI.
**No second server, Docker container, or production migration is required.**

## Setup (private copy only)

1. Keep your existing server and Custom GPT Action running.
2. Copy this directory to a private location **outside the public checkout**.
3. In that private copy, replace `https://commander.example.com/mcp` in `mcp.json`
   with your HTTPS Commander MCP endpoint. Do not commit the resulting file.
4. In ChatGPT Plugins add a custom MCP server with that URL and OAuth. Complete
   Commander's existing browser authorization flow; no new server token or OAuth
   configuration is necessary.
5. Install/test the plugin from the private package. The ChatGPT plugin workflow
   may require registration of the MCP connection and mapping to a `plugin_asdk_app`
   identifier. Consult the current OpenAI plugin documentation for the specific
   installation surface.
6. Verify `run_terminal_command` with a harmless bounded command, inspect the
   returned exit code, then separately check script mode and permission behavior.

The public `mcp.json` contains a documentation-only placeholder, not a deployed
endpoint. Do not publish a private endpoint, authorization grant, client mapping,
hostname or local filesystem path in the public repository.

The plugin **does not** disable Commander's existing command confirmation policy,
change operating-system privileges or grant more access than the configured MCP
client is permitted. It also cannot override ChatGPT plan/surface limitations.

Reference: https://developers.openai.com/plugins/build/plugins
Server configuration: ../../docs/client-setup.md
