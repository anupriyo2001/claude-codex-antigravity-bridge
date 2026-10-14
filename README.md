# Claude Code + Codex + Antigravity bridge

Use **Claude Code** as the orchestrator and call **OpenAI Codex** and **Google Antigravity** as specialist
workers in any project. The bridge is a small MCP server (plus CLI) with no dependencies. It:

- **routes each job to the right model and effort** with a zero-token classifier, so a simple job does
  not burn a frontier model,
- **fails over automatically** when an agent or model hits a usage limit, remembers the cooldown, and
  skips the exhausted option until it resets,
- **installs missing agents** from their official sources, so you only have to sign in,
- keeps workers **least-privileged**: they work on an isolated staged copy, never on your project, and
  every change needs the orchestrator's review before it is applied.

```
YOU
 └─ Claude Code (orchestrator: plans, routes, reviews, decides)
      ├─ its own subagents  ← model/effort advice from route_task (haiku / sonnet / opus)
      └─ agent-bridge (MCP)
           ├─ Codex        codex exec --json --output-schema   (models: luna / sol / astra, effort low..max)
           └─ Antigravity  agy -p --output-format json         (Gemini Flash low/med/high, Claude, GPT-OSS)
```

## Quick start

Windows (PowerShell):

```powershell
git clone <this repo> claude-codex-antigravity-bridge
cd claude-codex-antigravity-bridge
.\setup.ps1 -Project "C:\path\to\your\project" --claude-md
```

macOS / Linux:

```bash
./setup.sh --project /path/to/your/project --claude-md
```

Setup checks Node, git, Claude Code, Codex and Antigravity. It **installs anything missing** after asking
(`--yes` skips the questions):

