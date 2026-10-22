# Read-only installation preflight

An already-running process may keep answering HTTP after its installation files
have disappeared. Check the disk prerequisites independently before maintenance
and through an existing host monitor:

```bash
node scripts/check-installation.js \
  --release /opt/releases/ai-server-commander-current \
  --config /var/lib/ai-server-commander/config.json \
  --runtime /var/lib/ai-server-commander/runtime \
  --require-oauth-state
```

Use absolute paths and a release with direct configuration/runtime links to
persistent targets outside its releases directory. `--oauth-state PATH` or the
existing `OAUTH_STATE_PATH` overrides the default runtime OAuth file. Retain the
deployment's existing value. `--require-oauth-state` is appropriate after OAuth
has been used; without it, an uncreated store is allowed for a fresh installation.

`--node PATH` checks the executable used by the service instead of the executable
running the check. Repeat `--require-executable PATH` for external startup
wrappers or state-link helpers. The command checks critical source syntax,
dependency entry points, direct state links, readable configuration and existing
OAuth state. It never starts the application, prunes grants, rewrites files or
prints credentials, state contents or absolute deployment paths. Text inputs must
be regular files of at most 16 MiB; special files fail without being read.

Output is JSON with `ok`, `readOnly` and named checks. Exit status is `0` for
success, `1` for a failed check and `2` for invalid arguments. Keep a copy of this
standalone script and a stable Node runtime outside the installation being
monitored, so the check still runs after release files or its bundled Node go
missing. Do not run it solely through `npm` inside that installation.

Integrate with the existing monitor and alert destination; this command creates
no timer, scheduled job, messages or automatic repair. A failed check while HTTP
is healthy should alert the operator. Do not automatically restart that process:
preserve evidence, back up current state and restore prerequisites first.

This is a prerequisite check, not a complete dependency-integrity audit, protocol
test or backup. Before applying protections, stop writers for a consistent backup
of configuration and the complete runtime. After an approved deployment, verify
REST/MCP, existing OAuth clients and refresh, retained activity and a controlled
restart. Reuse current state on rollback rather than overwriting newer tokens or
logs with an old backup.
