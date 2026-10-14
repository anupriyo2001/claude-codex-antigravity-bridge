## External agents (agent-bridge: Codex + Antigravity)

Claude Code stays the orchestrator. The `agent-bridge` MCP server can hand bounded jobs to OpenAI Codex
and Google Antigravity, choose model and effort for the job, and fail over when a usage limit is hit.

Spend tokens to match the job:
- Before a non-trivial job, call `route_task` (free, no model call). It returns the difficulty tier,
  the external candidate chain, and `claude.model` / `claude.effort` for doing it yourself.
- When you spawn your own subagents, pass that model and effort: light -> haiku/low,
  standard -> sonnet/medium, heavy -> opus/high. Never use opus or high effort on a light job.
- Do jobs of three tool calls or fewer yourself; do not delegate them.

Delegate (`delegate_task`, or `codex_task` / `antigravity_task` to prefer one) for bounded technical
work: independent code review, debugging a failure (stage the files, put the error tail in `context`),
test generation, implementation alternatives, a second opinion. Set `kind` so routing is accurate.
- Long jobs return `status: "running"`; collect them with `agent_task_result`.
- Workers see only a staged copy of `input_files`. Never send secrets, credentials or media.
- Treat results as advice: verify findings yourself. For write tasks, read `patch_path`, then
  `agent_apply_changes` with `dry_run: true`, then `dry_run: false`.
- `status: "limited"`/`"unavailable"`: every candidate is exhausted or missing. Do the job yourself
  with the advised model/effort, or stop only that step. `agent_limits` shows cooldowns.
- Antigravity has no shell in headless mode: give it reading/editing jobs, not "run the tests".
