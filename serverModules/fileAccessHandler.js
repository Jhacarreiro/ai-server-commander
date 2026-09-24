const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {log} = require("../serverModules/logger");
const { redactPaths } = require("./stringifyError");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const tokenStorePath = path.join(__dirname, "../tokenStore.json");
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_ACCESS_FILE_BYTES = Math.max(1024, Number.parseInt(process.env.MAX_ACCESS_FILE_BYTES || String(8 * 1024 * 1024), 10) || 8 * 1024 * 1024);
const MAX_TOKEN_STORE_ENTRIES = Math.max(16, Number.parseInt(process.env.MAX_TOKEN_STORE_ENTRIES || "500", 10) || 500);

// A missing or unparseable expiry must count as expired: every comparison
// against an Invalid Date is false, so such an entry would never expire.
function isExpired(tokenInfo, now = Date.now()) {
    const expiry = new Date(tokenInfo && tokenInfo.expiryDate).getTime();
    return !Number.isFinite(expiry) || expiry < now;
}

// Function to read the token store. Unreadable files and malformed entries
// (legacy or corrupt shapes) are dropped instead of crashing every request;
// dropping a token only revokes a short-lived share link.
const readTokenStore = () => {
    if (!fs.existsSync(tokenStorePath)) return {};
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
    } catch (err) {
        log("tokenStore.json unreadable; starting with an empty store:", err && err.message ? err.message : err);
        return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store = {};
    for (const [token, info] of Object.entries(parsed)) {
        if (info && typeof info === "object" && typeof info.filePath === "string") store[token] = info;
    }
    return store;
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
        const fd = fs.openSync(tmpPath, "r+");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmpPath, tokenStorePath);
        try { fs.chmodSync(tokenStorePath, 0o600); } catch (_) {}
    } finally {
        if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
};


