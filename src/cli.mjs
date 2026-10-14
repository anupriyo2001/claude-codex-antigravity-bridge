#!/usr/bin/env node
// CLI front-end. Prints one JSON document on stdout.
//   node src/cli.mjs status
//   node src/cli.mjs models
//   node src/cli.mjs route <task.json | ->
//   node src/cli.mjs run <task.json | ->
//   node src/cli.mjs result <task_id>
//   node src/cli.mjs apply <task_id> [--confirm] [--files a,b]
//   node src/cli.mjs limits [--clear key|all]
import fs from 'node:fs';
import { getResult, applyChanges, sweepOrphans, ADAPTERS, AGENTS } from './core.mjs';
import { runTask, routeTask, agentStatus, readLimits, clearLimits } from './router.mjs';

const [cmd, arg, ...rest] = process.argv.slice(2);
const print = (o) => { process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); };
const usage = 'usage: cli.mjs status | models | route <task.json|-> | run <task.json|-> | result <id> | apply <id> [--confirm] [--files a,b] | limits [--clear key|all]';

function readTask(a) {
  const text = a === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(a, 'utf8');
  return JSON.parse(text);
}

async function main() {
  sweepOrphans();
  switch (cmd) {
    case 'status': print(await agentStatus()); return 0;
    case 'models': {
      const out = {};
      for (const a of AGENTS) { const r = ADAPTERS[a].resolve(); out[a] = r ? await ADAPTERS[a].models(r) : 'not installed'; }
      print(out); return 0;
    }
    case 'route': case 'run': {
      if (!arg) throw new Error(usage);
      let req;
      try { req = readTask(arg); } catch (e) { print({ status: 'invalid_request', errors: [{ class: 'INVALID_REQUEST', message: `task file is not valid JSON: ${e.message}` }] }); return 2; }
      if (cmd === 'route') { print(await routeTask(req)); return 0; }
      const ac = new AbortController();
      process.on('SIGINT', () => ac.abort());
      const r = await runTask(req, { signal: ac.signal });
      print(r);
      return r.status === 'success' ? 0 : 1;
    }
    case 'result': { const r = getResult(arg); print(r ?? { error: `no result for ${arg}` }); return r ? 0 : 1; }
    case 'apply': {
      const fi = rest.indexOf('--files');
      const files = fi >= 0 ? (rest[fi + 1] || '').split(',').filter(Boolean) : null;
      const r = applyChanges(arg, { dryRun: !rest.includes('--confirm'), files });
      print(r); return r.ok ? 0 : 1;
    }
    case 'limits': {
      if (arg === '--clear') clearLimits(rest[0] === 'all' || !rest[0] ? null : rest[0]);
      print({ limits: readLimits() }); return 0;
    }
    default: process.stderr.write(`${usage}\n`); return 2;
  }
}

main().then((code) => { process.exitCode = code ?? 0; }, (e) => { print({ status: 'failed', errors: [{ class: 'INTERNAL', message: e.message }] }); process.exitCode = 3; });
