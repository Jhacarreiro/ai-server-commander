module.exports = (log, config) => ((req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    const rawUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
    const fullUrl = rawUrl.replace(/([?&]token=)[^&]+/g, '$1***');
    log('request auth check', fullUrl, Object.keys(req.headers));

    const queryToken = req.path === '/mcp' && req.query && typeof req.query.token === 'string' ? req.query.token : undefined;
    const expectedMcpToken = config.mcpToken || config.authToken;
    if (queryToken && queryToken === expectedMcpToken) {
        next();
        return;
    }

    if (typeof bearerHeader !== 'undefined') {
        const bearerToken = bearerHeader.split(' ')[1];
        // Verify the token here (e.g., using a library like jsonwebtoken)
        if (bearerToken === config.authToken) {
            // Token is valid, proceed to the next middleware
            next();
        } else {
            res.sendStatus(403); // Forbidden
        }
    } else {
        res.sendStatus(401); // Unauthorized
    }
});