const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPendingNotices } = require('./notices');
const { appendActivity, preview, hashText, getActivityContext } = require('./activityLog');
const {
    COMMAND_TIMEOUT_MS,
    MAX_OUTPUT_CHARS,
    MAX_SCRIPT_BODY_BYTES,
    MAX_SHELL_BYTES,
    SAFE_MODE,
    executeBounded,
    findBlockedPattern,
    interruptCommand,
    positiveInteger,
    resolveCwd
} = require('../serverModules/commandExecutor');

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
}

function parseRequest(req) {
    const query = req.query || {};
    const body = req.body || {};
    const options = req.method === 'GET' ? query : body;

    let mode = 'inline';
    if (req.method !== 'GET') {
        if (body.mode === 'script') mode = 'script';
        else if (body.mode === 'inline' || !body.mode) mode = 'inline';
        else return { error: true, status: 400, message: 'Unknown mode: ' + body.mode + '. Supported: inline, script.' };
    }

    const command = req.method === 'GET' ? query.command : (body.command || query.command);
    const script = body.script;

    if (mode === 'inline' && (typeof command !== 'string' || !command.trim())) {
        return { error: true, status: 400, message: 'Command parameter is required for inline mode.' };
    }
    if (mode === 'script' && (typeof script !== 'string' || !script)) {
        return { error: true, status: 400, message: 'Script body is required for script mode and must be a string.' };
    }
    if (mode === 'script' && Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BODY_BYTES) {
        return { error: true, status: 413, message: 'Script body exceeds maximum of ' + MAX_SCRIPT_BODY_BYTES + ' bytes.' };
    }

    let shell = process.env.SHELL || '/bin/sh';
    if (mode === 'script' && options.shell) {
        if (typeof options.shell !== 'string' || Buffer.byteLength(options.shell, 'utf8') > MAX_SHELL_BYTES) {
            return { error: true, status: 400, message: 'Shell path is invalid or too long.' };
        }
        const candidate = options.shell.trim();
        if (!/^(\/[A-Za-z0-9._\-\/]+|[A-Za-z0-9._\-]{1,32})$/.test(candidate)) {
            return { error: true, status: 400, message: 'Shell path is not allowed.' };
        }
        shell = candidate;
    }

    const cwdResult = resolveCwd(options.cwd);
    if (cwdResult.error) {
        return { error: true, status: 400, message: cwdResult.error };
    }

    return {
        mode,
        command: mode === 'script' ? null : command,
        script: mode === 'script' ? script : null,
        cwd: cwdResult.cwd,
        timeoutMs: positiveInteger(options.timeoutMs, COMMAND_TIMEOUT_MS),
        maxOutputChars: positiveInteger(options.maxOutputChars, MAX_OUTPUT_CHARS),
        shell
    };
}

function createScriptFile(scriptBody) {
    const runtimeDir = path.join(__dirname, '..', 'runtime', 'scripts');
    fs.mkdirSync(runtimeDir, { recursive: true });

    const safeSuffix = crypto.randomBytes(6).toString('hex');
    const scriptDir = path.join(runtimeDir, 'req_' + Date.now() + '_' + safeSuffix);
    fs.mkdirSync(scriptDir, { recursive: true, mode: 0o700 });

    const scriptPath = path.join(scriptDir, 'script.sh');
    fs.writeFileSync(scriptPath, scriptBody, { mode: 0o500, encoding: 'utf8' });
    return { scriptPath, scriptDir };
}

function cleanupScriptDir(scriptDir) {
    try {
        if (scriptDir && fs.existsSync(scriptDir)) fs.rmSync(scriptDir, { recursive: true, force: true });
    } catch (error) {
        console.error('[terminal] script cleanup failed:', error.message);
    }
}

