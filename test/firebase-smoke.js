const assert = require('assert');
const { createFirebaseRepository } = require('../serverModules/firebaseDB');

let initialized = 0;
let added;
const fakeDb = {
    collection(name) {
        assert.strictEqual(name, 'Apps');
        return {
            async add(value) {
                added = value;
                return { id: 'doc-1' };
            },
            doc(id) {
                return {
                    async get() {
                        if (id === 'missing') return { exists: false };
                        return { exists: true, data: () => ({ privateId: 'secret', name: 'Public app' }) };
                    }
                };
            },
            where(field, op, value) {
                assert.deepStrictEqual([field, op, value], ['privateId', '==', 'private-1']);
                return {
                    async get() {
                        return { empty: false, docs: [{ data: () => ({ privateId: 'private-1', name: 'Private app' }) }] };
                    }
                };
            }
        };
    }
};
function firestore() { return fakeDb; }
firestore.FieldValue = { serverTimestamp: () => 'server-time' };
const fakeAdmin = {
    apps: [],
    credential: { cert: (credentials) => ({ credentials }) },
    initializeApp() { initialized += 1; fakeAdmin.apps.push({}); },
    firestore
};

(async () => {
    const disabled = createFirebaseRepository({ adminModule: fakeAdmin, credentials: null });
    assert.strictEqual(disabled.initDB(), false);
    await assert.rejects(() => disabled.getFirebaseAppByPublicId('x'), /Firebase is not configured/);
    console.log('PASS Firebase remains optional without credentials');

    const repository = createFirebaseRepository({ adminModule: fakeAdmin, credentials: { project_id: 'test' } });
    assert.strictEqual(repository.initDB(), true);
    assert.strictEqual(initialized, 1);
    const created = await repository.createAppInFirestore({ name: 'App', description: 'Test' });
    assert.strictEqual(created.id, 'doc-1');
    assert.ok(created.privateId.length >= 20);
    assert.strictEqual(added.createdAt, 'server-time');
    console.log('PASS Firebase create flow works with Firebase Admin v13 contract');

    assert.deepStrictEqual(await repository.getFirebaseAppByPublicId('doc-1'), { name: 'Public app' });
    assert.strictEqual(await repository.getFirebaseAppByPublicId('missing'), null);
    assert.deepStrictEqual(await repository.getFirebaseAppByPrivateId('private-1'), { name: 'Private app' });
    console.log('PASS Firebase public and private lookup behavior is preserved');
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
