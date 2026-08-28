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
    // Upgrade safety: an existing store from before the 0600 fix may still be
    // 0644. Tighten it BEFORE writing so an interruption between write and
    // chmod cannot leave new bearer-token mappings readable under the old mode.
    if (fs.existsSync(tokenStorePath)) {
        try { fs.chmodSync(tokenStorePath, 0o600); } catch (_) {}
    }
    const payload = JSON.stringify(tokenStore, null, 2);
    // Write via an owner-only temporary file and atomic rename so the new
    // contents are never visible under the legacy permissive mode.
    const tmpPath = `${tokenStorePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
        try { fs.chmodSync(tmpPath, 0o600); } catch (_) {}
        fs.renameSync(tmpPath, tokenStorePath);
        try { fs.chmodSync(tokenStorePath, 0o600); } catch (_) {}
    } finally {
        if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
};


module.exports.createToken = (getURL, filePath) => {
    const tokenStore = readTokenStore();
    let token = '';
    let existingTokenFound = false;

    // Check for an existing token for the filePath
    Object.keys(tokenStore).forEach(existingToken => {
        const tokenInfo = tokenStore[existingToken];
        if (tokenInfo.filePath === filePath && new Date(tokenInfo.expiryDate) > new Date()) {
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

    // Filter out expired tokens
    Object.keys(tokenStore).forEach(token => {
        if (new Date(tokenStore[token].expiryDate) < new Date()) {
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
    if (new Date(tokenInfo.expiryDate) < new Date()) {
        return res.status(410).send('Token has expired.');
    }

    if (req.query.diff) {
        // The file may live in a different git repository than the server's own
        // checkout; run the diff from the file's directory.
        const git = simpleGit({ baseDir: path.dirname(tokenInfo.filePath) });
        try {
            const diffOutput = await git.diff(['--', path.basename(tokenInfo.filePath)]);
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
