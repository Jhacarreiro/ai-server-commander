# ChatGPT Web watcher

The optional watcher attaches to an already-authenticated Chromium session over loopback CDP. It reports conversation state and completed assistant responses through authenticated REST routes. It is disabled by default and does not own browser credentials or submit user replies.

## Enable or disable

Set the flag in `config.json` and restart the Commander process:

```json
{
  "chatgptWeb": {
    "enabled": true
  }
}
```

Use `"enabled": false` to disable it. The setup wizard writes this disabled flag for new installations. The remaining settings are optional and use the defaults below.

`CHATGPT_WEB_ENABLED` takes precedence over the file, including an explicit `false`. For example, on a POSIX host:

```sh
CHATGPT_WEB_ENABLED=false npm start
CHATGPT_WEB_ENABLED=true npm start
```

Boolean values and `true/false`, `1/0`, `yes/no`, `on/off` are accepted. Invalid values stop startup with a configuration error. Omission defaults to disabled. `.env.example` is a reference; Commander does not load `.env` files automatically. In a service deployment, change the service environment or the persistent `config.json`, then restart that service. Editing the file alone does not change a running process.

While disabled, no browser observation or consent approval runs, no watcher state is read or written, and all watcher routes return HTTP 503 with `status: disabled`. Existing pending responses and deduplication history stay on disk and are reused when enabled again. REST terminal execution and MCP remain available.

## Settings and modes

```json
{
  "chatgptWeb": {
    "enabled": false,
    "cdpEndpoint": "http://127.0.0.1:9223",
    "conversationUrl": null,
    "stableMs": 4000,
    "primeMs": 20000,
    "pollMs": 5000,
    "statePath": "runtime/chatgpt-web-state.json",
    "emitInitial": false
  }
}
```

Environment overrides are `CHATGPT_WEB_ENABLED`, `CHATGPT_WEB_CDP_ENDPOINT`, `CHATGPT_WEB_CONVERSATION_URL`, `CHATGPT_WEB_STABLE_MS`, `CHATGPT_WEB_PRIME_MS`, `CHATGPT_WEB_POLL_MS`, `CHATGPT_WEB_STATE_PATH`, and `CHATGPT_WEB_EMIT_INITIAL`.

- **Attention mode** (`conversationUrl: null`): reads the account's sidebar attention index, records an initial baseline, and processes changed conversations individually. Waiting conversations can trigger the allowlisted consent action below. Unread or followed-up conversations provide completed assistant responses. A pending response must be acknowledged before further account processing.
- **Conversation mode** (a configured HTTPS `chatgpt.com` URL containing `/c/<conversation-id>`): observes that conversation's DOM and generation state. Existing content is primed for `primeMs` and must stabilize for `stableMs`; baseline content is recorded without a new-response notification. This mode does not approve consent.

CDP is restricted to loopback hosts. The watcher uses the existing session and does not launch a browser or navigate to another conversation.

## Automatic consent in attention mode

Attention mode can send a one-time JIT allow response for `runTerminalScript` when the consent domain matches `productionDomain`'s hostname. `CHATGPT_WEB_APPROVAL_DOMAIN` can override that hostname. Without an approval domain, no consent is approved. The allow payload uses `remember_answer: false`.

This is a browser write action and can resume terminal execution requested by the ChatGPT conversation. It runs during both automatic and explicit polls. Unmatched waiting state requires human attention; other domains and operations are rejected by the consent approver. Setting `enabled: false` disables this action along with observation.

## REST operations

All routes use normal Commander bearer authentication.

- `GET /api/chatgpt-web/status`: state and metadata, without response text.
- `GET /api/chatgpt-web/latest`: latest completed assistant response, if any.
- `GET /api/chatgpt-web/pending`: unacknowledged completed response, if any.
- `POST /api/chatgpt-web/ack`: acknowledge the exact pending fingerprint after downstream handling. Returns 400 for a missing fingerprint, 409 for a mismatch or no pending response, and 503 when persisted state cannot be read safely.
- `POST /api/chatgpt-web/poll`: perform one observation and, in attention mode, eligible consent handling.

Commander polls automatically every `pollMs`. Background polls, explicit polls, and ACKs share one mutation queue per watcher instance. Internal JavaScript callers must now `await watcher.ack(fingerprint)`; the HTTP request/response contract is unchanged.

States include `idle`, `generating`, `stabilizing`, `completed`, `needs_human`, and `error`. Authentication is checked against the ChatGPT session endpoint rather than visible login buttons.

## Persistence and recovery

State is written atomically with mode `0600` to `statePath`. Keep it outside disposable releases, and exclude it, browser profiles, cookies, tokens, and conversation data from Git. The recent-history ring retains up to 64 fingerprints; an already recorded fingerprint in that ring does not emit another `newResponse: true`. Pending responses and ACKs survive restarts.

A missing state file initializes a first run. Invalid JSON, an invalid state structure, or a file read error stops polling and consent actions with `status: error` and reason `state_invalid` or `state_unreadable`. Status/latest/pending report the fault; explicit poll returns it with `newResponse: false`, and ACK returns HTTP 503. The faulty file is preserved unchanged, and error responses do not include its contents.

To recover, stop the watcher, keep a private copy of the faulty file, and restore a valid backup with its deduplication history and pending response intact. Correct file permissions for an unreadable file. Enable/restart the watcher afterwards. Deleting the state starts a fresh baseline and loses retained deduplication and ACK history.

Use one Commander process per state file. The in-process queue does not coordinate multiple Commander instances. Browser failures do not trigger browser restarts, login attempts, or unrelated account changes. Summaries, reply suggestions, and notifications remain client responsibilities.
