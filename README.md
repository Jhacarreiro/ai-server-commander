# AI Server Commander
<img src="https://raw.githubusercontent.com/wonderwhy-er/ChatGPTServerCommander/main/logo4.png" width="350pxp" height="350px"/>
This project is a server that exposes terminal commands and file editing functionality to assistant clients. It started as an API for ChatGPT Actions and now also exposes a remote MCP endpoint for Claude and other MCP-capable clients. In essence, it allows an approved assistant session to control any machine where you install this. Install, run, and edit anything, even itself.

## Video Demo
[![Watch here](https://img.youtube.com/vi/8wMOferdWeA/maxresdefault.jpg)]([https://youtu.be/VIDEO_ID](https://youtu.be/8wMOferdWeA?t=1333))

## Features

- Execute server commands through a REST API that is compatible with Custom ChatGPT actions.
- Execute server commands through a remote MCP endpoint compatible with Claude connectors and other MCP clients.
- Reuse the same server-side capabilities across ChatGPT and Claude wherever possible, with REST/OpenAPI and MCP acting as adapters over shared behavior.
- Interface with external APIs and services.
- Local Tunnel / public HTTPS deployment support for making the server reachable by assistant clients.

## Assistant clients and usage model

AI Server Commander is a bridge between an assistant chat product and a machine you control. When used from ChatGPT or Claude, the model work happens in that chat session and uses that product's normal chat context, tool-call flow and plan limits. You do not need separate OpenAI API, Anthropic API, Codex or Claude Code credits just to use these server tools from the chat UI.

- Calls from a Custom GPT use the active ChatGPT session and its available usage for that plan.
- Calls from Claude use the active Claude conversation and its available connector/tool usage for that plan.
- AI Server Commander provides the external tool/API surface and executes approved server-side actions on your machine.
- Any third-party APIs or paid services that your commands call remain your responsibility.

The goal is feature parity across clients, not separate behavior per assistant. When a capability is added, it should normally be exposed to ChatGPT through REST/OpenAPI and to Claude through MCP with matching safety rules. See [ROADMAP.md](./ROADMAP.md).

## Work in Progress

- Auto-generation of API schema with Swagger is in progress. For the cross-client roadmap, see [ROADMAP.md](./ROADMAP.md). The legacy task list remains in [todo.md](./todo.md).

## Requirements/Installation

- Node.js v18+

To install the project dependencies, run:

```bash
npm install
```

# Setup Instructions

### 1.  First you will need to install Node.js, at time of writting its v20.16.0 https://nodejs.org/en
### 2.  Checkout the code and open Terminal in the folder
### 3.  install dependencies

```bash
npm install
```

### 4. Start the server with:

```bash
npm run start
```
### 5. On the first run, the setup process will guide you through configuring the port, determining whether it runs locally or on a server, and setting the domain.
### 6. The setup will generate a secret key for use in CustomGPT called authKey, don't share it, it will be used later to allow ChatGPT to call your server or computer

![image](https://github.com/user-attachments/assets/03570d60-3eea-4157-bb5f-785f05fe0ce7)

### 7. Finally, create a CustomGPT here https://chatgpt.com/gpts/editor
### 8. Add prompt to custom gpt from [prompt.md](./prompt.md)

![image](https://github.com/user-attachments/assets/666f50ef-e264-4cd3-ab8a-6d1554b089c1)

### 9. Add your URL to the generated OpenAPI spec, similar to this but with your domain: `https://appcookbook.wonderwhy-er.com/openapi.json`

![image](https://github.com/user-attachments/assets/901a7f31-22b7-42bf-b698-db346a8cb8f1)

### 10. Add API authentication, choose Bearer an add authKey from step 6   

![image](https://github.com/user-attachments/assets/2b41d095-c329-417c-a18e-d83f0a979afb)

For more detailed instructions, please refer to the setup video (TODO: Add video).

## Contributing

Contributions to the Server Commander project are welcome.
I did not put in work yet to make it easy to contribute but I will if I see interest in that.

Feel free to reach out to me on 

LinkedIn https://www.linkedin.com/in/eduardruzga/

Or Discord https://discord.com/channels/wonderwhyer

Or Twitter/X https://x.com/wonderwhy_er

## License

The project is licensed under the MIT License.

## Pending notices

Other local tools can leave short notices for the ChatGPT action to see on the next terminal response. Notices are kept in memory and are returned with terminal command responses until they are acknowledged or expire.

Create a notice:

```http
POST /api/notices
Content-Type: application/json

{
  "level": "warning",
  "source": "local-supervisor",
  "text": "Check that you are editing the live config file, not a generated copy.",
  "ttlSeconds": 1800
}
```

Run a terminal command as usual. If any notices are pending, the response includes them:

```json
{
  "message": "Command executed successfully.",
  "output": "...",
  "notices": [
    {
      "id": "notice_...",
      "level": "warning",
      "source": "local-supervisor",
      "text": "Check that you are editing the live config file, not a generated copy.",
      "createdAt": "2026-05-26T12:00:00.000Z",
      "expiresAt": "2026-05-26T12:30:00.000Z",
      "deliveredAt": "2026-05-26T12:00:05.000Z",
      "deliveredCount": 1
    }
  ]
}
```

Acknowledge a notice so it stops appearing:

```http
POST /api/notices/{id}/ack
```

## Activity log

Server Commander can keep a small automatic activity log for command and notice lifecycle events. The log is local to the running server and is exposed through:

```http
GET /api/activity?limit=50
GET /api/activity/status
```

The log records events such as:

```text
command_started
command_finished
notice_created
notices_listed
notice_acked
```

`command_finished` events include metadata and a redacted/truncated output preview:

```json
{
  "type": "command_finished",
  "exitCode": 0,
  "timedOut": false,
  "durationMs": 137,
  "outputLength": 5134,
  "outputTruncated": true,
  "outputPreview": "short redacted preview of stdout/stderr"
}
```

This is intended as lightweight operational visibility for integrations. It does not store full stdout/stderr.



Activity logs can also be queried by scope:

```http
GET /api/activity?scope=global&limit=50
GET /api/activity?scope=conversation&conversationId=...
GET /api/activity?scope=task&taskId=...
GET /api/activity/index
POST /api/activity/context
```

`POST /api/activity/context` associates a conversation with a stable `taskId`/`taskTitle`, which helps integrations keep simultaneous work streams separate.


## Scoped notices

Notices support scoped delivery:

```text
no conversationId/taskId -> global notice, visible to any terminal response
conversationId only      -> visible only to that conversation
taskId only              -> visible only to that task
both                     -> visible only when both match
```

This is useful when several ChatGPT conversations use the same Server Commander at the same time.

## Command execution modes (v1.0.4+)

### GET inline (existing action — fully compatible)

```http
GET /api/runTerminalScript?command=pwd%20%26%26%20hostname
```

### POST inline

```http
POST /api/runTerminalScript
Content-Type: application/json

{
  "command": "pwd && hostname",
  "mode": "inline",
  "cwd": "/data/workspace",
  "timeoutMs": 45000,
  "maxOutputChars": 12000
}
```

### POST script mode

Use script mode for multi-line commands, nested docker exec, JSON/YAML edits, or anything where shell quoting is fragile.

```http
POST /api/runTerminalScript
Content-Type: application/json

{
  "mode": "script",
  "script": "set -e\npwd\nhostname\n",
  "shell": "/bin/sh",
  "cwd": "/data/workspace",
  "timeoutMs": 45000,
  "maxOutputChars": 12000
}
```

The `/v1/commands/execute` endpoint accepts the same POST body.

### Response contract

```json
{
  "message": "Command executed successfully.",
  "output": "...",
  "exitCode": 0,
  "timedOut": false,
  "outputTruncated": false,
  "maxOutputChars": 12000,
  "mode": "inline",
  "notices": []
}
```

### When to use script mode

- Multi-line commands with control flow (`if`, `for`, `while`)
- Commands with nested quotes (`docker exec`, `awk`, `jq`, `sed`)
- JSON or YAML inline edits
- Any command that fails due to shell quoting in inline mode

### Safety notes

- Timeout is enforced; `COMMAND_TIMEOUT_MS` (default 120s) caps all executions
- Output is truncated at `MAX_OUTPUT_CHARS` (default 12000 chars)
- Script bodies are capped at `MAX_SCRIPT_BODY_BYTES` (default 512 KiB)
- CWD is validated and must exist as a directory
- Script temp files are cleaned up after execution
- Activity logs record hash/byte-length/preview — never full script bodies
- Destructive commands require explicit human approval
