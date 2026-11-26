# Larva 0.8.12

Larva now supports multi-hop subagents in Pi and the Codex MCP bridge. Spec v4 separates the shared launch and lineage mechanism from the policy for model-facing subagent tools.

- `subagent-runtime.json` adds three optional policy settings. `root_session_spawn` defaults to `"persona"`; `"allow"` bypasses `can_spawn` only for a native Pi root with an active persona and does not bypass Pi tool policy. `max_depth` limits nesting, and `max_active_runs` limits unsettled runs owned by the spawning process. Internal persona invocation shares the lineage mechanism but not these policy settings.
- Spawn admission runs six checks in order: validate inputs, resolve the child session root and any resume target, validate lineage, load runtime config, enforce depth and spawn authority, then check session ownership and reserve an active-run slot. The first failure wins. Independent hard limits cap depth at 100 and the ancestor list at 100 canonical session handles and 65,536 UTF-8 bytes. Resuming an ancestor or a still-owned session is rejected.
- Modern child RPC waits for descendant runs and their callback continuations before settling. Recognized descendant activity resets watchdogs hop by hop, and a resumed child keeps its launch persona.

## Installation and updates

- Python CLI and MCP server: `pip install larva==0.8.12` from PyPI, or run `uv sync` in a checkout of `v0.8.12`.
- Pi extension: `pi install npm:pi-larva@0.8.12`.
- Codex plugin: update the configured Larva marketplace source to `v0.8.12`, refresh the cached bundle, and restart Codex:

  ```bash
  codex plugin remove larva-subagent@larva
  codex plugin add larva-subagent@larva
  ```

See the [Spec v4 admission and lineage reference](https://github.com/Tefx/larva/blob/v0.8.12/docs/reference/PI_EXTENSION_ASYNC_SUBAGENTS.md#spawn-admission-and-lineage-spec-v4) for details.
