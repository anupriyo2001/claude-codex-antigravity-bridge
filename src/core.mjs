// Core of the Claude Code + Codex + Antigravity bridge.
// Workers only ever run inside an isolated staged copy; changes reach the project only through
// applyChanges(), which the orchestrator calls after reviewing the patch.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'config.json'), 'utf8'));
export const LIMITS = CONFIG.limits;
export const STATE_DIR = process.env.AGENT_BRIDGE_HOME || CONFIG.state_dir
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'agent-bridge');
const WORKER_SCHEMA_PATH = path.join(REPO_DIR, 'schemas', 'worker-output.schema.json');
const IS_WIN = process.platform === 'win32';

// Default project = AGENT_BRIDGE_PROJECT, else the directory the host started the server in.
export const DEFAULT_PROJECT = path.resolve(process.env.AGENT_BRIDGE_PROJECT || process.cwd());
const splitRoots = (v) => (v || '').split(path.delimiter === ';' ? ';' : /[;:]/).filter(Boolean).map((r) => path.resolve(r));
export const ALLOWED_ROOTS = [...new Set([
  DEFAULT_PROJECT,
  ...CONFIG.allowed_roots.map((r) => path.resolve(REPO_DIR, r)),
  ...splitRoots(process.env.AGENT_BRIDGE_ROOTS),
  ...splitRoots(process.env.AGENT_BRIDGE_EXTRA_ROOTS),
])];

// ---------------------------------------------------------------- policy

const DENY_NAME = [
  /^\.env(\..*)?$/i, /\.(pem|key|pfx|p12|crt|cer|kdbx|ppk|keystore|jks)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /credential/i, /secret/i, /^auth\.json$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /\.(sqlite3?|db)(-wal|-shm|-journal)?$/i, /^cookies?$/i, /^login data$/i,
];
const DENY_DIR = new Set(['.git', 'node_modules', '__pycache__', '.ssh', '.aws', '.azure', '.gnupg',
  '.codex', '.gemini', '.claude-credentials', '.venv', 'venv']);
const BINARY_EXT = /\.(mp4|mov|mkv|avi|webm|m4v|m4a|mp3|wav|flac|aac|ogg|opus|png|jpe?g|gif|webp|bmp|tiff?|ico|psd|blend\d?|exr|hdr|ttf|otf|woff2?|zip|7z|rar|gz|tar|exe|dll|so|dylib|bin|pyc|pdf|pak|asar)$/i;

export function deniedReason(rel) {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const p of parts.slice(0, -1)) if (DENY_DIR.has(p.toLowerCase())) return `inside protected folder "${p}"`;
  const base = parts[parts.length - 1] || '';
  if (DENY_NAME.some((re) => re.test(base))) return 'looks like a secret/credential/database file';
  if (BINARY_EXT.test(base)) return 'binary or media file (never sent to external agents)';
  return null;
}

export const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// ---------------------------------------------------------------- contract

export const ERROR = {
  INVALID_REQUEST: 'INVALID_REQUEST', POLICY: 'POLICY_VIOLATION', UNAVAILABLE: 'AGENT_UNAVAILABLE',
  UNSUPPORTED: 'UNSUPPORTED', AUTH: 'AUTH_REQUIRED', TIMEOUT: 'TIMEOUT', CRASH: 'AGENT_CRASH',
  MALFORMED: 'MALFORMED_OUTPUT', RATE_LIMIT: 'RATE_LIMIT', MODEL: 'MODEL_UNAVAILABLE', CANCELLED: 'CANCELLED',
  CONFLICT: 'CONFLICT', DENIED: 'PERMISSION_DENIED', INTERNAL: 'INTERNAL',
};
export const AGENTS = ['codex', 'antigravity'];
const RETRY_SAME = new Set([ERROR.CRASH, ERROR.MALFORMED]);
// These move on to the next candidate (another model or agent) instead of stopping the task.
const FAIL_OVER = new Set([ERROR.RATE_LIMIT, ERROR.MODEL, ERROR.AUTH, ERROR.UNAVAILABLE, ERROR.UNSUPPORTED, ERROR.CRASH, ERROR.MALFORMED, ERROR.DENIED]);
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KINDS = ['explain', 'summarize', 'review', 'test', 'analyze', 'debug', 'implement', 'design', 'other'];
const KNOWN_KEYS = new Set(['task_id', 'agent', 'objective', 'project_path', 'input_files', 'context', 'constraints',
  'expected_output', 'timeout_sec', 'retries', 'permissions', 'kind', 'tier', 'model', 'effort', 'failover', 'fallback_agent',
  'images', 'output_schema', 'allow_premium']);
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const MAX_IMAGES = 16;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const mockEnabled = () => process.env.AGENT_BRIDGE_ENABLE_MOCK === '1';
export const agentNames = () => (mockEnabled() ? [...AGENTS, 'mock', 'mock2'] : AGENTS);

export function newTaskId() {
  const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `t${d}-${crypto.randomBytes(3).toString('hex')}`;
}

