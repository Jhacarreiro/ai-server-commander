// exitApplicationHandler.js

/**
 * Handler function to exit the Node.js application.
 * This function should be attached to a specific route in the main server.
 *
 * @openapi
 * /api/restart:
 *   post:
 *     summary: Restart the Node.js application.
 *     description: This endpoint allows for the controlled restart of the server application upon request.
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
const { terminateAll, TERMINATE_ALL_ESCALATE_MS } = require('../serverModules/commandExecutor');

const RESTART_CLOSE_DELAY_MS = 100;
// Last-resort bound if SIGKILL escalation never settles. Must stay strictly
// after TERMINATE_ALL_ESCALATE_MS so trapped children can be killed first.
const RESTART_FORCE_EXIT_MS = TERMINATE_ALL_ESCALATE_MS + 200;
const RESTART_EXIT_DELAY_MS = RESTART_CLOSE_DELAY_MS + RESTART_FORCE_EXIT_MS;

const exitApplicationHandler = (close) => (req, res) => {
  console.log('Exit request received. Shutting down.');
  res.json({ message: 'Exiting application...' });
  setTimeout(() => {
    let exited = false;
    const exitProcess = () => {
      if (exited) return;
      exited = true;
      process.exit();
    };
    const force = setTimeout(exitProcess, RESTART_FORCE_EXIT_MS);
    const finish = () => {
      clearTimeout(force);
      exitProcess();
    };
    // SIGTERM first, then wait for the SIGKILL grace instead of a fixed 500 ms.
    const done = Promise.resolve(terminateAll());
    try {
      if (typeof close === 'function') close();
    } catch (err) {
      console.error('Restart close failed:', err && err.message ? err.message : err);
    }
    done.then(finish, finish);
  }, RESTART_CLOSE_DELAY_MS);
};

exitApplicationHandler.RESTART_CLOSE_DELAY_MS = RESTART_CLOSE_DELAY_MS;
exitApplicationHandler.RESTART_EXIT_DELAY_MS = RESTART_EXIT_DELAY_MS;

module.exports = exitApplicationHandler;

