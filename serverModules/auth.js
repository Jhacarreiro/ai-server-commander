const crypto = require('crypto');
const { validateAccessToken, protectedResourceMetadataUrl, expectedResource } = require('../api/oauth');
const crypto = require('crypto');

function safeEqual(a, b) {
    const left = Buffer.from(String(a ?? ''));
    const right = Buffer.from(String(b ?? ''));
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a ?? ''));
    const right = Buffer.from(String(b ?? ''));
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = (log, config) => ((req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    const rawUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
    const fullUrl = rawUrl.replace(/([?&]token=)[^&]+/g, '$1***');
    log('request auth check', fullUrl, Object.keys(req.headers));

    const publicOAuthPaths = new Set([
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server',
        '/.well-known/openid-configuration',
        '/oauth/register',
        '/oauth/authorize',
        '/oauth/token',
        '/oauth/revoke'
    ]);

    if (publicOAuthPaths.has(req.path)) {
        next();
        return;
    }

    const authParts = typeof bearerHeader === 'string' ? bearerHeader.split(' ') : [];
    const authScheme = authParts[0];
    const bearerToken = authParts[1];
    // RFC 7235: authentication schemes are case-insensitive.
    const isBearerScheme = typeof authScheme === 'string' && authScheme.toLowerCase() === 'bearer';

    if (req.path === '/mcp') {
        const queryToken = req.query && typeof req.query.token === 'string' ? req.query.token : undefined;
        const expectedMcpToken = config.mcpToken || config.authToken;
        // Pre-shared MCP token: accept query (?token=) OR standard Authorization: Bearer.
        // OAuth access tokens remain supported via validateAccessToken below.
        if (queryToken && safeEqual(queryToken, expectedMcpToken)) {
            next();
            return;
        }
        if (isBearerScheme && bearerToken && safeEqual(bearerToken, expectedMcpToken)) {
            next();
            return;
        }
        if (bearerToken && validateAccessToken(bearerToken, expectedResource(config, req), config)) {
            next();
            return;
        }
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${protectedResourceMetadataUrl(config, req)}", scope="terminal"`);
        res.sendStatus(401);
        return;
    }

    if (typeof bearerHeader !== 'undefined') {
        if (safeEqual(bearerToken, config.authToken)) {
            next();
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(401);
    }
});
