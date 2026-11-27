# Larva operator guide

## Configure an isolated home

An unset or empty `LARVA_HOME` selects `$HOME/.larva`. For a separate workspace or test run, use an existing normalized absolute path such as the result of `mktemp -d`:

```sh
export LARVA_HOME="$(mktemp -d)"
larva persona put reviewer.md
larva doctor --json
```

The CLI prints human-readable summaries by default; use `--json` for scripts. Every subcommand supports `--help` (`-h`). `larva mcp --help` prints help without starting MCP; normal `larva mcp` traffic reserves stdout for the protocol.

`larva doctor` is read-only. It diagnoses malformed definitions, dual-format conflicts, invalid route maps, Pi discovery, and unavailable models. It validates all maps and checks persona routes under `--profile <name>` when given, otherwise under `model-map.json` if present, or against literal routes when absent.

### Runtime configuration

`$LARVA_HOME/config.json` is optional. It accepts only the following keys, with closed nested objects. Invalid or unreadable configuration fails closed.

| Key | Values and defaults |
| --- | --- |
| `default_persona` | A persona ID or `null` (default). |
| `switch_mode` | `manual`, `confirm` (default), `auto`, or `free`. |
| `confirm_timeout_ms` | `0` disables the timeout; otherwise 1,000–86,400,000 ms. Default 900,000 ms. |
| `subagent.extension_sources` | Unique nonempty strings, default `[]`. Relative local paths resolve against `realpath(LARVA_HOME)`; `~/` expands and `pi-agent:` resolves against the base Pi agent directory. `builtin:`, `npm:`, `git:`, and URL sources are passed to Pi. |
| `subagent.root_session_spawn` | `persona` (default) or `allow`. Applies only to native Pi at depth zero with an active persona. An explicit target allowlist still applies. |
| `subagent.max_depth` | Optional integer 1–100; unset leaves only the hard ceiling of 100. |
| `subagent.max_active_runs` | Optional integer 1–100, limiting unsettled runs per parent process. |
| `subagent.stall_alert_ms` | `0` disables the alert; otherwise 60,000–86,400,000 ms. Default 600,000 ms, bounded by the run's hard deadline. |
| `gc.max_age_days` | Integer 1–3,650; default 30. |
| `gc.max_bytes` | Optional combined session and artifact byte target, at least 1,048,576 bytes. |

### Model maps

Store the default map in `model-map.json` and a named map such as `work` in `model-map.work.json`. Both are optional; named profiles use lowercase letters, digits, and hyphens, and `default` is reserved for the default map. A map contains only optional `models` and `prefix_rules` keys:

```json
{
  "models": {
    "provider/model-id": { "provider": "local", "model_id": "review" }
  },
  "prefix_rules": [
    { "from_prefix": "provider/", "to_provider": "local", "to_model_id_prefix": "mirror/" }
  ]
}
```

Entries are closed. Keys and values are nonempty and whitespace-free, except `to_model_id_prefix` may be empty. Duplicate `from_prefix` values are invalid. An exact route wins over the longest matching prefix; if neither matches, Larva uses the literal route. Run `larva doctor --profile work` to check the named profile and `/larva-model-map work` in Pi to select it. Use `/larva-model-map --status` to inspect the active profile and generation; `/larva-model-map status` selects `model-map.status.json` if it exists.

## Configure an external MCP host

Register `larva mcp` as a stdio server and pass the same `LARVA_HOME` and Pi provider environment to it. For Codex, the `plugins/codex/` marketplace plugin supplies its own server. Set `LARVA_MCP_PARENT_PERSONA` when you want a default parent identity to restrict root-level delegation; an explicit per-call `parent_persona_id` takes precedence. With neither set, the external host grants root-level spawn authority.

For a fresh spawn, supply an authorized, existing absolute `cwd` unless the host exposes exactly one usable local workspace root. Do not assume the server's own working directory is the workspace. For a resume, supply the exact `task_id` and omit `cwd` to use the recorded workspace.

Use `larva_subagent_wait` with `return_when: "any"` to observe the next ready result in a batch and `larva_subagent_status` to inspect current ownership. `larva_subagent_activity` reads recorded tool traces, not live state, and caps the final serialized `ToolResult` at 8,192 UTF-8 bytes. To cancel, pass `task_ids` and `reason` to `larva_subagent_cancel`; include `expected_run_epochs` when acting on an earlier snapshot. `cleanup_unconfirmed` means Larva kept the ownership evidence and will recheck cleanup in the background; the consoles also offer **Retry cleanup**.

## Inspect and retain state

```sh
larva gc --dry-run --json
larva gc --max-age 30 --max-bytes 104857600 --json
```

GC reaps only confirmed-dead capsules and stale leases and keeps evidence when teardown is unconfirmed. It protects locked or unreconciled sessions and files younger than 60 seconds. When a byte target is set, it also protects files within 24 hours. GC removes age-expired eligible files first, then removes remaining eligible sessions and artifacts oldest first until the byte target is met or no eligible files remain. Protected bytes still count toward the budget. Removing a session acquires its lease and rechecks eligibility so GC and resume cannot unlink and open the same session concurrently.

Dry-run and live reports include `deleted_sessions`, `deleted_artifacts`, `freed_bytes`, `remaining_bytes`, `protected_bytes`, and `budget_met`. `budget_met: false` can therefore be a successful GC result. Do not delete leases or terminate processes based solely on timestamps; inspect ownership and recorded evidence first.

See [Interfaces](../reference/INTERFACES.md) for command and tool signatures and [Asynchronous subagents](../reference/PI_EXTENSION_ASYNC_SUBAGENTS.md) for lifecycle details.
