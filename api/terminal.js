const { spawn } = require('child_process');

const MAX_OUTPUT_CHARS = parseInt(process.env.MAX_OUTPUT_CHARS || '12000', 10);
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || '120000', 10);
const SAFE_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.SAFE_MODE || 'false').toLowerCase());

const blockedCommandPatterns = [
    /rm\s+-rf\s+\/(?:\s|$)/,
    /\bmkfs(?:\.\