export function validateRequest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['request must be a JSON object'] };
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) errors.push(`unknown field "${k}"`);
  const req = {
    task_id: raw.task_id ?? newTaskId(),
    agent: raw.agent ?? 'auto',
    objective: raw.objective,
    project_path: path.resolve(raw.project_path ?? DEFAULT_PROJECT),
    input_files: raw.input_files ?? [],
    context: raw.context ?? '',
    constraints: raw.constraints ?? [],
    expected_output: raw.expected_output ?? '',
    timeout_sec: raw.timeout_sec ?? LIMITS.default_timeout_sec,
    retries: raw.retries ?? LIMITS.default_retries,
    permissions: { write: raw.permissions?.write === true, web: raw.permissions?.web === true },
    images: raw.images ?? [],
    output_schema: raw.output_schema ?? null,
    kind: raw.kind ?? 'other',
    tier: raw.tier ?? 'auto',
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    failover: raw.failover !== false,
    allow_premium: raw.allow_premium === true,
    fallback_agent: raw.fallback_agent ?? null,
  };
  if (typeof req.task_id !== 'string' || !TASK_ID_RE.test(req.task_id)) errors.push('task_id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$');
  if (req.agent !== 'auto' && !agentNames().includes(req.agent)) errors.push(`agent must be auto, ${AGENTS.join(' or ')}`);
  if (typeof req.objective !== 'string' || !req.objective.trim()) errors.push('objective is required');
  else if (req.objective.length > 8000) errors.push('objective is longer than 8000 characters');
  if (typeof req.context !== 'string' || req.context.length > 20000) errors.push('context must be a string of at most 20000 characters');
  if (typeof req.expected_output !== 'string' || req.expected_output.length > 4000) errors.push('expected_output must be a string of at most 4000 characters');
  if (!Array.isArray(req.constraints) || req.constraints.length > 50 || req.constraints.some((c) => typeof c !== 'string')) errors.push('constraints must be an array of up to 50 strings');
  if (!Array.isArray(req.input_files) || req.input_files.length > LIMITS.max_files || req.input_files.some((f) => typeof f !== 'string' || !f)) errors.push(`input_files must be an array of up to ${LIMITS.max_files} relative paths`);
  if (!Number.isInteger(req.timeout_sec) || req.timeout_sec < LIMITS.min_timeout_sec || req.timeout_sec > LIMITS.max_timeout_sec) errors.push(`timeout_sec must be an integer from ${LIMITS.min_timeout_sec} to ${LIMITS.max_timeout_sec}`);
  if (!Number.isInteger(req.retries) || req.retries < 0 || req.retries > LIMITS.max_retries) errors.push(`retries must be an integer from 0 to ${LIMITS.max_retries}`);
  if (!KINDS.includes(req.kind)) errors.push(`kind must be one of: ${KINDS.join(', ')}`);
  if (!['auto', 'light', 'standard', 'heavy'].includes(req.tier)) errors.push('tier must be auto, light, standard or heavy');
  if (req.model !== null && (typeof req.model !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(req.model))) errors.push('model must be a model slug');
  if (req.model !== null && req.agent === 'auto') errors.push('model needs a specific agent (codex or antigravity)');
  if (req.effort !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(req.effort)) errors.push('effort must be low, medium, high, xhigh or max');
  if (req.fallback_agent !== null && req.fallback_agent !== 'none' && !agentNames().includes(req.fallback_agent)) errors.push('fallback_agent must be codex, antigravity or none');
  if (req.fallback_agent === 'none') req.failover = false;
  if (raw.permissions !== undefined && (typeof raw.permissions !== 'object' || Object.keys(raw.permissions).some((k) => !['write', 'web'].includes(k)))) errors.push('permissions supports {"write": boolean, "web": boolean}');
  if (!Array.isArray(req.images) || req.images.length > MAX_IMAGES || req.images.some((f) => typeof f !== 'string' || !IMAGE_EXT.test(f))) errors.push(`images must be up to ${MAX_IMAGES} .jpg/.png/.webp paths`);
  if (req.output_schema !== null && (typeof req.output_schema !== 'object' || Array.isArray(req.output_schema) || req.output_schema.type !== 'object')) errors.push('output_schema must be a JSON Schema object with "type": "object"');
  else if (req.output_schema && JSON.stringify(req.output_schema).length > 20000) errors.push('output_schema is too large');
  if (!ALLOWED_ROOTS.some((r) => isInside(req.project_path, r))) errors.push(`project_path is outside the allowed roots (${ALLOWED_ROOTS.join('; ')})`);
  else if (!fs.existsSync(req.project_path) || !fs.statSync(req.project_path).isDirectory()) errors.push('project_path does not exist or is not a folder');
  return { errors, req };
}

