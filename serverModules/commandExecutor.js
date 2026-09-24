const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_OUTPUT_CHARS = positiveInteger(process.env.MAX_OUTPUT_CHARS, 12000);
const COMMAND_TIMEOUT_MS = positiveInteger(process.env.COMMAND_TIMEOUT_MS, 120000);
const MAX_SCRIPT_BODY_BYTES = positiveInteger(process.env.MAX_SCRIPT_BODY_BYTES, 524288);
// Linux rejects a single argv string above 128 KiB (MAX_ARG_STRLEN); keep
// inline commands well below it and send larger payloads as scripts.
const MAX_INLINE_COMMAND_BYTES = positiveInteger(process.env.MAX_INLINE_COMMAND_BYTES, 65536);
const MAX_CONCURRENT_COMMANDS = positiveInteger(process.env.MAX_CONCURRENT_COMMANDS, 8);
const KILL_GRACE_MS = 1500;
const MAX_CWD_BYTES = 1024;
const MAX_SHELL_BYTES = 256;
const SAFE_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.SAFE_MODE || 'false').toLowerCase());
// One default for inline commands and scripts, REST and MCP alike.
const DEFAULT_SHELL = process.env.SHELL || (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');

// Cut to at most maxChars UTF-16 units without leaving a lone high surrogate,
// which JSON consumers such as Python reject ("surrogates not allowed").
function sliceText(text, maxChars) {
    if (text.length <= maxChars) return text;
    let cut = maxChars;
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
    return text.slice(0, cut);
}

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

const activeProcesses = new Map();
// Entries whose process group was sent SIGTERM and still has a SIGKILL pending.
const pendingKills = new Set();

function terminateEntry(entry, signal = 'SIGTERM') {
    if (!entry || !entry.child) return false;
    try {
        if (process.platform !== 'win32' && entry.child.pid) process.kill(-entry.child.pid, signal);
        else entry.child.kill(signal);
        return true;
    } catch {
        try { return entry.child.kill(signal); } catch { return false; }
    }
}

// Probe the group, not only the leader: descendants can outlive it.
function processGroupAlive(entry) {
    const child = entry && entry.child;
    if (!child || !child.pid) return false;
    if (process.platform === 'win32') return child.exitCode === null;
    try {
        process.kill(-child.pid, 0);
        return true;
    } catch {
        try {
            process.kill(child.pid, 0);
            return true;
        } catch {
            return false;
        }
    }
}

function clearKillTimer(entry) {
    if (!entry || !entry.killTimer) return;
    clearTimeout(entry.killTimer);
    entry.killTimer = null;
    pendingKills.delete(entry);
}

// SIGTERM alone is not enough: a command that traps or ignores it would keep
// the request pending forever. After a short grace period, SIGKILL the whole
// group. A repeated call keeps the first deadline, so repeated interrupts
// cannot postpone it.
function escalateToKill(entry, graceMs = KILL_GRACE_MS) {
    if (!entry || !entry.child || !entry.child.pid) return;
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
    if (entry.killTimer) return;
    entry.killTimer = setTimeout(() => {
        entry.killTimer = null;
        pendingKills.delete(entry);
        if (processGroupAlive(entry)) terminateEntry(entry, 'SIGKILL');
    }, graceMs);
    pendingKills.add(entry);
}

function sanitizeCwd(raw) {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_CWD_BYTES || /\x00/.test(trimmed)) return undefined;
    try {
        const resolved = path.resolve(trimmed);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return undefined;
        return resolved;
    } catch {
        return undefined;
    }
}

function resolveCwd(raw, fallback = process.env.HOME || process.cwd()) {
    if (typeof raw === 'undefined' || raw === null || raw === '') {
        return { cwd: fallback };
    }
    const cwd = sanitizeCwd(raw);
    return cwd ? { cwd } : { error: 'Working directory does not exist or is not a readable directory.' };
}

function findBlockedPattern(command) {
    if (!SAFE_MODE) return null;
    return blockedCommandPatterns.find((pattern) => pattern.test(command)) || null;
}