| Tool | Official source used |
|---|---|
| Codex CLI | `npm install -g @openai/codex` (or the Codex desktop app's bundled CLI, found automatically) |
| Antigravity CLI `agy` | Google's installer `https://antigravity.google/cli/install.ps1` / `install.sh` (verifies SHA-512) |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` (skipped when the Claude desktop app is present) |
| Node.js (wrappers only) | `winget install OpenJS.NodeJS.LTS` / `brew install node` |

Next, it opens each sign-in for you: `codex login` and the `agy` Google sign-in. Then it writes the project's `.mcp.json`
(merging with existing servers, with a backup). With `--claude-md` it also adds the usage rules from
`templates/CLAUDE.snippet.md` to the project's `CLAUDE.md`. Start a new Claude Code session in the project
and approve the `agent-bridge` server.

### Use it in your other projects

Clone once, then connect as many projects as you like. Each project gets its own `.mcp.json` entry
pointing at this one copy, so updating the clone (`git pull`) updates every project:

```powershell
# Windows: from inside the clone
.\setup.ps1 -Project "C:\path\to\another\project" --claude-md
```

```bash
# any OS: from inside the project you want to connect
node /path/to/claude-codex-antigravity-bridge/scripts/setup.mjs --project . --claude-md
```

Already-installed agents and existing sign-ins are detected and skipped, so connecting another project
takes seconds. Then open the project in Claude Code and approve `agent-bridge`. Each project is
isolated: the bridge only accepts files inside the project it was registered for.

Other flags: `--check` (report only), `--no-install`, `--skip-signin`, `--register-codex`,
`--register-antigravity` (see "When Claude itself hits its limit").

## MCP tools

| Tool | What it does |
|---|---|
| `agent_bridge_status` | installed agents, sign-in, available models, active cooldowns |
| `route_task` | **free preview**: difficulty tier, the agent/model/effort chain, and the model/effort Claude should use itself |
| `delegate_task` | run a job on the best available agent, with automatic failover |
| `codex_task` / `antigravity_task` | same, preferring one agent (optionally `model` / `effort` pinned) |
| `agent_task_result` | collect a job that returned `running` (long jobs keep working in the background) |
| `agent_apply_changes` | apply a reviewed write job's changes (`dry_run` default true; conflict-checked; backs up originals) |
| `agent_limits` | show or clear usage-limit cooldowns |

The same functions exist as a CLI: `node src/cli.mjs status | models | route | run | result | apply | limits`.

## How routing works

1. **Classify (no tokens).** `kind` (explain … design), hard-topic keywords (security, concurrency,
   race condition, migration …), simple-wording keywords (typo, rename, explain …), input size, file count
   and write permission give a score. The score maps to a tier: `light`, `standard` or `heavy`. You can
   override it with `tier`.
2. **Candidate chain** from `routing.json` for that tier, for example:
   - light: `codex gpt-6-luna @low` → `antigravity gemini-3.8-flash-low` → …
   - standard: `codex gpt-6.1-sol @medium` → `antigravity gemini-3.8-flash-medium` → …
   - heavy: `codex gpt-6-astra @high` → `antigravity claude-opus-4-6-thinking` → …

   Candidates are skipped when the agent is not installed, when your account does not offer the model
   (live model lists: Codex `models_cache.json`, `agy models`), or when the model is in a cooldown.
3. **Claude's own work.** `route_task` also returns `claude.model` / `claude.effort`
   (haiku/low, sonnet/medium, opus/high). The CLAUDE.md snippet tells Claude to use them for its own
   subagents and to do 3-tool-call jobs itself.

Edit `routing.json` when providers ship new models; `node src/cli.mjs models` shows what your accounts offer.

## Usage limits and failover

| Event | Bridge behaviour |
|---|---|
| Usage/rate limit (`usage limit`, `429`, `quota`, `resource exhausted` …) | records a cooldown (parsed from "try again in 2 hours", default 30 min) for the **whole agent**, or only the model if the error names it; moves to the next candidate at once; later jobs skip it until the cooldown ends |
| Model not offered / unknown | 12 h cooldown for that model; next candidate |
| Not signed in | 10 min cooldown for that agent; next candidate |
| Crash / malformed output | retried on the same candidate (`retries`, max 2), then next candidate |
| Timeout / cancel | process tree killed; **no** failover (avoids burning quota on a job that is too big) |
| Everything exhausted | `status: "limited"` + advice: Claude does it itself with the advised model/effort |

`failover: false` (or `fallback_agent: "none"`) pins a single candidate. `agent_limits` with
`clear: "all"` resets cooldowns after your plan resets.

### When Claude itself hits its limit

A Claude Code session cannot route around its own limit, because it stops. Register the same bridge in
the other two apps so they can take over as orchestrator and call each other:

```bash
node scripts/setup.mjs --project <path> --register-codex --register-antigravity
```

Then continue in the Codex app or Antigravity, which see the same `delegate_task` tools and the shared cooldown ledger.

## Task contract

Request (`schemas/task-request.schema.json`): `objective` (required), `kind`, `input_files` (relative paths),
`context`, `constraints[]`, `expected_output`, `agent` (`auto`/`codex`/`antigravity`), `tier`, `model`,
`effort`, `failover`, `timeout_sec`, `retries`, `permissions.write`, `project_path`, `task_id`.

Result: `status` (`success`, `failed`, `limited`, `timeout`, `unavailable`, `blocked`, `invalid_request`,
`cancelled`, `running`), `agent`, `model`, `effort`, `tier`, `summary`, `findings[{severity,file,line,message}]`,
`warnings`, `errors[{class,agent,model,message}]`, `files_created/modified/deleted` (computed by the bridge,
not taken from the worker), `patch_path`, `apply_allowed`, `routing` (tier, reasons, planned chain,
skipped, Claude advice), `attempts[]`, `usage`, `recommended_next_action`.

## Security model

- Workers run in `<state>/tasks/<id>/stage`, a copy of only the listed `input_files`.
  State lives in `%LOCALAPPDATA%\agent-bridge` (Windows) or `~/.local/state/agent-bridge`.
- Refused: `.env*`, keys/certificates, `id_*`, credential/secret files, `auth.json`, databases, folders
  `.git .ssh .aws .codex .gemini node_modules`, and all media and binaries. Paths may not leave the project.
  Size limits are 1 MB per file and 10 MB / 200 files per task.
- Workers get a minimal environment, so no API keys are inherited. Prompts go through stdin (Codex) or as a direct
  argument without a shell (agy). Batch shims are never executed.
- Codex: `--sandbox read-only` (or `workspace-write` in the stage), `--ignore-user-config`, `--ephemeral`.
  Antigravity: `--sandbox`; shell stays soft-denied and `--dangerously-skip-permissions` is never used.
- Apply: optimistic lock (SHA-256 at staging) plus a per-project apply lock. Any change in between
  returns `CONFLICT`. Originals are backed up and nothing is deleted.
- Only the project root (`AGENT_BRIDGE_PROJECT`, else the server's working directory) is allowed. Add more
  with `AGENT_BRIDGE_ROOTS` or `config.json` `allowed_roots`.

## Tests

```bash
node tests/run-tests.mjs          # fast: contract, policy, classifier, cooldowns, crash/limit/auth failover,
                                  # timeout + process-tree kill, cancel, concurrency, orphans, MCP protocol
node tests/run-tests.mjs --real   # real Codex + Antigravity: auto routing, write+apply, cross-agent
                                  # failover, runtime model error, timeout, MCP async round trip
```

The real tests use your plans' quota (a few small jobs).

## Verified on

Windows 11, Node 26.7, Codex CLI 0.162 (bundled with the Codex desktop app, ChatGPT sign-in),
agy 1.3.5, Claude Code desktop app. The macOS/Linux paths (binary locations, `install.sh`, process
handling) follow the official docs but have **not been run** yet.

## Known limits

- Whether the Codex sandbox blocks *reads* outside the stage is unverified. Containment of reads relies on
  staging, the prompt rules and policy, so keep secrets out of reach regardless.
- The classifier is a heuristic. Override with `tier`, `model`/`effort` or edit `routing.json`.
- Model names in `routing.json` change over time. Unknown ones are skipped automatically, but update the list.
- Antigravity headless has no shell, so give it reading/editing jobs.
- Some MCP hosts (reportedly the Claude desktop app) cancel tool calls after about 60 s. Task tools therefore return
  `running` after 40 s, and `agent_task_result` collects the result.

## Uninstall

Remove the `agent-bridge` entry from the project's `.mcp.json` (backups sit next to it), remove the
`<!-- agent-bridge:start/end -->` block from `CLAUDE.md`, then run `codex mcp remove agent-bridge` /
`agy mcp remove agent-bridge` if registered. Optionally delete the state folder.
