
const _log = [];
const MAX_LOG_ENTRIES = 2000;
module.exports = {
    log: function (...args) {
        console.log(...args);
        _log.push(args);
        if (_log.length > MAX_LOG_ENTRIES) _log.splice(0, _log.length - MAX_LOG_ENTRIES);
    },
    getLog: () => _log,
}