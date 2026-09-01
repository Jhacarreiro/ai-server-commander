const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {log} = require("../serverModules/logger");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

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
        // Legacy/corrupt non-object entries (e.g. null) would crash the
        // scan and 500 every file-edit request AFTER the edit was applied.
        if (tokenInfo && typeof tokenInfo === 'object' && tokenInfo.filePath === filePath && new Date(tokenInfo.expiryDate) > new Date()) {
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

    // Filter out expired tokens (skip legacy/corrupt non-object entries)
    Object.keys(tokenStore).forEach(token => {
        const entry = tokenStore[token];
        if (entry && typeof entry === 'object' && new Date(entry.expiryDate) < new Date()) {
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
                if (!Number.isSafeInteger(indexSize) || indexSize < 0 || indexSize > 8 * 1024 * 1024) {
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
                        if (currentStat.size > 8 * 1024 * 1024) {
                            throw new Error('Target file is too large to diff safely.');
                        }
                        currentBlob = fs.readFileSync(tokenInfo.filePath);
                        currentMode = (currentStat.mode & 0o111) ? '100755' : '100644';
                    }
                }

                if (currentBlob.length > 8 * 1024 * 1024) {
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