function quoteShellArg(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

async function executeCommand(parsed, activityContext = getActivityContext(null), source = 'rest') {
    const { mode, command, script, cwd, timeoutMs, maxOutputChars, shell } = parsed;
    const activityId = 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const startedAtMs = Date.now();
    const payloadText = mode === 'script' ? script : command;
    const payloadHash = hashText(payloadText || '');
    const payloadByteLength = Buffer.byteLength(payloadText || '', 'utf8');
    const payloadPreview = preview(payloadText || '', 240);
    const blockedPattern = findBlockedPattern(payloadText || '');

    appendActivity({
        type: 'command_started',
        id: activityId,
        source,
        mode,
        commandHash: payloadHash,
        commandPreview: payloadPreview,
        payloadByteLength,
        cwd,
        shell: mode === 'script' ? shell : undefined,
        safeMode: SAFE_MODE
    }, activityContext);

    if (blockedPattern) {
        const notices = getPendingNotices(activityContext);
        appendActivity({
            type: 'command_finished',
            id: activityId,
            source,
            mode,
            commandHash: payloadHash,
            exitCode: 126,
            timedOut: false,
            interrupted: false,
            blocked: true,
            matchedRule: String(blockedPattern),
            durationMs: Date.now() - startedAtMs,
            outputLength: 0,
            outputTruncated: false,
            outputPreview: '',
            noticesCount: notices.length,
            errorPreview: 'Command blocked by SAFE_MODE policy',
            cwd,
            shell: mode === 'script' ? shell : undefined
        }, activityContext);

        return {
            status: 403,
            result: {
                message: 'Command blocked by SAFE_MODE policy.',
                activityId,
                output: '',
                exitCode: 126,
                timedOut: false,
                interrupted: false,
                blocked: true,
                outputTruncated: false,
                maxOutputChars: Math.min(maxOutputChars, MAX_OUTPUT_CHARS),
                mode,
                notices
            }
        };
    }

    console.log('[terminal] execute source=' + source + ' mode=' + mode + ' id=' + activityId + ' cwd=' + cwd + ' timeoutMs=' + timeoutMs + ' maxOutputChars=' + maxOutputChars);
    console.log(mode === 'inline' ? '[terminal] command: ' + command : '[terminal] script: ' + payloadByteLength + ' bytes');

    let scriptDir = null;
    try {
        let commandToRun = command;
        let executionShell = process.env.SHELL || '/bin/bash';
        if (mode === 'script') {
            const created = createScriptFile(script);
            scriptDir = created.scriptDir;
            commandToRun = quoteShellArg(shell) + ' ' + quoteShellArg(created.scriptPath);
            executionShell = shell;
        }

        const execution = await executeBounded({
            activityId,
            command: commandToRun,
            shell: executionShell,
            cwd,
            timeoutMs,
            maxOutputChars
        });
        const notices = getPendingNotices(activityContext);

        appendActivity({
            type: 'command_finished',
            id: activityId,
            source,
            mode,
            commandHash: payloadHash,
            commandPreview: payloadPreview,
            payloadByteLength,
            exitCode: execution.exitCode,
            timedOut: execution.timedOut,
            interrupted: execution.interrupted,
            blocked: false,
            durationMs: Date.now() - startedAtMs,
            outputLength: execution.output.length,
            outputTruncated: execution.outputTruncated,
            outputPreview: preview(execution.output, 1200),
            noticesCount: notices.length,
            errorPreview: execution.exitCode === 0 ? null : preview(execution.output, 500),
            cwd,
            shell: mode === 'script' ? shell : undefined
        }, activityContext);

        let message = mode === 'script' ? 'Script executed successfully.' : 'Command executed successfully.';
        if (execution.interrupted) message = mode === 'script' ? 'Script interrupted.' : 'Command interrupted.';
        else if (execution.exitCode !== 0) message = mode === 'script' ? 'Script finished with error.' : 'Command finished with error.';

        return {
            status: 200,
            result: {
                message,
                activityId,
                output: execution.limitedOutput,
                exitCode: execution.exitCode,
                timedOut: execution.timedOut,
                interrupted: execution.interrupted,
                blocked: false,
                outputTruncated: execution.outputTruncated,
                maxOutputChars: execution.maxOutputChars,
                mode,
                notices
            }
        };
    } catch (error) {
        console.error('[terminal] execution error:', error.message);
        const notices = getPendingNotices(activityContext);
        appendActivity({
            type: 'command_finished',
            id: activityId,
            source,
            mode,
            commandHash: payloadHash,
            exitCode: 1,
            timedOut: false,
            interrupted: false,
            blocked: false,
            durationMs: Date.now() - startedAtMs,
            outputLength: 0,
            outputTruncated: false,
            outputPreview: '',
            noticesCount: notices.length,
            errorPreview: preview(error.message, 500),
            cwd,
            shell: mode === 'script' ? shell : undefined
        }, activityContext);

        return {
            status: 500,
            result: {
                message: mode === 'script' ? 'Script execution failed.' : 'Command execution failed.',
                activityId,
                output: '',
                exitCode: 1,
                timedOut: false,
                interrupted: false,
                blocked: false,
                outputTruncated: false,
                maxOutputChars: Math.min(maxOutputChars, MAX_OUTPUT_CHARS),
                mode,
                notices
            }
        };
    } finally {
        cleanupScriptDir(scriptDir);
    }
}

async function terminalHandler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const parsed = parseRequest(req);
    if (parsed.error) return res.status(parsed.status).json({ message: parsed.message });

    const outcome = await executeCommand(parsed, getActivityContext(req), 'rest');
    return res.status(outcome.status).json(outcome.result);
}

function interruptHandler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed. Please use POST.' });

    const activityId = (req.body && req.body.activityId) || (req.query && req.query.activityId);
    const result = interruptCommand(activityId);
    if (result.reason === 'ambiguous') {
        return res.status(409).json({ message: 'Multiple commands are running. Provide activityId.', activeIds: result.activeIds });
    }
    if (result.interrupted) return res.status(200).json({ message: 'Command interrupted.', activityId: result.activityId });
    return res.status(200).json({ message: 'No matching running command.', activityId: activityId || null, activeIds: result.activeIds || [] });
}

function getCurrentDirectory() {
    return Promise.resolve(process.env.HOME || process.cwd());
}

module.exports = {
    executeBounded,
    executeCommand,
    getCurrentDirectory,
    interruptHandler,
    parseRequest,
    terminalHandler
};
