// Router: picks agent + model + effort per task (zero LLM tokens), tracks usage-limit cooldowns,
// and fails over to the next best candidate when an agent or model is exhausted.
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_DIR, STATE_DIR, LIMITS, ERROR, AGENTS, ADAPTERS, adapterFor, agentNames, validateRequest, expandInputs,
  taskDir, sha256, resetStage, diffStage, runOnce, log, deniedReason, RETRY_SAME, FAIL_OVER,
} from './core.mjs';

export const ROUTING = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'routing.json'), 'utf8'));
const TIERS = ['light', 'standard', 'heavy'];

// ---------------------------------------------------------------- classification

export function classify(req, staged = { total: 0, count: 0 }) {
  const c = ROUTING.classifier;
  const text = `${req.objective} ${req.context || ''} ${(req.constraints || []).join(' ')}`.toLowerCase();
  const reasons = [];
  let score = c.kind_weight[req.kind] ?? c.kind_weight.other;
  reasons.push(`kind ${req.kind} +${score}`);
  const heavy = c.heavy_keywords.filter((k) => text.includes(k));
  const light = c.light_keywords.filter((k) => text.includes(k));
  if (heavy.length) { score += 2; reasons.push(`hard topic (${heavy.slice(0, 3).join(', ')}) +2`); }
  if (light.length && !heavy.length) { score -= 1; reasons.push(`simple wording (${light.slice(0, 3).join(', ')}) -1`); }
  const kb = staged.total / 1024;
  const sizePts = kb < 8 ? 0 : kb < 64 ? 1 : kb < 512 ? 2 : 3;
  if (sizePts) reasons.push(`${Math.round(kb)} KB input +${sizePts}`);
  score += sizePts;
  if (staged.count > 10) { score += 1; reasons.push(`${staged.count} files +1`); }
  if (req.permissions?.write) { score += 1; reasons.push('writes files +1'); }
  if (req.objective.length > 1500) { score += 1; reasons.push('long brief +1'); }
  const tier = score <= c.thresholds.light_max ? 'light' : score <= c.thresholds.standard_max ? 'standard' : 'heavy';
  return { tier, score, reasons };
}

// ---------------------------------------------------------------- limits ledger

const LIMITS_FILE = () => path.join(STATE_DIR, 'limits.json');

export function readLimits() {
  try {
    const all = JSON.parse(fs.readFileSync(LIMITS_FILE(), 'utf8'));
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, v]) => Date.parse(v.until) > now));
  } catch { return {}; }
}

function writeLimits(obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${LIMITS_FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, LIMITS_FILE());
}

// "try again in 2 hours", "resets in 45m", "retry after 90 seconds"
export function cooldownFrom(text, defaultMin) {
  const m = /(?:try again|retry|resets?|available again)\D{0,20}?(\d+(?:\.\d+)?)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day)s?\b/i.exec(text || '');
  if (!m) return defaultMin;
  const n = Number(m[1]); const u = m[2][0].toLowerCase();
  const min = u === 's' ? n / 60 : u === 'm' ? n : u === 'h' ? n * 60 : n * 1440;
  return Math.min(Math.max(min, 1), 7 * 1440);
}

export function recordLimit(key, cls, text) {
  const minutes = cls === ERROR.RATE_LIMIT ? cooldownFrom(text, LIMITS.rate_limit_cooldown_min)
    : cls === ERROR.AUTH ? LIMITS.auth_cooldown_min : LIMITS.unknown_model_cooldown_hours * 60;
  const all = readLimits();
  all[key] = { reason: cls, until: new Date(Date.now() + minutes * 60000).toISOString(), detail: String(text || '').slice(0, 300) };
  writeLimits(all);
  log({ event: 'limit_recorded', key, reason: cls, minutes: Math.round(minutes) });
}

export function clearLimits(key = null) {
  if (!key) { writeLimits({}); return; }
  const all = readLimits(); delete all[key]; writeLimits(all);
}

const blockedBy = (limits, cand) => limits[`${cand.agent}`] || limits[`${cand.agent}:${cand.model ?? '*'}`] || null;

// ---------------------------------------------------------------- candidates

const modelCache = new Map();
async function modelsFor(agent) {
  if (agent === 'mock' || agent === 'mock2') return null;
  if (modelCache.has(agent)) return modelCache.get(agent);
  const r = ADAPTERS[agent].resolve();
  const list = r ? await ADAPTERS[agent].models(r).catch(() => null) : null;
  modelCache.set(agent, list);
  return list;
}