export function expandInputs(req) {
  const errors = []; const warnings = []; const files = new Map(); let total = 0;
  const addFile = (abs, rel, explicit) => {
    const why = deniedReason(rel);
    if (why) { (explicit ? errors : warnings).push(`${explicit ? 'refused' : 'skipped'} ${rel}: ${why}`); return; }
    const size = fs.statSync(abs).size;
    if (size > LIMITS.max_file_bytes) { (explicit ? errors : warnings).push(`${explicit ? 'refused' : 'skipped'} ${rel}: larger than ${LIMITS.max_file_bytes} bytes`); return; }
    total += size; files.set(rel, abs);
  };
  const walk = (absDir, relDir) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = path.join(relDir, ent.name);
      if (ent.isSymbolicLink()) { warnings.push(`skipped ${rel}: symbolic link`); continue; }
      if (ent.isDirectory()) { if (DENY_DIR.has(ent.name.toLowerCase())) warnings.push(`skipped ${rel}: protected folder`); else walk(path.join(absDir, ent.name), rel); }
      else if (ent.isFile()) addFile(path.join(absDir, ent.name), rel, false);
    }
  };
  for (const item of req.input_files) {
    if (path.isAbsolute(item)) { errors.push(`refused ${item}: input_files must be relative to project_path`); continue; }
    const abs = path.resolve(req.project_path, item);
    if (!isInside(abs, req.project_path)) { errors.push(`refused ${item}: escapes project_path`); continue; }
    if (!fs.existsSync(abs)) { errors.push(`refused ${item}: does not exist`); continue; }
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) { errors.push(`refused ${item}: symbolic link`); continue; }
    const rel = path.relative(req.project_path, abs);
    if (st.isDirectory()) {
      const why = rel && deniedReason(path.join(rel, 'x.txt'));
      if (why) { errors.push(`refused ${item}: ${why}`); continue; }
      walk(abs, rel);
    } else addFile(abs, rel, true);
  }
  if (files.size > LIMITS.max_files) errors.push(`too many files (${files.size} > ${LIMITS.max_files})`);
  if (total > LIMITS.max_total_bytes) errors.push(`input too large (${total} > ${LIMITS.max_total_bytes} bytes)`);
  return { errors, warnings, files, total };
}

// Images (contact sheets, thumbnails, preview frames) for vision jobs. They may live in the project or
// in any allowed root (e.g. an external media folder) and are staged under `_images/`. Video/audio never.
export function expandImages(req) {
  const errors = []; const files = new Map(); let total = 0;
  req.images.forEach((item, n) => {
    const abs = path.isAbsolute(item) ? path.resolve(item) : path.resolve(req.project_path, item);
    if (!ALLOWED_ROOTS.some((r) => isInside(abs, r))) { errors.push(`refused image ${item}: outside the allowed roots`); return; }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { errors.push(`refused image ${item}: does not exist`); return; }
    if (fs.lstatSync(abs).isSymbolicLink()) { errors.push(`refused image ${item}: symbolic link`); return; }
    const size = fs.statSync(abs).size;
    if (size > MAX_IMAGE_BYTES) { errors.push(`refused image ${item}: larger than ${MAX_IMAGE_BYTES} bytes`); return; }
    total += size;
    files.set(path.join('_images', `${String(n + 1).padStart(2, '0')}-${path.basename(abs)}`), abs);
  });
  return { errors, files, total };
}

// ---------------------------------------------------------------- files

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const taskDir = (id) => path.join(STATE_DIR, 'tasks', id);

function listTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

function resetStage(dir, manifest) {
  const stage = path.join(dir, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const rel of Object.keys(manifest)) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.copyFileSync(path.join(dir, 'baseline', rel), path.join(stage, rel));
  }
}

function diffStage(dir, manifest) {
  const stage = path.join(dir, 'stage');
  const now = new Set(listTree(stage));
  const created = []; const modified = []; const deleted = [];
  for (const rel of now) {
    if (!(rel in manifest)) created.push(rel);
    else if (sha256(path.join(stage, rel)) !== manifest[rel]) modified.push(rel);
  }
  for (const rel of Object.keys(manifest)) if (!now.has(rel)) deleted.push(rel);
  let patchPath = null;
  if (created.length || modified.length || deleted.length) {
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--binary', 'baseline', 'stage'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    patchPath = path.join(dir, 'changes.patch');
    fs.writeFileSync(patchPath, r.stdout || `git diff unavailable: ${r.error?.message || r.stderr}`);
  }
  return { created, modified, deleted, patchPath };
}

// ---------------------------------------------------------------- processes

const ENV_KEEP = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PATH', 'Path', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME'];

// Minimal environment: workers never inherit API keys or tokens from the parent process.
export function workerEnv(extra = {}) {
  const env = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, NO_COLOR: '1', ...extra };
}

export function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export function runProcess(bin, args, { cwd, stdin = null, timeoutMs, env, signal, onSpawn } = {}) {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let timedOut = false; let cancelled = false; let settled = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN });
    } catch (e) { resolve({ code: null, stdout, stderr, spawnError: e }); return; }
    onSpawn?.(child.pid);
    const finish = (res) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); resolve(res); } };
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const onAbort = () => { cancelled = true; killTree(child.pid); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { if (stdout.length < 32e6) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 4e6) stderr += d; });
    child.on('error', (e) => finish({ code: null, stdout, stderr, spawnError: e, timedOut, cancelled }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut, cancelled, pid: child.pid }));
    // Always close stdin: codex exec otherwise waits forever for more input.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? undefined);
  });
}

