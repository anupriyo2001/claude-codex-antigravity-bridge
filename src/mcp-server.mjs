#!/usr/bin/env node
// MCP server (stdio, newline-delimited JSON-RPC 2.0). Works with Claude Code, Codex and Antigravity
// as MCP clients. stdout carries protocol messages only; diagnostics go to stderr.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { getResult, applyChanges, newTaskId, sweepOrphans, STATE_DIR, TASK_ID_RE, activeTasks, describeRun } from './core.mjs';
import { runTask, routeTask, agentStatus, readLimits, clearLimits } from './router.mjs';

// Some MCP hosts cancel stdio tool calls after ~60 s, so task tools wait at most WAIT_MAX seconds,
// then return status "running" and keep working; agent_task_result collects the result later.
const WAIT_DEFAULT = 40;
const WAIT_MAX = 50;
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'agent-bridge', version: '2.0.0' };

setImmediate(() => { try { sweepOrphans(); } catch (e) { process.stderr.write(`orphan sweep failed: ${e.message}\n`); } });

const taskProps = {
  objective: { type: 'string', description: 'One bounded task, written so the worker needs no chat history.' },
  kind: { type: 'string', enum: ['explain', 'summarize', 'review', 'test', 'analyze', 'debug', 'implement', 'design', 'other'], description: 'Helps the router pick model and effort.' },
  input_files: { type: 'array', items: { type: 'string' }, description: 'Files/folders relative to project_path, copied into an isolated stage. Secrets and media are refused.' },
  project_path: { type: 'string', description: 'Defaults to the project the server was started for.' },
  context: { type: 'string' },
  constraints: { type: 'array', items: { type: 'string' } },
  expected_output: { type: 'string' },
  tier: { type: 'string', enum: ['auto', 'light', 'standard', 'heavy'], description: 'Default auto (zero-token classifier).' },
  timeout_sec: { type: 'integer', minimum: 5, maximum: 1800, description: 'Per attempt. Default 600.' },
  retries: { type: 'integer', minimum: 0, maximum: 2, description: 'Same-candidate retries for crash/malformed output. Default 1.' },
  failover: { type: 'boolean', description: 'Move to the next model/agent on usage limits or failures. Default true.' },
  allow_premium: { type: 'boolean', description: 'Allow premium models (e.g. gpt-6-astra, gpt-6.1-sol at high effort). Default false: cheapest capable models only.' },
  permissions: { type: 'object', properties: {
    write: { type: 'boolean', description: 'true lets the worker edit its staged copy; the project is untouched until agent_apply_changes.' },
    web: { type: 'boolean', description: 'true allows background web search (Codex only, via API; no browser). Routes to Codex.' } }, additionalProperties: false },
  images: { type: 'array', items: { type: 'string' }, description: 'Up to 16 .jpg/.png/.webp (contact sheets, thumbnails, frames) for vision jobs; project-relative or absolute inside an allowed root.' },
  output_schema: { type: 'object', description: 'Optional JSON Schema (type object) for a custom answer shape; the result carries it as `output`. For Codex, every object needs additionalProperties:false and all properties required.' },
  task_id: { type: 'string' },
  wait_sec: { type: 'integer', minimum: 0, maximum: WAIT_MAX, description: `Seconds to wait before returning status "running" (default ${WAIT_DEFAULT}).` },
};
const pinned = { model: { type: 'string', description: 'Pin a model slug (optional; the router picks one otherwise).' }, effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] } };

const TOOLS = [
  { name: 'agent_bridge_status', description: 'Which external agents are installed and signed in, their models, and any usage-limit cooldowns. Cheap.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'route_task', description: 'Preview routing without running anything: difficulty tier, the agent/model/effort chain that would be tried, and the model/effort Claude should use if it does the job itself. Zero tokens.',
    inputSchema: { type: 'object', properties: { ...taskProps, agent: { type: 'string', enum: ['auto', 'codex', 'antigravity'] } }, additionalProperties: false } },
  { name: 'delegate_task', description: 'Run a bounded task on the best available external agent. The router picks agent, model and effort for the difficulty and fails over to the next best option on usage limits or errors. Returns structured findings and, for write tasks, a patch to review.',
    inputSchema: { type: 'object', properties: taskProps, required: ['objective'], additionalProperties: false } },
  { name: 'codex_task', description: 'Like delegate_task but prefers OpenAI Codex (falls over to Antigravity unless failover=false).',
    inputSchema: { type: 'object', properties: { ...taskProps, ...pinned }, required: ['objective'], additionalProperties: false } },
  { name: 'antigravity_task', description: 'Like delegate_task but prefers Google Antigravity (agy, file reading/editing only, no shell). Falls over to Codex unless failover=false.',
    inputSchema: { type: 'object', properties: { ...taskProps, ...pinned }, required: ['objective'], additionalProperties: false } },
  { name: 'agent_task_result', description: 'Get the result of a delegated task. Waits up to wait_sec (default 40) if still running.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, wait_sec: { type: 'integer', minimum: 0, maximum: WAIT_MAX } }, required: ['task_id'], additionalProperties: false } },
  { name: 'agent_apply_changes', description: 'Copy reviewed changes from a successful write task into the project. dry_run defaults to true. Refuses if a target changed since staging; backs up originals; never deletes.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, dry_run: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } } }, required: ['task_id'], additionalProperties: false } },
  { name: 'agent_limits', description: 'Show usage-limit cooldowns, or clear one (key like "codex" or "codex:gpt-6-astra") / all after a plan reset.',
    inputSchema: { type: 'object', properties: { clear: { type: 'string', description: 'Key to clear, or "all".' } }, additionalProperties: false } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const toolResult = (obj, isError) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError: Boolean(isError) });

const tasks = new Map(); // task_id -> { promise, abort, done }
const waitFor = (promise, sec) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), sec * 1000))]);
const clampWait = (v) => (Number.isInteger(v) ? Math.max(0, Math.min(WAIT_MAX, v)) : WAIT_DEFAULT);
const runningResult = (taskId) => {
  const a = activeTasks().find((x) => x.task_id === taskId);
  return { task_id: taskId, status: 'running', running_on: a ? describeRun(a) : 'starting', elapsed_sec: a?.elapsed_sec ?? 0,
    summary: a ? `Running on ${describeRun(a)} for ${a.elapsed_sec}s (attempt ${a.attempt}).` : 'Starting.',
    recommended_next_action: `Call agent_task_result with task_id "${taskId}" to collect the result.` };
};
// First line of every task result names the agent, model and effort, like a subagent label.
const headline = (r) => (r.status === 'running' ? `[${r.running_on}] running ${r.elapsed_sec}s - ${r.task_id}`
  : r.agent ? `[${r.ran_on ?? `${r.agent} · ${r.model ?? 'default'} · effort ${r.effort ?? 'default'}`}] ${r.status} in ${r.duration_sec}s - ${r.task_id}`
    : `[no agent] ${r.status} - ${r.task_id ?? ''}`);
