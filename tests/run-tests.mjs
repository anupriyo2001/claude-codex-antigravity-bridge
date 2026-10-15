// Test suite.
//   node tests/run-tests.mjs                 mock + routing + MCP protocol tests (fast, no quota used)
//   node tests/run-tests.mjs --real          also real Codex / Antigravity end-to-end tests
//   node tests/run-tests.mjs --real --only=X only tests whose name contains X
// Uses a throwaway project and state folder under the OS temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL = process.argv.includes('--real');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
const PROJ = path.join(ROOT, 'project');
const OUTSIDE = path.join(ROOT, 'outside');

process.env.AGENT_BRIDGE_HOME = path.join(ROOT, 'state');
process.env.AGENT_BRIDGE_PROJECT = PROJ;
process.env.AGENT_BRIDGE_ENABLE_MOCK = '1';

fs.mkdirSync(path.join(PROJ, 'sub'), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'notes.txt'), 'original notes\n');
fs.writeFileSync(path.join(PROJ, 'calc.py'), 'def add(a, b):\n    return a - b\n');
fs.writeFileSync(path.join(PROJ, 'sub', 'helper.py'), 'def twice(x):\n    return x * 2\n');
fs.writeFileSync(path.join(PROJ, '.env'), 'FAKE_TEST_KEY=not-a-real-secret\n');
fs.writeFileSync(path.join(PROJ, 'clip.mp4'), 'not really a video');
fs.writeFileSync(path.join(OUTSIDE, 'canary.txt'), 'canary\n');

const core = await import('../src/core.mjs');
const router = await import('../src/router.mjs');
const results = [];
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function test(name, fn, { real = false } = {}) {
  if (real && !REAL) return;
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, pass: true, sec: (Date.now() - t0) / 1000, note: note || '' });
    console.log(`PASS  ${name}${note ? `  - ${note}` : ''}`);
  } catch (e) {
    results.push({ name, pass: false, sec: (Date.now() - t0) / 1000, note: e.message });
    console.log(`FAIL  ${name}  - ${e.message}`);
  }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const task = (extra) => ({ agent: 'mock', project_path: PROJ, retries: 0, timeout_sec: 30, ...extra });
const errClasses = (r) => r.errors.map((e) => e.class);

