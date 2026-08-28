const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { retrieveFile } = require('../serverModules/fileAccessHandler');

const root = path.resolve(__dirname, '..');
const storePath = path.join(root, 'tokenStore.json');

(async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-file-diff-'));
    const originalStore = fs.existsSync(storePath)
        ? { data: fs.readFileSync(storePath), mode: fs.statSync(storePath).mode & 0o777 }
        : null;

    try {
        execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
        execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tmpRepo });
        execFileSync('git', ['config', 'user.name', 'ASC Test'], { cwd: tmpRepo });

        const filePath = path.join(tmpRepo, 'example.txt');
        fs.writeFileSync(filePath, 'before\n');
        execFileSync('git', ['add', 'example.txt'], { cwd: tmpRepo });
        execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: tmpRepo });

        const markerPath = path.join(tmpRepo, 'helper-ran.marker');
        const helperPath = path.join(tmpRepo, 'evil-diff-helper.sh');
        fs.writeFileSync(
            helperPath,
            `#!/bin/sh\nprintf helper-ran > ${JSON.stringify(markerPath)}\ncat "$1"\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(tmpRepo, '.gitattributes'), 'example.txt diff=evil filter=evil\n');
        execFileSync('git', ['add', '.gitattributes'], { cwd: tmpRepo });
        execFileSync('git', ['commit', '-q', '-m', 'add diff attributes'], { cwd: tmpRepo });
        execFileSync('git', ['config', 'diff.external', helperPath], { cwd: tmpRepo });
        execFileSync('git', ['config', 'diff.evil.textconv', helperPath], { cwd: tmpRepo });
        execFileSync('git', ['config', 'core.fsmonitor', helperPath], { cwd: tmpRepo });
        execFileSync('git', ['config', 'filter.evil.clean', helperPath], { cwd: tmpRepo });
        execFileSync('git', ['config', 'filter.evil.process', helperPath], { cwd: tmpRepo });

        fs.writeFileSync(filePath, 'after\n');

        const token = 'test-token';
        const tokenStore = {
            [token]: {
                filePath,
                expiryDate: new Date(Date.now() + 60_000).toISOString()
            }
        };
        fs.writeFileSync(storePath, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });

        const req = { params: { token }, query: { diff: '1' } };
        const res = {
            statusCode: 200,
            body: '',
            status(code) {
                this.statusCode = code;
                return this;
            },
            send(body) {
                this.body = String(body);
                return this;
            },
            setHeader() {}
        };

        await retrieveFile(req, res);
        assert.strictEqual(res.statusCode, 200, 'diff request should succeed outside the server checkout');

        const match = res.body.match(/atob\('([^']+)'\)/);
        assert.ok(match, 'response should embed a base64 git diff');
        const diff = Buffer.from(match[1], 'base64').toString('utf8');
        assert.match(diff, /diff --git a\/example\.txt b\/example\.txt/);
        assert.match(diff, /\+after/);
        assert.match(diff, /-before/);
        assert.strictEqual(
            fs.existsSync(markerPath),
            false,
            'target repository diff helpers must not execute'
        );
        console.log('PASS /access diff runs in the target repo without executing repo-controlled helpers');

        const deletedPath = path.join(tmpRepo, 'tracked-deleted.txt');
        fs.writeFileSync(deletedPath, 'tracked before deletion\n');
        execFileSync('git', ['-c', 'core.fsmonitor=false', 'add', 'tracked-deleted.txt'], { cwd: tmpRepo });
        execFileSync('git', ['-c', 'core.fsmonitor=false', 'commit', '-q', '-m', 'add tracked deletion fixture'], { cwd: tmpRepo });
        fs.unlinkSync(deletedPath);
        const deletedToken = 'tracked-deleted-token';
        tokenStore[deletedToken] = {
            filePath: deletedPath,
            expiryDate: new Date(Date.now() + 60_000).toISOString()
        };
        fs.writeFileSync(storePath, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
        const deletedReq = { params: { token: deletedToken }, query: { diff: '1' } };
        const deletedRes = {
            statusCode: 200,
            body: '',
            status(code) { this.statusCode = code; return this; },
            send(body) { this.body = String(body); return this; },
            setHeader() {}
        };
        await retrieveFile(deletedReq, deletedRes);
        assert.strictEqual(deletedRes.statusCode, 200, 'tracked deletion should produce a diff');
        const deletedMatch = deletedRes.body.match(/atob\('([^']+)'\)/);
        assert.ok(deletedMatch, 'tracked deletion response should embed a diff');
        const deletedDiff = Buffer.from(deletedMatch[1], 'base64').toString('utf8');
        assert.match(deletedDiff, /deleted file mode 100644/);
        assert.match(deletedDiff, /-tracked before deletion/);
        assert.match(deletedDiff, /\+\+\+ \/dev\/null/);
        console.log('PASS /access diff preserves tracked deletion semantics');

        if (process.platform !== 'win32') {
            const modePath = path.join(tmpRepo, 'mode-only.sh');
            fs.writeFileSync(modePath, '#!/bin/sh\necho mode\n', { mode: 0o644 });
            execFileSync('git', ['-c', 'core.fsmonitor=false', 'add', 'mode-only.sh'], { cwd: tmpRepo });
            execFileSync('git', ['-c', 'core.fsmonitor=false', 'commit', '-q', '-m', 'add mode fixture'], { cwd: tmpRepo });
            fs.chmodSync(modePath, 0o755);
            const modeToken = 'mode-only-token';
            tokenStore[modeToken] = {
                filePath: modePath,
                expiryDate: new Date(Date.now() + 60_000).toISOString()
            };
            fs.writeFileSync(storePath, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
            const modeReq = { params: { token: modeToken }, query: { diff: '1' } };
            const modeRes = {
                statusCode: 200,
                body: '',
                status(code) { this.statusCode = code; return this; },
                send(body) { this.body = String(body); return this; },
                setHeader() {}
            };
            await retrieveFile(modeReq, modeRes);
            assert.strictEqual(modeRes.statusCode, 200, 'mode-only change should produce a diff');
            const modeMatch = modeRes.body.match(/atob\('([^']+)'\)/);
            assert.ok(modeMatch, 'mode-only response should embed a diff');
            const modeDiff = Buffer.from(modeMatch[1], 'base64').toString('utf8');
            assert.match(modeDiff, /old mode 100644/);
            assert.match(modeDiff, /new mode 100755/);
            console.log('PASS /access diff preserves mode-only semantics');
        }

        const danglingPath = path.join(tmpRepo, 'dangling.txt');
        fs.writeFileSync(danglingPath, 'regular before\n');
        execFileSync('git', ['-c', 'core.fsmonitor=false', 'add', 'dangling.txt'], { cwd: tmpRepo });
        execFileSync('git', ['-c', 'core.fsmonitor=false', 'commit', '-q', '-m', 'add dangling fixture'], { cwd: tmpRepo });
        fs.unlinkSync(danglingPath);
        fs.symlinkSync('missing-target.txt', danglingPath);
        const danglingToken = 'dangling-token';
        tokenStore[danglingToken] = {
            filePath: danglingPath,
            expiryDate: new Date(Date.now() + 60_000).toISOString()
        };
        fs.writeFileSync(storePath, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
        const danglingReq = { params: { token: danglingToken }, query: { diff: '1' } };
        const danglingRes = {
            statusCode: 200,
            body: '',
            status(code) { this.statusCode = code; return this; },
            send(body) { this.body = String(body); return this; },
            setHeader() {}
        };
        await retrieveFile(danglingReq, danglingRes);
        assert.strictEqual(danglingRes.statusCode, 200, 'dangling symlink should be diffed as an existing path');
        const danglingMatch = danglingRes.body.match(/atob\('([^']+)'\)/);
        assert.ok(danglingMatch, 'dangling symlink response should embed a diff');
        const danglingDiff = Buffer.from(danglingMatch[1], 'base64').toString('utf8');
        assert.match(danglingDiff, /new mode 120000/);
        assert.match(danglingDiff, /\+missing-target\.txt/);
        console.log('PASS /access diff treats dangling symlinks as existing paths');

        const oversizedPath = path.join(tmpRepo, 'oversized.txt');
        fs.writeFileSync(oversizedPath, 'small\n');
        execFileSync('git', ['-c', 'core.fsmonitor=false', 'add', 'oversized.txt'], { cwd: tmpRepo });
        execFileSync('git', ['-c', 'core.fsmonitor=false', 'commit', '-q', '-m', 'add oversized fixture'], { cwd: tmpRepo });
        fs.truncateSync(oversizedPath, 9 * 1024 * 1024);
        const oversizedToken = 'oversized-token';
        tokenStore[oversizedToken] = {
            filePath: oversizedPath,
            expiryDate: new Date(Date.now() + 60_000).toISOString()
        };
        fs.writeFileSync(storePath, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
        const oversizedReq = { params: { token: oversizedToken }, query: { diff: '1' } };
        const oversizedRes = {
            statusCode: 200,
            body: '',
            status(code) { this.statusCode = code; return this; },
            send(body) { this.body = String(body); return this; },
            setHeader() {}
        };
        await retrieveFile(oversizedReq, oversizedRes);
        assert.strictEqual(oversizedRes.statusCode, 500, 'oversized working-tree file should fail closed');
        assert.match(oversizedRes.body, /too large to diff safely/i);
        console.log('PASS /access diff rejects oversized files before diff materialization');

        const missingDir = path.join(tmpRepo, 'deleted-dir');
        const missingPath = path.join(missingDir, 'gone.txt');
        fs.mkdirSync(missingDir);
        fs.writeFileSync(missingPath, 'gone\n');
        const missingToken = 'missing-dir-token';
        tokenStore[missingToken] = {
            filePath: missingPath,
            expiryDate: new Date(Date.now() + 60_000).toISOString()
        };
        fs.writeFileSync(storePath, JSON.stringify(tokenStore, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.rmSync(missingDir, { recursive: true, force: true });

        const missingReq = { params: { token: missingToken }, query: { diff: '1' } };
        const missingRes = {
            statusCode: 200,
            body: '',
            status(code) {
                this.statusCode = code;
                return this;
            },
            send(body) {
                this.body = String(body);
                return this;
            },
            setHeader() {}
        };
        await retrieveFile(missingReq, missingRes);
        assert.strictEqual(missingRes.statusCode, 500, 'missing target directory should stay inside the handler error boundary');
        assert.match(missingRes.body, /Error fetching Git diff:/);
        console.log('PASS /access diff returns 500 when the target directory disappears');
        assert.strictEqual(fs.existsSync(markerPath), false, 'repo-controlled helper marker must remain absent through all diff cases');
    } finally {
        fs.rmSync(tmpRepo, { recursive: true, force: true });
        if (originalStore) {
            fs.writeFileSync(storePath, originalStore.data, { mode: originalStore.mode });
            fs.chmodSync(storePath, originalStore.mode);
        } else if (fs.existsSync(storePath)) {
            fs.unlinkSync(storePath);
        }
    }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