const taskResult = (r, isError) => ({ ...toolResult(r, isError), content: [{ type: 'text', text: `${headline(r)}\n${JSON.stringify(r, null, 2)}` }] });

async function callTool(name, args = {}) {
  if (name === 'agent_bridge_status') return toolResult(await agentStatus(), false);
  if (name === 'route_task') { const r = await routeTask(args); return toolResult(r, r.status === 'invalid_request'); }
  if (name === 'agent_limits') {
    if (args.clear) clearLimits(args.clear === 'all' ? null : args.clear);
    return toolResult({ limits: readLimits() }, false);
  }
  if (name === 'delegate_task' || name === 'codex_task' || name === 'antigravity_task') {
    const { wait_sec: waitSec, ...rest } = args;
    const agent = name === 'codex_task' ? 'codex' : name === 'antigravity_task' ? 'antigravity' : 'auto';
    const taskId = rest.task_id ?? newTaskId();
    if (tasks.has(taskId)) return toolResult({ task_id: taskId, status: 'invalid_request', errors: [{ class: 'INVALID_REQUEST', message: 'task_id already running' }] }, true);
    const ac = new AbortController();
    const entry = { abort: ac, done: false };
    entry.promise = runTask({ ...rest, task_id: taskId, agent }, { signal: ac.signal }).finally(() => { entry.done = true; });
    tasks.set(taskId, entry);
    const r = await waitFor(entry.promise, clampWait(waitSec));
    if (!r) return taskResult(runningResult(taskId), false);
    return taskResult(r, r.status !== 'success');
  }
  if (name === 'agent_task_result') {
    const entry = tasks.get(args.task_id);
    if (entry && !entry.done) {
      const r = await waitFor(entry.promise, clampWait(args.wait_sec));
      if (!r) return taskResult(runningResult(args.task_id), false);
    }
    const r = getResult(args.task_id);
    if (r) return taskResult(r, r.status !== 'success');
    const started = typeof args.task_id === 'string' && TASK_ID_RE.test(args.task_id)
      && fs.existsSync(path.join(STATE_DIR, 'tasks', args.task_id, 'request.json'));
    return toolResult(started
      ? { task_id: args.task_id, status: 'interrupted', errors: [{ class: 'INTERNAL', message: 'task started but has no result; the bridge process that ran it has exited' }], recommended_next_action: 'Resend with a new task_id, or let the orchestrator handle it.' }
      : { task_id: args.task_id, status: 'not_found' }, true);
  }
  if (name === 'agent_apply_changes') {
    const r = applyChanges(args.task_id, { dryRun: args.dry_run !== false, files: args.files ?? null });
    return toolResult(r, !r.ok);
  }
  return null;
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications (no id) never get a reply. A task that already returned "running" keeps going
  // after notifications/cancelled; it is bounded by its own timeout_sec.
  if (!Object.hasOwn(msg, 'id')) return undefined;
  if (typeof id !== 'string' && typeof id !== 'number') return fail(null, -32600, 'request id must be a string or number');
  try {
    if (method === 'initialize') {
      const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return reply(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
        instructions: 'You stay the orchestrator. Use route_task to pick model/effort, delegate only bounded tasks, review every result and patch before agent_apply_changes.' });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const r = await callTool(params?.name, params?.arguments);
      return r ? reply(id, r) : fail(id, -32602, `unknown tool: ${params?.name}`);
    }
    return fail(id, -32601, `method not found: ${method}`);
  } catch (e) {
    process.stderr.write(`agent-bridge error: ${e.stack}\n`);
    return reply(id, toolResult({ status: 'failed', errors: [{ class: 'INTERNAL', message: e.message }] }, true));
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && typeof msg === 'object' && Object.hasOwn(msg, 'id')) fail(typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null, -32600, 'invalid request');
    return;
  }
  handle(msg);
});
// Host closed the connection: stop every worker so no codex/agy process is orphaned.
rl.on('close', () => { for (const t of tasks.values()) if (!t.done) t.abort.abort(); });
