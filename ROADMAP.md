# Roadmap

AI Server Commander follows a capability-first model: implement a capability once in shared core code, then expose it through REST/OpenAPI and MCP with matching safety semantics.

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

The high-severity LocalTunnel and setup dependency chains were removed in v1.0.8, and Firebase Admin moved to the latest Node 20-compatible major. Continue monitoring the remaining moderate Google/Firebase transitive advisories and upgrade when forward-compatible upstream fixes exist.

## Later possibilities

- restricted HTTP proxy for allowlisted domains with server-side credentials;
- named remote-host adapters with per-host policy;
- optional container-backed execution profiles;
- browser/UI automation adapters with explicit confirmation for sensitive actions;
- richer client UI components without making them required for core MCP compatibility.

## Deliberately out of scope

- unauthenticated public command execution;
- arbitrary internet proxying by default;
- unrestricted SSH to arbitrary hosts;
- claims that a regex denylist is a sandbox;
- automatic destructive execution based only on model judgment.

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
