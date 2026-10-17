---
name: larva-subagent
description: Discover Larva personas and delegate self-contained work to Pi child sessions through MCP.
---

# Larva subagent routing

## When to use Larva vs. native Codex subagents

1. **Default to Codex native subagents:** Use Codex's built-in `spawn_agent`,
   `wait`, `send_input`, and `close_agent` for ordinary subagent delegation.
2. **Opt-in / capability-driven `larva_subagent`:** Use it only when the user
   explicitly requests `larva` / `larva_subagent` / `pi` subagents, uses
   `@larva` / `@larva:<persona_id>` / `@persona:<persona_id>` /
   `larva://personas/<persona_id>` composer mentions, or when
   the task requires Larva-specific capabilities: `model-map.json` cross-provider
   routing, persistent `.jsonl` child session resume across turns/processes,
   `can_spawn` parent whitelist enforcement, or `larva_subagent_activity`
   inspection.
3. **Strict handle separation:** Pass `larva_subagent` `.jsonl` `task_id`
   handles only to `larva_subagent_wait`, `larva_subagent_select`,
   `larva_subagent_cancel`, `larva_subagent_activity`, or `larva_subagent`
   (resume)—never to Codex's `wait`, `send_input`, or `close_agent`.
   Never pass Codex `agent_id` handles to `larva_subagent_*` tools.

Retain integration responsibility and respect the user's scope, effect
permissions, and any parent persona's `can_spawn` policy.

## Discover and delegate

When the user selects a persona via `@larva` + `Tab` in the Codex composer,
the inserted mention is
`[@larva:<persona_id>](mcp-resource://larva-pi-subagent/larva%3A%2F%2Fpersonas%2F<persona_id>)`.
That selection, a `larva://personas/<persona_id>` resource, or a written
`@larva:<persona_id>` / `@persona:<persona_id>` supplies the exact `persona_id`:
call `larva_subagent` directly with that ID without calling `larva_personas` first.
When no exact `persona_id` is given (including `@Larva Subagents` alone), call
`larva_personas` first with a task-relevant query and select a fitting returned
candidate. Give `larva_subagent` its exact `persona_id`, a concise
route rationale, absolute working paths, requested outcome, allowed effects,
exclusions, and completion checks. Do not invent persona IDs.

For one delegated task, set `wait_for_completion: true` to receive terminal
output in the same call. Set the host tool timeout high enough for the work.
For parallel fan-out, set `wait_for_completion: false` on each call, retain
every accepted exact `task_id`, then use `larva_subagent_wait` (`all`, `any`,
or `first_error`) or `larva_subagent_select` (any ready child). Use bounded
`timeout_ms` checkpoints. Read `terminal_outputs` keyed by task ID; an empty
outbox on a timed-out checkpoint is not completion. Check terminal status and
integrate each child's result, including failures and reported gaps.

### Call examples

Replace the example persona with a discovered ID and `task_id` with an exact
returned handle; the following are alternative calls, not a script to replay:

```json
[
  {"name":"larva_personas","arguments":{"query":"TypeScript"}},
  {"name":"larva_subagent","arguments":{"persona_id":"node-typescript-engineer","task":"Inspect the assigned absolute project path and report findings.","wait_for_completion":true}},
  {"name":"larva_subagent","arguments":{"persona_id":"node-typescript-engineer","task":"Inspect one independent assigned component.","wait_for_completion":false}},
  {"name":"larva_subagent_wait","arguments":{"task_ids":["/owned/children/exact-session.jsonl"],"return_when":"all","timeout_ms":60000}},
  {"name":"larva_subagent_select","arguments":{"task_ids":["/owned/children/exact-session.jsonl"],"timeout_ms":60000}},
  {"name":"larva_subagent","arguments":{"persona_id":"node-typescript-engineer","task":"Continue the same authorized task.","task_id":"/owned/children/exact-session.jsonl","wait_for_completion":true}},
  {"name":"larva_subagent_activity","arguments":{"task_id":"/owned/children/exact-session.jsonl","limit":5}}
]
```

## Resume and inspect

Resume by calling `larva_subagent` with the same persona, a continuation task,
and the exact returned absolute child-session JSONL `task_id`. Never substitute
a persona name, partial path, `last`, or `latest`. Reconcile uncertain prior
effects before any user-authorized resume after cancellation.

Use `larva_subagent_activity` with an exact `task_id` (or `session_path`) for
read-only recorded tool activity. Page with its cursor; expand an exact
`tool_call_id` when necessary. Activity is recorded evidence, not proof of
acceptance or live lifecycle authority. Use status/events for diagnostics and
`larva_subagent_cancel` for targeted cancellation; never shell sleep polling.
Keep the MCP connection open: runs and outbox are process-local, and disconnect
aborts active children. Historical sessions remain resumable by exact path,
but a new server cannot observe old live handles or recover the old outbox.