const exists = (p) => Boolean(p) && fs.existsSync(p);
const firstExisting = (cands) => cands.find(exists) ?? null;

function onPath(names) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (d && exists(p)) return p; }
  return null;
}

function newestIn(dir, file) {
  if (!exists(dir)) return null;
  const hits = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name, file)).filter(exists)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0] || null;
}

// An npm global install on Windows exposes `codex.cmd`. Batch shims are never executed (prompt
// injection risk), so run the package's JS entry point with node instead.
function viaNpmShim(cmdPath, pkg, entry) {
  const js = path.join(path.dirname(cmdPath), 'node_modules', ...pkg.split('/'), ...entry.split('/'));
  return exists(js) ? { bin: process.execPath, pre: [js], source: 'npm' } : null;
}

// ---------------------------------------------------------------- worker output

function checkWorkerOutput(o) {
  const sev = ['blocker', 'major', 'minor', 'info'];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not a JSON object';
  if (typeof o.summary !== 'string') return 'summary missing';
  if (!Array.isArray(o.findings)) return 'findings missing';
  for (const f of o.findings) {
    if (!f || !sev.includes(f.severity) || typeof f.message !== 'string') return 'finding without valid severity/message';
    if (f.file !== null && f.file !== undefined && typeof f.file !== 'string') return 'finding.file must be string or null';
    if (f.line !== null && f.line !== undefined && !Number.isInteger(f.line)) return 'finding.line must be integer or null';
  }
  if (!Array.isArray(o.warnings) || o.warnings.some((w) => typeof w !== 'string')) return 'warnings must be strings';
  if (typeof o.recommended_next_action !== 'string') return 'recommended_next_action missing';
  return null;
}

// Caller-supplied schema: the agent CLIs enforce it; here we only confirm an object with the required keys.
function checkCustomOutput(o, schema) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'not a JSON object';
  const missing = (schema.required || []).filter((k) => !(k in o));
  return missing.length ? `missing required field(s): ${missing.join(', ')}` : null;
}

// Jobs currently running in any bridge process (MCP server or CLI), for live visibility.
export function activeTasks() {
  const dir = path.join(STATE_DIR, 'active');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    let a; try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    let alive = true; try { process.kill(a.owner_pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) { fs.rmSync(file, { force: true }); continue; }
    out.push({ ...a, elapsed_sec: Math.round((Date.now() - Date.parse(a.started)) / 1000) });
  }
  return out;
}

// Antigravity encodes effort in the model slug (e.g. gemini-3.8-flash-low); show it like Codex effort.
const effortOf = (a) => (a.effort && a.effort !== 'default' ? a.effort : (/-(low|medium|high|xhigh|max)$/.exec(a.model || '') || [])[1] || 'default');
export const describeRun = (a) => `${a.agent} · ${a.model ?? 'default'} · effort ${effortOf(a)}`;

export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { return null; }
}

export function classifyText(text) {
  if (/not supported when using|not recognized as a known model|unknown model|model[^.\n]{0,60}(not found|does not exist|not available|unsupported)|invalid model/i.test(text)) return ERROR.MODEL;
  if (/usage limit|rate.?limit|\b429\b|quota|resource.?exhausted|too many requests|insufficient_quota|limit (reached|exceeded)|out of credits|capacity/i.test(text)) return ERROR.RATE_LIMIT;
  if (/not logged in|login required|authentication required|unauthori[sz]ed|\b401\b|please sign in|sign in to continue/i.test(text)) return ERROR.AUTH;
  return null;
}

function workerPrompt(req, stagedFiles, { noShell = false, viewImages = false } = {}) {
  const posix = (f) => f.split(path.sep).join('/');
  const images = stagedFiles.filter((f) => f.startsWith(`_images${path.sep}`));
  const files = stagedFiles.filter((f) => !images.includes(f));
  const list = files.length ? files.map((f) => `- ${posix(f)}`).join('\n') : '- (no text files were staged)';
  const imageLines = images.length
    ? ['', `IMAGES (${images.length}) to look at${viewImages ? ' (open each with your file/image viewer)' : ' (attached to this message, in this order)'}:`, ...images.map((f) => `- ${posix(f)}`)]
    : [];
  const netRule = req.permissions.web
    ? '- You MAY use your built-in web search to read public pages for this objective. Do not log in, download files, submit forms or open/drive a browser window.'
    : '- Do not use the network or a browser, install packages, push, publish, upload or change any account or system setting.';
  const finalAnswer = req.output_schema
    ? ['', 'FINAL ANSWER: return only the JSON object required by the output schema you were given.']
    : ['', 'FINAL ANSWER: return only the JSON object required by the output schema:',
      'summary (what you did and concluded), findings (concrete issues; file = relative path or null, line = number or null),',
      'warnings (limits, unverified points), recommended_next_action (one concrete step for the orchestrator).'];
  const writeRule = req.permissions.write
    ? 'You may create or modify files inside the current directory only. Do not delete files. The orchestrator reviews every change before anything reaches the real project.'
    : 'This is a READ-ONLY task. Do not create, modify or delete any file.';
  return [
    'You are an external specialist worker. An orchestrating agent (usually Claude Code) sent you one bounded task through a local bridge.',
    `Task ID: ${req.task_id}`,
    '', 'OBJECTIVE:', req.objective,
    req.context ? `\nCONTEXT:\n${req.context}` : '',
    req.constraints.length ? `\nCONSTRAINTS:\n${req.constraints.map((c) => `- ${c}`).join('\n')}` : '',
    req.expected_output ? `\nEXPECTED OUTPUT:\n${req.expected_output}` : '',
    '', 'WORKSPACE: the current directory is an isolated staged copy that contains only these files:', list,
    ...imageLines,
    '', 'RULES:',
    '- Work only inside the current directory. Do not read, list or search anything outside it.',
    '- Do not read environment variables, credentials, keys, browser data or user-profile folders.',
    netRule,
    '- Never open, launch or drive a web browser.',
    `- ${writeRule}`,
    ...(noShell ? ['- Terminal/shell commands are NOT available here and will be denied. Do the task by reading (and, if allowed, editing) files only; do not try to run code.'] : []),
    '- Be honest: if you could not run or verify something, say so.',
    ...finalAnswer,
  ].filter((s) => s !== '').join('\n');
}

