# Asynchronous Pi subagents

Native Pi and external MCP share one process supervisor. A child runs in an isolated Pi agent configuration capsule and retains its transcript in `LARVA_HOME/state/sessions/`. The sole public session handle, `task_id`, is the canonical path of that contained `.jsonl` file. Each run has a new opaque `run_epoch`; this distinguishes successive runs of the same transcript and guards cancellation and pinned UI views. See [Interfaces](INTERFACES.md#model-tools-seven-in-native-pi-six-in-external-mcp) for tool signatures.

## Authority and tool visibility

- **Native Pi at depth zero:** No active persona means no spawn authority. Under `root_session_spawn: "persona"`, the active persona's `can_spawn` governs. Under `"allow"`, `false` becomes `true`, but an explicit target allowlist still governs.
- **External MCP at depth zero:** The per-call `parent_persona_id` wins over a nonblank `LARVA_MCP_PARENT_PERSONA`. The resolved persona's `can_spawn` governs; absent both, the host grants spawn authority. `root_session_spawn` does not apply.
- **Descendants:** The launch-bound `LARVA_PI_INITIAL_PERSONA_ID` governs. A missing launch identity or conflicting parent override fails closed.

Native Pi first applies the persona's allow patterns to its baseline tools (an empty list keeps the baseline), then removes deny matches. Structural policy narrows this result: children and `manual` mode hide the switch tool, and `effectiveCanSpawn === false` hides all five subagent tools. The same [admission checks](PI_AGENT_PERSONA_SWITCH_POLICY.md#tool-admission) apply to stale direct calls and nested `ctx.executeTool()` calls.

## Admission and acceptance

1. Validate the persona and task, timeouts, workspace syntax, and lexical containment of any `task_id`.
2. Resolve the workspace. A fresh spawn takes an explicit existing absolute directory, or the native Pi session's `cwd`. External MCP without `cwd` requires exactly one reported root and that root must be an existing local `file://` directory; every other case returns `LARVA_CWD_REQUIRED`. Resume reads the Pi version 2 or 3 transcript header and requires an absolute, existing workspace. If supplied, `cwd` must match the resolved workspace.
3. Validate incoming and outgoing lineage (depth and ancestor count at most 100; serialized lineage at most 65,536 UTF-8 bytes).
4. Load and validate runtime configuration.
5. Enforce spawn authority and configured depth.
6. Reject ancestor self-resume, enforce the per-parent active-run limit, reserve the run slot, and acquire the atomic session lease. Resume rechecks transcript existence under the lease before starting Pi.

A lease is installed only after staging `lease.json`; it progresses through `reserving`, `spawning`, and `running`. The supervisor preserves ambiguous spawn evidence as unreconciled rather than assuming a grace period proves exit. Stale lease reclamation requires positive evidence that the relevant owner and child process tree have exited; it rechecks the observed lease ID under a serialized guard. A live run's lease is released only after teardown is confirmed.

An accepted receipt requires a verified preload capability (`max_record_bytes: 1048576`, terminal marker `agent_settled`), a verified route via `get_state`, a locked task ID, and successful RPC `prompt` admission that was not dispatched as a handled command. Acceptance is not completion.

## Progress and settlement

- The hard silence deadline `no_progress_timeout_ms` accepts 120,000–86,400,000 ms; default 3,600,000 ms. `stall_alert_ms` is `0` to disable or 60,000–86,400,000 ms. An explicit positive alert must be less than the hard deadline; an inherited alert is capped at half the deadline.
- Timers start at acceptance. An alert marks the run `stall_suspected`; eligible native parents receive at most one alert steer per silence episode. Recognized progress restores `waiting_for_child`. The hard deadline cancels the run, with a 1,500 ms grace period before `SIGKILL`.
- Native Pi terminal callbacks are distinct from alerts. In multi-hop runs, a terminal callback obligation settles when the callback is recorded and its consuming turn settles, or when delivery fails, is suppressed, or becomes stale. Alerts do not create such obligations. `/reload` retains ownership, epoch, original deadlines, and at-most-once terminal callback delivery.
- Execution `status` (`accepted`, `running`, `cancelling`, `success`, `failed`, `cancelled`) is separate from `output_state` (`pending`, `inline`, `artifactized`, `delivery_failed`, `evicted`). Results longer than 36,000 code points are written as artifacts. A failed artifact write after successful execution reports `delivery_failed` without turning the run into a failure or replaying it.

## Observation and cancellation

Use `larva_subagent_wait` to synchronize, `larva_subagent_status` for point-in-time state, and `larva_subagent_activity` for read-only recorded tool activity. Activity describes the transcript, not process acceptance or liveness. Its serialized wire `ToolResult` envelope is capped at 8,192 UTF-8 bytes. Native Pi receives results through terminal callbacks; MCP can enrich a wait with terminal output. Wait binds all targets to their epochs at ingress, including when a transcript is resumed while waiting. The deadline covers output enrichment: ready execution may return with output still `pending`. `first_error` means execution failed or was cancelled, not that output delivery failed. The supervisor retains terminal snapshots and output metadata for the 25 most recent completed epochs.

Cancel explicitly with `larva_subagent_cancel` and use `expected_run_epochs` when acting on a previously observed run. If exit or cleanup cannot be confirmed, Larva keeps the capsule and lease evidence, reports `cleanup_unconfirmed`, and does not terminate the host or affect unrelated runs. Bounded background checks continue until confirmed cleanup releases the slot and lease. Both consoles offer **Retry cleanup** for these rows. On host shutdown (EOF, `SIGTERM`, or `SIGINT`), standalone MCP exits `1` if owned runs or cleanup are still unsettled. View teardown, status reads, and wait timeouts do not cancel runs.

`larva gc` only reclaims capsules and stale locks with confirmed exit evidence; unresolved spawning capsules are retained and reported. See [operator retention guidance](../guides/USAGE.md#inspect-and-retain-state).
