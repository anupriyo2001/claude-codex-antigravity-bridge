#!/usr/bin/env node
// One-step setup: installs missing agents from their official sources, walks you through sign-in,
// and registers the bridge with Claude Code (and optionally Codex / Antigravity) for a project.
//
//   node scripts/setup.mjs --project <path>            check, install what is missing, sign in, register
//   node scripts/setup.mjs --check                      report only, change nothing
//   options: --yes (no questions)  --no-install  --skip-signin  --claude-md (add usage rules to the
//            project's CLAUDE.md)  --register-codex  --register-antigravity  --skip-claude-cli
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'src', 'mcp-server.mjs');
const IS_WIN = process.platform === 'win32';
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const CHECK = flag('--check');
const YES = flag('--yes');
const PROJECT = opt('--project') ? path.resolve(opt('--project')) : null;
const TTY = process.stdin.isTTY && process.stdout.isTTY;

const say = (s = '') => console.log(s);
const ok = (s) => say(`  [ok]   ${s}`);
const warn = (s) => say(`  [!!]   ${s}`);
const todo = (s) => say(`  [todo] ${s}`);
const report = { installed: [], signed_in: [], registered: [], user_actions: [] };

async function ask(q) {
  if (YES) return true;
  if (!TTY) { warn(`${q} -> skipped (no terminal; rerun with --yes to allow)`); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ?      ${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

// npm is a .cmd shim on Windows and needs a shell; it only ever gets fixed, trusted arguments.
const needsShell = (cmd) => IS_WIN && cmd === 'npm';
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: needsShell(cmd), ...o });
const interactive = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', shell: needsShell(cmd) });
const has = (cmd) => run(IS_WIN ? 'where.exe' : 'which', [cmd]).status === 0;

async function loadCore() {
  // Fresh import each time so newly installed binaries are found.
  const core = await import(`../src/core.mjs?t=${Date.now()}`);
  return core;
}

// ---------------------------------------------------------------- prerequisites

say('\n== Prerequisites');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) { warn(`Node ${process.versions.node} is too old; install Node 18+ from https://nodejs.org`); process.exit(1); }
ok(`Node ${process.versions.node}`);
if (has('git')) ok('git'); else { warn('git not found: needed for patches. Install from https://git-scm.com'); report.user_actions.push('Install git'); }
const npmOk = has('npm');
if (npmOk) ok('npm'); else warn('npm not found (comes with Node) - Codex/Claude CLI installs need it');

// ---------------------------------------------------------------- Claude Code (orchestrator)

