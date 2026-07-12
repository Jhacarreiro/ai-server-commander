const { validateAccessToken, protectedResourceMetadataUrl, expectedResource } = require('../api/oauth');

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
        '/oauth/token'
    ]);

    if (publicOAuthPaths.has(req.path)) {
        next();
        return;
    }

    const bearerToken = typeof bearerHeader !== 'undefined' ? bearerHeader.split(' ')[1] : undefined;

    if (req.path === '/mcp') {
        const queryToken = req.query && typeof req.query.token === 'string' ? req.query.token : undefined;
        const expectedMcpToken = config.mcpToken || config.authToken;
        if (queryToken && queryToken === expectedMcpToken) {
            next();
            return;
        }
        if (bearerToken && validateAccessToken(bearerToken, expectedResource(config, req))) {
            next();
            return;
        }
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${protectedResourceMetadataUrl(config, req)}", scope="terminal"`);
        res.sendStatus(401);
        return;
    }

    if (typeof bearerHeader !== 'undefined') {
        if (bearerToken === config.authToken) {
            next();
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(401);
    }
});
