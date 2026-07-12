const crypto = require('crypto');
const admin = require('firebase-admin');

function loadServiceAccount() {
    try {
        return require('../firebaseAdmin.json');
    } catch (_) {
        return null;
    }
}

function createFirebaseRepository({ adminModule = admin, credentials = loadServiceAccount() } = {}) {
    let db = null;

    function initDB() {
        if (!credentials) return false;
        if (!Array.isArray(adminModule.apps) || adminModule.apps.length === 0) {
            adminModule.initializeApp({ credential: adminModule.credential.cert(credentials) });
        }
        db = adminModule.firestore();
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
            createdAt: adminModule.firestore.FieldValue.serverTimestamp()
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
