// exitApplicationHandler.js

/**
 * Handler function to exit the Node.js application.
 * This function should be attached to a specific route in the main server.
 *
 * @openapi
 * /api/restart:
 *   post:
 *     summary: Restart the Node.js application.
 *     description: Stops accepting new connections, waits for in-flight responses to drain, then exits. A last-resort process exit applies if drain exceeds RESTART_FORCE_EXIT_MS (default 30000).
 *     operationId: exitApplication
 *     responses:
 *       '200':
 *         description: Application is exiting.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   description: A message indicating that the application is restarting.
 */
function forceExitMs() {
  const parsed = Number(process.env.RESTART_FORCE_EXIT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30000;
}

const exitApplicationHandler = (close) => (req, res) => {
  console.log('Exit request received. Shutting down.');
  res.json({ message: 'Exiting application...' });
  // Flush the restart response, then wait for close() to finish so
  // in-flight requests can drain. process.exit is only a last-resort
  // bound (RESTART_FORCE_EXIT_MS, default 30000) if close never completes.
  setTimeout(() => {
    let exited = false;
    const exitProcess = () => {
      if (exited) return;
      exited = true;
      process.exit();
    };
    const force = setTimeout(exitProcess, forceExitMs());
    const finish = () => {
      clearTimeout(force);
      exitProcess();
    };
    try {
      const maybe = typeof close === 'function' ? close(finish) : undefined;
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(finish, finish);
      }
    } catch (err) {
      console.error('Restart close failed:', err && err.message ? err.message : err);
      finish();
    }
  }, 100);
};

module.exports = exitApplicationHandler;