// ---------------------------------------------------------------- adapters

const home = os.homedir();
const LA = process.env.LOCALAPPDATA || '';

export const ADAPTERS = {
  codex: {
    // OpenAI Codex CLI, official non-interactive mode: `codex exec --json --output-schema -o`.
    resolve() {
      const forced = process.env.AGENT_BRIDGE_CODEX_BIN || CONFIG.codex.bin;
      if (forced) return exists(forced) ? { bin: forced, pre: [], source: 'configured' } : null;
      const p = onPath(IS_WIN ? ['codex.exe', 'codex.cmd'] : ['codex']);
      if (p && /\.cmd$/i.test(p)) { const s = viaNpmShim(p, '@openai/codex', 'bin/codex.js'); if (s) return s; }
      else if (p) return { bin: p, pre: [], source: 'PATH' };
      const bundled = IS_WIN ? newestIn(path.join(LA, 'OpenAI', 'Codex', 'bin'), 'codex.exe')
        : firstExisting(['/Applications/Codex.app/Contents/Resources/codex', path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex')]);
      return bundled ? { bin: bundled, pre: [], source: 'Codex desktop app' } : null;
    },
    async status(r) {
      const v = await runProcess(r.bin, [...r.pre, '--version'], { timeoutMs: 20000, env: workerEnv() });
      const l = await runProcess(r.bin, [...r.pre, 'login', 'status'], { timeoutMs: 20000, env: workerEnv() });
      const loginText = `${l.stdout}${l.stderr}`.trim();
      return { version: v.stdout.trim() || null, auth: l.code === 0 && /logged in/i.test(loginText) ? 'ok' : 'required', auth_detail: loginText.split('\n')[0] || null };
    },
    async models() {
      const f = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'models_cache.json');
      if (!exists(f)) return null;
      try {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        return (d.models || []).filter((m) => m.slug && m.visibility !== 'hide')
          .map((m) => ({ slug: m.slug, name: m.display_name, description: m.description, efforts: (m.supported_reasoning_levels || []).map((x) => x.effort) }));
      } catch { return null; }
    },
    caps: { web: true, images: true, shell: true },
    invocation(req, ctx, cand) {
      // --search is a global flag (before `exec`): live web search through the API, no browser.
      const args = [...(req.permissions.web ? ['--search'] : []), 'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', req.permissions.write ? 'workspace-write' : 'read-only',
        '-c', 'shell_environment_policy.inherit="core"',
        '-C', ctx.stage, '--output-schema', ctx.schemaPath, '-o', ctx.lastMessage];
      if (CONFIG.codex.ignore_user_config) args.splice(args.indexOf('exec') + 4, 0, '--ignore-user-config', ...(IS_WIN ? ['-c', 'windows.sandbox="unelevated"'] : []));
      if (cand.model) args.push('-m', cand.model);
      if (cand.effort) args.push('-c', `model_reasoning_effort="${cand.effort}"`);
      // -i takes several values, so end the list with `--` before the stdin marker.
      if (ctx.images.length) args.push('-i', ...ctx.images.map((f) => path.join(ctx.stage, f)), '--');
      args.push('-'); // prompt via stdin: no length limit, nothing sensitive on the command line
      return { args, stdin: ctx.prompt };
    },
    parse(proc, ctx) {
      let sessionId = null; let usage = null; const errs = []; let lastAgentText = null;
      for (const line of proc.stdout.split(/\r?\n/)) {
        const ev = parseJsonLoose(line); if (!ev) continue;
        if (ev.type === 'thread.started') sessionId = ev.thread_id ?? null;
        else if (ev.type === 'turn.completed') usage = ev.usage ?? null;
        else if (ev.type === 'turn.failed') errs.push(ev.error?.message || JSON.stringify(ev.error || ev));
        else if (ev.type === 'error' && !/Defaulting to fallback metadata/i.test(ev.message || '')) errs.push(ev.message || JSON.stringify(ev));
        else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') lastAgentText = ev.item.text;
      }
      const lastFile = exists(ctx.lastMessage) ? fs.readFileSync(ctx.lastMessage, 'utf8') : null;
      const out = parseJsonLoose(lastFile) ?? parseJsonLoose(lastAgentText);
      return { sessionId, usage, errs, out, rawText: lastFile ?? lastAgentText };
    },
  },

  antigravity: {
    // Google Antigravity CLI, official headless mode: `agy -p ... --output-format json --json-schema`.
    // Shell commands stay soft-denied in headless mode (least privilege), so workers read/edit files only.
    // No web: its headless web tools drive a visible browser window, so web jobs go to Codex instead.
    noShell: true,
    viewImages: true,
    caps: { web: false, images: true, shell: false },
    resolve() {
      const forced = process.env.AGENT_BRIDGE_AGY_BIN || CONFIG.antigravity.bin;
      if (forced) return exists(forced) ? { bin: forced, pre: [], source: 'configured' } : null;
      const p = onPath(IS_WIN ? ['agy.exe'] : ['agy'])
        ?? firstExisting(IS_WIN ? [path.join(LA, 'agy', 'bin', 'agy.exe')] : [path.join(home, '.local', 'bin', 'agy')]);
      return p ? { bin: p, pre: [], source: 'agy CLI' } : null;
    },
    async status(r) {
      const v = await runProcess(r.bin, ['--version'], { timeoutMs: 20000, env: workerEnv() });
      const h = await runProcess(r.bin, ['--help'], { timeoutMs: 20000, env: workerEnv() });
      const help = `${h.stdout}${h.stderr}`;
      const headless = ['--output-format', '--json-schema', '--print-timeout', '--model'].every((f) => help.includes(f));
      return { version: (v.stdout || v.stderr).trim().split('\n')[0] || null, auth: 'verified on first real run', headless_flags_verified: headless };
    },
    async models(r) {
      const cache = path.join(STATE_DIR, 'models-antigravity.json');
      if (exists(cache) && (Date.now() - fs.statSync(cache).mtimeMs) / 3.6e6 < LIMITS.model_list_cache_hours) {
        try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* refresh */ }
      }
      const res = await runProcess(r.bin, ['models'], { timeoutMs: 60000, env: workerEnv() });
      if (res.code !== 0) return null;
      const list = res.stdout.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length >= 2 && /^[a-z0-9]/.test(p[0]))
        .map(([slug, name]) => ({ slug: slug.trim(), name: name.trim() }));
      if (!list.length) return null;
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(list));
      return list;
    },
    invocation(req, ctx, cand) {
      const args = ['-p', ctx.prompt, '--output-format', 'json', '--json-schema', ctx.schemaPath,
        '--print-timeout', `${req.timeout_sec}s`, '--sandbox'];
      if (cand.model) args.push('--model', cand.model);
      if (cand.effort) args.push('--effort', cand.effort);
      return { args, stdin: null };
    },
    parse(proc) {
      const env = parseJsonLoose(proc.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '');
      const errs = [];
      if (env && env.status && env.status !== 'SUCCESS') errs.push(`status ${env.status}: ${env.error || ''}`.trim());
      const out = env ? (env.structured_output ?? parseJsonLoose(env.response)) : null;
      let errClass = null;
      // Headless mode soft-denies tools it cannot prompt for and may then end with an empty answer.
      if (!out && !errs.length && env?.denied_actions?.length) {
        errClass = ERROR.DENIED;
        errs.push(`worker produced no answer after denied action(s): ${env.denied_actions.map((d) => d.display_name || d.action).join(', ')}. Shell access is intentionally not granted.`);
      }
      return { sessionId: env?.conversation_id || null, usage: env?.usage ?? null, errs, out, rawText: env?.response ?? proc.stdout, errClass };
    },
  },
};

