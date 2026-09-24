function stringifyError(err) {
    if (!(err instanceof Error)) throw new TypeError("Only Error instances can be stringified");

    // Client-facing payload: the message stays actionable, but stack traces
    // (server paths and internals) are only written to the server log.
    const errorObject = {
        name: err.name,
        message: err.message,
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
    stringifyError
}
