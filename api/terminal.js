const { exec } = require('child_process');
const { getPendingNotices } = require('./notices');
const { appendActivity, preview, hashText, getActivityContext } = require('./activityLog');

const MAX_OUTPUT_CHARS = parseInt(process.env.MAX_OUTPUT_CHARS || '12000', 10);
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || '120000', 10);
const SAFE_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.SAFE_MODE || 'false').toLowerCase());

const blockedCommandPatterns = [
    /rm\s+-rf\s+\/(?:\s|$)/i,
    /\bmkfs(?:\.|\s|$)/i,
    /\bdd\s+if=/i,
    /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bpoweroff\b/i,
    /\bhalt\b/i,
    /\bpasswd\b/i,
    /\buserdel\b/i,
    /\bgroupdel\b/i,
    /chmod\s+-R\s+777\s+\//i,
    /chown\s+-R\b/i
];

let currentChild = null;

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
}

function getCommand(req) {
    return req.query.command || (req.body && req.body.command);
}

function findBlockedPattern(command) {
    if (!SAFE_MODE) return null;
    return blockedCommandPatterns.find((pattern) => pattern.test(command)) || null;
}

function terminalHandler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const command = getCommand(req);
    if (!command) {
        return res.status(400).json({ message: 'Command parameter is required.' });
    }

    const activityContext = getActivityContext(req);
    const activityId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAtMs = Date.now();
    const blockedPattern = findBlockedPattern(command);

    appendActivity({
        type: 'command_started',
        id: activityId,
        commandHash: hashText(command),
        commandPreview: preview(command, 240),
        safeMode: SAFE_MODE
    }, activityContext);

    if (blockedPattern) {
        const notices = getPendingNotices(activityContext);
        appendActivity({
            type: 'command_finished',
            id: activityId,
            commandHash: hashText(command),
            exitCode: 126,
            timedOut: false,
            blocked: true,
            matchedRule: String(blockedPattern),
            durationMs: Date.now() - startedAtMs,
            outputLength: 0,
            outputTruncated: false,
            outputPreview: '',
            noticesCount: notices.length,
            errorPreview: 'Command blocked by SAFE_MODE policy'
        }, activityContext);

        return res.status(403).json({
            message: 'Command blocked by SAFE_MODE policy.',
            output: '',
            exitCode: 126,
            timedOut: false,
            blocked: true,
            notices
        });
    }

    console.log('execute command');
    console.log(command);

    let finished = false;
    currentChild = exec(command, {
        shell: process.env.SHELL || '/bin/bash',
        cwd: process.env.HOME || process.cwd(),
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: Math.max(MAX_OUTPUT_CHARS * 4, 1024 * 1024)
    }, (error, stdout, stderr) => {
        if (finished) return;
        finished = true;
        currentChild = null;

        const output = [
            stdout || '',
            stderr ? '\n[stderr]\n' + stderr : '',
            error ? `\n[error]\n${error.message}` : ''
        ].join('').trim();

        const outputTruncated = output.length > MAX_OUTPUT_CHARS;
        const limitedOutput = outputTruncated ? output.slice(0, MAX_OUTPUT_CHARS) : output;
        const exitCode = error && typeof error.code !== 'undefined' ? error.code : 0;
        const timedOut = Boolean(error && error.killed);
        const notices = getPendingNotices(activityContext);

        console.log(`Command finished. exitCode=${exitCode} timedOut=${timedOut} output_length=${output.length}`);

        appendActivity({
            type: 'command_finished',
            id: activityId,
            commandHash: hashText(command),
            exitCode,
            timedOut,
            blocked: false,
            durationMs: Date.now() - startedAtMs,
            outputLength: output.length,
            outputTruncated,
            outputPreview: preview(output, 1200),
            noticesCount: notices.length,
            errorPreview: error ? preview(error.message, 240) : null
        }, activityContext);

        return res.status(200).json({
            message: error ? 'Command finished with error.' : 'Command executed successfully.',
            output: limitedOutput,
            exitCode,
            timedOut,
            outputTruncated,
            maxOutputChars: MAX_OUTPUT_CHARS,
            notices
        });
    });
}

function interruptHandler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed. Please use POST.' });
    }

    if (currentChild) {
        currentChild.kill('SIGTERM');
        currentChild = null;
        return res.status(200).json({ message: 'Command interrupted.' });
    }

    return res.status(200).json({ message: 'No running command.' });
}

function getCurrentDirectory() {
    return Promise.resolve(process.env.HOME || process.cwd());
}

module.exports = { getCurrentDirectory, interruptHandler, terminalHandler };
