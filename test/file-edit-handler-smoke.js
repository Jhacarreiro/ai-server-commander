process.env.MAX_REPLACEMENTS = '3';
process.env.MAX_EDIT_FILE_BYTES = '2048';

const fs = require('fs');
const path = require('path');
const readEditTextFileHandler = require('../api/readEditTextFile2Handler');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

function createRes() {
    const res = {
        statusCode: 200,
        body: undefined,
        sent: undefined,
        status(n) {
            this.statusCode = n;
            return this;
        },
        json(o) {
            this.body = o;
            return this;
        },
        send(s) {
            this.sent = s;
            return this;
        },
        type() {
            return this;
        },
        setHeader() {
            return this;
        }
    };
    return res;
}

function conflictBlock(i) {
    return `<<<<<<< HEAD\nold${i}\n=======\nnew${i}\n>>>>>>> br`;
}

(async () => {
    const repoRoot = path.resolve(__dirname, '..');
    fs.mkdirSync(path.join(repoRoot, 'runtime'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(repoRoot, 'runtime', 'fileedit-'));
    const handler = readEditTextFileHandler;
    try {
        const capPath = path.join(dir, 'cap.txt');
        fs.writeFileSync(capPath, 'placeholder\n');
        const capRes = createRes();
        await handler(() => 'http://x')({
            method: 'POST',
            query: {},
            body: {
                filePath: capPath,
                mergeText: [0, 1, 2, 3].map(conflictBlock).join('\n')
            }
        }, capRes);
        assert(
            capRes.statusCode === 400 && capRes.body && String(capRes.body.error).includes('Too many replacements'),
            'mergeText four blocks hits replacement cap',
            JSON.stringify({ status: capRes.statusCode, body: capRes.body })
        );

        const twoPath = path.join(dir, 'two.txt');
        fs.writeFileSync(twoPath, 'old0\nold1\n');
        const twoRes = createRes();
        await handler(() => 'http://x')({
            method: 'POST',
            query: {},
            body: {
                filePath: twoPath,
                mergeText: [0, 1].map(conflictBlock).join('\n')
            }
        }, twoRes);
        assert(
            twoRes.statusCode === 200,
            'mergeText two blocks is not a cap rejection',
            JSON.stringify({ status: twoRes.statusCode, body: twoRes.body, sent: twoRes.sent })
        );

        const falsyRes = createRes();
        await handler(() => 'http://x')({
            method: 'POST',
            query: {},
            body: { filePath: path.join(dir, 'falsy.txt'), replacements: false }
        }, falsyRes);
        assert(
            falsyRes.statusCode === 400 && falsyRes.body && falsyRes.body.error === 'replacements must be an array.',
            'explicit falsy replacements must be an array',
            JSON.stringify({ status: falsyRes.statusCode, body: falsyRes.body })
        );

        const truthyRes = createRes();
        await handler(() => 'http://x')({
            method: 'POST',
            query: {},
            body: { filePath: path.join(dir, 'nope.txt'), replacements: 'nope' }
        }, truthyRes);
        assert(
            truthyRes.statusCode === 400 && truthyRes.body && truthyRes.body.error === 'replacements must be an array.',
            'explicit non-array replacements must be an array',
            JSON.stringify({ status: truthyRes.statusCode, body: truthyRes.body })
        );

        const bigPath = path.join(dir, 'big.txt');
        fs.writeFileSync(bigPath, 'x'.repeat(4096));
        const bigRes = createRes();
        await handler(() => 'http://x')({
            method: 'POST',
            query: {},
            body: {
                filePath: bigPath,
                replacements: [{ originalText: 'x', replacementText: 'y' }]
            }
        }, bigRes);
        assert(
            bigRes.statusCode === 500 && bigRes.body && String(bigRes.body.error).includes('MAX_EDIT_FILE_BYTES'),
            'oversized file rejected before edit',
            JSON.stringify({ status: bigRes.statusCode, body: bigRes.body })
        );

        const helloPath = path.join(dir, 'hello.txt');
        fs.writeFileSync(helloPath, 'hello world');
        const helloRes = createRes();
        await handler(() => 'http://x')({
            method: 'POST',
            query: {},
            body: {
                filePath: helloPath,
                replacements: [{ originalText: 'hello', replacementText: 'hi' }]
            }
        }, helloRes);
        const onDisk = fs.readFileSync(helloPath, 'utf8');
        assert(
            helloRes.statusCode === 200 && helloRes.sent && String(helloRes.sent).includes('File url:') && onDisk === 'hi world',
            'happy path replaces text and reports file url',
            JSON.stringify({ status: helloRes.statusCode, sent: helloRes.sent, onDisk })
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
