// exitApplicationHandler.js

/**
 * Handler function to exit the Node.js application.
 * This function should be attached to a specific route in the main server.
 *
 * @openapi
 * /api/restart:
 *   post:
 *     summary: Restart the Node.js application.
 *     description: Interrupts running commands (SIGTERM, then SIGKILL after a short grace period), stops accepting new connections, waits for in-flight responses to drain, then exits. A last-resort process exit applies if draining exceeds RESTART_FORCE_EXIT_MS (default 30000).
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
const { shutdown } = require('../serverModules/shutdown');

const exitApplicationHandler = (close) => (req, res) => {
  console.log('Exit request received. Shutting down.');
  res.json({ message: 'Exiting application...' });
  // Flush the restart response before shutting down.
  setTimeout(() => shutdown(close), 100);
};

module.exports = exitApplicationHandler;
