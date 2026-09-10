const express = require('express');
const http = require('http');
const path = require('path');
const socketSetup = require('./socketSetup');
const { configPromise } = require('./configHandler');
const { openapiSpecification, setURL } = require('./swaggerSetup');
const {addApi} = require("./apiRoutes");
const {log, getLog} = require("./logger");
const {initDB} = require("./firebaseDB");
const fs = require('fs');
const marked = require('marked');
const { MAX_SCRIPT_BODY_BYTES } = require('./commandExecutor');

module.exports = async () => {
    log('start');
    initDB();
    const config = await configPromise;
    log('got config', {
        port: config.port,
        productionDomain: config.productionDomain,
        hasAuthToken: Boolean(config.authToken),
        hasMcpToken: Boolean(config.mcpToken)
    });
    const expressApp = express();
    const server = http.createServer(expressApp);
    expressApp.use(express.json({ limit: MAX_SCRIPT_BODY_BYTES }));
    expressApp.use(express.urlencoded({ extended: false, limit: MAX_SCRIPT_BODY_BYTES }));

    log('serving static from', path.join(__dirname, '..', 'public'));
    expressApp.use(express.static(path.join(__dirname, '..', 'public')));

// CORS preflight handling. Browsers send OPTIONS without credentials, so this
// must run BEFORE the auth middleware; otherwise every browser call to /api/*
// dies on a 401 preflight (the handler-level setCors/OPTIONS branches are
// unreachable because Express auto-answers OPTIONS without invoking handlers).
// Only actual preflights (Origin + Access-Control-Request-Method present) are
// answered here; any other OPTIONS request falls through so auth and Express's
// automatic Allow handling keep their previous behavior.
expressApp.use((req, res, next) => {
    if (req.method !== 'OPTIONS' || !req.headers.origin || !req.headers['access-control-request-method']) return next();
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id, x-conversation-id');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    return res.sendStatus(204);
});

// Render README.md at the root route ('/')


openapiSpecification(expressApp);
    const {viewAppHandler, editAppHandler} = require('../api/firebaseAppHandlers');
    expressApp.get('/api/apps/view/:public_id', viewAppHandler);
    expressApp.get('/api/apps/edit/:private_id', editAppHandler);
    expressApp.get('/access/:token', require('./fileAccessHandler').retrieveFile);

    expressApp.get('/', (req, res) => {
        const readmePath = path.join(__dirname, '..', 'README.md');
        fs.readFile(readmePath, 'utf8', (err, data) => {
            if (err) {
                res.status(500).send('Error reading README.md');
                return;
            }
const htmlContent = marked.parse(data);
            res.send(`<html><body>${htmlContent}</body></html>`);  // Send HTML response
        });
    });

    expressApp.use(require('./auth.js')(log, config));

    const serverUrl = config.productionDomain;
    // Canonical listener-close for /api/restart: stop accepts, drop idle
    // keep-alives, and invoke the handler callback only after in-flight
    // responses drain. Active command-process cleanup is a separate path.
    addApi(expressApp, config, () => serverUrl, (done) => {
        if (typeof server.closeIdleConnections === 'function') {
            server.closeIdleConnections();
        }
        server.close(typeof done === 'function' ? done : undefined);
    });

    expressApp.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        console.error(err.stack || err.message);
        const status = err.type === 'entity.too.large' ? 413 : (err.status || 500);
        const message = status === 413 ? 'Request body too large.' : status === 400 ? 'Invalid request body.' : 'Internal server error.';
        return res.status(status).json({ error: message });
    });

    server.on('error', (error) => {
        // EADDRINUSE / EACCES on the listen socket previously crashed with
        // an unhandled 'error' event and a raw Node stack - no mention of
        // the port or the likely cause.
        if (error && error.code === 'EADDRINUSE') {
            console.error('Failed to start: port ' + config.port + ' is already in use. Stop the other process or change the port in config.');
            process.exit(1);
        }
        if (error && error.code === 'EACCES') {
            console.error('Failed to start: permission denied binding port ' + config.port + ' (privileged ports need root).');
            process.exit(1);
        }
        console.error('Failed to start server:', error && error.message ? error.message : error);
        process.exit(1);
    });
    server.listen(config.port, () => {
        log('Server running on http://localhost:' + config.port);
        setURL(serverUrl);
    });
    return server;
};