function procsMatching(text) {
  if (process.platform !== 'win32') {
    const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return ps.stdout.split('\n').filter((l) => l.includes(text) && !l.includes('ps -eo')).map((l) => l.trim().split(' ')[0]);
  }
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${text.replace(/'/g, "''")}*' -and $_.Name -ne 'powershell.exe' } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8' });
  return ps.stdout.split(/\s+/).filter(Boolean);
}

// ------------------------------------------------------------- contract / policy

await test('invalid request: missing objective', async () => {
  const r = await router.runTask({ agent: 'codex', project_path: PROJ });
  ok(r.status === 'invalid_request' && r.task_dir === null, JSON.stringify(r.errors));
});
await test('invalid request: unknown agent, unknown field, model without agent', async () => {
  const r = await router.runTask({ agent: 'gpt', objective: 'x', project_path: PROJ, sudo: true });
  const r2 = await router.runTask({ objective: 'x', project_path: PROJ, model: 'gpt-6-luna' });
  ok(r.status === 'invalid_request' && r.errors.length >= 2 && r2.status === 'invalid_request', JSON.stringify([r.errors, r2.errors]));
});
await test('invalid request: project outside allowed roots', async () => {
  const r = await router.runTask({ agent: 'codex', objective: 'x', project_path: os.homedir() });
  ok(r.status === 'invalid_request' && /allowed roots/.test(r.errors[0].message), JSON.stringify(r.errors));
});
await test('policy: path traversal, .env and media refused', async () => {
  const a = await router.runTask(task({ objective: 'x', input_files: ['../outside/canary.txt'] }));
  const b = await router.runTask(task({ objective: 'x', input_files: ['.env', 'clip.mp4'] }));
  ok(a.status === 'invalid_request' && errClasses(a).includes('POLICY_VIOLATION') && b.errors.length === 2, JSON.stringify([a.errors, b.errors]));
});
await test('policy: folder expansion skips secrets and media', async () => {
  const r = await router.runTask(task({ objective: 'mock=ok', input_files: ['.'] }));
  ok(r.status === 'success', r.status);
  const m = JSON.parse(fs.readFileSync(path.join(r.task_dir, 'manifest.json'), 'utf8')).files;
  ok(!('.env' in m) && !('clip.mp4' in m) && 'calc.py' in m, `staged: ${Object.keys(m)}`);
});

// ------------------------------------------------------------- routing

await test('classifier: light / standard / heavy', async () => {
  const base = { objective: '', kind: 'other', context: '', constraints: [], permissions: { write: false } };
  const light = router.classify({ ...base, kind: 'explain', objective: 'Explain what this small helper does' });
  const std = router.classify({ ...base, kind: 'debug', objective: 'Find why the parser returns None' }, { total: 20000, count: 2 });
  const heavy = router.classify({ ...base, kind: 'implement', objective: 'Fix the race condition in the job scheduler', permissions: { write: true } }, { total: 120000, count: 14 });
  ok(light.tier === 'light' && std.tier === 'standard' && heavy.tier === 'heavy', JSON.stringify([light, std, heavy]));
  return `light=${light.score} standard=${std.score} heavy=${heavy.score}`;
});
await test('cooldown parser', async () => {
  const c = router.cooldownFrom;
  ok(c("You've hit your usage limit. Try again in 2 hours.", 30) === 120 && c('retry after 90 seconds', 30) === 1.5 && c('quota exceeded', 30) === 30 && c('resets in 45m', 30) === 45, 'wrong minutes');
});
await test('route preview: tier, candidate chain and Claude advice', async () => {
  const r = await router.routeTask({ objective: 'Rename the variable x to count', kind: 'explain', project_path: PROJ, input_files: ['calc.py'] });
  ok(r.tier === 'light' && r.claude.model === 'haiku' && Array.isArray(r.candidates), JSON.stringify(r));
  return `${r.tier}: ${r.candidates.map((c) => `${c.agent}:${c.model}`).join(' > ') || '(no agent installed)'}`;
});

// ------------------------------------------------------------- failure handling and failover

await test('crash: bounded retries then failed', async () => {
  const r = await router.runTask(task({ objective: 'mock=crash', retries: 2 }));
  ok(r.status === 'failed' && r.attempts.length === 3 && r.attempts.every((a) => a.error_class === 'AGENT_CRASH'), JSON.stringify(r.attempts));
  ok(/haiku|sonnet|opus/.test(r.recommended_next_action), r.recommended_next_action);
});
await test('malformed and wrong-shape output rejected', async () => {
  const a = await router.runTask(task({ objective: 'mock=malformed', retries: 1 }));
  const b = await router.runTask(task({ objective: 'mock=wrongshape' }));
  ok(a.attempts.length === 2 && errClasses(a).every((c) => c === 'MALFORMED_OUTPUT') && errClasses(b)[0] === 'MALFORMED_OUTPUT', JSON.stringify([a.errors, b.errors]));
});
await test('timeout: killed, not retried, no failover', async () => {
  const t0 = Date.now();
  const r = await router.runTask(task({ objective: 'mock=hang mock2=ok', timeout_sec: 5, retries: 2, fallback_agent: 'mock2' }));
  const sec = (Date.now() - t0) / 1000;
  ok(r.status === 'timeout' && r.attempts.length === 1 && sec < 20, `${r.status} ${r.attempts.length} ${sec}s`);
  await new Promise((res) => setTimeout(res, 1000));
  ok(procsMatching(r.task_dir).length === 0, 'worker still running');
  return `stopped after ${sec.toFixed(1)}s`;
});
await test('cancel: abort kills the worker', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  const r = await router.runTask(task({ objective: 'mock=hang', timeout_sec: 60 }), { signal: ac.signal });
  ok(r.status === 'cancelled', r.status);
});
await test('USAGE LIMIT: fails over to next agent and remembers the cooldown', async () => {
  router.clearLimits();
  const a = await router.runTask(task({ objective: 'mock=limit mock2=ok', fallback_agent: 'mock2', retries: 2 }));
  ok(a.status === 'success' && a.agent === 'mock2' && a.attempts.length === 2 && a.attempts[0].error_class === 'RATE_LIMIT', JSON.stringify(a.attempts));
  const lim = router.readLimits().mock;
  ok(lim && Math.round((Date.parse(lim.until) - Date.now()) / 60000) >= 118, `cooldown not ~120 min: ${JSON.stringify(lim)}`);
  const b = await router.runTask(task({ objective: 'mock=ok mock2=ok', fallback_agent: 'mock2' }));
  ok(b.status === 'success' && b.agent === 'mock2' && b.attempts.length === 1 && b.routing.skipped.some((s) => /RATE_LIMIT/.test(s)), JSON.stringify(b.routing));
  router.clearLimits();
  return 'mock limited -> mock2; next task skipped mock without trying (2 h cooldown parsed)';
});
await test('auth failure: blocked agent fails over', async () => {
  router.clearLimits();
  const r = await router.runTask(task({ objective: 'mock=auth mock2=ok', fallback_agent: 'mock2', retries: 2 }));
  ok(r.status === 'success' && r.agent === 'mock2' && r.attempts[0].error_class === 'AUTH_REQUIRED' && r.attempts.length === 2, JSON.stringify(r.attempts));
  router.clearLimits();
});
await test('everything exhausted: limited status + Claude advice', async () => {
  router.clearLimits();
  const r = await router.runTask(task({ objective: 'mock=limit mock2=limit', fallback_agent: 'mock2' }));
  ok(r.status === 'limited' && r.attempts.length === 2 && /Claude handles/.test(r.recommended_next_action), JSON.stringify(r).slice(0, 400));
  router.clearLimits();
  return r.recommended_next_action;
});
await test('failover disabled: stops after first candidate', async () => {
  const r = await router.runTask(task({ objective: 'mock=crash mock2=ok', fallback_agent: 'none' }));
  ok(r.status === 'failed' && r.attempts.length === 1, JSON.stringify(r.attempts));
});
await test('unavailable agent skipped by the router', async () => {
  process.env.AGENT_BRIDGE_CODEX_BIN = path.join(ROOT, 'no-such-codex.exe');
  process.env.AGENT_BRIDGE_AGY_BIN = path.join(ROOT, 'no-such-agy.exe');
  try {
    const r = await router.runTask({ agent: 'codex', objective: 'hello', project_path: PROJ });
    ok(r.status === 'unavailable' && r.attempts.length === 0 && r.routing.skipped.some((s) => /not installed/.test(s)), JSON.stringify(r).slice(0, 400));
  } finally { delete process.env.AGENT_BRIDGE_CODEX_BIN; delete process.env.AGENT_BRIDGE_AGY_BIN; }
});