export async function buildCandidates(req, tier) {
  const notes = [];
  const pool = [];
  const push = (c) => { if (!pool.some((p) => p.agent === c.agent && p.model === c.model && p.effort === c.effort)) pool.push(c); };
  const tierList = (t) => (ROUTING.tiers[t] || []).map((c) => ({ agent: c.agent, model: c.model ?? null, effort: c.effort ?? null }));
  const order = [tier, ...TIERS.filter((t) => t !== tier).sort((a, b) => Math.abs(TIERS.indexOf(a) - TIERS.indexOf(tier)) - Math.abs(TIERS.indexOf(b) - TIERS.indexOf(tier)) || TIERS.indexOf(b) - TIERS.indexOf(a))];

  if (req.agent !== 'auto' && req.model) push({ agent: req.agent, model: req.model, effort: req.effort, pinned: true });
  if (req.agent === 'mock' || req.agent === 'mock2') {
    push({ agent: req.agent, model: req.model, effort: req.effort });
    if (req.fallback_agent && req.fallback_agent !== req.agent) push({ agent: req.fallback_agent, model: null, effort: null });
  } else {
    const preferred = req.agent === 'auto' ? null : req.agent;
    const first = tierList(tier).filter((c) => !preferred || c.agent === preferred);
    first.forEach((c) => push({ ...c, effort: req.effort ?? c.effort }));
    if (req.failover) {
      // Same agent, neighbouring tiers (prefer stronger) before switching agents.
      for (const t of order.slice(1)) tierList(t).filter((c) => !preferred || c.agent === preferred).forEach((c) => push({ ...c, effort: req.effort ?? c.effort }));
      if (preferred) for (const t of order) tierList(t).filter((c) => c.agent !== preferred).forEach((c) => push({ ...c, effort: req.effort ?? c.effort }));
    }
    if (preferred && !pool.length) push({ agent: preferred, model: null, effort: req.effort });
  }

  const limits = readLimits();
  const out = [];
  for (const c of pool) {
    if (!agentNames().includes(c.agent)) continue;
    const adapter = adapterFor(c.agent);
    if (!adapter.resolve()) { notes.push(`skip ${c.agent}: not installed`); continue; }
    const block = blockedBy(limits, c);
    if (block) { notes.push(`skip ${c.agent}${c.model ? `:${c.model}` : ''}: ${block.reason} until ${block.until}`); continue; }
    // AGENT_BRIDGE_SKIP_MODEL_CHECK=1 (tests) lets an unlisted model reach the agent to exercise runtime failover.
    const models = c.model && process.env.AGENT_BRIDGE_SKIP_MODEL_CHECK !== '1' ? await modelsFor(c.agent) : null;
    if (models && !models.some((m) => m.slug === c.model)) { notes.push(`skip ${c.agent}:${c.model}: not offered to this account`); continue; }
    const effs = models?.find((m) => m.slug === c.model)?.efforts;
    if (c.effort && effs?.length && !effs.includes(c.effort)) { notes.push(`${c.agent}:${c.model}: effort ${c.effort} unsupported, using default`); c.effort = null; }
    out.push(c);
  }
  return { candidates: out.slice(0, req.failover ? LIMITS.max_candidates : 1), notes };
}

export function claudeAdvice(tier) {
  return { ...(ROUTING.claude[tier] || ROUTING.claude.standard), tier,
    note: 'Use this model/effort when Claude Code does the job itself (Agent tool model/effort).' };
}

// ---------------------------------------------------------------- route preview (no run)

export async function routeTask(raw) {
  const { errors, req } = validateRequest({ ...raw, objective: raw.objective ?? '(preview)' });
  if (errors.length) return { status: 'invalid_request', errors };
  const staged = expandInputs(req);
  const cls = req.tier !== 'auto' ? { tier: req.tier, score: null, reasons: ['tier set by caller'] } : classify(req, { total: staged.total, count: staged.files.size });
  const { candidates, notes } = await buildCandidates(req, cls.tier);
  return {
    tier: cls.tier, score: cls.score, reasons: cls.reasons, candidates, skipped: notes,
    claude: claudeAdvice(cls.tier),
    recommendation: cls.tier === 'light' && !req.permissions.write
      ? 'Light job: if it takes Claude three tool calls or fewer, do it directly instead of delegating.'
      : candidates.length ? `Delegate to ${candidates[0].agent}${candidates[0].model ? ` (${candidates[0].model}${candidates[0].effort ? `, ${candidates[0].effort}` : ''})` : ''}.`
        : 'No external agent available right now: Claude does it with the advised model/effort.',
  };
}

