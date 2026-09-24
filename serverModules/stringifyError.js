// Absolute paths inside an error message (for example "ENOENT: no such file
// or directory, open '/srv/app/x'") reveal the server's layout to the client.
// Only whole path tokens are replaced, so the rest of the message, including
// relative paths, URLs and regex hints, stays readable.
const QUOTED_PATH = /(['"`])((?:[A-Za-z]:[\\/]|\/(?!\/))[^'"`\r\n]*)\1/g;
const BARE_PATH = /(^|[\s(=:,])((?:[A-Za-z]:[\\/]|\/(?!\/))[\w.@+~%-]+(?:[\\/][\w.@+~%-]*)*)/g;

function redactPaths(text) {
    return String(text)
        .replace(QUOTED_PATH, (match, quote) => quote + '[path]' + quote)
        .replace(BARE_PATH, (match, lead) => lead + '[path]');
}

function stringifyError(err) {
    if (!(err instanceof Error)) throw new TypeError("Only Error instances can be stringified");

    // Client-facing payload: the message stays actionable, but stack traces
    // and absolute paths (server layout and internals) only go to the server log.
    const errorObject = {
        name: err.name,
        message: redactPaths(err.message),
    };

    // Add any additional properties that are specific to the Error type
    // or the environment (such as 'code' in Node.js errors)
    if ('code' in err && (typeof err.code === 'string' || typeof err.code === 'number')) {
        errorObject.code = err.code;
    }

    // Convert to a JSON string
    return JSON.stringify(errorObject, null, 2);
}

module.exports = {
    redactPaths,
    stringifyError
}
