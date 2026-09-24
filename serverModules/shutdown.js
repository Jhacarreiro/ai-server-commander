// Graceful shutdown shared by /api/restart and process signals: interrupt
// running commands, stop accepting connections, and exit once in-flight
// responses drain. Commands run in their own process groups, so without this
// they would outlive a server that is simply killed.
const { killPendingNow, terminateAll } = require('./commandExecutor');

let shuttingDown = false;

function forceExitMs() {
    const parsed = Number(process.env.RESTART_FORCE_EXIT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30000;
}

// `close(done)` stops the listener and calls `done` once in-flight requests
// have drained. process.exit is only a last-resort bound
// (RESTART_FORCE_EXIT_MS, default 30000) if close never completes.
function shutdown(close) {
    if (shuttingDown) return false;
    shuttingDown = true;
    let exited = false;
    const exitProcess = () => {
        if (exited) return;
        exited = true;
        killPendingNow();
        process.exit();
    };
    const force = setTimeout(exitProcess, forceExitMs());
    const finish = () => {
        clearTimeout(force);
        exitProcess();
    };
    // Interrupt running commands first: their requests then complete with
    // interrupted: true and drain, and no command outlives the process.
    terminateAll();
    try {
        const maybe = typeof close === 'function' ? close(finish) : undefined;
        if (maybe && typeof maybe.then === 'function') {
            maybe.then(finish, finish);
        }
    } catch (err) {
        console.error('Shutdown close failed:', err && err.message ? err.message : err);
        finish();
    }
    return true;
}

// SIGTERM (systemd, containers, kill) and SIGINT (Ctrl-C) take the same path
// as /api/restart. A second signal while draining exits immediately.
function handleShutdownSignals(close) {
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
            if (!shuttingDown) {
                console.log(`${signal} received. Shutting down.`);
                shutdown(close);
                return;
            }
            console.log(`${signal} received while shutting down. Exiting now.`);
            terminateAll();
            killPendingNow();
            process.exit(1);
        });
    }
}

module.exports = { handleShutdownSignals, shutdown };
