const crypto = require('crypto');
const { getOAuthStore, hashSecret, safeEqualHash } = require('../serverModules/oauthStore');

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const AUTH_CODE_TTL_MS = positiveInteger(process.env.OAUTH_AUTH_CODE_TTL_SECONDS, 300) * 1000;
const ACCESS_TOKEN_TTL_SECONDS = positiveInteger(process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS, 3600);
const REFRESH_TOKEN_TTL_MS = positiveInteger(process.env.OAUTH_REFRESH_TOKEN_TTL_SECONDS, 30 * 24 * 3600) * 1000;
const SUPPORTED_SCOPE = 'terminal';

function baseUrl(config, req) {
    const configured = config.productionDomain || config.serverUrl;
    if (configured) return String(configured).replace(/\/$/, '');
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    return `${proto}://${req.get('host')}`.replace(/\/$/, '');
}

function mcpUrl(config, req) { return `${baseUrl(config, req)}/mcp`; }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function sha256Base64Url(value) { return crypto.createHash('sha256').update(value).digest('base64url'); }
function sendJson(res, value, status = 200) { res.status(status).type('application/json').json(value); }
function htmlEscape(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeRedirectUris(body) {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.slice(0, 10) : [];
    return uris.filter((value) => {
        if (typeof value !== 'string' || value.length > 2048) return false;
        try {
            const uri = new URL(value);
            if (uri.username || uri.password || uri.hash) return false;
            if (uri.protocol === 'https:') return true;
            return uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname);
        } catch (_) {
            return false;
        }
    });
}

function normalizeScope(scope) {
    const scopes = String(scope || SUPPORTED_SCOPE).split(/\s+/).filter(Boolean);
    return scopes.includes(SUPPORTED_SCOPE) ? SUPPORTED_SCOPE : null;
}

function parseBasicCredentials(req) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) return null;
    try {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator < 0) return null;
        return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
    } catch (_) { return null; }
}

function clientIdFromRequest(req) {
    const basic = parseBasicCredentials(req);
    return (basic && basic.clientId) || (req.body && req.body.client_id);
}

function validateClientSecret(req, client) {
    if (!client) return false;
    if ((client.token_endpoint_auth_method || 'none') === 'none') return true;
    const basic = parseBasicCredentials(req);
    if (basic) return basic.clientId === client.client_id && safeEqualHash(basic.clientSecret, client.client_secret_hash);
    return safeEqualHash(req.body && req.body.client_secret, client.client_secret_hash);
}

function issueTokenPair(store, clientId, sourceRecord, oldRefreshToken = null, authCode = null) {
    const accessToken = `at_${token()}`;
    const refreshToken = `rt_${token()}`;
    const now = Date.now();
    const accessRecord = {
        client_id: clientId,
        resource: sourceRecord.resource,
        scope: sourceRecord.scope,
        expires_at: now + ACCESS_TOKEN_TTL_SECONDS * 1000
    };
    const refreshRecord = { ...accessRecord, expires_at: now + REFRESH_TOKEN_TTL_MS };
    if (oldRefreshToken) store.rotateRefreshToken(oldRefreshToken, accessToken, accessRecord, refreshToken, refreshRecord);
    else if (authCode) store.exchangeAuthorizationCode(authCode, accessToken, accessRecord, refreshToken, refreshRecord);
    else store.issueTokenPair(accessToken, accessRecord, refreshToken, refreshRecord);
    return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: sourceRecord.scope
    };
}

