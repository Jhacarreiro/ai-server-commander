const {terminalHandler, interruptHandler} = require('../api/terminal');
const {createNoticeHandler, pendingNoticesHandler, ackNoticeHandler} = require('../api/notices');
const {activityHandler, activityStatusHandler, activityIndexHandler, activityContextHandler} = require('../api/activityLog');
const createMcpHandler = require('../api/mcp');
const { addOAuthRoutes } = require('../api/oauth');

const exitApplicationHandler = require('../api/exitApplicationHandler');
const {initDB} = require("./firebaseDB");

const wrapAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
    addApi: (app, config, getURL, close) => {
        addOAuthRoutes(app, config);
        const mcpHandler = createMcpHandler(config);
        app.all('/mcp', wrapAsync(mcpHandler));
        app.use((req, res, next) => {
            const originalSend = res.send;
            const queryKeys = req.query && typeof req.query === 'object' ? Object.keys(req.query) : [];
            const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];

            console.log('Request:', {
                method: req.method,
                path: req.path,
                queryKeys,
                bodyKeys
            });

            res.send = function(data) {
                const responseSize = Buffer.isBuffer(data)
                    ? data.length
                    : Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data ?? null));
                console.log('Response:', {
                    method: req.method,
                    path: req.path,
                    statusCode: res.statusCode,
                    type: Buffer.isBuffer(data) ? 'buffer' : typeof data,
                    bytes: responseSize
                });
                originalSend.call(this, data);
            };

            next();
        });
        const readEditTextFileHandler = require('../api/readEditTextFile2Handler')(getURL);
        app.get('/api/runTerminalScript', wrapAsync(terminalHandler));
        app.post('/api/runTerminalScript', wrapAsync(terminalHandler));
        app.post('/v1/commands/execute', wrapAsync(terminalHandler));
        app.get('/api/server-url', wrapAsync(require('../api/getServerUrlHandler')(getURL)));
        app.get('/api/logs', wrapAsync(require('../api/getLogsHandler')));
        app.get('/api/activity', wrapAsync(activityHandler));
        app.get('/api/activity/status', wrapAsync(activityStatusHandler));
        app.get('/api/activity/index', wrapAsync(activityIndexHandler));
        app.post('/api/activity/context', wrapAsync(activityContextHandler));
        app.post('/api/notices', wrapAsync(createNoticeHandler));
        app.get('/api/notices/pending', wrapAsync(pendingNoticesHandler));
        app.post('/api/notices/:id/ack', wrapAsync(ackNoticeHandler));
        app.post('/api/restart', wrapAsync(exitApplicationHandler(close)));
        app.post("/api/interrupt", wrapAsync(interruptHandler));
        app.post('/api/read-or-edit-file', wrapAsync(readEditTextFileHandler));
        app.get('/api/read-or-edit-file', wrapAsync(readEditTextFileHandler));
    }
};
