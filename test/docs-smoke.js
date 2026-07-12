const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
    'README.md', 'CHANGELOG.md', 'ROADMAP.md', 'LICENSE', 'NOTICE.md',
    'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md',
    'config.example.json', '.env.example', 'docs/architecture.md', 'docs/deployment.md'
];
const requiredReadmeSections = [
    '## Features', '## Quick start', '## ChatGPT Custom GPT Actions',
    '## Remote MCP clients', '## Security model', '## Testing', '## Troubleshooting'
];
const privateMarkers = [
    /gpt-terminal\.gallivanter/i,
    /192\.168\.\d+\.\d+/,
    /\/home\/AIcenas/,
    /joaocarreiro@gmail/i
];

function assert(condition, label, details = '') {
    if (!condition) throw new Error(`${label}${details ? ': ' + details : ''}`);
    console.log(`PASS ${label}`);
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full);
        if (entry.isDirectory()) {
            if (['.git', 'node_modules', 'runtime', '.claude-octopus'].includes(entry.name)) return [];
            return walk(full);
        }
        return [relative];
    });
}

for (const relative of requiredFiles) {
    assert(fs.existsSync(path.join(root, relative)), `required documentation exists: ${relative}`);
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const heading of requiredReadmeSections) {
    assert(readme.includes(heading), `README includes ${heading}`);
}

const missingLinks = [];
for (const relative of walk(root).filter((file) => file.endsWith('.md'))) {
    const full = path.join(root, relative);
    const text = fs.readFileSync(full, 'utf8');
    const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
    let match;
    while ((match = linkPattern.exec(text))) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const local = target.split('#', 1)[0];
        if (local && !fs.existsSync(path.resolve(path.dirname(full), local))) {
            missingLinks.push(`${relative} -> ${target}`);
        }
    }
}
assert(missingLinks.length === 0, 'all local Markdown links resolve', missingLinks.join('; '));

const privateHits = [];
const textFiles = walk(root).filter((file) =>
    file !== 'test/docs-smoke.js' &&
    (/\.(?:md|js|json|yml|yaml|example)$/.test(file) || ['LICENSE', '.nvmrc'].includes(file))
);
for (const relative of textFiles) {
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    const matched = privateMarkers.find((marker) => marker.test(text));
    if (matched) privateHits.push(relative);
}
assert(privateHits.length === 0, 'no private deployment markers in public text files', privateHits.join(', '));
