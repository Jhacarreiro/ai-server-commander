const crypto = require('crypto');

function state() {
    if (!global.__cscOAuthState) {
        global.__cscOAuthState = {
            clients: new Map(),
            authCodes: new Map(),
            accessTokens: new Map(),
            refreshTokens: new Map()
        };
    }
    return global.__cscOAuthState;
}

function baseUrl(config, req) {
    const configured = config.productionDomain || config.serverUrl;
    if (configured) return String(configured).replace(/\/$/, '');
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    return `${proto}://${req.get('host')}`.replace(/\/$/, '');
}

function mcpUrl(config, req) {
    return `${baseUrl(config, req)}/mcp`;
}

function token() {
    return crypto.randomBytes(32).toString('base64url');
}

function sha256Base64Url(value) {
    return crypto.createHash('sha256').update(value).digest('base64url');
}

function sendJson(res, value, status = 200) {
    res.status(status).type('application/json').json(value);
}

function htmlEscape(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normalizeRedirectUris(body) {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    return uris.filter((u) => typeof u === 'string' && (u.startsWith('https://') || u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1')));
}

function findClient(clientId) {
    const s = state();
    return s.clients.get(clientId);
}

function validateClientSecret(req, client) {
    if (!client || !client.client_secret) return true;

    const auth = req.headers.authorization || '';
    if (auth.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
            const idx = decoded.indexOf(':');
            const id = decoded.slice(0, idx);
            const secret = decoded.slice(idx + 1);
            return id === client.client_id && secret === client.client_secret;
        } catch (_) {
            return false;
        }
    }

    return req.body && req.body.client_secret === client.client_secret;
}

function addOAuthRoutes(app, config) {
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
        const base = baseUrl(config, req);
        sendJson(res, {
            resource: mcpUrl(config, req),
            authorization_servers: [base],
            scopes_supported: ['terminal'],
            bearer_methods_supported: ['header'],
            resource_documentation: 'https://github.com/Jhacarreiro/ai-server-commander#remote-mcp-clients'
        });
    });

    app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
        const base = baseUrl(config, req);
        sendJson(res, {
            resource: mcpUrl(config, req),
            authorization_servers: [base],
            scopes_supported: ['terminal'],
            bearer_methods_supported: ['header'],
            resource_documentation: 'https://github.com/Jhacarreiro/ai-server-commander#remote-mcp-clients'
        });
    });

    const authMetadata = (req, res) => {
        const base = baseUrl(config, req);
        sendJson(res, {
            issuer: base,
            authorization_endpoint: `${base}/oauth/authorize`,
            token_endpoint: `${base}/oauth/token`,
            registration_endpoint: `${base}/oauth/register`,
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: ['terminal'],
            resource_parameter_supported: true
        });
    };

    app.get('/.well-known/oauth-authorization-server', authMetadata);
    app.get('/.well-known/openid-configuration', authMetadata);

    app.post('/oauth/register', (req, res) => {
        const body = req.body || {};
        const redirectUris = normalizeRedirectUris(body);
        if (!redirectUris.length) {
            return sendJson(res, { error: 'invalid_redirect_uri', error_description: 'At least one HTTPS or localhost redirect URI is required.' }, 400);
        }

        const client = {
            client_id: `csc_${token()}`,
            client_secret: body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none' ? token() : undefined,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: redirectUris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
            scope: body.scope || 'terminal',
            client_name: body.client_name || 'AI Server Commander MCP client'
        };
        state().clients.set(client.client_id, client);

        const response = { ...client };
        if (!client.client_secret) delete response.client_secret;
        return sendJson(res, response, 201);
    });

    app.get('/oauth/authorize', (req, res) => {
        const q = req.query || {};
        const client = findClient(q.client_id);
        if (!client) return res.status(400).send('Unknown OAuth client.');
        if (!client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send('Invalid redirect_uri.');
        if (q.response_type !== 'code') return res.status(400).send('Unsupported response_type.');
        if (!q.code_challenge || q.code_challenge_method !== 'S256') return res.status(400).send('PKCE S256 is required.');

        const hidden = Object.entries(q).map(([k, v]) => `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`).join('\n');
        res.type('html').send(`<!doctype html>
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
        const client = findClient(body.client_id);
        if (!client) return res.status(400).send('Unknown OAuth client.');
        if (!client.redirect_uris.includes(body.redirect_uri)) return res.status(400).send('Invalid redirect_uri.');
        if (body.approval_code !== config.authToken) return res.status(403).send('Invalid approval code.');
        if (body.response_type !== 'code') return res.status(400).send('Unsupported response_type.');
        if (!body.code_challenge || body.code_challenge_method !== 'S256') return res.status(400).send('PKCE S256 is required.');

        const code = `code_${token()}`;
        state().authCodes.set(code, {
            client_id: body.client_id,
            redirect_uri: body.redirect_uri,
            code_challenge: body.code_challenge,
            resource: body.resource || mcpUrl(config, req),
            scope: body.scope || 'terminal',
            expires_at: Date.now() + 5 * 60 * 1000
        });

        const redirect = new URL(body.redirect_uri);
        redirect.searchParams.set('code', code);
        if (body.state) redirect.searchParams.set('state', body.state);
        res.redirect(302, redirect.toString());
    });

    app.post('/oauth/token', (req, res) => {
        const body = req.body || {};
        const grantType = body.grant_type;
        const client = findClient(body.client_id);
        if (!client) return sendJson(res, { error: 'invalid_client' }, 401);
        if (!validateClientSecret(req, client)) return sendJson(res, { error: 'invalid_client' }, 401);

        if (grantType === 'authorization_code') {
            const codeData = state().authCodes.get(body.code);
            if (!codeData) return sendJson(res, { error: 'invalid_grant' }, 400);
            if (Date.now() > codeData.expires_at) {
                state().authCodes.delete(body.code);
                return sendJson(res, { error: 'invalid_grant' }, 400);
            }
            if (codeData.client_id !== body.client_id || codeData.redirect_uri !== body.redirect_uri) {
                return sendJson(res, { error: 'invalid_grant' }, 400);
            }
            if (!body.code_verifier || sha256Base64Url(body.code_verifier) !== codeData.code_challenge) {
                return sendJson(res, { error: 'invalid_grant', error_description: 'PKCE verification failed.' }, 400);
            }

            state().authCodes.delete(body.code);
            const accessToken = `at_${token()}`;
            const refreshToken = `rt_${token()}`;
            const expiresIn = 3600;
            const record = {
                client_id: body.client_id,
                resource: codeData.resource,
                scope: codeData.scope,
                expires_at: Date.now() + expiresIn * 1000
            };
            state().accessTokens.set(accessToken, record);
            state().refreshTokens.set(refreshToken, { ...record, expires_at: Date.now() + 30 * 24 * 3600 * 1000 });
            return sendJson(res, {
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: expiresIn,
                refresh_token: refreshToken,
                scope: codeData.scope
            });
        }

        if (grantType === 'refresh_token') {
            const refreshData = state().refreshTokens.get(body.refresh_token);
            if (!refreshData || refreshData.client_id !== body.client_id || Date.now() > refreshData.expires_at) {
                return sendJson(res, { error: 'invalid_grant' }, 400);
            }
            state().refreshTokens.delete(body.refresh_token);
            const accessToken = `at_${token()}`;
            const refreshToken = `rt_${token()}`;
            const expiresIn = 3600;
            const record = {
                client_id: body.client_id,
                resource: refreshData.resource,
                scope: refreshData.scope,
                expires_at: Date.now() + expiresIn * 1000
            };
            state().accessTokens.set(accessToken, record);
            state().refreshTokens.set(refreshToken, { ...record, expires_at: Date.now() + 30 * 24 * 3600 * 1000 });
            return sendJson(res, {
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: expiresIn,
                refresh_token: refreshToken,
                scope: refreshData.scope
            });
        }

        return sendJson(res, { error: 'unsupported_grant_type' }, 400);
    });
}

function validateAccessToken(accessToken, expectedResource) {
    const record = state().accessTokens.get(accessToken);
    if (!record) return false;
    if (Date.now() > record.expires_at) {
        state().accessTokens.delete(accessToken);
        return false;
    }
    if (expectedResource && record.resource && record.resource !== expectedResource) return false;
    return true;
}

function protectedResourceMetadataUrl(config, req) {
    return `${baseUrl(config, req)}/.well-known/oauth-protected-resource/mcp`;
}

function expectedResource(config, req) {
    return mcpUrl(config, req);
}

module.exports = { addOAuthRoutes, validateAccessToken, protectedResourceMetadataUrl, expectedResource };