// exec() silently ignores `detached`, so commands never got their own process
// group and group signals missed pipelines and background children.
function spawnShellCommand(command, { shell, cwd, maxBuffer }, onOverflow, callback) {
    const child = spawn(shell, ['-c', command], {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const captured = { stdout: '', stderr: '' };
    let overflowed = null;
    let finished = false;

    for (const name of ['stdout', 'stderr']) {
        let bytes = 0;
        child[name].setEncoding('utf8');
        child[name].on('data', (chunk) => {
            if (overflowed) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBuffer) {
                // Like exec(): stop a runaway producer instead of letting it
                // run until the timeout.
                overflowed = name;
                onOverflow();
                return;
            }
            captured[name] += chunk;
        });
    }

    const done = (error) => {
        if (finished) return;
        finished = true;
        callback(error, captured.stdout, captured.stderr);
    };
    child.once('error', done);
    child.once('close', (code, signal) => {
        if (overflowed) {
            done(Object.assign(new Error(overflowed + ' maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
        } else if (code === 0 && !signal) {
            done(null);
        } else {
            done(Object.assign(new Error('Command failed'), { code: typeof code === 'number' ? code : 1, signal }));
        }
    });
    return child;
}

function executeBounded(options) {
    const {
        command,
        shell = DEFAULT_SHELL,
        cwd = process.env.HOME || process.cwd(),
        timeoutMs = COMMAND_TIMEOUT_MS,
        maxOutputChars = MAX_OUTPUT_CHARS,
        activityId = 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    } = options;

    const effectiveTimeout = Math.min(positiveInteger(timeoutMs, COMMAND_TIMEOUT_MS), COMMAND_TIMEOUT_MS);
    const effectiveMaxOutput = Math.min(positiveInteger(maxOutputChars, MAX_OUTPUT_CHARS), MAX_OUTPUT_CHARS);

    return new Promise((resolve, reject) => {
        if (activeProcesses.has(activityId)) {
            reject(new Error('A command with this activityId is already running.'));
            return;
        }
        if (activeProcesses.size >= MAX_CONCURRENT_COMMANDS) {
            reject(Object.assign(
                new Error(`Too many concurrent commands (max ${MAX_CONCURRENT_COMMANDS}). Interrupt one or wait for completion.`),
                { code: 'TOO_MANY_CONCURRENT_COMMANDS' }
            ));
            return;
        }

        const entry = { child: null, interrupted: false, timedOut: false, timer: null, killTimer: null };
        const stop = () => {
            terminateEntry(entry);
            escalateToKill(entry);
        };
        const child = spawnShellCommand(command, {
            shell,
            cwd,
            maxBuffer: Math.max(effectiveMaxOutput * 4, 1024 * 1024)
        }, stop, (error, stdout, stderr) => {
            if (entry.timer) clearTimeout(entry.timer);
            // Keep a pending SIGKILL while descendants of an exited leader remain.
            if (!processGroupAlive(entry)) clearKillTimer(entry);
            if (activeProcesses.get(activityId) === entry) activeProcesses.delete(activityId);

            const output = [
                stdout || '',
                stderr ? '\n[stderr]\n' + stderr : '',
                error ? '\n[error]\n' + error.message : ''
            ].join('').trim();

            const outputTruncated = output.length > effectiveMaxOutput;
            const limitedOutput = outputTruncated ? sliceText(output, effectiveMaxOutput) : output;
            const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;

            resolve({
                activityId,
                output,
                limitedOutput,
                outputTruncated,
                exitCode,
                timedOut: entry.timedOut,
                interrupted: entry.interrupted,
                timeoutMs: effectiveTimeout,
                maxOutputChars: effectiveMaxOutput
            });
        });

        entry.child = child;
        entry.timer = setTimeout(() => {
            entry.timedOut = true;
            stop();
        }, effectiveTimeout);
        activeProcesses.set(activityId, entry);
    });
}

function interruptCommand(activityId) {
    let targetId = activityId;
    if (!targetId) {
        const ids = Array.from(activeProcesses.keys());
        if (ids.length === 0) return { interrupted: false, reason: 'none', activeIds: [] };
        if (ids.length > 1) return { interrupted: false, reason: 'ambiguous', activeIds: ids };
        [targetId] = ids;
    }

    const entry = activeProcesses.get(targetId);
    if (!entry || !entry.child) {
        return { interrupted: false, reason: 'not_found', activityId: targetId, activeIds: Array.from(activeProcesses.keys()) };
    }

    entry.interrupted = true;
    terminateEntry(entry);
    escalateToKill(entry);
    return { interrupted: true, activityId: targetId };
}

function getActiveCommandIds() {
    return Array.from(activeProcesses.keys());
}

// Used on /api/restart: interrupt every running command (SIGTERM, then SIGKILL
// after the grace period) so none keeps running after the server exits.
function terminateAll() {
    const entries = Array.from(activeProcesses.values());
    for (const entry of entries) {
        entry.interrupted = true;
        terminateEntry(entry);
        escalateToKill(entry);
    }
    return entries.length;
}

// Last step before process.exit(): a pending SIGKILL timer would never fire,
// so kill any group that is still alive right away.
function killPendingNow() {
    for (const entry of new Set([...pendingKills, ...activeProcesses.values()])) {
        clearKillTimer(entry);
        if (processGroupAlive(entry)) terminateEntry(entry, 'SIGKILL');
    }
}

module.exports = {
    COMMAND_TIMEOUT_MS,
    DEFAULT_SHELL,
    MAX_CWD_BYTES,
    KILL_GRACE_MS,
    MAX_CONCURRENT_COMMANDS,
    MAX_INLINE_COMMAND_BYTES,
    MAX_OUTPUT_CHARS,
    MAX_SCRIPT_BODY_BYTES,
    MAX_SHELL_BYTES,
    SAFE_MODE,
    executeBounded,
    findBlockedPattern,
    getActiveCommandIds,
    interruptCommand,
    killPendingNow,
    positiveInteger,
    resolveCwd,
    sanitizeCwd,
    sliceText,
    terminateAll
};
