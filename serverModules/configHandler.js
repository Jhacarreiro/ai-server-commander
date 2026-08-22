const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const DEFAULT_CONFIG_PATH = path.resolve(process.env.CONFIG_FILE_PATH || './config.json');

function normalizePort(value) {
    const port = Number.parseInt(String(value), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Configuration port must be an integer between 1 and 65535.');
    }
    return port;
}

function normalizeHost(value) {
    if (value == null || String(value).trim() === '') {
        throw new Error('host is required. Configurations that omitted host previously bound all interfaces. Set host to "127.0.0.1" for loopback (recommended behind a reverse proxy) or "0.0.0.0" / "::" to listen on all interfaces.');
    }
    const raw = String(value).trim();
    if (raw.length > 255 || /[\x00-\x1f\s]/.test(raw)) {
        throw new Error('host must be a hostname or IP address.');
    }
    return raw;
}

function formatListenUrl(host, port, protocol = 'http') {
    const hostname = String(host);
    const hostPart = hostname.includes(':') && !hostname.startsWith('[')
        ? `[${hostname}]`
        : hostname;
    return `${protocol}://${hostPart}:${port}`;
}

function normalizeProductionDomain(value) {
    const raw = String(value || '').trim().replace(/\/$/, '');
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('productionDomain must be a valid HTTP or HTTPS URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('productionDomain must use HTTP or HTTPS.');
    }
    return raw;
}

function validateConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Configuration must be a JSON object.');
    }
    if (input.useLocalTunnel === true) {
        throw new Error('LocalTunnel support was removed. Set useLocalTunnel to false, configure productionDomain, and deploy behind a maintained HTTPS reverse proxy or tunnel.');
    }

    const authToken = String(input.authToken || '').trim();
    if (authToken.length < 32) {
        throw new Error('authToken must contain at least 32 characters.');
    }
    const mcpToken = input.mcpToken == null ? undefined : String(input.mcpToken).trim();
    if (mcpToken && mcpToken.length < 32) {
        throw new Error('mcpToken must contain at least 32 characters when provided.');
    }

    return {
        ...input,
        port: normalizePort(input.port),
        host: normalizeHost(input.host),
        useLocalTunnel: false,
        localTunnelSubdomain: null,
        productionDomain: normalizeProductionDomain(input.productionDomain),
        authToken,
        ...(mcpToken ? { mcpToken } : {})
    };
}

function loadConfigFile(configPath = DEFAULT_CONFIG_PATH) {
    // Strip a UTF-8 BOM: 'UTF-8 with BOM' saves (Windows Notepad, some
    // editors) would otherwise make JSON.parse throw a cryptic
    // "Unexpected token" at startup with no way to recover.
    let raw = fs.readFileSync(configPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    return validateConfig(parsed);
}

function writeConfigFile(configPath, config) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
}

async function defaultAsk(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await rl.question(question);
    } finally {
        rl.close();
    }
}

async function createConfig({ configPath = DEFAULT_CONFIG_PATH, ask = defaultAsk } = {}) {
    if (!process.stdin.isTTY && ask === defaultAsk) {
        throw new Error(`Configuration not found at ${configPath}. Copy config.example.json to config.json and replace every placeholder before starting the server.`);
    }

    const portAnswer = String(await ask('Server port [3000]: ')).trim();
    const productionDomainAnswer = String(await ask('Public HTTP(S) origin, for example https://commander.example.com: ')).trim();
    const config = validateConfig({
        port: portAnswer || 3000,
        host: '127.0.0.1',
        useLocalTunnel: false,
        productionDomain: productionDomainAnswer,
        authToken: crypto.randomBytes(32).toString('hex'),
        mcpToken: crypto.randomBytes(32).toString('hex')
    });
    writeConfigFile(configPath, config);
    console.log(`Configuration saved to ${configPath}`);
    return config;
}

async function loadOrCreateConfig(options = {}) {
    const configPath = path.resolve(options.configPath || DEFAULT_CONFIG_PATH);
    if (fs.existsSync(configPath)) {
        console.log(`Configuration loaded from ${configPath}`);
        return loadConfigFile(configPath);
    }
    return createConfig({ ...options, configPath });
}

const configPromise = loadOrCreateConfig().catch((error) => {
    console.error('Configuration error:', error.message);
    throw error;
});

module.exports = {
    configPromise,
    createConfig,
    formatListenUrl,
    loadConfigFile,
    loadOrCreateConfig,
    normalizePort,
    normalizeProductionDomain,
    validateConfig,
    writeConfigFile
};
