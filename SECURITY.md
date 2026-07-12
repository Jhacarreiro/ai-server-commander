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
- keep `config.json` mode `600`;
- use HTTPS and high-entropy tokens;
- enable `SAFE_MODE`, while treating it only as a denylist;
- avoid membership in `sudo`, `docker` or privileged groups;
- restrict ingress where client requirements permit;
- require human confirmation for write, delete, restart, permission and credential operations;
- rotate any secret accidentally included in logs, prompts, screenshots or issues.

## Dependency findings

The project may retain dependency advisories when the only automated fix is breaking or invalid. Such findings are tracked separately, assessed against enabled production paths and addressed through tested migrations rather than blind `npm audit fix --force` changes.
