const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const DEFAULT_CONFIG_PATH = path.resolve(process.env.CONFIG_FILE_PATH || './config.json');

function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

function cancelledSetupError() {
    const error = new Error('Setup cancelled.');
    error.code = 'SETUP_CANCELLED';
    return error;
}

function normalizePort(value) {
    // Strict full-string decimal digits. parseInt would silently accept
    // "3000abc" -> 3000 and "1e3" -> port 1, so the wizard could not retry.
    // Zero-padded digit strings such as "00001" remain valid when the
    // numeric value is in 1..65535.
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) {
        throw new Error('Configuration port must be an integer between 1 and 65535.');
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Configuration port must be an integer between 1 and 65535.');
    }
    return port;
}

// Previous releases used parseInt, so a persisted "8080abc" listened on 8080.
// Recover that effective port in memory only; never rewrite the file.
function legacyEffectivePort(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
        return value;
    }
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    return parsed;
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
    try {
        return validateConfig(parsed);
    } catch (error) {
        const message = error && error.message ? String(error.message) : '';
        // Upgrade path: a persisted config that only fails port validation
        // (legacy parseInt leftovers like "3000abc" / "1e3") keeps tokens and
        // domain and rewrites the port to 3000.
        if (!message.includes('port must be an integer')) throw error;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw error;
        const effective = legacyEffectivePort(parsed.port);
        if (effective == null) {
            throw new Error(
                `Persisted port ${JSON.stringify(parsed.port)} is not a recoverable integer 1-65535. Edit config.json port to a decimal integer and restart.`
            );
        }
        const repaired = validateConfig({ ...parsed, port: effective });
        console.error(`Using legacy effective port ${effective} from persisted ${JSON.stringify(parsed.port)} in ${configPath} (file not rewritten)`);
        return repaired;
    }
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
    } catch (error) {
        if (isAbortError(error)) {
            throw cancelledSetupError();
        }
        throw error;
    } finally {
        rl.close();
    }
}

async function createConfig({ configPath = DEFAULT_CONFIG_PATH, ask = defaultAsk } = {}) {
    if (!process.stdin.isTTY && ask === defaultAsk) {
        throw new Error(`Configuration not found at ${configPath}. Copy config.example.json to config.json and replace every placeholder before starting the server.`);
    }

    // Interactive wizard: re-prompt on invalid input instead of crashing with
    // a raw stack trace. Empty port input falls back to the shown default.
    // Ctrl-D/EOF from readline is a clean cancellation, not a retry.
    let config;
    while (true) {
        let portAnswer;
        let productionDomainAnswer;
        try {
            portAnswer = String(await ask('Server port [3000]: ')).trim();
            productionDomainAnswer = String(await ask('Public HTTP(S) origin, for example https://commander.example.com: ')).trim();
        } catch (error) {
            if (error && error.code === 'SETUP_CANCELLED') {
                throw error;
            }
            if (isAbortError(error)) {
                throw cancelledSetupError();
            }
            throw error;
        }
        try {
            config = validateConfig({
                port: portAnswer || 3000,
                useLocalTunnel: false,
                productionDomain: productionDomainAnswer,
                authToken: crypto.randomBytes(32).toString('hex'),
                mcpToken: crypto.randomBytes(32).toString('hex')
            });
            break;
        } catch (error) {
            console.error(`Invalid input: ${error && error.message ? error.message : error}`);
            console.error('Please try again.');
        }
    }
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
    if (error && error.code === 'SETUP_CANCELLED') {
        console.error(error.message);
        process.exit(1);
    }
    console.error('Configuration error:', error.message);
    throw error;
});

module.exports = {
    configPromise,
    createConfig,
    loadConfigFile,
    loadOrCreateConfig,
    normalizePort,
    normalizeProductionDomain,
    validateConfig,
    writeConfigFile
};
