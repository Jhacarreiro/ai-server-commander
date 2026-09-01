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

        fs.writeFileSync(filePath, 'original content\n', 'utf8');
        await replaceTextInSection(filePath, [{ originalText: 'original content\n', replacementText: 'x' }]);
        const exact = fs.readFileSync(filePath);
        assert.strictEqual(exact.toString('utf8'), 'x', 'shorter replacement writes exact content');
        assert.ok(!exact.includes(0), 'shorter replacement does not leave NUL padding');
        console.log('PASS shorter replacement writes exact content without NUL padding');

        fs.writeFileSync(filePath, 'original content\n', 'utf8');
        let openWrap = fs.promises.open;
        fs.promises.open = async (...args) => {
            const handle = await openWrap(...args);
            fs.promises.open = openWrap;
            fs.unlinkSync(filePath);
            return handle;
        };
        await replaceTextInSection(filePath, [{ originalText: 'original content', replacementText: 'replaced' }]);
        fs.promises.open = openWrap;
        assert.strictEqual(fs.existsSync(filePath), false, 'unlinked path is not recreated by the handle write');
        console.log('PASS deletion after open does not recreate the path');

        fs.writeFileSync(filePath, 'original content\n', 'utf8');
        openWrap = fs.promises.open;
        fs.promises.open = async (...args) => {
            const handle = await openWrap(...args);
            fs.promises.open = openWrap;
            fs.unlinkSync(filePath);
            fs.writeFileSync(filePath, 'DECOY\n', 'utf8');
            return handle;
        };
        await replaceTextInSection(filePath, [{ originalText: 'original content', replacementText: 'replaced' }]);
        fs.promises.open = openWrap;
        assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'DECOY\n', 'replaced path is not overwritten');
        console.log('PASS path replacement after open leaves the decoy file intact');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
