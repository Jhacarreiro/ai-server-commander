const { exec } = require('child_process');
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

        const entry = { child: null, interrupted: false, timedOut: false, timer: null };
        const child = exec(command, {
            shell,
            cwd,
            detached: process.platform !== 'win32',
            maxBuffer: Math.max(effectiveMaxOutput * 4, 1024 * 1024)
        }, (error, stdout, stderr) => {
            if (entry.timer) clearTimeout(entry.timer);
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
