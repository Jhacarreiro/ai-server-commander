# Contributing

Thank you for considering a contribution to AI Server Commander.

## Development setup

```bash
git clone https://github.com/Jhacarreiro/ai-server-commander.git
cd ai-server-commander
npm install
cp config.example.json config.json
```

Replace the example secrets and keep `config.json` local. Use a non-production test host and an unprivileged account.

Before submitting changes:

```bash
npm run check
npm test
npm audit --omit=dev
```

An audit advisory does not automatically justify a forced dependency migration. Explain compatibility and test impact for major upgrades.

## Pull requests

- Create a focused branch from `main`.
- Keep changes small and reviewable.
- Add tests for behavior changes.
- Update README, CHANGELOG or docs when user-facing behavior changes.
- Preserve REST/MCP parity when changing shared capabilities.
- Keep OAuth, policy and execution logic out of client-specific adapters where possible.
- Show the commands used for validation in the PR description.
- Do not commit generated runtime state, logs, tokens, credentials, private hostnames or deployment-specific paths.

## Design principles

1. One capability, shared core, thin client adapters.
2. Same safety semantics for REST and MCP.
3. Secure defaults and explicit expansion.
4. Fail closed on invalid paths and malformed policy.
5. Backward compatibility unless a release clearly documents a break.
6. Short, verifiable commands in tests and examples.
7. No claims that `SAFE_MODE` is a sandbox.

## Commit style

Use concise imperative subjects, for example:

```text
feat: add structured MCP output
fix: reject invalid working directory
 docs: document reverse proxy deployment
```

## Reporting security issues

Follow [SECURITY.md](./SECURITY.md). Do not open a public issue containing exploit details or secrets.
