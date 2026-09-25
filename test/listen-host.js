const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-listen-'));

// Ask the platform for its actual default address instead of assuming IPv6.
async function probe(host) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, resolve);
    });
    const address = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address;
}

async function verifyListener(host, expected) {
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
        port: expected.port,
        ...(host === undefined ? {} : { host }),
        productionDomain: 'https://commander.example.com',
        authToken: 'a'.repeat(64)
    }));
    // Exercise the real server and configuration loader. IPC only reports
    // the bound socket and allows deterministic cleanup; no listener stubs.
    const child = spawn(process.execPath, ['-e', `
        require('./serverModules/pluginServer')().then(server => {
            const ready = () => process.send(server.address());
            if (server.listening) ready();
            else server.once('listening', ready);
            process.on('message', () => server.close(() => process.exit(0)));
        }).catch(error => { console.error(error.message); process.exit(1); });
    `], {
        cwd: root,
        env: {
            ...process.env,
            CONFIG_FILE_PATH: configPath,
            OAUTH_STATE_PATH: path.join(tmp, 'oauth.json'),
            COMMAND_OPERATIONS_PATH: path.join(tmp, 'operations.json')
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
        const address = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Listener startup timed out: ' + output)), 10000);
            const finish = (error, value) => {
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(value);
            };
            child.once('message', value => finish(null, value));
            child.once('error', error => finish(error));
            child.once('exit', code => finish(new Error('Server exited ' + code + ': ' + output)));
        });
        assert.strictEqual(address.address, expected.address);
        assert.strictEqual(address.family, expected.family);
        assert.strictEqual(address.port, expected.port);
        const hostname = host || (address.family === 'IPv6' ? '::1' : '127.0.0.1');
        const status = await new Promise((resolve, reject) => {
            const request = http.get({ hostname, port: address.port, path: '/openapi.json', agent: false }, response => {
                response.resume();
                response.on('end', () => resolve(response.statusCode));
            });
            request.setTimeout(5000, () => request.destroy(new Error('HTTP request timed out')));
            request.on('error', reject);
        });
        assert.strictEqual(status, 200);
        console.log('PASS real listener ' + (host || '(omitted host)') + ' binds ' + address.address + ' and serves HTTP');
    } finally {
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        if (child.connected) child.send('stop');
        else child.kill();
        await exited;
        clearTimeout(timer);
    }
}

(async () => {
    try {
        await verifyListener(undefined, await probe(undefined));
        await verifyListener('127.0.0.1', await probe('127.0.0.1'));
        let ipv6;
        try { ipv6 = await probe('::1'); }
        catch (error) {
            if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) throw error;
            console.log('SKIP IPv6 loopback unavailable on this platform');
        }
        if (ipv6) await verifyListener('::1', ipv6);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
