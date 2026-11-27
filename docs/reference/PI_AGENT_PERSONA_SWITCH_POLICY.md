# Pi persona switching

A persona binds identity, prompt, model, thinking, tool policy, and spawn authority in native Pi. Manual selection is distinct from model-initiated switching. See [Interfaces](INTERFACES.md#native-pi) for commands and startup flags.

## Startup precedence

Native Pi selects the first applicable identity: explicit `--larva-persona <id>`, the latest valid `larva-active-persona-commit` in restored session history, configured `default_persona`, then `larva:none`. An invalid or unavailable explicit persona exits `2` before prompting. Failure to activate a restored or configured default persona falls back to `larva:none` with a warning. Restore and session-tree navigation preserve genuine user model and thinking overrides made after the commit, not Larva's own borrow, profile, or rollback changes. Tree navigation also preserves the active model-map profile and unsettled restoration or routing latches.

Switch mode comes from `--larva-mode`, a session-local override, `config.json`, or the default `confirm`, in that order. The startup flag survives `/reload` until `/larva-mode` changes it. In a Larva-launched child, the launch-bound identity and `manual` mode are authoritative on both spawn and resume. Resume verifies the recommitted identity and route before forwarding the task.

## Switch modes

| Mode | Model-initiated `larva_persona_switch` |
| --- | --- |
| `manual` | Hidden and rejected if invoked directly. The human can still select a persona in the native parent. |
| `confirm` | Requires interactive TUI confirmation; otherwise returns `LARVA_CONFIRMATION_UNAVAILABLE`. |
| `auto` | Borrows the requested persona for the turn without confirmation. |
| `free` | Commits a persistent switch without confirmation. |

In `confirm`, the choices are **Borrow once** (default), **Deny**, **Auto-borrow for this session**, and **Switch persistently**. Auto-borrow promotes the session to `auto` only after the borrow succeeds. Denial, timeout, Escape, and Ctrl+C leave persona, route, and mode unchanged. A late response after denial has no effect.

`continue_task: true` must be the only tool call in its assistant turn; a mixed batch fails before confirmation or mutation with `LARVA_BAD_INPUT`. It starts a one-turn continuation. Autonomous continuation chains are capped internally at eight consecutive switches per user turn (`LARVA_SWITCH_CHAIN_LIMIT`). A persistent switch does not restore the prior persona after continuation.

## Turn-scoped leases

The first temporary borrow captures the original persona and exact native `(model, thinking)` pair. Borrows emit `larva-agent-persona-switch-audit`, not the persistent `larva-active-persona-commit` entry. A committed human selection via `/larva-persona`, `Ctrl+Alt+P`, or **Switch persistently** clears the lease and any restoration or routing latch. An ad-hoc model or thinking change, a failed switch, or a denial does not clear it.

At turn end (or continuation settlement), Larva restores:

- `larva:none` and its captured native route if the original identity was unset; a new profile remains selected for future persona activations.
- The original named persona and exact captured route if no profile change committed during the lease.
- The original named persona resolved under the new profile if a profile change committed during the lease.

A failed restoration preserves current runtime state, reports `restore_failed`, and blocks further autonomous switching until manual persona selection.

## Tool admission

Persona `tools.allow` narrows Pi's baseline tools (an empty list keeps the baseline); `tools.deny` wins. Structural switch and spawn restrictions narrow the set further. Both direct calls and nested `ctx.executeTool()` calls must pass persona policy, structural authority, and `route_uncertain` checks. Nested calls may use Pi's callable set even when a tool is not declared to the model at the top level; nesting does not bypass Larva's policy.

Authority changes before Pi snapshots the next turn update the active tool set for that turn. Once snapshotted, late spawn revocations remove disallowed declarations and reject calls immediately; late grants take effect at the next snapshot, subject to Pi's declaration hiding.

## Live model-map changes

In an idle TUI, `/larva-model-map` opens the profile selector. `/larva-model-map --status` reports the active profile and generation without changing them; outside the TUI, no argument also means inspection. `/larva-model-map <profile|default>` changes the profile, so `/larva-model-map status` still selects `model-map.status.json`. Lookup uses the exact `models` key first, then the longest matching prefix, then the literal route. Applying a profile changes model and thinking as a pair. If applying fails, the profile generation stays unchanged. A verified rollback reports failure; an unverified rollback raises `LARVA_ROUTE_UNCERTAIN` and requires manual `/model` or `/larva-persona` reconciliation.

The change is deliberately partial across children. Starting children that have not passed the pre-prompt route fence verify the new profile before accepting the prompt. Accepted children keep their verified route until the entire run settles, including internal callback continuations. Later spawns and resumes verify the new profile. The command reports `fenced_for_startup`, `in_flight_until_run_settles`, `ended_during_switch`, and `failed` counts.
