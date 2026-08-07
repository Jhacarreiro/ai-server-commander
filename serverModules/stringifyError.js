function stringifyError(err) {
    if (!(err instanceof Error)) throw new TypeError("Only Error instances can be stringified");

    // Client-facing payload: never include stack traces. Callers should log the
    // full Error server-side before responding.
    const errorObject = {
        name: err.name,
        message: sanitizeMessage(err.message),
    };

    if ("code" in err && (typeof err.code === "string" || typeof err.code === "number")) {
        errorObject.code = err.code;
    }

    return JSON.stringify(errorObject, null, 2);
}

function sanitizeMessage(message) {
    const text = String(message || "Error");
    return text
        .replace(/\/[\w.-]+(?:\/[\w.-]+)+/g, "[path]")
        .replace(/[A-Za-z]:\\[\w.\\-]+/g, "[path]")
        .slice(0, 300);
}

module.exports = {
    stringifyError,
};
