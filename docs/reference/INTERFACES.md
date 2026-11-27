# Larva 0.9 interfaces

## CLI: eight commands

| Command | Purpose |
| --- | --- |
| `larva persona validate <file\|dir\|-> [--json]` | Validate definitions without writing. Checks the schema, filename binding, and duplicate IDs in a batch. |
| `larva persona put <file\|dir\|-> [--prune] [--json]` | Validate all inputs, then upsert each definition. Directory-only `--prune` removes unlisted personas after successful incoming commits. |
| `larva persona get <id> [--json]` | Return the canonical spec and digest. |
| `larva persona list [--query <text>] [--full] [--json]` | Return ID-sorted summaries, or canonical specs with `--full`. Summaries include `id`, `description`, `model`, `thinking`, `can_spawn`, and `spec_digest`. |
| `larva persona rm <id...> [--json]` | Verify all IDs exist before removing both possible formats for each. |
| `larva mcp` | Serve stdio MCP over `Content-Length` or newline-delimited JSON-RPC 2.0. |
| `larva doctor [--profile <name>] [--json]` | Check home, runtime config, all definitions and model-map files, Pi discovery, and resolution of every persona route under the selected profile. |
| `larva gc [--max-age <days>] [--max-bytes <bytes>] [--dry-run] [--json]` | Reap dead capsules and leases; apply retention to inactive sessions and artifacts. |

Except for `larva mcp`, commands print concise human-readable summaries or tables by default. `--json` writes `{ ok: boolean, data?: ..., error?: { code, message, details? } }` to stdout. Exit status is `0` for success, `1` for domain, validation, or cleanup failure, and `2` for usage errors, which identify the offending or missing flags.

The top-level CLI and all subcommands support `--help` and `-h` on stdout with exit `0`. `larva mcp --help` prints usage before server startup. Without help, `larva mcp` reserves stdout for protocol traffic and rejects `--json` and unknown flags on stderr with exit `2`.

## Model tools: seven in native Pi, six in external MCP