// Test-only fake worker so crash/timeout/limit handling can be proven without a real agent.
function mockAdapter(name) {
  return {
    resolve: () => ({ bin: process.execPath, pre: [], source: 'mock' }),
    async status() { return { version: 'mock', auth: 'ok' }; },
    async models() { return null; },
    invocation(req, ctx, cand) {
      const key = cand.model ? `${name}:${cand.model}` : name;
      const m = req.objective.match(new RegExp(`(?:^|\\s)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(\\w+)`)) || req.objective.match(new RegExp(`(?:^|\\s)${name}=(\\w+)`));
      return { args: [path.join(REPO_DIR, 'tests', 'mock-agent.mjs'), m ? m[1] : 'ok', ctx.stage, ctx.lastMessage], stdin: ctx.prompt };
    },
    parse(proc, ctx) {
      const t = exists(ctx.lastMessage) ? fs.readFileSync(ctx.lastMessage, 'utf8') : proc.stdout;
      return { sessionId: `mock-${proc.pid}`, usage: null, errs: [], out: parseJsonLoose(t), rawText: t };
    },
  };
}
export const adapterFor = (agent) => (agent === 'mock' || agent === 'mock2' ? mockAdapter(agent) : ADAPTERS[agent]);

// ---------------------------------------------------------------- run

