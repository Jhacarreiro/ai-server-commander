const { executeBounded, parseRequest } = require('../api/terminal');
function assert(cond, label, details='') { if (!cond) throw new Error(label + (details ? ': ' + details : '')); console.log('PASS ' + label); }
(async () => {
  assert(typeof executeBounded === 'function', 'executeBounded export exists');
  assert(typeof parseRequest === 'function', 'parseRequest export exists');
  const ok = await executeBounded({ command: 'printf executor_ok', cwd: process.cwd(), timeoutMs: 5000, maxOutputChars: 12000, shell: '/bin/sh' });
  assert(ok.exitCode === 0 && ok.output === 'executor_ok', 'executeBounded captures stdout', JSON.stringify(ok));
  const fail = await executeBounded({ command: 'exit 7', cwd: process.cwd(), timeoutMs: 5000, maxOutputChars: 12000, shell: '/bin/sh' });
  assert(fail.exitCode === 7, 'executeBounded preserves non-zero exit', JSON.stringify(fail));
  const parsed = parseRequest({ method: 'POST', body: { mode: 'script', script: 'echo hi' }, query: {} });
  assert(parsed.mode === 'script' && parsed.script === 'echo hi', 'parseRequest script mode');
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
