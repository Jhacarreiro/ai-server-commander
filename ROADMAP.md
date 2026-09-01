# Roadmap

AI Server Commander follows a capability-first model: implement a capability once in shared core code, then expose it through REST/OpenAPI and MCP with matching safety semantics.

## Product direction — a small AI control plane

Commander started as a bounded terminal bridge. The intended evolution is a small, self-hosted control plane for capabilities that AI clients need to use across machines and authenticated local services.

The boundary matters:

- Commander owns typed capabilities, authentication, policy, execution state and machine-readable results.
- Client-specific agents own interpretation, summarization, suggested replies and conversational behavior.
- UI surfaces such as Telegram relays or a future mobile-first PWA are clients of Commander, not part of the execution core.
- Browser profiles, cookies, user sessions, bot tokens and deployment-specific conversation identifiers are runtime state and must never be committed to the public repository.

This keeps the command executor independently useful while allowing additional capability adapters to share the same operational model.

## Current baseline — v1.0.8

- Shared bounded executor for REST and MCP.
- Inline command and multi-line script modes.
- Timeout and output caps.
- Per-command activity IDs and targeted interruption.
- `SAFE_MODE` denylist.
- Activity logging and notices.
- ChatGPT Custom GPT Action support through OpenAPI.
- Remote MCP with OAuth discovery, dynamic registration, PKCE, persistent hashed state, refresh rotation and revocation.
- MCP title, input/output schemas, risk annotations, OAuth security metadata and structured results.
- CI, deployment documentation and standard open-source contribution/security files.

## Near-term priorities

### Authenticated web-conversation watcher — MVP1

MVP1 is implemented as a deliberately read-only, disabled-by-default browser/session capability. The initial target is an explicitly selected AI web conversation running in an operator-authenticated, persistent headful browser profile.

MVP1 should:

- attach to or launch an explicitly configured persistent browser profile without owning the user's credentials;
- inspect one explicitly selected conversation;
- identify the latest assistant response using stable semantic/DOM signals where possible;
- distinguish at least `idle`, `generating`, `completed` and `needs_human` states;
- detect a new completed response exactly once through durable deduplication state;
- return the completed response and minimal conversation metadata through a typed API;
- expose status/latest/pending/ack operations without requiring an LLM in the polling loop;
- keep watcher state local and exclude browser profiles, cookies and conversation data from Git;
- fail safely when login, CAPTCHA, consent or unexpected UI changes require human takeover;
- remain read-only: MVP1 must not submit messages, click confirmation dialogs or perform account-changing actions.

The first intended consumer is an isolated OpenClaw relay agent connected to a separate Telegram bot. Commander should only report deterministic conversation state and response content; the agent may summarize the response and suggest what the operator could say next. Telegram-specific logic does not belong in Commander.

Success criteria for MVP1:

1. a watched conversation can generate a response while the mobile client is closed;
2. Commander reliably detects completion and emits one new-response event/state transition;
3. an external client can retrieve the exact completed response;
4. restarting the watcher does not duplicate already-acknowledged responses;
5. authentication/UI interruptions surface as `needs_human` rather than triggering unsafe recovery behavior.

### Web-conversation relay — MVP2

Only after MVP1 is stable, consider explicit write capabilities:

- submit a user-approved reply to a selected conversation;
- stop or retry generation where the target UI supports it;
- watch multiple conversations;
- expose explicit acknowledgement/read state;
- require confirmation for any sensitive or ambiguous browser action.

Suggested replies remain an agent/client concern. Commander should transport the approved text, not decide what the user should say.

### Mobile client path — MVP3+

Telegram is the validation client, not the final UX contract. Keep the conversation API transport-neutral so the same backend can later support a mobile-first PWA with:

- reliable completion and `needs_human` notifications;
- quick replies and contextual actions;
- conversation read/unread state;
- deep links to the relevant conversation;
- multiple backend adapters without changing the client interaction model.

The PWA should remain optional. Commander must continue to work as a headless REST/MCP service.

### Policy profiles and path controls

Add named profiles with:

- default working directory;
- allowed and denied paths;
- command allowlists or risk classes;
- per-profile timeout/output caps;
- client-independent behavior.

Unknown profiles should fail closed.

### First-class read-only tools

Reduce reliance on arbitrary shell commands for common diagnostics:

- `server_status`;
- `list_directory`;
- `read_file`;
- `git_status`;
- `process_status`;
- bounded `service_logs`.

Each tool should have a matching REST operation or documented mapping.

### Human confirmation protocol

Add explicit risk classes and confirmation tokens for operations such as:

- project file writes;
- service restarts;
- permission changes;
- protected configuration edits;
- destructive or unknown-risk commands.

Client annotations help, but server-side confirmation state is the stronger control.

### Rate limiting and abuse controls

Add configurable:

- per-token request limits;
- concurrent command limits;
- maximum queue depth;
- authentication failure throttling;
- structured security events.

### Dependency maintenance

The high-severity LocalTunnel and setup dependency chains were removed in v1.0.8. The runtime now uses the direct `@google-cloud/firestore` client instead of the broader Firebase Admin package, eliminating the unused Storage dependency chain; keep runtime dependencies on supported Node 20-compatible releases and require a clean production audit before release.

## Later possibilities

- restricted HTTP proxy for allowlisted domains with server-side credentials;
- named remote-host adapters with per-host policy;
- optional container-backed execution profiles;
- additional browser/UI automation adapters with explicit confirmation for sensitive actions;
- additional conversation/provider adapters behind the same typed interface;
- richer client UI components without making them required for core REST/MCP compatibility.

## Deliberately out of scope

- unauthenticated public command execution;
- arbitrary internet proxying by default;
- unrestricted SSH to arbitrary hosts;
- claims that a regex denylist is a sandbox;
- automatic destructive execution based only on model judgment;
- committing browser profiles, cookies, tokens or private conversation state;
- making a specific UI, browser vendor or AI provider mandatory for the command-execution core.

## Release quality bar

Every behavior milestone should include:

- syntax checks;
- shared-core unit or smoke tests;
- REST tests;
- MCP tests;
- unauthorized request tests;
- policy/blocked-command tests where relevant;
- OpenAPI/schema validation;
- deployment notes and rollback steps.
