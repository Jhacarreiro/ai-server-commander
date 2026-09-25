# Deployment and Upgrades

## Recommended topology

```text
Internet or trusted client
          │ HTTPS
          ▼
Nginx / Caddy / managed tunnel
          │ loopback or private LAN
          ▼
AI Server Commander as an unprivileged systemd service
```

Do not expose the Node process directly to the public internet without TLS and access controls.

## Dedicated user

Example for Linux:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin ai-commander
sudo mkdir -p /opt/ai-server-commander
sudo chown ai-commander:ai-commander /opt/ai-server-commander
```

Do not add this user to `sudo` or `docker` unless the associated privileges are explicitly part of your threat model.

## Install

```bash
sudo -u ai-commander git clone https://github.com/Jhacarreiro/ai-server-commander.git /opt/ai-server-commander
cd /opt/ai-server-commander
sudo -u ai-commander npm ci --omit=dev
sudo -u ai-commander cp config.example.json config.json
sudo chmod 600 config.json
```

Edit `config.json` with the public HTTPS origin and fresh random tokens.

## Listen address

`host` is optional. Existing configurations and the setup wizard omit it, keeping
the current all-interface listener: Node uses `::` where IPv6 is available or
`0.0.0.0` otherwise. An IPv6 unspecified listener may also accept IPv4 connections,
depending on the operating system. No upgrade automatically restricts the bind.

For a reverse proxy on the same host and network namespace, add
`"host": "127.0.0.1"` to the private `config.json` before starting the service.
This matches the Nginx example below. `"host": "::1"` selects IPv6 loopback;
adjust the proxy upstream accordingly. Supply an address or hostname, not a URL,
port, or bracketed IPv6 address. Empty/non-string values are rejected; an address
that cannot be resolved or bound fails startup instead of falling back to all interfaces.

A proxy in another container or on another machine cannot reach the service's
loopback address. In that topology, choose a reachable interface or leave `host`
unset and restrict access using network/firewall policy. `productionDomain` is
independent: it remains the externally visible HTTPS origin.

The startup message reports the actual bound address. Changing `host` requires a
service restart; verify both the listener and proxy access after any planned change.

## systemd example

```ini
[Unit]
Description=AI Server Commander
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ai-commander
Group=ai-commander
WorkingDirectory=/opt/ai-server-commander
Environment=NODE_ENV=production
Environment=SAFE_MODE=true
Environment=COMMAND_TIMEOUT_MS=120000
Environment=MAX_OUTPUT_CHARS=12000
Environment=MAX_SCRIPT_BODY_BYTES=524288
Environment=OAUTH_STATE_PATH=/opt/ai-server-commander-state/oauth-state.json
ExecStart=/usr/bin/node main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/ai-server-commander/runtime /opt/ai-server-commander-state

[Install]
WantedBy=multi-user.target
```

`Restart=always` is required for `/api/restart`: the server exits with status 0 after draining, which `Restart=on-failure` would treat as a clean stop and leave the service down. `systemctl stop` is not affected, and `SIGTERM` gets the same drain as `/api/restart` (running commands are interrupted first), bounded by `RESTART_FORCE_EXIT_MS` (default 30 seconds, below systemd's default `TimeoutStopSec` of 90 seconds).

Adjust paths for your Node installation and deployment layout. `ProtectSystem`, `ProtectHome` and `ReadWritePaths` may need changes if commands must access project directories outside the application tree.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-server-commander
sudo systemctl status ai-server-commander --no-pager
```

## Nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name commander.example.com;

    # Configure certificates using your normal TLS process.

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 130s;
    }
}
```

Set `productionDomain` to `https://commander.example.com`.

LocalTunnel support was removed in v1.0.8. Deployments upgrading from `useLocalTunnel: true` must move to a maintained reverse proxy, VPN or tunnel and set `productionDomain` to the external HTTPS origin.

## Post-deployment validation

```bash
curl -fsS https://commander.example.com/openapi.json | head
curl -i https://commander.example.com/.well-known/oauth-protected-resource/mcp
curl -i https://commander.example.com/.well-known/oauth-authorization-server
```

Authenticated REST smoke test:

```bash
curl -fsS \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"command":"printf deployment_ok","timeoutMs":5000}' \
  https://commander.example.com/v1/commands/execute
```

Use a real MCP client or the repository smoke test to validate MCP.

## Upgrade pattern

Prefer immutable release directories and a stable symlink:

```text
/opt/ai-server-commander-current -> /opt/releases/ai-server-commander-1.0.7
/opt/ai-server-commander-state/config.json
/opt/ai-server-commander-state/runtime/
/opt/ai-server-commander-state/oauth-state.json
```

Suggested process:

1. Download or clone the new tagged release into a new directory.
2. Run `npm ci --omit=dev`.
3. Link the existing `config.json` and `runtime/` state, and preserve the same `OAUTH_STATE_PATH`.
4. Run `npm run check` and `npm test` before cutover.
5. Start a staging instance on another port.
6. Validate REST, MCP, OAuth metadata and OpenAPI.
7. Switch the stable symlink and restart the service.
8. Keep the previous release intact until the new release has run cleanly.

## Rollback

1. Stop or restart the service through the process manager.
2. Point the stable symlink back to the previous release.
3. Reuse the unchanged state directory.
4. Start the service.
5. Validate `/openapi.json`, REST and MCP.

Never delete the previous release before the new version has passed production validation.

## Backups

Back up:

- `config.json` using encrypted secret-aware storage;
- `oauth-state.json` if uninterrupted MCP authorization is required;
- any runtime records required for audit or diagnostics;
- reverse-proxy and service-unit configuration.

Do not commit these backups to the repository.
