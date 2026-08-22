const startServer = require('./serverModules/pluginServer.js');

startServer().catch((error) => {
    console.error('Failed to start server:', error && error.message ? error.message : error);
    if (error && error.stack) console.error(error.stack);
    process.exit(1);
});