export function log(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'bridge.log'), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch { /* logging must never break a run */ }
}

export async function runOnce(cand, req, dir, stagedFiles, n, signal) {
  const adapter = adapterFor(cand.agent);
  const t0 = Date.now();
  const base = { agent: cand.agent, model: cand.model ?? null, effort: cand.effort ?? null, attempt: n, started: new Date(t0).toISOString() };
  const r = adapter.resolve();
  if (!r) return { ...base, ok: false, error_class: ERROR.UNAVAILABLE, message: `${cand.agent} CLI not found (run the setup script)`, duration_sec: 0 };
  if (/\.(cmd|bat)$/i.test(r.bin)) return { ...base, ok: false, error_class: ERROR.UNSUPPORTED, message: `${r.bin} is a batch shim; only real executables are run so prompts cannot be shell-injected`, duration_sec: 0 };
  let schemaPath = WORKER_SCHEMA_PATH;
  if (req.output_schema) { schemaPath = path.join(dir, 'output-schema.json'); fs.writeFileSync(schemaPath, JSON.stringify(req.output_schema)); }
  const ctx = {
    stage: path.join(dir, 'stage'), lastMessage: path.join(dir, `attempt-${n}-${cand.agent}-last.json`), schemaPath,
    images: stagedFiles.filter((f) => f.startsWith(`_images${path.sep}`)),
    prompt: workerPrompt(req, stagedFiles, { noShell: Boolean(adapter.noShell), viewImages: Boolean(adapter.viewImages) }),
  };
  const inv = adapter.invocation(req, ctx, cand);
  const workerFile = path.join(dir, 'worker.json');
  const activeFile = path.join(STATE_DIR, 'active', `${req.task_id}.json`);
  const onSpawn = (pid) => {
    const info = { task_id: req.task_id, agent: cand.agent, model: cand.model ?? 'default', effort: cand.effort ?? 'default', attempt: n,
      kind: req.kind, started: new Date().toISOString(), timeout_sec: req.timeout_sec, worker_pid: pid, owner_pid: process.pid, objective: req.objective.slice(0, 120) };
    fs.writeFileSync(workerFile, JSON.stringify(info));
    fs.mkdirSync(path.dirname(activeFile), { recursive: true });
    fs.writeFileSync(activeFile, JSON.stringify(info));
  };
  const proc = await runProcess(r.bin, [...r.pre, ...inv.args], { cwd: ctx.stage, stdin: inv.stdin, timeoutMs: req.timeout_sec * 1000, env: workerEnv(), signal, onSpawn });
  fs.rmSync(workerFile, { force: true });
  fs.rmSync(activeFile, { force: true });
  fs.writeFileSync(path.join(dir, `attempt-${n}-${cand.agent}-stdout.log`), proc.stdout);
  fs.writeFileSync(path.join(dir, `attempt-${n}-${cand.agent}-stderr.log`), proc.stderr);
  const meta = { ...base, exit_code: proc.code, duration_sec: Math.round((Date.now() - t0) / 100) / 10 };
  if (proc.spawnError) return { ...meta, ok: false, error_class: proc.spawnError.code === 'ENOENT' ? ERROR.UNAVAILABLE : ERROR.CRASH, message: proc.spawnError.message };
  if (proc.cancelled) return { ...meta, ok: false, error_class: ERROR.CANCELLED, message: 'cancelled by the caller; worker process tree killed' };
  if (proc.timedOut) return { ...meta, ok: false, error_class: ERROR.TIMEOUT, message: `no result within ${req.timeout_sec}s; worker process tree killed` };
  const p = adapter.parse(proc, ctx);
  const tail = proc.stderr.split(/\r?\n/).filter((l) => l.trim() && !/Reading additional input from stdin|rmcp::transport/.test(l)).slice(-5).join(' | ');
  const textForClass = `${p.errs.join(' ')} ${proc.code !== 0 ? tail : ''}`;
  if (proc.code !== 0 || p.errs.length) {
    const cls = p.errClass ?? classifyText(textForClass) ?? (p.out ? ERROR.MALFORMED : ERROR.CRASH);
    return { ...meta, ok: false, error_class: cls, message: (p.errs.join(' | ') || tail || `exit code ${proc.code}`).slice(0, 1500), session_id: p.sessionId, raw_error: textForClass.slice(0, 2000) };
  }
  const bad = req.output_schema ? checkCustomOutput(p.out, req.output_schema) : checkWorkerOutput(p.out);
  if (bad) return { ...meta, ok: false, error_class: ERROR.MALFORMED, message: `worker output rejected: ${bad}. Raw start: ${String(p.rawText ?? '').slice(0, 300)}`, session_id: p.sessionId };
  return { ...meta, ok: true, output: p.out, session_id: p.sessionId, usage: p.usage };
}

export { resetStage, diffStage, sha256, RETRY_SAME, FAIL_OVER };

// ---------------------------------------------------------------- apply

