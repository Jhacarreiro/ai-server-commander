const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-operations-'));
const storePath = path.join(tmp, 'command-operations.json');
process.env.COMMAND_OPERATIONS_PATH = storePath;
process.env.SAFE_MODE = 'true';

const {
    OPERATION_TTL_MS,
    claimOperation,
    finishOperation,
    getOperationStatus,
    releaseOperation
} = require('../serverModules/commandOperations');
const { executeCommand, parseRequest } = require('../api/terminal');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

function parsed(body) {
    const result = parseRequest({ method: 'POST', body, query: {} });
    if (result.error) throw new Error(result.message);
    return result;
}

(async () => {
    try {
        const base = { fingerprint: 'fp-a', activityId: 'cmd_a', mode: 'inline' };

        let claim = claimOperation({ scope: 'rest', operationId: 'op-1', ...base });
        assert(claim.claimed, 'first claim succeeds');
        claim = claimOperation({ scope: 'rest', operationId: 'op-1', ...base, activityId: 'cmd_b' });
        assert(!claim.claimed && claim.duplicate, 'same fingerprint is a duplicate');
        claim = claimOperation({ scope: 'rest', operationId: 'op-1', ...base, fingerprint: 'fp-other' });
        assert(!claim.claimed && claim.conflict, 'different fingerprint is a conflict');
        claim = claimOperation({ scope: 'mcp', operationId: 'op-1', ...base });
        assert(claim.claimed, 'the same operationId is independent per scope');

        assert(!releaseOperation({ scope: 'rest', operationId: 'op-1', activityId: 'cmd_other' }), 'release requires the owning activityId');
        assert(releaseOperation({ scope: 'rest', operationId: 'op-1', activityId: 'cmd_a' }), 'owning activity can release an accepted claim');
        assert(getOperationStatus({ scope: 'rest', operationId: 'op-1' }).state === 'unknown', 'released operation is unknown');
        assert(claimOperation({ scope: 'rest', operationId: 'op-1', ...base }).claimed, 'released operationId can be claimed again');

        finishOperation({ scope: 'rest', operationId: 'op-1' }, { exitCode: 0, mode: 'inline' });
        assert(!releaseOperation({ scope: 'rest', operationId: 'op-1', activityId: 'cmd_a' }), 'finished operation is never released');
        const finished = getOperationStatus({ scope: 'rest', operationId: 'op-1' });
        assert(finished.state === 'finished' && finished.result.exitCode === 0, 'finished status keeps the result summary', JSON.stringify(finished));

        const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        for (const record of Object.values(store.operations)) {
            if (record.scope === 'rest') record.updatedAt = new Date(Date.now() - OPERATION_TTL_MS - 1000).toISOString();
        }
        fs.writeFileSync(storePath, JSON.stringify(store));
        assert(getOperationStatus({ scope: 'rest', operationId: 'op-1' }).state === 'unknown', 'expired operation is treated as unknown');
        assert(claimOperation({ scope: 'rest', operationId: 'op-1', ...base }).claimed, 'expired operationId can be claimed again');

        fs.writeFileSync(storePath, '{ not json');
        let threw = false;
        try { claimOperation({ scope: 'rest', operationId: 'op-2', ...base }); } catch (_) { threw = true; }
        assert(threw, 'corrupt store fails closed on claim');
        assert(fs.readFileSync(storePath, 'utf8') === '{ not json', 'corrupt store is not overwritten');
        const corrupt = await executeCommand(parsed({ command: 'printf never', operationId: 'op-corrupt' }), undefined, 'rest');
        assert(corrupt.status === 500 && corrupt.result.output === '', 'executeCommand refuses to run when the store is unreadable', JSON.stringify(corrupt));
        fs.unlinkSync(storePath);

        const marker = path.join(tmp, 'marker.txt');
        const append = parsed({ command: `printf x >> ${marker}`, cwd: tmp, operationId: 'op-append' });
        const first = await executeCommand(append, undefined, 'rest');
        assert(first.status === 200 && first.result.replayed === false && first.result.operationState === 'finished', 'first execution runs', JSON.stringify(first.result));
        const replay = await executeCommand(append, undefined, 'rest');
        assert(replay.status === 200 && replay.result.replayed === true, 'replay is reported', JSON.stringify(replay.result));
        assert(fs.readFileSync(marker, 'utf8') === 'x', 'replay does not execute the command again');
        const otherScope = await executeCommand(append, undefined, 'mcp');
        assert(otherScope.result.replayed === false && fs.readFileSync(marker, 'utf8') === 'xx', 'another client scope is not replayed');

        const blocked = parsed({ command: 'shutdown now', operationId: 'op-blocked' });
        const rejected = await executeCommand(blocked, undefined, 'rest');
        assert(rejected.status === 403 && rejected.result.operationState === 'not_executed', 'SAFE_MODE rejection reports not_executed', JSON.stringify(rejected.result));
        assert(getOperationStatus({ scope: 'rest', operationId: 'op-blocked' }).state === 'unknown', 'SAFE_MODE rejection does not consume the operationId');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
