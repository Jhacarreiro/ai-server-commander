const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replaceTextInSection } = require('../api/readEditTextFile2Handler');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-edit-'));
    try {
        const filePath = path.join(dir, 'target.txt');
        fs.writeFileSync(filePath, 'original content\n', 'utf8');

        // A missing file is rejected regardless of replacements and is never
        // implicitly created (PR #9 behavior).
        const missingPath = path.join(dir, 'missing.txt');
        await assert.rejects(
            () => replaceTextInSection(missingPath, [{ originalText: 'x', replacementText: 'y' }]),
            /File does not exist/,
            'missing file rejected'
        );
        assert.strictEqual(fs.existsSync(missingPath), false, 'missing file not created');
        console.log('PASS missing file rejected without implicit creation');

        // If the open fails after the existsSync check (file disappeared), the
        // error must propagate instead of continuing with an empty buffer that
        // would truncate the file on write.
        const realOpen = fs.promises.open;
        let injected = false;
        fs.promises.open = async (...args) => {
            if (!injected) {
                injected = true;
                fs.promises.open = realOpen;
                const err = new Error(`ENOENT: no such file or directory, open '${args[0]}'`);
                err.code = 'ENOENT';
                throw err;
            }
            return realOpen(...args);
        };
        await assert.rejects(
            () => replaceTextInSection(filePath, [{ originalText: 'original content', replacementText: 'replaced content' }]),
            /ENOENT/,
            'failed open propagates to caller'
        );
        fs.promises.open = realOpen;
        assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'original content\n', 'file untouched after failed open');
        console.log('PASS failed open propagates and leaves the file untouched');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