module.exports.createToken = (getURL, filePath) => {
    const tokenStore = readTokenStore();

    // Rotate: revoke earlier tokens for this file and mint a fresh one.
    // Reusing and extending the old token kept a leaked link valid for as
    // long as the file kept being edited.
    for (const [existingToken, tokenInfo] of Object.entries(tokenStore)) {
        if (tokenInfo.filePath === filePath || isExpired(tokenInfo)) delete tokenStore[existingToken];
    }

    const token = crypto.randomBytes(20).toString('hex');
    tokenStore[token] = { filePath, expiryDate: new Date(Date.now() + TOKEN_TTL_MS) };

    // Bound the store: drop the tokens closest to expiry first.
    const entries = Object.entries(tokenStore);
    if (entries.length > MAX_TOKEN_STORE_ENTRIES) {
        entries
            .sort((a, b) => new Date(a[1].expiryDate) - new Date(b[1].expiryDate))
            .slice(0, entries.length - MAX_TOKEN_STORE_ENTRIES)
            .forEach(([oldToken]) => { delete tokenStore[oldToken]; });
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
    if (isExpired(tokenInfo)) {
        return res.status(410).send('Token has expired.');
    }

    if (req.query.diff) {
        // Refuse oversized files before any git work. A missing file is fine:
        // the diff can still show a tracked deletion.
        try {
            const earlyStat = fs.lstatSync(tokenInfo.filePath);
            if (earlyStat.isFile() && earlyStat.size > MAX_ACCESS_FILE_BYTES) {
                return res.status(500).send('Error fetching Git diff: Target file is too large to diff safely.');
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(err);
                return res.status(500).send('Failed to read the file.');
            }
        }
        try {
            // Treat the target repository as data, not executable configuration.
            // Git plumbing only locates/reads the stage-0 blob. The actual comparison
            // runs as `git diff --no-index` in a private temporary directory with no
            // repository, no system/global config, and executable diff/textconv paths
            // disabled. Repository-local attributes/filters/hooks are therefore never
            // consulted while producing the displayed diff.
            const targetDir = path.dirname(tokenInfo.filePath);
            const gitOptions = {
                cwd: targetDir,
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
                timeout: 5000
            };
            const { stdout: rootOutput } = await execFileAsync(
                'git',
                ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
                gitOptions
            );
            const repoRoot = rootOutput.trim();
            const relativePath = path.relative(repoRoot, tokenInfo.filePath).split(path.sep).join('/');
            if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
                throw new Error('Target file is not inside its Git repository.');
            }

            const { stdout: stagedOutput } = await execFileAsync(
                'git',
                ['-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z', '--', `:(literal)${relativePath}`],
                { ...gitOptions, cwd: repoRoot }
            );
            const stagedLines = stagedOutput.split('\0').filter(Boolean);
            let diffOutput = '';
            if (stagedLines.length > 0) {
                const stageZero = stagedLines.find((line) => {
                    const tab = line.indexOf('\t');
                    return tab > 0
                        && /^\d+\s+[0-9a-f]+\s+0$/.test(line.slice(0, tab))
                        && line.slice(tab + 1) === relativePath;
                });
                if (!stageZero) {
                    throw new Error('Target file has no stage-0 index entry.');
                }
                const match = stageZero.match(/^(\d+)\s+([0-9a-f]+)\s+0\t/);
                if (!match) {
                    throw new Error('Could not parse target index entry.');
                }
                const indexMode = match[1];
                const indexHash = match[2];

                const { stdout: indexSizeOutput } = await execFileAsync(
                    'git',
                    ['-c', 'core.fsmonitor=false', 'cat-file', '-s', indexHash],
                    { ...gitOptions, cwd: repoRoot }
                );
                const indexSize = Number.parseInt(indexSizeOutput.trim(), 10);
                if (!Number.isSafeInteger(indexSize) || indexSize < 0 || indexSize > MAX_ACCESS_FILE_BYTES) {
                    throw new Error('Target file is too large to diff safely.');
                }
                const { stdout: indexBlob } = await execFileAsync(
                    'git',
                    ['-c', 'core.fsmonitor=false', 'cat-file', 'blob', indexHash],
                    { ...gitOptions, cwd: repoRoot, encoding: null }
                );

                let currentStat = null;
                try {
                    currentStat = fs.lstatSync(tokenInfo.filePath);
                } catch (error) {
                    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
                }
                const currentExists = currentStat !== null;
                let currentBlob = Buffer.alloc(0);
                let currentMode = null;
                if (currentStat) {
                    if (currentStat.isSymbolicLink()) {
                        currentBlob = Buffer.from(fs.readlinkSync(tokenInfo.filePath));
                        currentMode = '120000';
                    } else {
                        if (!currentStat.isFile()) {
                            throw new Error('Target path is not a regular file or symlink.');
                        }
                        if (currentStat.size > MAX_ACCESS_FILE_BYTES) {
                            throw new Error('Target file is too large to diff safely.');
                        }
                        currentBlob = fs.readFileSync(tokenInfo.filePath);
                        currentMode = (currentStat.mode & 0o111) ? '100755' : '100644';
                    }
                }

                if (currentBlob.length > MAX_ACCESS_FILE_BYTES) {
                    throw new Error('Target file is too large to diff safely.');
                }

                const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-diff-'));
                try {
                    const beforePath = path.join(tmpDir, 'before');
                    const afterPath = path.join(tmpDir, 'after');
                    const emptyConfigPath = path.join(tmpDir, 'empty-gitconfig');
                    fs.writeFileSync(beforePath, indexBlob, { mode: 0o600 });
                    fs.writeFileSync(afterPath, currentBlob, { mode: 0o600 });
                    fs.writeFileSync(emptyConfigPath, '', { mode: 0o600 });

                    const safeLabel = relativePath.replace(/[\r\n\t]/g, '_');
                    const diffEnv = {
                        ...process.env,
                        GIT_CONFIG_NOSYSTEM: '1',
                        GIT_CONFIG_GLOBAL: emptyConfigPath,
                        GIT_PAGER: 'cat',
                        GIT_OPTIONAL_LOCKS: '0'
                    };
                    let body = '';
                    try {
                        const result = await execFileAsync(
                            'git',
                            ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'],
                            {
                                cwd: tmpDir,
                                env: diffEnv,
                                encoding: 'utf8',
                                maxBuffer: 16 * 1024 * 1024,
                                timeout: 5000
                            }
                        );
                        body = result.stdout;
                    } catch (error) {
                        if (error.code === 1 && typeof error.stdout === 'string') {
                            body = error.stdout;
                        } else {
                            throw error;
                        }
                    }

                    if (body) {
                        body = body
                            .replace(/^diff --git a\/before b\/after$/m, `diff --git a/${safeLabel} b/${safeLabel}`)
                            .replace(/^--- a\/before$/m, `--- a/${safeLabel}`)
                            .replace(/^\+\+\+ b\/after$/m, currentExists ? `+++ b/${safeLabel}` : '+++ /dev/null')
                            .replace(
                                /^Binary files (?:a\/)?before and (?:b\/)?after differ$/m,
                                currentExists
                                    ? `Binary files a/${safeLabel} and b/${safeLabel} differ`
                                    : `Binary files a/${safeLabel} and /dev/null differ`
                            );
                    }

                    const header = `diff --git a/${safeLabel} b/${safeLabel}`;
                    const metadata = [];
                    if (!currentExists) {
                        metadata.push(`deleted file mode ${indexMode}`);
                    } else if (currentMode && indexMode !== currentMode) {
                        metadata.push(`old mode ${indexMode}`, `new mode ${currentMode}`);
                    }

                    if (!body && metadata.length > 0) {
                        body = `${header}\n${metadata.join('\n')}\n`;
                    } else if (body && metadata.length > 0) {
                        const lines = body.split('\n');
                        if (lines[0] === header) {
                            lines.splice(1, 0, ...metadata);
                            body = lines.join('\n');
                        } else {
                            body = `${header}\n${metadata.join('\n')}\n${body}`;
                        }
                    }
                    diffOutput = body;
                } finally {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                }
            }
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
            res.status(500).send('Error fetching Git diff: ' + redactPaths(error.message));
        }
    } else {
        // Read through one descriptor so the size check and the read see the
        // same file, and never load an arbitrarily large file into memory.
        let fd;
        try {
            fd = fs.openSync(tokenInfo.filePath, 'r');
        } catch (err) {
            console.error(err);
            return res.status(500).send('Failed to read the file.');
        }
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) return res.status(400).send('Token target is not a regular file.');
            if (stat.size > MAX_ACCESS_FILE_BYTES) {
                return res.status(413).send('File exceeds MAX_ACCESS_FILE_BYTES (' + MAX_ACCESS_FILE_BYTES + ').');
            }
            const data = fs.readFileSync(fd, 'utf8');
            res.setHeader('Content-Type', 'text/plain');
            res.send(data);
        } catch (err) {
            console.error(err);
            res.status(500).send('Failed to read the file.');
        } finally {
            fs.closeSync(fd);
        }
    }
};
