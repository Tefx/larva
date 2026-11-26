# Larva user guide

## Create and install personas

Follow the [installation instructions](../../README.md#install-and-start). Larva keeps definitions under `LARVA_HOME/personas/` and defaults to `$HOME/.larva` when `LARVA_HOME` is unset or empty.

Save this as `reviewer.md`, replacing `provider/model-id` with a route available in Pi:

```markdown
---
description: Reviews a proposed change.
model: provider/model-id
thinking: medium
---

Inspect the proposed change. Return prioritized findings with file references.
```

The same definition can be authored in JSON as `reviewer.json`:

```json
{
  "id": "reviewer",
  "description": "Reviews a proposed change.",
  "model": "provider/model-id",
  "thinking": "medium",
  "prompt": "Inspect the proposed change. Return prioritized findings with file references."
}
```

Choose one format per ID. The Markdown filename supplies an omitted `id`; JSON requires it. Both definitions produce the same canonical spec and `spec_digest`. When reading from stdin, either format requires an explicit `id`.

```sh
larva persona validate reviewer.md
larva persona put reviewer.md
larva persona list --query review
larva persona get reviewer --json
larva doctor
```

To replace Markdown with JSON, run `larva persona put reviewer.json`; it installs the validated replacement, then removes the other format. `larva persona rm reviewer` removes the definition regardless of format. `larva persona put <dir> --prune` also removes personas not in the import, so use it only for a directory intended to define the full store.

## Use personas in Pi

Start with `pi --larva-persona reviewer`, or use `/larva-persona reviewer` in an open session. `/larva-persona` without an ID and `Ctrl+Alt+P` open the TUI selector. Check the badge to see which persona is active. `/larva-mode` reports the autonomous switch mode: `manual` keeps selection human-controlled, `confirm` asks in the TUI, `auto` lets the agent borrow a persona for a turn, and `free` allows the agent to switch persistently.

To delegate, create a second persona with an explicit spawn allowlist. For example, save this as `coordinator.md`, update the route, and run `larva persona put coordinator.md`:

```markdown
---
description: Coordinates reviews.
model: provider/model-id
can_spawn: [reviewer]
---

Delegate change reviews to the reviewer persona. Summarize its findings and
state any remaining uncertainty.
```

Activate `coordinator` and ask it to delegate a review to `reviewer`. The child has its own Pi process, config capsule, and recorded transcript. Open `/larva-subagent` to monitor runs. Cancelling a run is explicit; leaving the console does not cancel it.

## Delegate from Codex

Enable Larva Subagents from the local marketplace entry for `plugins/codex/`. The plugin ships its own MCP server but needs Pi available to launch children. Use the same `LARVA_HOME` as in the persona setup.

Mention `@larva:reviewer` to delegate directly, or use `@larva` without an ID to search. On fresh runs give Codex an authorized absolute workspace path if the host cannot supply exactly one usable local root. To resume, use the exact `task_id`; Larva reuses the workspace recorded in the transcript. Spawn and wait cards follow the run they started, even if the transcript is later resumed in a different run.

For configuration and troubleshooting, see the [operator guide](USAGE.md). For the full launcher and tool surface, see [Interfaces](../reference/INTERFACES.md).