say('\n== Claude Code (orchestrator)');
const claudeCli = has('claude');
const winApps = (() => { try { return fs.readdirSync(path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps')); } catch { return []; } })();
const claudeDesktop = IS_WIN
  ? winApps.some((n) => /^claude-desktop\.exe$|^Claude_/i.test(n)) || fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude'))
    || fs.existsSync(path.join(process.env.APPDATA || '', 'Claude', 'claude-code'))
  : fs.existsSync('/Applications/Claude.app') || fs.existsSync(path.join(os.homedir(), 'Applications', 'Claude.app'));
if (claudeCli) ok('claude CLI found');
if (claudeDesktop) ok('Claude desktop app found (Code tab can use the bridge)');
if (!claudeCli && !claudeDesktop) {
  if (CHECK || flag('--no-install') || flag('--skip-claude-cli')) todo('Claude Code not found: npm install -g @anthropic-ai/claude-code');
  else if (npmOk && await ask('Install Claude Code CLI (npm install -g @anthropic-ai/claude-code)?')) {
    const r = interactive('npm', ['install', '-g', '@anthropic-ai/claude-code']);
    if (r.status === 0) { ok('Claude Code CLI installed'); report.installed.push('claude-code'); report.user_actions.push('Run `claude` once and sign in to your Anthropic account'); }
    else warn('Claude Code install failed (see npm output above)');
  }
}

// ---------------------------------------------------------------- Codex

say('\n== OpenAI Codex');
let core = await loadCore();
let codex = core.ADAPTERS.codex.resolve();
if (codex) ok(`found (${codex.source}): ${codex.bin}`);
else if (CHECK || flag('--no-install')) todo('Codex CLI missing: npm install -g @openai/codex');
else if (!npmOk) todo('Codex CLI missing and npm is unavailable: install Node.js, then npm install -g @openai/codex');
else if (await ask('Codex CLI is missing. Install it from npm (@openai/codex, official)?')) {
  const r = interactive('npm', ['install', '-g', '@openai/codex']);
  core = await loadCore(); codex = core.ADAPTERS.codex.resolve();
  if (r.status === 0 && codex) { ok(`installed: ${codex.bin}`); report.installed.push('codex'); }
  else warn('Codex install did not produce a usable CLI (open a new terminal and rerun setup)');
}
if (codex) {
  const st = await core.ADAPTERS.codex.status(codex);
  if (st.auth === 'ok') { ok(`signed in (${st.auth_detail})`); report.signed_in.push('codex'); }
  else if (CHECK || flag('--skip-signin')) todo('Codex sign-in needed: run `codex login`');
  else if (TTY) {
    say('         Opening Codex sign-in. Finish it in the browser window that opens.');
    interactive(codex.bin, [...codex.pre, 'login']);
    const again = await core.ADAPTERS.codex.status(codex);
    if (again.auth === 'ok') { ok('signed in'); report.signed_in.push('codex'); } else { warn('Codex still not signed in'); report.user_actions.push('Run `codex login`'); }
  } else report.user_actions.push('Run `codex login` in a terminal');
}

// ---------------------------------------------------------------- Antigravity

say('\n== Google Antigravity (agy CLI)');
let agy = core.ADAPTERS.antigravity.resolve();
if (agy) ok(`found: ${agy.bin}`);
else if (CHECK || flag('--no-install')) todo(IS_WIN ? 'agy missing: irm https://antigravity.google/cli/install.ps1 | iex' : 'agy missing: curl -fsSL https://antigravity.google/cli/install.sh | bash');
else if (await ask('Antigravity CLI (agy) is missing. Install it with Google\'s official installer?')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-install-'));
  const url = `https://antigravity.google/cli/install.${IS_WIN ? 'ps1' : 'sh'}`;
  const file = path.join(tmp, path.basename(url));
  const res = await fetch(url);
  if (!res.ok) warn(`download failed: ${res.status} ${url}`);
  else {
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    say(`         Downloaded the official installer (${fs.statSync(file).size} bytes); it verifies the binary's SHA-512 itself.`);
    const r = IS_WIN
      ? interactive('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file])
      : interactive('bash', [file]);
    core = await loadCore(); agy = core.ADAPTERS.antigravity.resolve();
    if (r.status === 0 && agy) { ok(`installed: ${agy.bin}`); report.installed.push('antigravity'); }
    else warn('agy install did not produce a usable CLI (see output above)');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (agy) {
  const st = await core.ADAPTERS.antigravity.status(agy);
  if (!st.headless_flags_verified) warn('this agy version lacks a headless flag the bridge uses; run `agy update`');
  if (CHECK || flag('--skip-signin')) todo('Antigravity sign-in is checked by a real run (skipped in --check)');
  else {
    const probe = run(agy.bin, ['-p', 'Reply with exactly: ok', '--output-format', 'json', '--print-timeout', '90s'], { timeout: 120000, input: '' });
    const env = core.parseJsonLoose((probe.stdout || '').trim().split(/\r?\n/).pop() || '');
    if (env?.status === 'SUCCESS') { ok('signed in (test prompt answered)'); report.signed_in.push('antigravity'); }
    else if (TTY) {
      say('         Antigravity needs a sign-in. The agy app opens now: sign in with Google in the browser, then exit agy (Ctrl+C or /exit).');
      interactive(agy.bin, []);
      const again = run(agy.bin, ['-p', 'Reply with exactly: ok', '--output-format', 'json', '--print-timeout', '90s'], { timeout: 120000, input: '' });
      if ((again.stdout || '').includes('"SUCCESS"')) { ok('signed in'); report.signed_in.push('antigravity'); }
      else { warn('Antigravity still not answering'); report.user_actions.push('Run `agy` once, sign in with Google, exit, then rerun setup'); }
    } else report.user_actions.push('Run `agy` in a terminal and sign in with Google');
  }
}

// ---------------------------------------------------------------- registration

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, b);
  return b;
}

if (PROJECT && !CHECK) {
  say(`\n== Register with Claude Code for ${PROJECT}`);
  if (!fs.existsSync(PROJECT)) { warn('project folder does not exist'); process.exit(1); }
  const mcpFile = path.join(PROJECT, '.mcp.json');
  let cfg = { mcpServers: {} };
  if (fs.existsSync(mcpFile)) {
    try { cfg = JSON.parse(fs.readFileSync(mcpFile, 'utf8')); cfg.mcpServers ??= {}; }
    catch { warn('.mcp.json is not valid JSON; leaving it untouched'); cfg = null; }
  }
  if (cfg) {
    const b = backup(mcpFile);
    cfg.mcpServers['agent-bridge'] = { type: 'stdio', command: process.execPath, args: [SERVER], env: { AGENT_BRIDGE_PROJECT: PROJECT } };
    fs.writeFileSync(mcpFile, `${JSON.stringify(cfg, null, 2)}\n`);
    ok(`wrote ${mcpFile}${b ? ` (backup: ${path.basename(b)})` : ''}`);
    report.registered.push('claude-code (.mcp.json)');
    report.user_actions.push('Start a new Claude Code session in the project and approve the "agent-bridge" MCP server');
  }
  if (flag('--claude-md')) {
    const md = path.join(PROJECT, 'CLAUDE.md');
    const snippet = fs.readFileSync(path.join(REPO, 'templates', 'CLAUDE.snippet.md'), 'utf8');
    const start = '<!-- agent-bridge:start -->'; const end = '<!-- agent-bridge:end -->';
    const block = `${start}\n${snippet.trim()}\n${end}\n`;
    const cur = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    const b = backup(md);
    const next = cur.includes(start) ? cur.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`), block) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}\n${block}`;
    fs.writeFileSync(md, next);
    ok(`CLAUDE.md routing rules ${cur.includes(start) ? 'updated' : 'added'}${b ? ` (backup: ${path.basename(b)})` : ''}`);
  }
  // Optional: let Codex / Antigravity act as orchestrator when Claude's own limit is reached.
  const envArgs = ['AGENT_BRIDGE_PROJECT=' + PROJECT];
  if (flag('--register-codex') && codex) {
    const r = run(codex.bin, [...codex.pre, 'mcp', 'add', 'agent-bridge', '--env', envArgs[0], '--', process.execPath, SERVER]);
    if (r.status === 0) { ok('registered in Codex (codex mcp add)'); report.registered.push('codex'); } else warn(`codex mcp add failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  }
  if (flag('--register-antigravity') && agy) {
    const r = run(agy.bin, ['mcp', 'add', '--env', envArgs[0], 'agent-bridge', process.execPath, SERVER], { input: '' });
    if (r.status === 0) { ok('registered in Antigravity (agy mcp add)'); report.registered.push('antigravity'); } else warn(`agy mcp add failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  }
} else if (!PROJECT) say('\n(no --project given: nothing registered. Rerun with --project <path> to connect a project.)');

// ---------------------------------------------------------------- summary

say('\n== Summary');
core = await loadCore();
for (const a of ['codex', 'antigravity']) {
  const r = core.ADAPTERS[a].resolve();
  say(`  ${a.padEnd(12)} ${r ? `ready (${r.source})` : 'NOT installed'}${report.signed_in.includes(a) ? ', signed in' : ''}`);
}
if (report.installed.length) say(`  installed now: ${report.installed.join(', ')}`);
if (report.registered.length) say(`  registered:    ${report.registered.join(', ')}`);
if (report.user_actions.length) { say('\n  Your remaining steps:'); report.user_actions.forEach((s, i) => say(`   ${i + 1}. ${s}`)); }
say('\n  Verify any time: node src/cli.mjs status   |   full test: node tests/run-tests.mjs --real\n');
