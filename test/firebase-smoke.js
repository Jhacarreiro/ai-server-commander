const assert = require('assert');
const { createFirebaseRepository } = require('../serverModules/firebaseDB');

let initialized = 0;
let initOptions;
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

class FakeFirestore {
    constructor(options) {
        initialized += 1;
        initOptions = options;
        return fakeDb;
    }
}

const fakeFieldValue = { serverTimestamp: () => 'server-time' };

(async () => {
    const disabled = createFirebaseRepository({
        FirestoreClass: FakeFirestore,
        fieldValue: fakeFieldValue,
        credentials: null
    });
    assert.strictEqual(disabled.initDB(), false);
    await assert.rejects(() => disabled.getFirebaseAppByPublicId('x'), /Firebase is not configured/);
    console.log('PASS Firestore remains optional without credentials');

    const credentials = {
        project_id: 'test-project',
        client_email: 'service@example.test',
        private_key: 'test-private-key'
    };
    const repository = createFirebaseRepository({
        FirestoreClass: FakeFirestore,
        fieldValue: fakeFieldValue,
        credentials
    });
    assert.strictEqual(repository.initDB(), true);
    assert.strictEqual(initialized, 1);
    assert.deepStrictEqual(initOptions, {
        projectId: 'test-project',
        credentials: {
            client_email: 'service@example.test',
            private_key: 'test-private-key'
        }
    });

    const created = await repository.createAppInFirestore({ name: 'App', description: 'Test' });
    assert.strictEqual(created.id, 'doc-1');
    assert.ok(created.privateId.length >= 20);
    assert.strictEqual(added.createdAt, 'server-time');
    console.log('PASS Firestore create flow works with service-account credentials');

    assert.deepStrictEqual(await repository.getFirebaseAppByPublicId('doc-1'), { name: 'Public app' });
    assert.strictEqual(await repository.getFirebaseAppByPublicId('missing'), null);
    assert.deepStrictEqual(await repository.getFirebaseAppByPrivateId('private-1'), { name: 'Private app' });
    console.log('PASS Firestore public and private lookup behavior is preserved');
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
