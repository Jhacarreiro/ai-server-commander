const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-activity-'));
process.env.ACTIVITY_LOG_DIR = tmp;
process.env.MAX_ACTIVITY_CONTEXTS = '3';
process.env.MAX_ACTIVITY_LOG_BYTES = '65536';

const { appendActivity, activityHandler, activityStatusHandler, activityContextHandler, getActivityContext, safeId } = require('../api/activityLog');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

function call(handler, req) {
    const res = { headers: {}, statusCode: 200, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    handler({ method: 'GET', headers: {}, query: {}, body: {}, ...req }, res);
    return res;
}

try {
    // Dot-only identifiers must not escape the conversations directory.
    for (const id of ['.', '..', '...']) {
        const key = safeId(id);
        assert(!/^\.+$/.test(key) && !key.includes('/'), `safeId(${JSON.stringify(id)}) is not a path component`, key);
    }
    const dotContext = getActivityContext({ headers: { 'x-conversation-id': '..' }, query: {}, body: {} });
    appendActivity({ type: 'probe' }, dotContext);
    assert(!fs.existsSync(path.join(tmp, 'activity.jsonl')), 'conversation id ".." does not write into the activity root');

    // Responses no longer disclose server paths.
    const list = call(activityHandler, { query: { scope: 'global' } });
    const status = call(activityStatusHandler, { query: { scope: 'global' } });
    assert(!('logPath' in list.body) && !('statusPath' in list.body) && !('statusPath' in status.body), 'activity responses do not include file paths', JSON.stringify(Object.keys(list.body)));

    // Directories and saved contexts are capped (3 here).
    for (let i = 0; i < 6; i++) {
        appendActivity({ type: 'probe', n: i }, getActivityContext({ headers: { 'x-conversation-id': 'conv-' + i }, query: {}, body: { taskId: 'task-' + i } }));
    }
    const conversations = fs.readdirSync(path.join(tmp, 'conversations'));
    assert(conversations.length <= 3 && conversations.includes('conv-5'), 'conversation directories are capped and keep the newest', JSON.stringify(conversations));
    assert(fs.readdirSync(path.join(tmp, 'tasks')).length <= 3, 'task directories are capped');
    for (let i = 0; i < 5; i++) call(activityContextHandler, { method: 'POST', body: { conversationId: 'ctx-' + i, taskId: 't' } });
    const contexts = JSON.parse(fs.readFileSync(path.join(tmp, 'contexts.json'), 'utf8'));
    assert(Object.keys(contexts.conversations).length <= 3, 'saved contexts are capped', JSON.stringify(Object.keys(contexts.conversations)));

    // A legacy or foreign contexts.json shape no longer breaks every request.
    fs.writeFileSync(path.join(tmp, 'contexts.json'), JSON.stringify({ version: 1 }));
    const legacy = getActivityContext({ headers: { 'x-conversation-id': 'legacy' }, query: {}, body: {} });
    assert(legacy.taskId === 'default', 'contexts.json without conversations is tolerated');

    // Logs rotate at MAX_ACTIVITY_LOG_BYTES and reads only take the tail.
    const big = 'x'.repeat(2000);
    for (let i = 0; i < 80; i++) appendActivity({ type: 'fill', i, big });
    const globalLog = path.join(tmp, 'global.jsonl');
    assert(fs.existsSync(globalLog + '.1') && fs.statSync(globalLog).size < 65536 + 4096, 'global log rotates at MAX_ACTIVITY_LOG_BYTES', String(fs.statSync(globalLog).size));
    const tail = call(activityHandler, { query: { scope: 'global', limit: '5' } });
    assert(tail.body.events.length === 5 && tail.body.events[4].i === 79, 'activity endpoint returns the newest events from the tail', JSON.stringify(tail.body.events.map((e) => e.i)));
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
