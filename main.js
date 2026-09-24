const startServer = require('./serverModules/pluginServer.js');

// Without a handler, a configuration or startup error surfaced as an
// unhandled rejection with a raw stack trace.
startServer().catch((error) => {
    console.error('Failed to start server:', error && error.message ? error.message : error);
    process.exit(1);
});
