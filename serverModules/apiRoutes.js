const {terminalHandler, interruptHandler} = require('../api/terminal');
const {createNoticeHandler, pendingNoticesHandler, ackNoticeHandler} = require('../api/notices');
const {activityHandler, activityStatusHandler, activityIndexHandler, activityContextHandler} = require('../api/activityLog');
const createMcpHandler = require('../api/mcp');

//const createAppHandlerWithUrl = require('../api/firebase'); // Modify import to pass getURL function
const exitApplicationHandler = require('../api/exitApplicationHandler');
const {initDB} = require("./firebaseDB");

module.exports = {
    addApi: (app, config, getURL, close) => {
        const mcpHandler = createMcpHandler(config);
        app.all('/mcp', mcpHandler);
        // Logging middleware to log request and response details
        app.use((req, res, next) => {
            const originalSend = res.send;
            console.log(`Request to ${req.path}:`);
            console.log('Query Params:', req.query);
            console.log('Body:', req.body);

            res.send = function(data) {
                console.log(`Response from ${req.path}:`);
                console.log('Response:', data);
                originalSend.call(this, data);
            };

            next();
        });
        const readEditTextFileHandler = require('../api/readEditTextFile2Handler')(getURL);
        app.get('/api/runTerminalScript', terminalHandler);
        app.post('/api/runTerminalScript', terminalHandler);
        /*const createAppHandler = createAppHandlerWithUrl(getURL);
        app.route('/api/apps')
              .post(createAppHandler)
              .get(createAppHandler); // Add support for GET requests*/
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
        // Add new routes for Firebase applications
    }
};