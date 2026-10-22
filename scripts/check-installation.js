#!/usr/bin/env node
'use strict';
// Standalone and read-only: safe to keep outside the release being monitored.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const criticalFiles = [
    'main.js', 'serverModules/pluginServer.js', 'serverModules/configHandler.js',
    'serverModules/commandExecutor.js', 'serverModules/commandOperations.js',
    'serverModules/auth.js', 'serverModules/oauthStore.js', 'serverModules/logger.js',
    'serverModules/swaggerSetup.js', 'api/terminal.js', 'api/mcp.js', 'api/oauth.js',
    'api/activityLog.js', 'api/notices.js'
];
function object(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function readText(file) {
    const metadata = fs.statSync(file);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new Error('invalid_input_file');
    return fs.readFileSync(file, 'utf8');
}
function inside(parent, target) {
    const relative = path.relative(parent, target);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function inspectInstallation(options) {
    const checks = [];
    function check(name, operation) {
        try { operation(); checks.push({ name, ok: true }); return true; }
        catch { checks.push({ name, ok: false }); return false; }
    }
    const requireCondition = condition => { if (!condition) throw new Error('check_failed'); };
    const release = path.resolve(options.release);
    const config = path.resolve(options.config);
    const runtime = path.resolve(options.runtime);
    check('release_directory', () => requireCondition(fs.statSync(release).isDirectory()));
    check('node_executable', () => {
        const executable = options.node || process.execPath;
        requireCondition(fs.statSync(executable).isFile());
        fs.accessSync(executable, fs.constants.R_OK | fs.constants.X_OK);
    });
    let configuration;
    check('configuration_json', () => {
        configuration = JSON.parse(readText(config).replace(/^\uFEFF/, ''));
        requireCondition(object(configuration));
    });
    check('persistent_state_layout', () => {
        const parent = path.dirname(fs.realpathSync(release));
        requireCondition(!inside(parent, fs.realpathSync(config)));
        requireCondition(!inside(parent, fs.realpathSync(runtime)));
        requireCondition(fs.statSync(runtime).isDirectory());
        fs.accessSync(runtime, fs.constants.R_OK);
    });
    for (const [name, target] of [['config.json', config], ['runtime', runtime]]) {
        check('direct_link:' + name, () => {
            const link = path.join(release, name);
            requireCondition(fs.lstatSync(link).isSymbolicLink());
            const destination = fs.readlinkSync(link);
            // Directory aliases are valid (for example, an aliased state root).
            // Keep the final target direct: a link through another release's
            // config/runtime entry could disappear when that release is removed.
            requireCondition(path.isAbsolute(destination));
            requireCondition(!fs.lstatSync(destination).isSymbolicLink());
            requireCondition(fs.realpathSync(destination) === fs.realpathSync(target));
        });
    }
    for (const file of criticalFiles) {
        check('source:' + file, () => {
            const source = readText(path.join(release, file));
            new vm.Script(source, { filename: file });
        });
    }
    check('package_dependencies', () => {
        const packagePath = path.join(release, 'package.json');
        const metadata = JSON.parse(readText(packagePath));
        const resolve = createRequire(packagePath).resolve;
        for (const name of Object.keys(metadata.dependencies || {})) fs.accessSync(resolve(name), fs.constants.R_OK);
    });
    const oauth = options.oauthState || process.env.OAUTH_STATE_PATH || configuration?.oauthStatePath || path.join(runtime, 'oauth-state.json');
    check('oauth_state', () => {
        requireCondition(path.isAbsolute(oauth));
        if (!fs.existsSync(oauth) && !options.requireOAuthState) return;
        const data = JSON.parse(readText(oauth));
        requireCondition(data.version === 1 && ['clients', 'authCodes', 'accessTokens', 'refreshTokens'].every(key => object(data[key])));
    });
    for (const [index, executable] of (options.executables || []).entries()) {
        check('additional_executable:' + (index + 1), () => {
            requireCondition(fs.statSync(executable).isFile());
            fs.accessSync(executable, fs.constants.R_OK | fs.constants.X_OK);
        });
    }
    return { ok: checks.every(item => item.ok), readOnly: true, checks };
}

function parseArgs(args) {
    const options = { executables: [] };
    const fields = { '--release': 'release', '--config': 'config', '--runtime': 'runtime', '--node': 'node', '--oauth-state': 'oauthState' };
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (flag === '--require-oauth-state') options.requireOAuthState = true;
        else if (flag === '--require-executable') options.executables.push(args[++index]);
        else if (fields[flag]) {
            const value = args[++index];
            if (!value || !path.isAbsolute(value)) throw new Error('absolute_paths_required');
            options[fields[flag]] = value;
        }
        else throw new Error('invalid_arguments');
    }
    const values = ['release', 'config', 'runtime', 'node', 'oauthState'].map(key => options[key]).filter(value => value !== undefined);
    if (!options.release || !options.config || !options.runtime || values.some(value => !path.isAbsolute(value)) || options.executables.some(value => !value || !path.isAbsolute(value))) {
        throw new Error('absolute_paths_required');
    }
    return options;
}
if (require.main === module) {
    try {
        const result = inspectInstallation(parseArgs(process.argv.slice(2)));
        console.log(JSON.stringify(result));
        process.exitCode = result.ok ? 0 : 1;
    } catch {
        console.log(JSON.stringify({ ok: false, readOnly: true, error: 'invalid_arguments', usage: '--release PATH --config PATH --runtime PATH [--node PATH] [--oauth-state PATH] [--require-oauth-state] [--require-executable PATH]' }));
        process.exitCode = 2;
    }
}
module.exports = { inspectInstallation };
