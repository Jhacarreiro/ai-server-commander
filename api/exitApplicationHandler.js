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
// Hard exit must land after SIGTERM + the SIGKILL grace, or a command that
// ignores SIGTERM is still running when the process dies.
const RESTART_EXIT_DELAY_MS = RESTART_CLOSE_DELAY_MS + TERMINATE_ALL_ESCALATE_MS + 200;

const exitApplicationHandler = (close) => (req, res) => {
  console.log('Exit request received. Shutting down.');
  res.json({ message: 'Exiting application...' });
  setTimeout(() => {
    // Kill active terminal commands first: detached children would otherwise
    // survive process.exit() and keep running unmanaged after the restart.
    terminateAll();
    close();
  }, RESTART_CLOSE_DELAY_MS);
  setTimeout(() => process.exit(), RESTART_EXIT_DELAY_MS);
};

exitApplicationHandler.RESTART_CLOSE_DELAY_MS = RESTART_CLOSE_DELAY_MS;
exitApplicationHandler.RESTART_EXIT_DELAY_MS = RESTART_EXIT_DELAY_MS;

module.exports = exitApplicationHandler;

