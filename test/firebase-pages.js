const assert = require('node:assert/strict');
const { createFirebaseAppHandlers } = require('../api/firebaseAppHandlers');

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        setHeader() {},
        send(body) { this.body = body; return this; }
    };
}

(async () => {
    let privateReads = 0;
    const repository = {
        async getFirebaseAppByPublicId(id) {
            return id === 'missing' ? null : { name: '<Public app>', description: 'A "description"', bodyHtml: '<p>Public body</p>' };
        },
        async getFirebaseAppByPrivateId(id) {
            privateReads++;
            return id === 'missing' ? null : { name: '<Private app>', description: 'Private description' };
        }
    };
    for (const firebaseWebConfig of [undefined, null, [], {}, { apiKey: 'web-key', projectId: 'example-project' },
        { apiKey: 123, projectId: 'example-project', appId: 'example-app' }]) {
        const handlers = createFirebaseAppHandlers({ repository, firebaseWebConfig });
        const res = response();
        await handlers.editAppHandler({ params: { private_id: 'existing' } }, res);
        assert.equal(res.statusCode, 503);
        assert(!res.body.includes('firebaseConfig'));
        const view = response();
        await handlers.viewAppHandler({ params: { public_id: 'existing' } }, view);
        assert.equal(view.statusCode, 200);
        assert(view.body.includes('&lt;Public app&gt;') && view.body.includes('<p>Public body</p>'));
    }
    assert.equal(privateReads, 0, 'Disabled browser integration must not query an implicit project');

    const firebaseWebConfig = {
        apiKey: 'example-web-key', projectId: 'example-project', appId: 'example-app',
        authDomain: 'example-project.firebaseapp.com', measurementId: '</script><script>unexpected()</script>',
        private_key: 'must-never-reach-browser', client_email: 'private@example.invalid'
    };
    const handlers = createFirebaseAppHandlers({ repository, firebaseWebConfig });
    const privateId = '</script><script>unexpectedId()</script>';
    const edit = response();
    await handlers.editAppHandler({ params: { private_id: privateId } }, edit);
    assert.equal(edit.statusCode, 200);
    assert(!edit.body.includes('must-never-reach-browser') && !edit.body.includes('private@example.invalid'));
    assert(!edit.body.includes('</script><script>'));
    assert.equal((edit.body.match(/<script\b/g) || []).length, 1);
    const settings = JSON.parse(edit.body.match(/const firebaseConfig = (.+);/)[1]);
    assert.equal(settings.projectId, 'example-project');
    assert.equal(settings.apiKey, 'example-web-key');
    assert.equal(settings.measurementId, firebaseWebConfig.measurementId);
    assert.equal(JSON.parse(edit.body.match(/const privateId = (.+);/)[1]), privateId);

    for (const [handler, parameter] of [['viewAppHandler', 'public_id'], ['editAppHandler', 'private_id']]) {
        const missing = response();
        await handlers[handler]({ params: { [parameter]: 'missing' } }, missing);
        assert.equal(missing.statusCode, 404);
    }
    console.log('PASS Firebase pages use explicit browser settings, preserve public views and safely embed configured data');
})().catch(error => { console.error(error); process.exitCode = 1; });