// ---------------------------------------------------------------- run with failover

function baseResult(req) {
  return {
    task_id: req?.task_id ?? null, agent: null, model: null, effort: null, tier: null, status: 'failed', summary: '',
    files_created: [], files_modified: [], files_deleted: [], patch_path: null, apply_allowed: false,
    findings: [], warnings: [], errors: [], recommended_next_action: '', routing: null, attempts: [],
    worker_session_id: null, usage: null, duration_sec: 0, task_dir: req ? taskDir(req.task_id) : null,
  };
}

const STATUS_FOR = { [ERROR.TIMEOUT]: 'timeout', [ERROR.UNAVAILABLE]: 'unavailable', [ERROR.UNSUPPORTED]: 'unavailable',
  [ERROR.AUTH]: 'blocked', [ERROR.CANCELLED]: 'cancelled', [ERROR.RATE_LIMIT]: 'limited', [ERROR.MODEL]: 'unavailable' };

export async function runTask(raw, { signal } = {}) {
  const t0 = Date.now();
  const { errors, req } = validateRequest(raw);
  if (errors.length) {
    const r = baseResult(req); r.status = 'invalid_request'; r.task_dir = null;
    r.errors = errors.map((m) => ({ class: ERROR.INVALID_REQUEST, message: m }));
    r.summary = 'Request rejected before any agent was started.';
    r.recommended_next_action = 'Fix the request fields listed in errors and resend.';
    log({ event: 'rejected', task_id: req?.task_id, errors });
    return r;
  }
  const dir = taskDir(req.task_id);
  if (fs.existsSync(dir)) {
    const r = baseResult(req); r.status = 'invalid_request'; r.task_dir = null;
    r.errors = [{ class: ERROR.INVALID_REQUEST, message: `task_id ${req.task_id} already exists` }];
    r.recommended_next_action = 'Use a new task_id (or omit it to generate one).';
    return r;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(req, null, 2));
  const result = baseResult(req);
  const finish = () => {
    result.duration_sec = Math.round((Date.now() - t0) / 100) / 10;
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
    log({ event: 'finished', task_id: req.task_id, status: result.status, tier: result.tier,
      attempts: result.attempts.map((a) => `${a.agent}:${a.model ?? 'default'}:${a.ok ? 'ok' : a.error_class}`), duration_sec: result.duration_sec, objective: req.objective.slice(0, 160) });
    return result;
  };

  const staged = expandInputs(req);
  result.warnings.push(...staged.warnings);
  if (staged.errors.length) {
    result.status = 'invalid_request';
    result.errors = staged.errors.map((m) => ({ class: ERROR.POLICY, message: m }));
    result.summary = 'Input files refused by the bridge policy; no agent was started.';
    result.recommended_next_action = 'Remove the refused paths (secrets, media, paths outside the project) and resend.';
    return finish();
  }
  const manifest = {};
  fs.mkdirSync(path.join(dir, 'baseline'), { recursive: true });
  for (const [rel, abs] of staged.files) {
    fs.mkdirSync(path.dirname(path.join(dir, 'baseline', rel)), { recursive: true });
    fs.copyFileSync(abs, path.join(dir, 'baseline', rel));
    manifest[rel] = sha256(abs);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ project_path: req.project_path, files: manifest }, null, 2));
  const stagedFiles = Object.keys(manifest);

  const cls = req.tier !== 'auto' ? { tier: req.tier, score: null, reasons: ['tier set by caller'] } : classify(req, { total: staged.total, count: staged.files.size });
  const { candidates, notes } = await buildCandidates(req, cls.tier);
  result.tier = cls.tier;
  result.routing = { tier: cls.tier, score: cls.score, reasons: cls.reasons, planned: candidates.map((c) => `${c.agent}:${c.model ?? 'default'}${c.effort ? `@${c.effort}` : ''}`), skipped: notes, claude: claudeAdvice(cls.tier) };

  let last = null;
  outer: for (const cand of candidates) {
    if (cand.skip) continue;
    for (let i = 0; i <= req.retries; i += 1) {
      resetStage(dir, manifest);
      log({ event: 'attempt', task_id: req.task_id, agent: cand.agent, model: cand.model, effort: cand.effort, try: i + 1 });
      last = await runOnce(cand, req, dir, stagedFiles, result.attempts.length + 1, signal);
      result.attempts.push(Object.fromEntries(Object.entries(last).filter(([k]) => k !== 'output' && k !== 'raw_error')));
      if (last.ok || last.error_class === ERROR.CANCELLED || last.error_class === ERROR.TIMEOUT) break outer;
      if ([ERROR.RATE_LIMIT, ERROR.AUTH].includes(last.error_class)) {
        // An account-wide limit blocks the whole agent; a model-specific one only that model.
        const modelSpecific = cand.model && new RegExp(cand.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(last.raw_error || '');
        recordLimit(last.error_class === ERROR.AUTH || !modelSpecific ? cand.agent : `${cand.agent}:${cand.model}`, last.error_class, last.raw_error || last.message);
      } else if (last.error_class === ERROR.MODEL && cand.model) recordLimit(`${cand.agent}:${cand.model}`, ERROR.MODEL, last.message);
      if (!RETRY_SAME.has(last.error_class) || i === req.retries) break;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    if (!FAIL_OVER.has(last.error_class) || !req.failover) break;
    // Skip remaining candidates of an agent that is now blocked account-wide.
    if ([ERROR.RATE_LIMIT, ERROR.AUTH].includes(last.error_class) && readLimits()[cand.agent]) {
      for (const c of candidates) if (c.agent === cand.agent) c.skip = true;
    }
  }
  for (const a of result.attempts) if (!a.ok) result.errors.push({ class: a.error_class, agent: a.agent, model: a.model, message: a.message });

  if (last?.ok) {
    const o = last.output;
    const changes = diffStage(dir, manifest);
    Object.assign(result, {
      status: 'success', agent: last.agent, model: last.model, effort: last.effort, summary: o.summary, findings: o.findings,
      recommended_next_action: o.recommended_next_action, worker_session_id: last.session_id ?? null, usage: last.usage ?? null,
      files_created: changes.created, files_modified: changes.modified, files_deleted: changes.deleted, patch_path: changes.patchPath,
    });
    result.warnings.push(...o.warnings);
    if (result.attempts.length > 1) result.warnings.push(`completed by ${last.agent}:${last.model ?? 'default'} after ${result.attempts.length - 1} failed attempt(s); see attempts`);
    const touched = [...changes.created, ...changes.modified, ...changes.deleted];
    if (touched.length && !req.permissions.write) result.warnings.push(`read-only task but the worker changed ${touched.length} staged file(s); changes were NOT made available to apply`);
    const deniedNew = changes.created.filter((f) => deniedReason(f));
    if (deniedNew.length) result.warnings.push(`worker created protected-type files that will never be applied: ${deniedNew.join(', ')}`);
    result.apply_allowed = req.permissions.write && (changes.created.length + changes.modified.length) > 0;
    return finish();
  }
  const clsErr = last?.error_class ?? (candidates.length ? ERROR.INTERNAL : ERROR.UNAVAILABLE);
  if (!candidates.length) result.errors.push({ class: ERROR.UNAVAILABLE, message: `no usable candidate: ${notes.join('; ') || 'no agent installed'}` });
  result.status = STATUS_FOR[clsErr] ?? 'failed';
  const advice = claudeAdvice(cls.tier);
  result.summary = candidates.length ? `No usable result after ${result.attempts.length} attempt(s) (${clsErr}).` : 'No external agent/model is available right now.';
  result.recommended_next_action = clsErr === ERROR.TIMEOUT
    ? `Narrow the objective or raise timeout_sec; otherwise Claude handles it (model ${advice.model}, effort ${advice.effort}).`
    : `Claude handles the task itself with model ${advice.model}, effort ${advice.effort}, or stops only this stage.`;
  return finish();
}

// ---------------------------------------------------------------- status

export async function agentStatus() {
  const out = { state_dir: STATE_DIR, agents: {}, limits: readLimits() };
  for (const name of AGENTS) {
    const a = ADAPTERS[name]; const r = a.resolve();
    out.agents[name] = r ? { available: true, bin: r.bin, source: r.source, ...(await a.status(r)), models: (await a.models(r).catch(() => null))?.map((m) => m.slug) ?? 'unknown' }
      : { available: false, install: 'run: node scripts/setup.mjs' };
  }
  return out;
}