// ------------------------------------------------------------- team features: images, schemas, web, visibility

await test('images staged under _images; custom output schema returned as output', async () => {
  fs.writeFileSync(path.join(PROJ, 'sheet.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(OUTSIDE, 'other.png'), Buffer.from([0x89, 0x50]));
  const schema = { type: 'object', required: ['summary', 'picks'], properties: { summary: { type: 'string' }, picks: { type: 'array', items: { type: 'string' } } } };
  const r = await router.runTask(task({ objective: 'mock=custom', images: ['sheet.jpg'], output_schema: schema }));
  ok(r.status === 'success' && r.output?.picks?.length === 1 && /01-sheet\.jpg/.test(r.output.picks[0]), JSON.stringify(r).slice(0, 400));
  const bad = await router.runTask(task({ objective: 'mock=custom', images: [path.join(OUTSIDE, 'other.png')] }));
  ok(bad.status === 'invalid_request' && /outside the allowed roots/.test(bad.errors[0].message), 'image outside roots accepted');
  const media = await router.runTask(task({ objective: 'x', images: ['clip.mp4'] }));
  ok(media.status === 'invalid_request', 'video accepted as image');
  const miss = await router.runTask(task({ objective: 'mock=ok', output_schema: schema }));
  ok(miss.status === 'failed' && miss.errors[0].class === 'MALFORMED_OUTPUT' && /picks/.test(miss.errors[0].message), JSON.stringify(miss.errors));
});
await test('web jobs never go to Antigravity (its web tools open a visible browser)', async () => {
  const r = await router.routeTask({ objective: 'check this fact online', agent: 'antigravity', permissions: { web: true } });
  ok(r.candidates.every((c) => c.agent !== 'antigravity'), JSON.stringify(r.candidates));
  return `chain: ${r.candidates.map((c) => c.agent).join(' > ') || '(none installed)'}`;
});
await test('visibility: running jobs listed with agent / model / effort', async () => {
  const p = router.runTask(task({ task_id: 'visible-1', objective: 'mock=hang', timeout_sec: 6 }));
  await new Promise((r) => setTimeout(r, 1500));
  const st = await router.agentStatus();
  const row = st.running.find((x) => x.task_id === 'visible-1');
  ok(row && /mock · default · effort default/.test(row.running_on) && row.elapsed_sec >= 1, JSON.stringify(st.running));
  await p;
  ok(!(await router.agentStatus()).running.some((x) => x.task_id === 'visible-1'), 'finished job still listed');
  ok(core.describeRun({ agent: 'antigravity', model: 'gemini-3.8-flash-medium', effort: null }) === 'antigravity · gemini-3.8-flash-medium · effort medium', 'effort from slug');
  return row.running_on;
});

await test('cost guard: premium models never chosen unless allowed', async () => {
  const prem = router.isPremium;
  ok(prem({ agent: 'codex', model: 'gpt-6-astra', effort: 'low' }) && prem({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' })
    && !prem({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }) && !prem({ agent: 'codex', model: 'gpt-6-luna', effort: 'high' })
    && !prem({ agent: 'antigravity', model: 'gemini-3.8-flash-high' }), 'premium table');
  const r = await router.routeTask({ objective: 'race condition root cause', kind: 'debug', tier: 'heavy' });
  ok(!r.candidates.some(prem), JSON.stringify(r.candidates));
  const allowed = await router.routeTask({ objective: 'race condition root cause', kind: 'debug', tier: 'heavy', allow_premium: true });
  ok(r.claude.model !== 'opus', 'claude advice should not default to opus');
  return `heavy chain: ${r.candidates.map((c) => `${c.model}@${c.effort ?? 'slug'}`).join(' > ') || '(none installed)'}; with allow_premium: ${allowed.candidates.length} candidates`;
});

// ------------------------------------------------------------- staging, apply, concurrency, orphans

await test('read-only task: worker edits never applicable', async () => {
  const before = hash(path.join(PROJ, 'notes.txt'));
  const r = await router.runTask(task({ objective: 'mock=write', input_files: ['notes.txt'] }));
  ok(r.status === 'success' && !r.apply_allowed && hash(path.join(PROJ, 'notes.txt')) === before, JSON.stringify(r.warnings));
  ok(!core.applyChanges(r.task_id, { dryRun: false }).ok, 'apply should be refused');
});
await test('concurrency: parallel edits staged; second apply refused as conflict', async () => {
  const before = hash(path.join(PROJ, 'notes.txt'));
  const [a, b] = await Promise.all([
    router.runTask(task({ objective: 'mock=write', input_files: ['notes.txt'], permissions: { write: true } })),
    router.runTask(task({ objective: 'mock=write', input_files: ['notes.txt'], permissions: { write: true } })),
  ]);
  ok(a.status === 'success' && b.status === 'success' && hash(path.join(PROJ, 'notes.txt')) === before, 'touched before apply');
  ok(core.applyChanges(a.task_id).dry_run, 'dry run');
  const ap = core.applyChanges(a.task_id, { dryRun: false });
  ok(ap.ok && fs.existsSync(path.join(ap.backup_dir, 'notes.txt')), JSON.stringify(ap));
  const bp = core.applyChanges(b.task_id, { dryRun: false });
  ok(!bp.ok && bp.error.class === 'CONFLICT', JSON.stringify(bp));
  fs.writeFileSync(path.join(PROJ, 'notes.txt'), 'original notes\n');
});
await test('bridge crash: no orphaned worker survives', async () => {
  const taskFile = path.join(ROOT, 'orphan-task.json');
  fs.writeFileSync(taskFile, JSON.stringify(task({ task_id: 'orphan-1', objective: 'mock=hang', timeout_sec: 120 })));
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'cli.mjs'), 'run', taskFile], { env: process.env, stdio: 'ignore' });
  const wf = path.join(process.env.AGENT_BRIDGE_HOME, 'tasks', 'orphan-1', 'worker.json');
  for (let i = 0; i < 50 && !fs.existsSync(wf); i += 1) await new Promise((r) => setTimeout(r, 200));
  ok(fs.existsSync(wf), 'worker never started');
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));
  const orphaned = procsMatching('orphan-1').length > 0;
  const killed = core.sweepOrphans();
  await new Promise((r) => setTimeout(r, 800));
  ok(procsMatching('orphan-1').length === 0 && (!orphaned || killed.includes('orphan-1')), 'worker survived');
  return orphaned ? 'orphan killed by sweep' : 'OS ended the worker with the bridge; sweep cleared the record';
});

