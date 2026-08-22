const crypto = require('crypto');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

function loadServiceAccount() {
    try {
        return require('../firebaseAdmin.json');
    } catch (_) {
        return null;
    }
}

function createFirebaseRepository({
    FirestoreClass = Firestore,
    fieldValue = FieldValue,
    credentials = loadServiceAccount()
} = {}) {
    let db = null;

    function initDB() {
        if (!credentials) return false;
        db = new FirestoreClass({
            projectId: credentials.project_id,
            credentials: {
                client_email: credentials.client_email,
                private_key: credentials.private_key
            }
        });
        return true;
    }

    function requireDB() {
        if (!db) throw new Error('Firebase is not configured. Add firebaseAdmin.json and restart the service.');
        return db;
    }

    async function createAppInFirestore(appData) {
        const { name, description, headHtml, bodyHtml } = appData;
        const privateId = crypto.randomBytes(18).toString('base64url');
        const newAppData = {
            privateId,
            name,
            description,
            headHtml: headHtml || '',
            bodyHtml: bodyHtml || '',
            createdAt: fieldValue.serverTimestamp()
        };
        const docRef = await requireDB().collection('Apps').add(newAppData);
        return { id: docRef.id, privateId };
    }

    async function getFirebaseAppByPublicId(publicId) {
        const doc = await requireDB().collection('Apps').doc(publicId).get();
        if (!doc.exists) return null;
        const { privateId, ...publicData } = doc.data();
        return publicData;
    }

    async function getFirebaseAppByPrivateId(id) {
        const querySnapshot = await requireDB().collection('Apps').where('privateId', '==', id).get();
        if (querySnapshot.empty) return null;
        const { privateId, ...publicData } = querySnapshot.docs[0].data();
        return publicData;
    }

    return {
        createAppInFirestore,
        getFirebaseAppByPrivateId,
        getFirebaseAppByPublicId,
        initDB
    };
}

const repository = createFirebaseRepository();

module.exports = {
    createFirebaseRepository,
    createAppInFirestore: repository.createAppInFirestore,
    getFirebaseAppByPrivateId: repository.getFirebaseAppByPrivateId,
    getFirebaseAppByPublicId: repository.getFirebaseAppByPublicId,
    initDB: repository.initDB
};
