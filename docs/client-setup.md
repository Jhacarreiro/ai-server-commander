# Connecting OpenAI and Claude

Connect an assistant to Commander, then start with a read-only command. The assistant's model and subscription come from OpenAI or Anthropic; Commander provides authenticated access to your server.

## Before you start

You need a running Commander deployment and its public HTTPS origin, such as `https://commander.example.com`. Use your own hostname everywhere below.

| What you are configuring | URL | Authentication |
|---|---|---|
| ChatGPT Custom GPT Action | `/openapi.json` | Commander's `authToken`, entered in the Action's authentication settings |
| ChatGPT MCP connection | `/mcp` | OAuth |
| Claude web / Desktop connector | `/mcp` | OAuth |
| Claude Code MCP server | `/mcp` | OAuth; optional Bearer token for CLI clients |

For OAuth, Commander's own authorization page asks for an **approval code**. This is the `authToken` from the private server configuration. Enter it only on your Commander's HTTPS authorization page. It is not an OpenAI API key, Anthropic API key, or `mcpToken`. The client receives its own OAuth tokens after approval.

The optional browser watcher can stay disabled. You do not need OpenClaw, OpenCLI, Chromium or a ChatGPT browser profile to use REST or MCP.

## ChatGPT: Custom GPT Action

1. Open your Custom GPT in the GPT editor and open its Action configuration.
2. Import `https://commander.example.com/openapi.json` as the schema.
3. Set authentication to **API Key**, with **Bearer** authentication. Enter the private `authToken` value as the key.
4. Copy or adapt the [assistant instructions](../prompt.md) into the GPT's instructions and save the GPT.
5. Ask: **"Use Commander to run `pwd && hostname` and report the output and exit code."**

The schema exposes `executeCommand` for POST execution and the compatible `runTerminalScript` Action. An Action test succeeds when a real tool response includes `output` and `exitCode: 0`.

See [OpenAI's GPT Action authentication guide](https://developers.openai.com/api/docs/actions/authentication). This connection uses Commander's API-key authentication; the OAuth instructions below apply to MCP connections.

## ChatGPT: remote MCP

1. In ChatGPT, enable **Developer mode** under **Settings > Security and login**, if your account and workspace allow it.
2. Open **Plugins**, select the plus button, and create a connection named **AI Server Commander**.
3. Enter `https://commander.example.com/mcp` as the server URL and use OAuth authentication. Commander supports dynamic client registration (DCR).
4. Complete authorization on your Commander origin using its approval code.
5. Enable/select the connection in a new chat and ask it to run `pwd && hostname` using `run_terminal_command`.

Check for actual tool output and exit code, rather than a model-only reply. Account access and menu labels can vary; use the [current OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) if the controls differ. If the MCP feature is unavailable to your account, use the Custom GPT Action route above where supported.

## Claude: web and Desktop

1. Open **Customize > Connectors**. Select **+ > Add custom connector** and name it **AI Server Commander**.
2. Enter `https://commander.example.com/mcp` and add the connector. Commander supports dynamic registration, so a manually supplied OAuth client ID/secret is normally unnecessary.
3. Select **Connect** and authorize on your Commander origin with its approval code.
4. Enable the connector for your conversation using the chat's **+ > Connectors** menu.
5. Ask: **"Use AI Server Commander to run `pwd && hostname`; report its output and exit code."**

On Team/Enterprise workspaces, an owner must first add the custom web connector under **Organization settings > Connectors**. Members then connect their accounts individually. Use the same remote-connector flow in Claude Desktop; local stdio configuration is a different setup.

See [Anthropic's custom remote connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) for current availability and menus.

## Claude Code

In your local terminal, add the remote server with HTTP transport:

```bash
claude mcp add --transport http --scope user commander https://commander.example.com/mcp
claude
```

Inside Claude Code, run `/mcp`, select `commander`, and authenticate through the browser. Complete the Commander approval-code page, then ask Claude to run `pwd && hostname` through its `run_terminal_command` tool.

To inspect or remove the connection:

```bash
claude mcp get commander
claude mcp remove commander --scope user
```

The recommended flow is OAuth. CLI clients also support an explicit `Authorization: Bearer <mcpToken>` header; when the server has no `mcpToken`, it uses `authToken` instead. Keep such tokens in private client configuration and out of committed project files.

See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## First command and everyday use

For MCP, the first tool call can use these arguments:

```json
{
  "command": "pwd && hostname",
  "timeoutMs": 5000,
  "maxOutputChars": 2000
}
```

Commands run on the **Commander host**, with its service user's permissions. Use an explicit `cwd` for project work. Read the returned `exitCode`, `timedOut`, `blocked` and `outputTruncated` fields. Use the [instruction starter](../prompt.md) to keep requests small and handle approvals and retries consistently.

For mutations, send a fresh `operationId`. After a lost response, recover the recorded operation before deciding whether to retry; retention is bounded. See [operation recovery](../README.md#idempotent-recovery-with-operationid).

## If the connection fails

| Symptom | What to check |
|---|---|
| Schema import fails | Open `/openapi.json`; confirm HTTPS and that `productionDomain` matches the public origin. |
| REST returns `401` | The Action must send Bearer authentication using `authToken`. |
| OAuth approval fails | Use `authToken` as the approval code on the Commander page, not `mcpToken` or a model-provider API key. |
| OAuth discovery fails | The reverse proxy must expose `/.well-known/*` and `/oauth/*` as well as `/mcp`. |
| MCP disconnects at initialization | Commander advertises MCP `2025-03-26`; the client must accept that version. |
| No tool call appears | Enable/select the connection for that chat and explicitly ask to use `run_terminal_command`. |
| Watcher endpoints return `503 / disabled` | Expected while the optional watcher is off; REST execution and MCP still work. |

Use these public, read-only checks with your own origin:

```bash
curl -i https://commander.example.com/openapi.json
curl -i https://commander.example.com/.well-known/oauth-protected-resource/mcp
curl -i https://commander.example.com/.well-known/oauth-authorization-server
curl -i https://commander.example.com/mcp
```

The unauthenticated MCP request should return `401` with a `WWW-Authenticate` discovery challenge. Do not use an execution route as a health probe.

Client instructions checked against official documentation on **1 October 2026**. Deployment details: [deployment guide](./deployment.md). Optional browser monitoring: [watcher operations](./watcher-operations.md).