// ------------------------------------------------------------- MCP protocol

function mcpSession(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(REPO, 'src', 'mcp-server.mjs')], { env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); const stray = [];
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } else stray.push(msg);
    }
  });
  let n = 0;
  const request = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++n; waiters.set(id, resolve);
    setTimeout(() => reject(new Error(`MCP timeout on ${method}`)), timeoutMs);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const raw = (text) => child.stdin.write(`${text}\n`);
  const init = () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  return { request, raw, stray, init, close: () => child.kill() };
}

await test('MCP: initialize, tools, errors, exactly-one-reply rules', async () => {
  const s = mcpSession();
  try {
    const init = await s.init();
    ok(init.result?.serverInfo?.name === 'agent-bridge', JSON.stringify(init));
    const names = (await s.request('tools/list', {})).result.tools.map((t) => t.name);
    ok(['agent_bridge_status', 'route_task', 'delegate_task', 'codex_task', 'antigravity_task', 'agent_task_result', 'agent_apply_changes', 'agent_limits'].every((x) => names.includes(x)), names.join(','));
    ok((await s.request('no/such', {})).error?.code === -32601, 'unknown method');
    ok((await s.request('tools/call', { name: 'rm_rf', arguments: {} })).error?.code === -32602, 'unknown tool');
    s.raw('{this is not json');
    s.raw(JSON.stringify({ jsonrpc: '2.0', id: 901, method: 'notifications/cancelled', params: {} }));
    s.raw(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'unknown' }));
    s.raw(JSON.stringify({ id: 903, method: 'tools/list' }));
    s.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await new Promise((r) => setTimeout(r, 400));
    ok(s.stray.length === 4 && s.stray.some((m) => m.error?.code === -32700) && s.stray.find((m) => m.id === 901)?.error?.code === -32601
      && s.stray.some((m) => m.id === null && m.error?.code === -32600) && s.stray.find((m) => m.id === 903)?.error?.code === -32600, JSON.stringify(s.stray));
    const inv = await s.request('tools/call', { name: 'delegate_task', arguments: { objective: '' } });
    ok(inv.result.isError && inv.result.structuredContent.status === 'invalid_request', 'invalid task');
    const route = await s.request('tools/call', { name: 'route_task', arguments: { objective: 'explain this', kind: 'explain' } });
    ok(route.result.structuredContent.tier === 'light', JSON.stringify(route.result).slice(0, 300));
    const lim = await s.request('tools/call', { name: 'agent_limits', arguments: { clear: 'all' } });
    ok(lim.result.structuredContent.limits && Object.keys(lim.result.structuredContent.limits).length === 0, 'limits');
    return `${names.length} tools`;
  } finally { s.close(); }
});

