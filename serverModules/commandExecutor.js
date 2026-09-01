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

const activeProcesses = new Map();

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

function processGroupAlive(pid, child) {
    if (process.platform === 'win32') return !!(child && child.exitCode === null);
    if (!pid) return false;
    try {
        // Probe the group first: a reaped leader can leave descendants
        // in the same pgid, and those still need SIGKILL.
        process.kill(-pid, 0);
        return true;
    } catch {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }
}

// exec() silently drops `detached`, so process-group signals never reach
// descendants. spawn() is what actually creates a new pgid.
function spawnShellCommand(command, options, callback) {
    const child = spawn(options.shell, ['-c', command], {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const maxBuffer = options.maxBuffer || 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;

    if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdoutBytes += Buffer.byteLength(chunk);
            if (stdoutBytes <= maxBuffer) stdout += chunk;
        });
    }
    if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderrBytes += Buffer.byteLength(chunk);
            if (stderrBytes <= maxBuffer) stderr += chunk;
        });
    }

    const done = (error) => {
        if (finished) return;
        finished = true;
        callback(error, stdout, stderr);
    };
    child.once('error', done);
    child.once('close', (code, signal) => {
        if (code === 0 && !signal) {
            done(null);
            return;
        }
        done(Object.assign(new Error('Command failed'), {
            code: typeof code === 'number' ? code : 1,
            signal
        }));
    });
    return child;
}

function clearKillTimer(entry) {
    if (!entry || !entry.killTimer) return;
    clearTimeout(entry.killTimer);
    entry.killTimer = null;
}

// A single SIGTERM is not enough: a child that traps/ignores TERM (or a
// defunct group member) would keep the request pending forever with no
// escalation. Wait briefly, then SIGKILL the group.
function escalateToKill(entry, graceMs = 1500) {
    if (!entry || !entry.child || !entry.child.pid) return;
    // A second interrupt must not restart the grace window; that would
    // let a caller delay SIGKILL indefinitely.
    if (entry.killTimer) return;
    const pid = entry.child.pid;
    const child = entry.child;

    entry.killTimer = setTimeout(() => {
        entry.killTimer = null;
        if (!processGroupAlive(pid, child)) return;
        try {
            if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
            else child.kill('SIGKILL');
        } catch {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
    }, graceMs);

    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
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

function executeBounded(options) {
    const {
        command,
        shell = process.env.SHELL || '/bin/bash',
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

        const entry = { child: null, interrupted: false, timedOut: false, timer: null, killTimer: null };
        const child = spawnShellCommand(command, {
            shell,
            cwd,
            maxBuffer: Math.max(effectiveMaxOutput * 4, 1024 * 1024)
        }, (error, stdout, stderr) => {
            if (entry.timer) clearTimeout(entry.timer);
            // Cancel SIGKILL only when the whole group is gone. If the
            // leader exited first, keep the pending escalation.
            if (!processGroupAlive(entry.child && entry.child.pid, entry.child)) clearKillTimer(entry);
            if (activeProcesses.get(activityId) === entry) activeProcesses.delete(activityId);

            const output = [
                stdout || '',
                stderr ? '\n[stderr]\n' + stderr : '',
                error ? '\n[error]\n' + error.message : ''
            ].join('').trim();

            const outputTruncated = output.length > effectiveMaxOutput;
            const limitedOutput = outputTruncated ? output.slice(0, effectiveMaxOutput) : output;
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
            terminateEntry(entry);
            escalateToKill(entry);
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

module.exports = {
    COMMAND_TIMEOUT_MS,
    MAX_CWD_BYTES,
    MAX_OUTPUT_CHARS,
    MAX_SCRIPT_BODY_BYTES,
    MAX_SHELL_BYTES,
    SAFE_MODE,
    executeBounded,
    findBlockedPattern,
    getActiveCommandIds,
    interruptCommand,
    positiveInteger,
    resolveCwd,
    sanitizeCwd
};
