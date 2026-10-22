# Protect the installation from terminal commands

The optional [Linux systemd unit](../deploy/systemd/ai-server-commander.service)
keeps installation and configuration paths read-only while allowing persistent
runtime state and an explicit project workspace to be written. Review and adapt
it before installation; the repository does not activate or replace services.

Use an administrator-owned layout:

```text
/opt/ai-server-commander/releases/VERSION/  administrator-owned code and dependencies
/opt/ai-server-commander/current           administrator-owned release symlink
/etc/ai-server-commander/config.json       existing private configuration
/var/lib/ai-server-commander/runtime/      existing runtime, including OAuth and logs
/var/lib/ai-server-commander/tokenStore.json optional existing share-link store
/srv/commander-work/                      explicit writable project workspace
```

Protect the parent directories and the stable release symlink too. A file's
read-only mode alone does not prevent its owner from deleting it through a
writable parent. Use an unprivileged service account without administrative or
Docker-socket access. It needs read access to configuration, not ownership of
the installation. A private configuration can be administrator-owned with a
service-readable group and mode `0640`, inside a restricted parent directory.

## Back up before enabling protection

1. Record the active release, both resolved state targets, any explicit OAuth,
   activity, operation or token-store environment paths, and the existing unit.
2. Stop the service and every other writer to its state. Create a private,
   timestamped backup outside the installation and the executor's writable roots.
3. Back up the complete runtime, configuration, existing share-link store and
   service configuration. Keep secret-aware encrypted/off-host backups as well.
   Verify the archive and its file ownership/modes before proceeding.
4. Preserve the same state targets where possible. If relocation is required,
   copy the complete stopped state, compare its contents privately, and retain
   the originals. Do not replace it with examples or create a fresh OAuth store.
5. Install the new release and dependencies, then use `link-release-state.sh` to
   point `config.json` and `runtime` directly to their stable external targets.
   Do this during deployment, before making the release read-only. A repeated
   helper invocation succeeds without writing when both direct links are correct.
6. Set administrator ownership on code, dependencies, release links and their
   parents. Keep state writable by the service user with private permissions.
   Pre-create `/srv/commander-work` for that user. Adapt the sample unit's paths,
   Node executable and writable project roots; never allow the whole installation
   back through `ReadWritePaths`.
7. Validate the unit with `systemd-analyze verify`, then apply it through the
   service manager. Verify REST and MCP command execution, existing OAuth clients
   and refresh, activity retention, share links and one controlled restart.

`TOKEN_STORE_PATH` moves share-link state out of the installation; its parent must
already exist and be privately writable. Omission preserves the previous
`tokenStore.json` location. Existing tokens must be copied deliberately when
changing that path. The setting does not modify OAuth or activity storage.

The sample `HOME` and working directory point at the dedicated project workspace
rather than the installation or an operator's home. File-edit routes use this
workspace too. `StateDirectory` and the explicit project `ReadWritePaths` provide
the writable exceptions to `ProtectSystem=strict`. The runtime symlink points to the
external state directory. If Node itself is installed in a writable home, protect
that runtime and its parents separately or use an administrator-managed Node.

## Limits and rollback

This protects against accidental writes to the installation. Commands still run
as the service account and can access its writable state; it is not isolation
between the terminal worker and OAuth credentials. Arbitrary privileged helpers,
Docker access or mount capabilities can bypass filesystem restrictions. Do not
claim a security boundary while exposing those privileges.

To roll back, stop the service, restore the previous unit/release link and start
using the current persistent state. Do not restore an older OAuth/runtime archive
over newer activity unless a separate state-recovery decision requires it.
Keep the verified backup until the protected deployment has been accepted.

Reference: [systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