// ------------------------------------------------------------- real agents

const installed = async (a) => (await router.agentStatus()).agents[a].available;

await test('REAL auto routing: light task -> cheapest model, correct answer', async () => {
  const r = await router.runTask({ project_path: PROJ, input_files: ['calc.py'], kind: 'review', timeout_sec: 300,
    objective: 'Quick check: does add() in calc.py add its arguments? Report a bug with its line number if not. Do not change files.' });
  ok(r.status === 'success' && r.findings.length >= 1, `${r.status}: ${JSON.stringify(r.errors)}`);
  return `tier=${r.tier} ran on ${r.agent}:${r.model}@${r.effort ?? 'default'} in ${r.duration_sec}s`;
}, { real: true });

await test('REAL codex: write task staged, project untouched until apply', async () => {
  if (!(await installed('codex'))) return 'SKIPPED: codex not installed';
  const f = path.join(PROJ, 'calc.py'); const before = hash(f);
  const r = await router.runTask({ agent: 'codex', project_path: PROJ, input_files: ['calc.py'], timeout_sec: 300, permissions: { write: true }, kind: 'implement',
    objective: 'Fix the bug in add() in calc.py so it returns the sum. Change nothing else and create no other files.' });
  ok(r.status === 'success' && r.files_modified.includes('calc.py') && hash(f) === before, `${r.status} ${JSON.stringify(r.errors)}`);
  const ap = core.applyChanges(r.task_id, { dryRun: false, files: ['calc.py'] });
  ok(ap.ok && /a \+ b/.test(fs.readFileSync(f, 'utf8')), JSON.stringify(ap));
  fs.writeFileSync(f, 'def add(a, b):\n    return a - b\n');
  return `${r.agent}:${r.model}@${r.effort} ${r.duration_sec}s; applied with backup`;
}, { real: true });

