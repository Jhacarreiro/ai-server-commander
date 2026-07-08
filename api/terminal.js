const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPendingNotices } = require('./notices');
const { appendActivity, preview, hashText, getActivityContext } = require('./activityLog');

const MAX_OUTPUT_CHARS = parseInt(process.env.MAX_OUTPUT_CHARS || '12000', 10);
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || '120000', 10);
const MAX_SCRIPT_BODY_BYTES = parseInt(process.env.MAX_SCRIPT_BODY_BYTES || '524288', 10);
const MAX_CWD_BYTES = 1024;
const MAX_SHELL_BYTES = 256;
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
let currentChildCwd = null;

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, openai-conversation-id, openai-ephemeral-user-id');
    res.setHeader('Access-Control-Allow-Credentials', true);
}

function findBlockedPattern(command) {
    if (!SAFE_MODE) return null;
    return blockedCommandPatterns.find((pattern) => pattern.test(command)) || null;
}

// ── Bounded executor ──────────────────────────────────────────────────────────

function executeBounded(options) {
    const {
        command,
        shell = process.env.SHELL || '/bin/bash',
        cwd = process.env.HOME || process.cwd(),
        timeoutMs = COMMAND_TIMEOUT_MS,
        maxOutputChars = MAX_OUTPUT_CHARS
    } = options;

    const effectiveTimeout = Math.min(timeoutMs, COMMAND_TIMEOUT_MS);
    const effectiveMaxOutput = Math.min(maxOutputChars, MAX_OUTPUT_CHARS);

    return new Promise((resolve) => {
        let finished = false;
        currentChild = exec(command, {
            shell,
            cwd,
            timeout: effectiveTimeout,
            maxBuffer: Math.max(effectiveMaxOutput * 4, 1024 * 1024)
        }, (error, stdout, stderr) => {
            if (finished) return;
            finished = true;
            currentChild = null;
            currentChildCwd = null;

            const output = [
                stdout || '',
                stderr ? '\n[stderr]\n' + stderr : '',
                error ? '\n[error]\n' + error.message : ''
            ].join('').trim();

            const outputTruncated = output.length > effectiveMaxOutput;
            const limitedOutput = outputTruncated ? output.slice(0, effectiveMaxOutput) : output;
            const exitCode = error && typeof error.code !== 'undefined' ? error.code : 0;
            const timedOut = Boolean(error && error.killed);

            resolve({ output, limitedOutput, outputTruncated, exitCode, timedOut });
        });

        if (currentChild) {
            currentChildCwd = cwd;
        }
    });
}

// ── CWD sanitization ──────────────────────────────────────────────────────────

function sanitizeCwd(raw) {
    if (!raw) return undefined;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > MAX_CWD_BYTES) return undefined;
    if (/\x00/.test(trimmed)) return undefined;
    try {
        const resolved = path.resolve(trimmed);
        if (!fs.existsSync(resolved)) return undefined;
        if (!fs.statSync(resolved).isDirectory()) return undefined;
        return resolved;
    } catch {
        return undefined;
    }
}

// ── Request parsing ───────────────────────────────────────────────────────────

function getCommand(req) {
    return req.query.command || (req.body && req.body.command);
}

function parseRequest(req) {
    const query = req.query || {};
    const body = req.body || {};

    let mode = 'inline';
    if (req.method === 'GET') {
        mode = 'inline';
    } else if (body.mode === 'script') {
        mode = 'script';
    } else if (body.mode === 'inline' || !body.mode) {
        mode = 'inline';
    } else {
        return { error: true, status: 400, message: 'Unknown mode: ' + body.mode + '. Supported: inline, script.' };
    }

    const command = getCommand(req);
    const script = body.script;

    if (mode === 'inline' && !command) {
        return { error: true, status: 400, message: 'Command parameter is required for inline mode.' };
    }
    if (mode === 'script' && !script) {
        return { error: true, status: 400, message: 'Script body is required for script mode.' };
    }
    if (mode === 'script' && typeof script !== 'string') {
        return { error: true, status: 400, message: 'Script body must be a string.' };
    }
    if (mode === 'script' && Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BODY_BYTES) {
        return { error: true, status: 400, message: 'Script body exceeds maximum of ' + MAX_SCRIPT_BODY_BYTES + ' bytes.' };
    }

    let shell = process.env.SHELL || '/bin/sh';
    if (mode === 'script' && body.shell) {
        if (typeof body.shell !== 'string' || Buffer.byteLength(body.shell, 'utf8') > MAX_SHELL_BYTES) {
            return { error: true, status: 400, message: 'Shell path is invalid or too long.' };
        }
        const candidate = body.shell.trim();
        if (!/^(\/[A-Za-z0-9._\-\/]+|[A-Za-z0-9._\-]{1,32})$/.test(candidate)) {
            return { error: true, status: 400, message: 'Shell path is not allowed.' };
        }
        shell = candidate;
    }

    const cwd = sanitizeCwd(body.cwd) || process.env.HOME || process.cwd();
    const timeoutMs = (Number.isFinite(Number(body.timeoutMs)) && Number(body.timeoutMs) > 0)
        ? Number(body.timeoutMs) : COMMAND_TIMEOUT_MS;
    const maxOutputChars = (Number.isFinite(Number(body.maxOutputChars)) && Number(body.maxOutputChars) > 0)
        ? Number(body.maxOutputChars) : MAX_OUTPUT_CHARS;

    return {
        mode,
        command: mode === 'script' ? null : command,
        script: mode === 'script' ? script : null,
        cwd,
        timeoutMs,
        maxOutputChars,
        shell
    };
}