Input objects are closed. A question mark denotes an optional field. Availability in Pi is also subject to persona and [spawn policy](PI_EXTENSION_ASYNC_SUBAGENTS.md#authority-and-tool-visibility).

| Tool | Input and result |
| --- | --- |
| `larva_personas` | `query?`, `limit?` (1–50, default 20). Ranked search over ID, description, and model. Returns persona summaries without prompts. |
| `larva_persona_switch` | **Pi main only, unavailable in `manual`.** `persona_id`, `reason`, `continue_task?`. Requests a turn-scoped borrow or persistent switch depending on [mode](PI_AGENT_PERSONA_SWITCH_POLICY.md#switch-modes). |
| `larva_subagent` | `persona_id`, `task`, `task_id?`, `cwd?`, `no_progress_timeout_ms?`, `stall_alert_ms?`. MCP additionally accepts `wait_for_completion?` and `parent_persona_id?`. Starts or resumes a child and returns an accepted receipt with `task_id`, `run_epoch`, and `cwd`, or enriched terminal output when MCP waits for completion. |
| `larva_subagent_wait` | `task_ids` (1–25), `return_when?` (`all` by default, `any`, or `first_error`), `timeout_ms?` (0–86,400,000; default 10,000). Observes the run instances bound at ingress. Use `0` for a nonblocking snapshot. MCP adds `terminal_outputs` keyed by `task_id` with explicit output states. |
| `larva_subagent_status` | `task_id?`, `scope?` (`active`, `recent` by default, or `disk`), `limit?` (1–25, default 10). Exact lookup cannot be combined with `scope` or `limit`. Exact lookup falls back to contained disk records. The disk inventory reports `cwd`, `cwd_exists`, and `lock_state` (`unlocked`, `active_local`, `active_external`, or `unreconciled`); process-local inventories include startup failures. |
| `larva_subagent_activity` | `task_id`, `limit?` (1–20, default 5), `cursor?`, `tool_name?`, `since_timestamp?`, `until_timestamp?`, `tool_call_id?`, `disambiguation_index?`, `entry_id?`, `result_index?`, `segment_part?` (`args` or `result`), `offset?`, `length?` (1–4000), `source_version?`. Read-only inspection of recorded tool activity in the contained child transcript. The final serialized wire `ToolResult` envelope is at most 8,192 UTF-8 bytes, including escaping and wrapper fields. |
| `larva_subagent_cancel` | `task_ids` (1–25), `reason` (1–500 code points), `expected_run_epochs?` (optional `{ task_id, run_epoch }` list). Cancels process-local runs. Returns `cancelled`, `already_terminal`, `not_found`, or `cleanup_unconfirmed` per handle. A mismatched expected epoch is `already_terminal`; `isError` is true for invalid input or unconfirmed cleanup. |

## Native Pi

- Start with `--larva-persona <id>` or `--larva-mode <manual|confirm|auto|free>`.
- In an idle TUI, no-argument `/larva-persona`, `/larva-mode`, and `/larva-model-map` open interactive selectors with the current choice marked. `Ctrl+Alt+P` also opens the searchable persona selector, which includes **None**. Escape makes no change. Supply an ID, mode, or profile to set it directly (`default` selects the default map).
- `--status` on any of the three commands inspects without mutation, as does invoking it without arguments outside the TUI. `/larva-model-map --status` reports profile and generation; `/larva-model-map status` selects the literal `model-map.status.json` profile.
- The `larva` status slot displays `🎭 <id>`, `🎭 none`, `🎭 <borrowed> ↩ <origin>`, or `🎭 ⚠️ <id> (<code>)`. The `larva-subagents` slot displays `🤖 <running>`, `🤖 <running> · <cancelling> 🛑`, or `🤖 <cancelling> 🛑` and hides when both counts are zero.
- `/larva-subagent [task_id | --cancel <task_id>]` opens the fullscreen **Summary / Output / Prompt / Timeline / Metadata** console or requests targeted cancellation. The console exposes startup failures, paged prompt and artifact text, and **Retry cleanup** for `cleanup_unconfirmed` rows. Targeted cancellation captures the run epoch before confirmation so it cannot cancel a replacement run.
- Larva-launched children don't register these slash commands or the shortcut. See [nested tool admission](PI_AGENT_PERSONA_SWITCH_POLICY.md#tool-admission) for direct and nested calls.
- Editor completion supports `/larva-persona <query>`, `@persona:<query>`, and `@<query>` (native file suggestions first).
- Slash command outcomes use TUI notifications or structured RPC custom/status events. Peer Pi extensions can use `larva:resolve-system-prompt:v1` with `scope: "main"`.

## Codex and external MCP

The marketplace entry points to `plugins/codex/`. Its `.mcp.json` runs `node ./dist/mcp-server.mjs` and forwards `LARVA_HOME`, `LARVA_PI_CLI_SCRIPT`, `LARVA_MCP_PARENT_PERSONA`, `PI_CODING_AGENT_DIR`, standard OS/XDG/proxy variables, and provider credential variables. The plugin bundles the server and its sibling runtime files.

An exact `@larva:<id>`, `@persona:<id>`, or `larva://personas/<id>` delegates directly to the specified persona. A generic `@larva` or `@Larva Subagents` mention searches first. Without an explicit Larva or persona request, use Codex's native tools. Prefer an authorized absolute `cwd` on fresh spawn unless the host exposes exactly one usable local workspace root. Omit `cwd` on resume to use the recorded workspace.

`search_mentions` and persona resources support composer completion. The app-only `larva_subagent_panel` serves the fullscreen thread workbench and epoch-pinned refreshes. Spawn and wait cards stay pinned to their initiating epochs and become read-only if the snapshot expires. Status cards and the standalone workbench follow their queries. The fullscreen inspector has **All / Timeline / Result / Task & Session** tabs, with on-demand prompt and artifact text and expandable recorded tool activity. Recorded rows disclose busy leases or missing workspaces without offering cancellation for non-local runs. Cards distinguish [output states](PI_EXTENSION_ASYNC_SUBAGENTS.md#progress-and-settlement), show stalls, and use epoch-guarded cancellation. Rows with `cleanup_unconfirmed` offer **Retry cleanup**. Hiding or tearing down a view stops polling, not the child process; a disconnected view is read-only.
