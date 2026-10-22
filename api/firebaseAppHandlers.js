const firebaseRepository = require('../serverModules/firebaseDB');

function scriptJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function browserConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const field of ['apiKey', 'projectId', 'appId', 'authDomain', 'storageBucket', 'messagingSenderId', 'measurementId', 'databaseURL']) {
        if (value[field] === undefined) continue;
        if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 2048) return null;
        result[field] = value[field].trim();
    }
    return ['apiKey', 'projectId', 'appId'].every(field => result[field]) ? result : null;
}

function htmlEscape(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function viewAppHandler(req, res, repository) {
    const { public_id } = req.params;
    try {
        const appData = await repository.getFirebaseAppByPublicId(public_id);
        if (!appData) {
            return res.status(404).send('Application not found.');
        }

        // Construct HTML response
        let html = `
<html>
<head>
<title>${htmlEscape(appData.name)}</title>
<meta name="description" content="${htmlEscape(appData.description)}">
`;


        // Insert head HTML content directly
        html += appData.headHtml || '';
        html += `</head><body>`;


        // Body content directly from HTML string
        html += appData.bodyHtml;
        html += `</body></html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error('Error retrieving application:', error);
        res.status(500). send('Internal Server Error');
    }
}

async function editAppHandler(req, res, { repository, webConfig }) {
    const { private_id } = req.params;
    try {
        if (!webConfig) {
            return res.status(503).send('Firebase browser settings are not configured.');
        }
        const appData = await repository.getFirebaseAppByPrivateId(private_id);
        if (!appData) {
            return res.status(404).send('Application not found.');
        }

        // Construct the HTML response
        let html = `
<!DOCTYPE html>
<html>
<head>
    <title>${htmlEscape(appData.name)}</title>
    <meta name="description" content="${htmlEscape(appData.description)}">
<script type="module">
        import { initializeApp } from "https://www.gstatic.com/firebasejs/9.21.0/firebase-app.js";
        import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/9.21.0/firebase-firestore.js";

        const firebaseConfig = ${scriptJson(webConfig)};

        // Initialize Firebase
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);

        // Function to clear previous head HTML
        function clearHeadHtml() {
            const headHtmlElements = document.querySelectorAll('.dynamic-head');
            headHtmlElements.forEach(el => el.remove());
        }

        // Function to add new head HTML
        function addHeadHtml(html) {
            const headWrapper = document.createElement('div');
            headWrapper.classList.add('dynamic-head');
            headWrapper.innerHTML = html;
            document.head.appendChild(headWrapper);
        }

        // Subscribe to changes
        document.addEventListener('DOMContentLoaded', (event) => {
            const privateId = ${scriptJson(String(private_id))};
            const q = query(collection(db, 'Apps'), where('privateId', '==', privateId));
            onSnapshot(q, (querySnapshot) => {
                querySnapshot.forEach((doc) => {
                    const appData = doc.data();
                    document.title = appData.name;
                    document.querySelector('meta[name="description"]').setAttribute("content", appData.description);

                    // Update head HTML
                    clearHeadHtml();
                    addHeadHtml(appData.headHtml);

                    // Update body HTML
                    document.body.innerHTML = '';
                    const offScreenDiv = document.createElement('div');
                    offScreenDiv.style.display = 'none';
                    offScreenDiv.innerHTML = appData.bodyHtml;
                    
                    
                    while (offScreenDiv.firstChild) {
                        const child = offScreenDiv.firstChild;
                        document.body.appendChild(child);
            
                        // If the child is a script, re-create and append it to execute
                        if (child.tagName === 'SCRIPT') {
                            const scriptElement = document.createElement('script');
                            scriptElement.textContent = child.textContent;
                            document.body.appendChild(scriptElement);
                            document.body.removeChild(child); // Remove the old script
                        }
                    }
                });
            });
        });
    </script>
</head>
<body>
    <h1 id="app-name"></h1>
    <p id="app-description"></p>
    <!-- Add more HTML to display or edit the app data -->
</body>
</html>
        `;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error('Error retrieving application:', error);
        res.status(500).send('Internal Server Error');
    }
}

function createFirebaseAppHandlers({ firebaseWebConfig, repository = firebaseRepository } = {}) {
    const webConfig = browserConfig(firebaseWebConfig);
    return {
        viewAppHandler: (req, res) => viewAppHandler(req, res, repository),
        editAppHandler: (req, res) => editAppHandler(req, res, { repository, webConfig })
    };
}

module.exports = { createFirebaseAppHandlers };