// ── Script file helpers ───────────────────────────────────────────────────────

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
        if (scriptDir && fs.existsSync(scriptDir)) {
            fs.rmSync(scriptDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[terminal] script cleanup failed:', e.message);
    }
}

// ── Terminal handler ──────────────────────────────────────────────────────────

function terminalHandler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const parsed = parseRequest(req);
    if (parsed.error) {
        return res.status(parsed.status).json({ message: parsed.message });
    }

    const { mode, command, script, cwd, timeoutMs, maxOutputChars, shell } = parsed;

    const activityContext = getActivityContext(req);
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
            mode,
            commandHash: payloadHash,
            exitCode: 126,
            timedOut: false,
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

        return res.status(403).json({
            message: 'Command blocked by SAFE_MODE policy.',
            output: '',
            exitCode: 126,
            timedOut: false,
            blocked: true,
            notices
        });
    }

    console.log('[terminal] execute mode=' + mode + ' cwd=' + cwd + ' timeoutMs=' + timeoutMs + ' maxOutputChars=' + maxOutputChars);
    if (mode === 'inline') {
        console.log('[terminal] command: ' + command);
    } else {
        console.log('[terminal] script: ' + payloadByteLength + ' bytes');
    }

    // ── Script mode ───────────────────────────────────────────────────────────

    if (mode === 'script') {
        let scriptDir = null;
        try {
            const s = createScriptFile(script);
            scriptDir = s.scriptDir;

            executeBounded({
                command: shell + ' ' + s.scriptPath,
                shell,
                cwd,
                timeoutMs,
                maxOutputChars
            }).then(({ output, limitedOutput, outputTruncated, exitCode, timedOut }) => {
                cleanupScriptDir(scriptDir);
                const notices = getPendingNotices(activityContext);

                console.log('[terminal] script finished. exitCode=' + exitCode + ' timedOut=' + timedOut + ' output_length=' + output.length);

                appendActivity({
                    type: 'command_finished',
                    id: activityId,
                    mode,
                    commandHash: payloadHash,
                    commandPreview: payloadPreview,
                    payloadByteLength,
                    exitCode,
                    timedOut,
                    blocked: false,
                    durationMs: Date.now() - startedAtMs,
                    outputLength: output.length,
                    outputTruncated,
                    outputPreview: preview(output, 1200),
                    noticesCount: notices.length,
                    errorPreview: null,
                    cwd,
                    shell
                }, activityContext);

                return res.status(200).json({
                    message: exitCode === 0 ? 'Script executed successfully.' : 'Script finished with error.',
                    output: limitedOutput,
                    exitCode,
                    timedOut,
                    outputTruncated,
                    maxOutputChars,
                    mode: 'script',
                    notices
                });
            }).catch((err) => {
                cleanupScriptDir(scriptDir);
                console.error('[terminal] script execution error:', err.message);
                return res.status(500).json({
                    message: 'Script execution failed.',
                    output: '',
                    exitCode: 1,
                    timedOut: false,
                    outputTruncated: false,
                    maxOutputChars,
                    mode: 'script',
                    notices: getPendingNotices(activityContext)
                });
            });
        } catch (err) {
            cleanupScriptDir(scriptDir);
            console.error('[terminal] script setup error:', err.message);
            return res.status(500).json({
                message: 'Failed to prepare script execution.',
                output: '',
                exitCode: 1,
                timedOut: false,
                outputTruncated: false,
                maxOutputChars,
                mode: 'script',
                notices: getPendingNotices(activityContext)
            });
        }
        return;
    }

    // ── Inline mode ───────────────────────────────────────────────────────────

    executeBounded({
        command,
        shell: process.env.SHELL || '/bin/bash',
        cwd,
        timeoutMs,
        maxOutputChars
    }).then(({ output, limitedOutput, outputTruncated, exitCode, timedOut }) => {
        const notices = getPendingNotices(activityContext);

        console.log('[terminal] command finished. exitCode=' + exitCode + ' timedOut=' + timedOut + ' output_length=' + output.length);

        appendActivity({
            type: 'command_finished',
            id: activityId,
            mode,
            commandHash: payloadHash,
            commandPreview: payloadPreview,
            payloadByteLength,
            exitCode,
            timedOut,
            blocked: false,
            durationMs: Date.now() - startedAtMs,
            outputLength: output.length,
            outputTruncated,
            outputPreview: preview(output, 1200),
            noticesCount: notices.length,
            errorPreview: null,
            cwd,
            shell: mode === 'script' ? shell : undefined
        }, activityContext);

        return res.status(200).json({
            message: exitCode === 0 ? 'Command executed successfully.' : 'Command finished with error.',
            output: limitedOutput,
            exitCode,
            timedOut,
            outputTruncated,
            maxOutputChars,
            mode: 'inline',
            notices
        });
    }).catch((err) => {
        console.error('[terminal] command execution error:', err.message);
        return res.status(500).json({
            message: 'Command execution failed.',
            output: '',
            exitCode: 1,
            timedOut: false,
            outputTruncated: false,
            maxOutputChars,
            mode: 'inline',
            notices: getPendingNotices(activityContext)
        });
    });
}

// ── Interrupt handler ─────────────────────────────────────────────────────────

function interruptHandler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method not allowed. Please use POST.' });
    }

    if (currentChild) {
        currentChild.kill('SIGTERM');
        currentChild = null;
        currentChildCwd = null;
        return res.status(200).json({ message: 'Command interrupted.' });
    }

    return res.status(200).json({ message: 'No running command.' });
}

function getCurrentDirectory() {
    return Promise.resolve(process.env.HOME || process.cwd());
}

module.exports = { getCurrentDirectory, interruptHandler, terminalHandler, executeBounded, parseRequest };
