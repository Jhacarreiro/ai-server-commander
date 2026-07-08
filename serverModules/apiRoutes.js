const {terminalHandler, interruptHandler} = require('../api/terminal');
const {createNoticeHandler, pendingNoticesHandler, ackNoticeHandler} = require('../api/notices');
const {activityHandler, activityStatusHandler, activityIndexHandler, activityContextHandler} = require('../api/activityLog');
const createMcpHandler = require('../api/mcp');
const { addOAuthRoutes } = require('../api/oauth');

const exitApplicationHandler = require('../api/exitApplicationHandler');
const {initDB} = require("./firebaseDB");

module.exports = {
    addApi: (app, config, getURL, close) => {
        addOAuthRoutes(app, config);
        const mcpHandler = createMcpHandler(config);
        app.all('/mcp', mcpHandler);
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
        app.get('/api/runTerminalScript', terminalHandler);
        app.post('/api/runTerminalScript', terminalHandler);
        app.post('/v1/commands/execute', terminalHandler);
        app.get('/api/server-url', require('../api/getServerUrlHandler')(getURL));
        app.get('/api/logs', require('../api/getLogsHandler'));
        app.get('/api/activity', activityHandler);
        app.get('/api/activity/status', activityStatusHandler);
        app.get('/api/activity/index', activityIndexHandler);
        app.post('/api/activity/context', activityContextHandler);
        app.post('/api/notices', createNoticeHandler);
        app.get('/api/notices/pending', pendingNoticesHandler);
        app.post('/api/notices/:id/ack', ackNoticeHandler);
        app.post('/api/restart', exitApplicationHandler(close));
        app.post("/api/interrupt", interruptHandler);
        app.post('/api/read-or-edit-file', readEditTextFileHandler);
        app.get('/api/read-or-edit-file', readEditTextFileHandler);
    }
};
