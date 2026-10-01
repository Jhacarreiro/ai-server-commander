# Watcher on/off and browser recovery

The ChatGPT Web watcher is optional and **disabled by default**. ChatGPT Actions, Claude, REST execution and MCP work with it disabled. It observes an authenticated ChatGPT browser session; it is separate from connecting an assistant to Commander.

## Turn it on or off

Edit the private Commander `config.json`:

```json
{
  "chatgptWeb": {
    "enabled": false
  }
}
```

Use `true` to enable it. Restart the process that runs Commander after changing the flag. For example:

```bash
sudo systemctl restart ai-server-commander.service
```

Use your actual service name. `CHATGPT_WEB_ENABLED` overrides the file, including an explicit `false`. Changing the file alone does not change a running watcher.

With the watcher disabled:

- status/latest/pending/ACK/poll routes return authenticated `503` responses with `enabled: false` and `status: disabled`;
- no watcher observation or consent approval runs;
- pending responses, ACK and deduplication history remain on disk;
- REST terminal execution, MCP and OAuth remain available.

## Browser lifecycle: application and deployment

Commander itself attaches to an existing browser over loopback CDP. It does not launch or stop Chromium. A browser you started separately remains the operator's responsibility.

An optional **deployment-level browser supervisor** can provide automatic recovery. A container-based deployment, for example with OpenClaw, can use this flow:

```text
Commander start/stop
        |
        v
local authenticated watcher-status check
        |
        v
private enabled/disabled indication (no tokens)
        |
        v
container browser supervisor
        |
        +-- enabled: maintain Chromium + dedicated display; reuse saved profile
        +-- disabled: stop that Chromium/profile and the display it owns
```

Install such an integration separately in the process manager and container entrypoint. It is deployment-specific and is **not installed by `npm install` or `npm start`**. The stock watcher API contract remains the same.

For an equivalent integration, the operator should:

1. Keep the browser profile and all session data in private persistent storage outside release directories.
2. Publish the running Commander's effective flag at startup; publish `false` when Commander stops. Read the authenticated status route so environment overrides are respected.
3. Pass only the boolean to the browser container. Keep Commander's authentication token on the Commander host.
4. Start one supervisor from the container entrypoint, with a lock preventing duplicate instances. Missing or invalid control state means disabled.
5. When enabled, start the browser and its display if needed, reuse the same profile, and restore only the previously saved ChatGPT tabs. Keep CDP on loopback.
6. When disabled, close only the browser with the configured watcher profile/debug port, and the display owned by the supervisor. Keep the profile and watcher state.

The supervisor can remain idle while disabled so enabling Commander again can start the browser. It must not maintain a Chromium or dedicated display process while the watcher is off.

## Verify enabled mode

1. Enable the flag and restart Commander.
2. Confirm the browser session is authenticated and the status route reports an enabled, healthy watcher.
3. Restart OpenClaw while keeping Commander running.
4. Confirm CDP, authentication and sidebar/conversation observation return automatically, with the saved profile and no manual login.
5. Check pending response, ACK and deduplication state survived.

Measure recovery time on your own deployment, including container shutdown and startup. Preserve durable watcher state throughout the test, and record whether Commander stayed running.

## Verify disabled mode

1. Set the flag to `false` and restart Commander.
2. Confirm all five watcher routes report `503 / disabled`, the watcher browser has stopped, and its dedicated display is stopped.
3. Confirm MCP and REST still respond with their normal authentication.
4. Restart OpenClaw and confirm it becomes healthy without starting that browser.
5. Confirm the watcher state file remains unchanged while disabled.

Leave the watcher disabled after testing if continuous monitoring is not needed. Re-enabling requires an explicit configuration change and Commander restart.

## Recovery and rollback

If enabled status reports `attention_snapshot_failed`, check CDP and browser startup. `sidebar_attention_unavailable` can indicate a page that is still loading or requires attention. Authentication expiry requires a human login; the supervisor must not invent credentials or replace the profile.

For `state_invalid` or `state_unreadable`, preserve the state file and recover from a valid private backup as described in the [watcher API and persistence guide](./chatgpt-web-mvp1.md#persistence-and-recovery).

Before installing lifecycle hooks, back up the entrypoint and service configuration. To roll back, restore the entrypoint, remove only the lifecycle integration's service hooks, reload the process manager and restart affected services. Preserve the browser profile, configuration and runtime data, and keep the watcher disabled until another test is intended.

See [deployment and persistent state](./deployment.md#link-persistent-state-without-release-chains) and the [watcher settings and automatic consent behavior](./chatgpt-web-mvp1.md).
