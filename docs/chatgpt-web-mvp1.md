# ChatGPT Web watcher — MVP1

MVP1 adds a read-only, disabled-by-default browser/session capability to AI Server Commander. It observes one ChatGPT Web conversation through an already-authenticated Chromium session and reports deterministic state. It does not send messages, click buttons, handle credentials, or make account changes.

## Boundary

```text
ChatGPT Web
    │ authenticated Chromium session
    │ loopback CDP
    ▼
OpenCLI CDPBridge
    ▼
AI Server Commander
    ├── status
    ├── latest completed response
    └── explicit poll + durable dedup
```

Commander owns observation state, stability checks and deduplication. A consuming agent or UI owns summarization, reply suggestions and notifications.

## Configuration

The feature is disabled unless `chatgptWeb.enabled` or `CHATGPT_WEB_ENABLED` is true.

```json
{
  "chatgptWeb": {
    "enabled": false,
    "cdpEndpoint": "http://127.0.0.1:9223",
    "conversationUrl": null,
    "stableMs": 4000,
    "pollMs": 5000,
    "statePath": "runtime/chatgpt-web-state.json",
    "emitInitial": false
  }
}
```

Environment variables with matching names are also accepted: `CHATGPT_WEB_ENABLED`, `CHATGPT_WEB_CDP_ENDPOINT`, `CHATGPT_WEB_CONVERSATION_URL`, `CHATGPT_WEB_STABLE_MS`, `CHATGPT_WEB_POLL_MS`, `CHATGPT_WEB_STATE_PATH`, and `CHATGPT_WEB_EMIT_INITIAL`.

MVP1 restricts CDP to a loopback host. `conversationUrl`, when configured, must be an HTTPS `chatgpt.com` URL containing `/c/<conversation-id>`.

## REST operations

All routes use the normal Commander bearer authentication boundary.

- `GET /api/chatgpt-web/status` — state and metadata only; does not return response text.
- `GET /api/chatgpt-web/latest` — latest completed assistant response, if any.
- `GET /api/chatgpt-web/pending` — unacknowledged completed response, if any.
- `POST /api/chatgpt-web/ack` — acknowledges a specific pending fingerprint after a downstream client has handled it.
- `POST /api/chatgpt-web/poll` — performs one deterministic read-only observation.

When enabled, Commander also polls automatically every `pollMs`; the explicit poll route remains useful for bounded diagnostics.

When disabled, these routes return HTTP 503 with `status: disabled`.

## State model

MVP1 uses these states:

- `idle` — authenticated but no selected conversation/assistant response is currently observable;
- `generating` — ChatGPT exposes a visible stop-generation control;
- `stabilizing` — assistant text is present but has not remained unchanged for `stableMs`;
- `completed` — a stable response has been recorded;
- `needs_human` — authentication is missing or a configured conversation is not open;
- `error` — the browser/CDP snapshot failed.

The first stable response is treated as a baseline by default (`emitInitial: false`) so enabling the watcher does not emit an old response as new. A later stable fingerprint returns `newResponse: true` exactly once and remains available through `/pending` until a downstream client acknowledges that exact fingerprint. This pending state survives Commander restarts. State is written atomically with mode `0600` under `runtime/`, which is excluded from Git.

## Safety rules

- No browser profile, cookie, token, credential, private conversation or runtime state belongs in the repository.
- MVP1 never submits a message or automatically navigates to another conversation.
- Authentication is checked against the ChatGPT session endpoint, not against visible “Log in” buttons, because authenticated pages may still render those controls.
- Browser/CDP failures do not trigger autonomous recovery actions.

## Intended client path

The first intended client is a separate OpenClaw relay agent/bot that can poll Commander, notify a human when `newResponse` is true, summarize the response and suggest a reply. Telegram-specific behavior remains outside Commander. A later PWA can consume the same REST contract.
