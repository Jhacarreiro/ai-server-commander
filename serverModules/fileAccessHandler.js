const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {log} = require("../serverModules/logger");
const simpleGit = require("simple-git");

const tokenStorePath = path.join(__dirname, "../tokenStore.json");
const MAX_ACCESS_FILE_BYTES = Math.max(
    1024,
    Number.parseInt(process.env.MAX_ACCESS_FILE_BYTES || String(2 * 1024 * 1024), 10) || (2 * 1024 * 1024)
);
const MAX_TOKEN_STORE_ENTRIES = Math.max(
    16,
    Number.parseInt(process.env.MAX_TOKEN_STORE_ENTRIES || '500', 10) || 500
);

// Function to read the token store
const readTokenStore = () => {
    if (!fs.existsSync(tokenStorePath)) return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
        log("tokenStore.json unreadable; starting empty store:", err && err.message ? err.message : err);
        return {};
    }
};

// Function to write to the token store
// Atomic tmp+rename+fsync: a torn write must not silently revoke every
// outstanding share URL (bare writeFileSync can corrupt the file on crash).
const writeToTokenStore = (tokenStore) => {
    const tmpPath = tokenStorePath + ".tmp-" + process.pid + "-" + Date.now();
    const payload = JSON.stringify(tokenStore, null, 2);
    let fd = null;
    try {
        fd = fs.openSync(tmpPath, "w", 0o600);
        fs.writeFileSync(fd, payload, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmpPath, tokenStorePath);
        fs.chmodSync(tokenStorePath, 0o600);
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
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

    // Cap store growth (oldest expiry first) so tokenStore.json cannot grow without bound.
    const entries = Object.entries(tokenStore);
    if (entries.length > MAX_TOKEN_STORE_ENTRIES) {
        entries
            .sort((a, b) => new Date(a[1].expiryDate) - new Date(b[1].expiryDate))
            .slice(0, entries.length - MAX_TOKEN_STORE_ENTRIES)
            .forEach(([tok]) => { delete tokenStore[tok]; });
    }

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
        let st;
        try {
            st = fs.statSync(tokenInfo.filePath);
        } catch (err) {
            console.error(err);
            return res.status(500).send('Failed to read the file.');
        }
        if (!st.isFile()) {
            return res.status(400).send('Token target is not a regular file.');
        }
        if (st.size > MAX_ACCESS_FILE_BYTES) {
            return res.status(413).send(
                'File exceeds MAX_ACCESS_FILE_BYTES (' + MAX_ACCESS_FILE_BYTES + ').'
            );
        }
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