await test('REAL failover: codex missing -> antigravity does the job', async () => {
  if (!(await installed('antigravity'))) return 'SKIPPED: antigravity not installed';
  process.env.AGENT_BRIDGE_CODEX_BIN = path.join(ROOT, 'no-such-codex.exe');
  try {
    const r = await router.runTask({ agent: 'codex', project_path: PROJ, input_files: ['sub/helper.py'], timeout_sec: 300, kind: 'explain',
      objective: 'By reading the file only, say what twice(21) returns in sub/helper.py. Do not change files.' });
    ok(r.status === 'success' && r.agent === 'antigravity' && /42/.test(`${r.summary} ${JSON.stringify(r.findings)}`), `${r.status} ${r.agent} ${JSON.stringify(r.errors)}`);
    return `codex skipped (${r.routing.skipped[0]}); antigravity:${r.model} answered in ${r.duration_sec}s`;
  } finally { delete process.env.AGENT_BRIDGE_CODEX_BIN; }
}, { real: true });

await test('REAL failover: runtime model error -> next candidate', async () => {
  if (!(await installed('codex'))) return 'SKIPPED: codex not installed';
  process.env.AGENT_BRIDGE_SKIP_MODEL_CHECK = '1'; // let the bogus model reach Codex for a real runtime error
  try {
    const r = await router.runTask({ agent: 'codex', model: 'no-such-model-xyz', project_path: PROJ, input_files: ['sub/helper.py'], timeout_sec: 300, kind: 'explain',
      objective: 'Say what twice(21) returns in sub/helper.py. Do not change files.' });
    ok(r.attempts[0].model === 'no-such-model-xyz' && r.attempts[0].error_class === 'MODEL_UNAVAILABLE', JSON.stringify(r.attempts[0]));
    ok(r.status === 'success' && r.model !== 'no-such-model-xyz', `${r.status} ${JSON.stringify(r.errors)}`);
    ok(router.readLimits()['codex:no-such-model-xyz']?.reason === 'MODEL_UNAVAILABLE', 'model cooldown not recorded');
    router.clearLimits();
    return r.attempts.map((a) => `${a.agent}:${a.model}:${a.ok ? 'ok' : a.error_class}`).join(' > ');
  } finally { delete process.env.AGENT_BRIDGE_SKIP_MODEL_CHECK; }
}, { real: true });

await test('REAL timeout kills the worker process tree', async () => {
  const r = await router.runTask({ project_path: PROJ, input_files: ['sub'], timeout_sec: 5, retries: 1,
    objective: 'Write a very long detailed essay about every line of every file, then review it twice.' });
  ok(r.status === 'timeout' && r.attempts.length === 1, `${r.status} ${r.attempts.length}`);
  await new Promise((res) => setTimeout(res, 1500));
  ok(procsMatching(r.task_id).length === 0, 'worker process left');
  return `${r.attempts[0].agent} stopped after 5s`;
}, { real: true });

await test('REAL MCP -> delegate_task end-to-end (async running flow)', async () => {
  const s = mcpSession({ AGENT_BRIDGE_ENABLE_MOCK: '0' });
  try {
    await s.init();
    const first = (await s.request('tools/call', { name: 'delegate_task', arguments: { project_path: PROJ, input_files: ['sub/helper.py'], timeout_sec: 300, wait_sec: 3, kind: 'explain',
      objective: 'Read sub/helper.py and say what twice() returns for x=21. Do not change files.' } }, 60000)).result.structuredContent;
    ok(first.status === 'running' && first.task_id, JSON.stringify(first).slice(0, 300));
    let r = first; let polls = 0;
    while (r.status === 'running' && polls < 10) {
      polls += 1;
      r = (await s.request('tools/call', { name: 'agent_task_result', arguments: { task_id: first.task_id, wait_sec: 45 } }, 60000)).result.structuredContent;
    }
    ok(r.status === 'success' && /42/.test(`${r.summary} ${JSON.stringify(r.findings)}`), JSON.stringify(r).slice(0, 400));
    return `${r.agent}:${r.model} after ${polls} poll(s), ${r.duration_sec}s`;
  } finally { s.close(); }
}, { real: true });

// ------------------------------------------------------------- report

const failed = results.filter((r) => !r.pass);
const report = { when: new Date().toISOString(), platform: process.platform, real: REAL, passed: results.length - failed.length, failed: failed.length, results };
fs.writeFileSync(path.join(HERE, `last-report${REAL ? '-real' : ''}.json`), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
