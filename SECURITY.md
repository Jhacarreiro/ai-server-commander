# Security Policy

## Supported versions

Security fixes are applied to the latest released minor version. Older releases may not receive backports.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, exposed credentials or deployment-specific secrets.

Use GitHub's **Report a vulnerability** flow in the Security tab when available. If private reporting is unavailable, contact the maintainer through the repository owner's public GitHub profile and request a private channel before sharing technical details.

Include:

- affected version and commit;
- deployment topology and operating system;
- exact reproduction steps;
- impact and required privileges;
- whether credentials or production data were exposed;
- a minimal proof of concept with secrets removed.

You should receive an acknowledgement within seven days. Disclosure timing will be coordinated after a fix or mitigation is available.

## Security assumptions

AI Server Commander executes shell commands with the permissions of its service user. It is not a sandbox, container boundary or privilege-separation system.

Deployments should:

- use a dedicated unprivileged operating-system account;
- keep `config.json` and the OAuth state file mode `600`;
- use HTTPS and high-entropy tokens;
- enable `SAFE_MODE`, while treating it only as a denylist;
- avoid membership in `sudo`, `docker` or privileged groups;
- restrict ingress where client requirements permit;
- require human confirmation for write, delete, restart, permission and credential operations;
- rotate any secret accidentally included in logs, prompts, screenshots or issues;
- keep `OAUTH_STATE_PATH` on persistent local storage owned by the service account.

## OAuth state

OAuth client secrets, authorization codes, access tokens and refresh tokens are stored only as SHA-256 hashes. The state file also contains non-secret client metadata and expiry/resource/scope records. Protect the parent directory, back up the file only when continuity is required, and treat deletion as an authorization reset.

Persist merges the current on-disk file under an exclusive sibling lock directory before rewriting it. Local deletions (revocation, refresh rotation, consumed authorization codes, and expiry pruning) win over a stale in-memory snapshot, and a failed or malformed state read still fails closed instead of replacing the file with cached memory. Prefer a single writer process per `OAUTH_STATE_PATH`.

The server rejects malformed or symlinked OAuth state files rather than silently starting with an empty authorization database.

## Dependency findings

The project does not treat a green high-severity audit gate as sufficient for release. The current runtime dependency graph uses `@google-cloud/firestore` directly and has zero known production advisories under `npm audit --omit=dev`; new advisories should be investigated and removed or explicitly documented before release rather than hidden with `npm audit fix --force`.