function addOAuthRoutes(app, config) {
    const store = getOAuthStore(config);

    const protectedResourceMetadata = (req, res) => {
        const base = baseUrl(config, req);
        sendJson(res, {
            resource: mcpUrl(config, req),
            authorization_servers: [base],
            scopes_supported: [SUPPORTED_SCOPE],
            bearer_methods_supported: ['header'],
            resource_documentation: 'https://github.com/Jhacarreiro/ai-server-commander#remote-mcp-clients'
        });
    };
    app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
    app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

    const authMetadata = (req, res) => {
        const base = baseUrl(config, req);
        sendJson(res, {
            issuer: base,
            authorization_endpoint: `${base}/oauth/authorize`,
            token_endpoint: `${base}/oauth/token`,
            revocation_endpoint: `${base}/oauth/revoke`,
            registration_endpoint: `${base}/oauth/register`,
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
            revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: [SUPPORTED_SCOPE],
            resource_parameter_supported: true
        });
    };
    app.get('/.well-known/oauth-authorization-server', authMetadata);
    app.get('/.well-known/openid-configuration', authMetadata);

    app.post('/oauth/register', (req, res) => {
        const body = req.body || {};
        const redirectUris = normalizeRedirectUris(body);
        if (!redirectUris.length) return sendJson(res, { error: 'invalid_redirect_uri', error_description: 'At least one HTTPS or localhost redirect URI is required.' }, 400);
        const authMethod = body.token_endpoint_auth_method || 'none';
        if (!['none', 'client_secret_post', 'client_secret_basic'].includes(authMethod)) {
            return sendJson(res, { error: 'invalid_client_metadata', error_description: 'Unsupported token_endpoint_auth_method.' }, 400);
        }
        const scope = normalizeScope(body.scope);
        if (!scope) return sendJson(res, { error: 'invalid_client_metadata', error_description: 'The terminal scope is required.' }, 400);
        const clientSecret = authMethod === 'none' ? null : token();
        const storedClient = {
            client_id: `csc_${token()}`,
            ...(clientSecret ? { client_secret_hash: hashSecret(clientSecret) } : {}),
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: authMethod,
            scope,
            client_name: body.client_name || 'AI Server Commander MCP client'
        };
        store.setClient(storedClient);
        return sendJson(res, {
            client_id: storedClient.client_id,
            ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
            client_id_issued_at: storedClient.client_id_issued_at,
            redirect_uris: storedClient.redirect_uris,
            grant_types: storedClient.grant_types,
            response_types: storedClient.response_types,
            token_endpoint_auth_method: storedClient.token_endpoint_auth_method,
            scope: storedClient.scope,
            client_name: storedClient.client_name
        }, 201);
    });

    app.get('/oauth/authorize', (req, res) => {
        const q = req.query || {};
        const client = store.getClient(q.client_id);
        if (!client) return res.status(400).send('Unknown OAuth client.');
        if (!client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send('Invalid redirect_uri.');
        if (q.response_type !== 'code') return res.status(400).send('Unsupported response_type.');
        if (!q.code_challenge || q.code_challenge_method !== 'S256') return res.status(400).send('PKCE S256 is required.');
        if (!normalizeScope(q.scope)) return res.status(400).send('The terminal scope is required.');

        const hidden = Object.entries(q)
            .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
            .join('\n');
        return res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize AI Server Commander</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto; line-height: 1.45;">
<h1>Authorize AI Server Commander</h1>
<p>This connector can run shell commands on the configured host through the <code>run_terminal_command</code> MCP tool.</p>
<p>Only approve this if you initiated the connection from a trusted MCP client.</p>
<form method="post" action="/oauth/authorize">
${hidden}
<label>Approval code<br><input name="approval_code" type="password" autocomplete="one-time-code" style="width: 100%; font-size: 18px; padding: 8px;"></label>
<p><button type="submit" style="font-size: 18px; padding: 8px 16px;">Authorize</button></p>
</form>
</body></html>`);
    });

    app.post('/oauth/authorize', (req, res) => {
        const body = req.body || {};
        const client = store.getClient(body.client_id);
        if (!client) return res.status(400).send('Unknown OAuth client.');
        if (!client.redirect_uris.includes(body.redirect_uri)) return res.status(400).send('Invalid redirect_uri.');
        if (!safeEqualHash(body.approval_code, hashSecret(config.authToken))) return res.status(403).send('Invalid approval code.');
        if (body.response_type !== 'code') return res.status(400).send('Unsupported response_type.');
        if (!body.code_challenge || body.code_challenge_method !== 'S256') return res.status(400).send('PKCE S256 is required.');
        const scope = normalizeScope(body.scope);
        if (!scope) return res.status(400).send('The terminal scope is required.');

        const code = `code_${token()}`;
        store.setAuthCode(code, {
            client_id: body.client_id,
            redirect_uri: body.redirect_uri,
            code_challenge: body.code_challenge,
            resource: body.resource || mcpUrl(config, req),
            scope,
            expires_at: Date.now() + AUTH_CODE_TTL_MS
        });

        const redirect = new URL(body.redirect_uri);
        redirect.searchParams.set('code', code);
        if (body.state) redirect.searchParams.set('state', body.state);
        return res.redirect(302, redirect.toString());
    });

    app.post('/oauth/token', (req, res) => {
        const body = req.body || {};
        const clientId = clientIdFromRequest(req);
        const client = store.getClient(clientId);
        if (!client || !validateClientSecret(req, client)) return sendJson(res, { error: 'invalid_client' }, 401);

        if (body.grant_type === 'authorization_code') {
            const codeData = store.getAuthCode(body.code);
            if (!codeData) return sendJson(res, { error: 'invalid_grant' }, 400);
            if (Date.now() >= codeData.expires_at) {
                store.deleteAuthCode(body.code);
                return sendJson(res, { error: 'invalid_grant' }, 400);
            }
            if (codeData.client_id !== clientId || codeData.redirect_uri !== body.redirect_uri) {
                return sendJson(res, { error: 'invalid_grant' }, 400);
            }
            if (!body.code_verifier || sha256Base64Url(body.code_verifier) !== codeData.code_challenge) {
                return sendJson(res, { error: 'invalid_grant', error_description: 'PKCE verification failed.' }, 400);
            }
            return sendJson(res, issueTokenPair(store, clientId, codeData, null, body.code));
        }

        if (body.grant_type === 'refresh_token') {
            const refreshData = store.getRefreshToken(body.refresh_token);
            if (!refreshData || refreshData.client_id !== clientId || Date.now() >= refreshData.expires_at) {
                if (refreshData) store.deleteRefreshToken(body.refresh_token);
                return sendJson(res, { error: 'invalid_grant' }, 400);
            }
            return sendJson(res, issueTokenPair(store, clientId, refreshData, body.refresh_token));
        }

        return sendJson(res, { error: 'unsupported_grant_type' }, 400);
    });

    app.post('/oauth/revoke', (req, res) => {
        const body = req.body || {};
        const clientId = clientIdFromRequest(req);
        const client = store.getClient(clientId);
        if (!client || !validateClientSecret(req, client)) return sendJson(res, { error: 'invalid_client' }, 401);
        if (typeof body.token === 'string' && body.token) store.revokeToken(body.token, clientId);
        return res.status(200).end();
    });
}

function validateAccessToken(accessToken, expectedResource, config) {
    const store = getOAuthStore(config);
    const record = store.getAccessToken(accessToken);
    if (!record) return false;
    if (Date.now() >= record.expires_at) {
        store.deleteAccessToken(accessToken);
        return false;
    }
    if (expectedResource && record.resource && record.resource !== expectedResource) return false;
    return record.scope === SUPPORTED_SCOPE;
}

function protectedResourceMetadataUrl(config, req) {
    return `${baseUrl(config, req)}/.well-known/oauth-protected-resource/mcp`;
}

function expectedResource(config, req) {
    return mcpUrl(config, req);
}

module.exports = {
    addOAuthRoutes,
    expectedResource,
    protectedResourceMetadataUrl,
    validateAccessToken
};