function acquireLock(projectPath) {
  const lockDir = path.join(STATE_DIR, 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const lock = path.join(lockDir, `${crypto.createHash('sha1').update(projectPath.toLowerCase()).digest('hex')}.lock`);
  for (let i = 0; i < 2; i += 1) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return lock; } catch {
      const age = (Date.now() - fs.statSync(lock).mtimeMs) / 1000;
      if (age > LIMITS.apply_lock_stale_sec) fs.rmSync(lock, { force: true }); else return null;
    }
  }
  return null;
}

export function getResult(taskId) {
  if (!TASK_ID_RE.test(taskId || '')) return null;
  const f = path.join(taskDir(taskId), 'result.json');
  return exists(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

// Copies reviewed worker changes into the project. Refuses if any target changed since staging.
export function applyChanges(taskId, { dryRun = true, files = null } = {}) {
  const res = getResult(taskId);
  if (!res) return { ok: false, error: { class: ERROR.INVALID_REQUEST, message: `no finished task ${taskId}` } };
  if (res.status !== 'success' || !res.apply_allowed) return { ok: false, error: { class: ERROR.POLICY, message: 'task has no applicable changes (not successful, read-only, or nothing changed)' } };
  const dir = taskDir(taskId);
  if (exists(path.join(dir, 'applied.json'))) return { ok: false, error: { class: ERROR.CONFLICT, message: 'changes from this task were already applied' } };
  const { project_path: root, files: manifest } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  let todo = [...res.files_modified.map((f) => ({ rel: f, kind: 'modify' })), ...res.files_created.map((f) => ({ rel: f, kind: 'create' }))];
  if (files) todo = todo.filter((t) => files.includes(t.rel) || files.includes(t.rel.split(path.sep).join('/')));
  const refused = []; const conflicts = [];
  todo = todo.filter((t) => {
    const why = deniedReason(t.rel); const target = path.resolve(root, t.rel);
    if (why || !isInside(target, root)) { refused.push(`${t.rel}: ${why || 'outside project'}`); return false; }
    return true;
  });
  const lock = acquireLock(root);
  if (!lock) return { ok: false, error: { class: ERROR.CONFLICT, message: 'another apply is in progress for this project; try again shortly' } };
  try {
    for (const t of todo) {
      const target = path.resolve(root, t.rel);
      if (t.kind === 'modify' && (!exists(target) || sha256(target) !== manifest[t.rel])) conflicts.push(`${t.rel}: changed in the project after it was staged`);
      if (t.kind === 'create' && exists(target)) conflicts.push(`${t.rel}: already exists in the project`);
    }
    const plan = { task_id: taskId, project_path: root, will_modify: todo.filter((t) => t.kind === 'modify').map((t) => t.rel),
      will_create: todo.filter((t) => t.kind === 'create').map((t) => t.rel), not_applied_deletions: res.files_deleted, refused, patch_path: res.patch_path };
    if (conflicts.length) return { ok: false, error: { class: ERROR.CONFLICT, message: 'nothing applied: project files changed since staging', conflicts }, plan };
    if (dryRun) return { ok: true, dry_run: true, plan };
    const backupDir = path.join(dir, 'apply-backup');
    for (const t of todo) {
      const target = path.resolve(root, t.rel);
      if (t.kind === 'modify') { fs.mkdirSync(path.dirname(path.join(backupDir, t.rel)), { recursive: true }); fs.copyFileSync(target, path.join(backupDir, t.rel)); }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, 'stage', t.rel), target);
    }
    const record = { ...plan, applied_at: new Date().toISOString(), backup_dir: backupDir };
    fs.writeFileSync(path.join(dir, 'applied.json'), JSON.stringify(record, null, 2));
    log({ event: 'applied', task_id: taskId, modified: plan.will_modify, created: plan.will_create });
    return { ok: true, dry_run: false, ...record };
  } finally { fs.rmSync(lock, { force: true }); }
}

// ---------------------------------------------------------------- orphans

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Kills workers whose bridge process died without cleaning up. A worker is only killed when its
// command line still points at its own task folder (no PID-reuse accidents).
export function sweepOrphans() {
  const root = path.join(STATE_DIR, 'tasks');
  if (!exists(root)) return [];
  const killed = [];
  for (const id of fs.readdirSync(root)) {
    const wf = path.join(root, id, 'worker.json');
    if (!exists(wf)) continue;
    let w; try { w = JSON.parse(fs.readFileSync(wf, 'utf8')); } catch { continue; }
    if (alive(w.owner_pid)) continue;
    if (alive(w.worker_pid)) {
      const q = IS_WIN
        ? spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(w.worker_pid)}").CommandLine`], { encoding: 'utf8' })
        : spawnSync('ps', ['-o', 'args=', '-p', String(Number(w.worker_pid))], { encoding: 'utf8' });
      if ((q.stdout || '').includes(id)) { killTree(w.worker_pid); killed.push(id); }
    }
    fs.rmSync(wf, { force: true });
    log({ event: 'orphan_swept', task_id: id, worker_pid: w.worker_pid, killed: killed.includes(id) });
  }
  return killed;
}
