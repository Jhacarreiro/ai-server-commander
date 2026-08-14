const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {log} = require("../serverModules/logger");
const simpleGit = require("simple-git");

const tokenStorePath = path.join(__dirname, "../tokenStore.json");

// Function to read the token store
const readTokenStore = () => {
    if (fs.existsSync(tokenStorePath)) {
        return JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
    }
    return {};
};

// Function to write to the token store
const writeToTokenStore = (tokenStore) => {
    fs.writeFileSync(tokenStorePath, JSON.stringify(tokenStore, null, 2), "utf8");
};

// A token whose expiryDate is missing or unparseable must FAIL CLOSED
// (treated as expired). new Date(garbage) is Invalid Date, and every
// comparison against Invalid Date is false - a corrupt store entry would
// otherwise be served forever with no expiry.
function isExpired(tokenInfo, now = new Date()) {
    const expiry = new Date(tokenInfo && tokenInfo.expiryDate);
    return !(expiry instanceof Date) || Number.isNaN(expiry.getTime()) || expiry < now;
}


module.exports.createToken = (getURL, filePath) => {
    const tokenStore = readTokenStore();
    let token = '';
    let existingTokenFound = false;

    // Check for an existing token for the filePath.
    // Guard malformed (null/non-object) entries before reading filePath so
    // createToken can still clean them up instead of throwing.
    Object.keys(tokenStore).forEach(existingToken => {
        const tokenInfo = tokenStore[existingToken];
        if (!tokenInfo || typeof tokenInfo !== 'object') {
            return;
        }
        if (tokenInfo.filePath === filePath && !isExpired(tokenInfo)) {
            // Extend the existing token's expiry date
            tokenInfo.expiryDate = new Date(new Date().getTime() + 600000);
            token = existingToken;
            existingTokenFound = true;
        }
    });

    if (!existingTokenFound) {
        // Create a new token if none exists for the filePath
        token = crypto.randomBytes(20).toString('hex');
        tokenStore[token] = { filePath, expiryDate: new Date(new Date().getTime() + 600000) };
    }

    // Filter out expired tokens (fail-closed on corrupt entries)
    Object.keys(tokenStore).forEach(token => {
        if (isExpired(tokenStore[token])) {
            delete tokenStore[token];
        }
    });

    writeToTokenStore(tokenStore);

    const serverUrl = getURL(); // Gets the base server URL
    const accessUrl = `${serverUrl}/access/${token}`; // Constructs the file access URL
    log('created url', serverUrl);
    return  accessUrl;
};

module.exports.retrieveFile = async (req, res) => {
    const { token } = req.params; // Assume the token is passed as a URL parameter
    const tokenStore = readTokenStore();

    if (!tokenStore[token]) {
        return res.status(404).send('Token not found or has expired.');
    }

    const tokenInfo = tokenStore[token];
    if (isExpired(tokenInfo)) {
        return res.status(410).send('Token has expired.');
    }

    if (req.query.diff) {
        const git = simpleGit();
        try {
            const diffOutput = await git.diff(['--', tokenInfo.filePath]);
            const htmlDiff = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Git Diff</title>
                    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css" />
                    <script src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html.min.js"></script>
                </head>
                <body>
                    <div id="diff"></div>
                    <script>
                        document.addEventListener('DOMContentLoaded', function () {
                            const diffHtml = Diff2Html.html(atob('${Buffer.from(diffOutput).toString('base64')}'), {inputFormat: 'diff', showFiles: true, matching: 'lines'});
                            document.getElementById('diff').innerHTML = diffHtml;
                        });
                    </script>
                </body>
                </html>
                `;

            res.send(htmlDiff);
        } catch (error) {
            log('Error fetching Git diff:', error);
            res.status(500).send('Error fetching Git diff: ' + error.message);
        }
    } else {
        fs.readFile(tokenInfo.filePath, 'utf8', (err, data) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Failed to read the file.');
            }
            res.setHeader('Content-Type', 'text/plain');
            res.send(data);
        });
    }
};
