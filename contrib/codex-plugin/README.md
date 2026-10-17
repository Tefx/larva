# Larva subagents for Codex and other MCP hosts

The `larva-pi-subagent` stdio server runs persona-scoped Pi child sessions
from Codex, Claude Code, Cursor, OpenCode, or any MCP stdio host. The Codex
plugin adds a routing skill and presentation assets; direct MCP needs no plugin.

## Two independent MCP servers

| Server | Entry point | Capability |
| --- | --- | --- |
| Python registry | `larva mcp` | 13 PersonaSpec validation, CRUD, resolve and variant tools |
| Node child runtime | `node /absolute/path/to/larva/contrib/pi-extension/subagent-mcp-server.mjs` | 9 Pi persona discovery and subagent runtime tools |

Configure both when needed. `larva_personas` discovers resolved candidates
through the Larva CLI; the runtime supplies no registry mutations. The Python
server does not launch Pi children.

## Layered routing design

### Codex Plugin: Strategy B

Use native `spawn_agent` / `wait` / `send_input` / `close_agent` by default.
Opt into `larva_subagent` for an explicit Larva/Pi request or a needed capability:
persona `model-map.json` cross-provider routing, persistent `.jsonl` session
resume, a parent's `can_spawn` whitelist, or `larva_subagent_activity` inspection.
The bundled routing skill supplies this Codex-specific guidance.

Keep handles strictly separate: Larva's exact absolute `.jsonl` `task_id`
belongs only to Larva subagent tools, including resume. Codex `agent_id`
belongs only to native tools. Never pass one system's handle to the other.

### General Harness MCP

The nine tool descriptions are harness-neutral. Hosts with built-in subagents
should use those by default; Claude Code, Cursor, OpenCode and other stdio hosts
can opt into Larva capabilities without the Codex plugin or its skill.

## Prerequisites and automatic executable discovery

Install the Python Larva CLI and Pi separately; provide provider credentials
through the host environment. Use Node with native TypeScript and
`node:module.registerHooks` support. The checkout lock records Pi 0.85.1 as
build context; installed versions are not rejected by version number.
The headless entry supplies a TUI fallback only when normal package resolution
cannot find `@earendil-works/pi-tui`; native Pi keeps its TUI import.

**Larva CLI:** an explicit `LARVA_CLI_ARGV_JSON` argv prefix takes precedence.
Otherwise settings (including `~/.pi/agent/settings.json` `larva.cliPath`)
are consulted before executable discovery at `~/.local/bin/larva`, then
`PATH`. For example, existing settings may contain:

```json
{"larva": {"cliPath": "/absolute/path/to/larva"}}
```

**Pi CLI:** without an override, Larva searches `PATH`. The MCP host appends
existing `~/.local/bin`, `~/.pi/agent/bin`, `/opt/homebrew/bin` and
`/usr/local/bin` as tail fallbacks, preserving explicit prefix precedence.
Pi Managed Installer discovery follows `~/.local/bin/pi` to
`~/.pi/agent/bin/pi`, reads `~/.pi/agent/install/current-version`, then inspects
`~/.pi/agent/install/releases/<ver>/node_modules/.bin/pi`.
`inspectPiCliScript` verifies the real package name
`@earendil-works/pi-coding-agent` and exact `bin.pi` identity before launching
the JavaScript entry with the host's Node executable.

`LARVA_PI_CLI_SCRIPT` (or `LARVA_PI_REAL_BIN` when absent) strictly overrides
discovery. Set it only to an absolute real package bin script, never a shell
launcher. An invalid override fails closed with `LARVA_CHILD_START_FAILED`;
it does not fall back to managed indirection or `PATH`.
Native Pi keeps its captured package/bin launch identity.

## Install as a Codex Plugin

This is the supported Codex compatibility layout:
`.codex-plugin/plugin.json`, `.mcp.json`, `skills/`, and `assets/`.
See [OpenAI's packaging guide](https://developers.openai.com/plugins/build/plugins).

The repository includes `.agents/plugins/marketplace.json`, pointing to
`contrib/codex-plugin/`. Install directly without staging or configuration edits:

```sh
codex plugin marketplace add /path/to/larva
codex plugin add larva-subagent@larva
```

Codex copies the self-contained plugin into its cache. The MCP configuration
runs `node ./subagent-mcp-server.mjs` with `cwd: "."` at that cached plugin root.
The five bundled runtime files are `subagent-mcp-server.mjs`, `larva.ts`,
`activity.ts`, `child-rpc-frame-preload.mjs`, and `session-timeline-worker.mjs`.
They are byte-identical to the Pi extension sources;
no `node_modules` or `../pi-extension` is needed. Pi and the Python Larva CLI
remain separately installed executables. Configure their paths and credentials
in the launching environment as above. External-host runs skip TUI presentation and
timeline workers; dangling base-agent symlinks are ignored when creating capsules.

Restart the desktop client, start a new conversation, and verify that the skill
and nine runtime tools appear. After updating the checkout, refresh the cached copy:

```sh
codex plugin remove larva-subagent@larva && codex plugin add larva-subagent@larva
```

If your client lacks local plugins, use direct MCP configuration instead.
Configure only one runtime connection to avoid splitting process-local handles.

These are operator instructions; repository checks never install a plugin or
edit your live `~/.codex/config.toml` or `~/.codex/plugins/`.

## Direct MCP configuration

### Codex (`~/.codex/config.toml`)

Add a server to `~/.codex/config.toml` yourself (merge with existing settings):

```toml
[mcp_servers.larva-pi-subagent]
command = "node"
args = ["/absolute/path/to/larva/contrib/pi-extension/subagent-mcp-server.mjs"]
tool_timeout_sec = 3600
env_vars = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR",
  "LARVA_CLI_ARGV_JSON", "LARVA_PI_CLI_SCRIPT", "LARVA_PI_MODEL_MAP_FILE",
  "LARVA_PI_SUBAGENT_CONFIG_FILE", "LARVA_PI_CHILD_SESSION_DIR",
  "LARVA_MCP_PARENT_PERSONA", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "GEMINI_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"]
```

Automatic executable discovery needs no path overrides. For unusual installations,
set `LARVA_CLI_ARGV_JSON` and/or `LARVA_PI_CLI_SCRIPT` in the launching environment.
The bundle's
[`.mcp.json`](.mcp.json) contains the fuller provider/proxy allowlist; copy
additional entries for your provider. Never put API key values in the bundle.
An allowlist forwards existing values; it does not obtain credentials.

Optional `LARVA_PI_MODEL_MAP_FILE` and `LARVA_PI_SUBAGENT_CONFIG_FILE` select
adapter-local configuration. `LARVA_PI_CHILD_SESSION_DIR` selects persistent
child history. `PI_CODING_AGENT_DIR` selects Pi agent state. Use absolute paths.

The external server supplies `externalHostCanSpawn: true`; it needs no active
native Pi parent persona. Set `LARVA_MCP_PARENT_PERSONA` to enforce a resolved
parent's `can_spawn`, or pass `parent_persona_id` per spawn/resume call (takes
precedence). Without either, the external host supplies spawn authority.
Native Pi's active-persona authority rules remain unchanged.

### General MCP harnesses (Claude Code, Cursor, and OpenCode)

For Claude Code or Cursor, merge this entry into the host's MCP settings
(Claude Code project `.mcp.json`; Cursor project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "larva-pi-subagent": {
      "command": "node",
      "args": ["/absolute/path/to/larva/contrib/pi-extension/subagent-mcp-server.mjs"]
    }
  }
}
```

For OpenCode, merge into `opencode.json`:

```json
{
  "mcp": {
    "larva-pi-subagent": {
      "type": "local",
      "command": ["node", "/absolute/path/to/larva/contrib/pi-extension/subagent-mcp-server.mjs"],
      "enabled": true,
      "timeout": 3600000
    }
  }
}
```

Host-specific environment forwarding and call deadlines differ. Ensure the host
passes your provider credentials/proxy variables, and raise its tool deadline
for long waits. Codex's `env_vars` and `tool_timeout_sec` are Codex settings;
do not assume other hosts implement those keys.

## Tool usage and runtime lifecycle

In the Codex composer, type `@larva` → `Tab` → select `@larva:<persona_id>`.
The `openai/mentions` extension advertises `search_mentions`, a read-only,
app-only autocomplete tool (`ui.visibility: ["app"]`) alongside the nine
model-facing runtime tools below. It returns up to 30 ranked persona resource
links; an empty query lists available candidates. The server exposes
`larva://personas/{persona_id}` MCP resources through `resources/list`,
`resources/read`, and `resources/templates/list`. Resource text includes the
resolved persona ID, model, description, and delegation guidance.

An exact selected or written `@larva:<persona_id>` / `@persona:<persona_id>`
mention supplies the ID for a direct `larva_subagent` call. Without an exact ID,
including `@Larva Subagents` alone, discover candidates with `larva_personas`
first. Server `instructions` carry this guidance for MCP hosts.

| Tool | Use |
| --- | --- |
| `larva_personas` | Discover resolved persona candidates |
| `larva_subagent` | Spawn or resume a persona-scoped child |
| `larva_subagent_wait` | Wait for all, any, or first error |
| `larva_subagent_select` | Wait for any selected task |
| `larva_subagent_status` | Inspect process-local run snapshots/startup failures |
| `larva_subagent_events` | Read ordered lifecycle events |
| `larva_subagent_sessions` | List recent process-local sessions |
| `larva_subagent_cancel` | Cancel one exact task handle |
| `larva_subagent_activity` | Inspect recorded tool calls/results from a session path |

The server loads `larva.ts` when a `tools/call` passes tool lookup and input
schema validation, or when listing/reading persona resources. Initialization,
ping, `tools/list`, `resources/templates/list` and schema-rejected calls
leave the runtime unloaded (about 42 MB idle RSS in an observed local run;
platform and Node build affect this figure). Idle EOF exits without importing
it; after loading starts, shutdown awaits `resetExtensionUI("mcp_shutdown")` to reap children and capsules.

For one task, `larva_subagent(wait_for_completion: true)` returns terminal
results in `structuredContent.terminal_outputs` keyed by exact task ID.
For parallel work, use `wait_for_completion: false` (the default), preserve the
accepted `task_id`, then call `larva_subagent_wait` or
`larva_subagent_select`. Those results include snapshots/readiness and
`terminal_outputs`; text content also includes captured callback messages.
Payloads include `result_text`, `child_output_truncated`, and nullable
`full_output_artifact`. Read a referenced artifact only when needed.

The outbox retains up to 25 completed outputs for this server process.
Observation does not consume output. A timeout can return no terminal output.
Keep the connection open; EOF/signals abort active children, and restarting the
server loses observer registry/outbox state. Exact historical JSONL paths can
be resumed, but are not rediscovered as live handles by a new process.
Resume by passing the exact `.jsonl` `task_id` plus `persona_id` and a continuation
`task` to `larva_subagent`. Use `larva_subagent_activity({task_id: ...})` for
read-only historical tool inspection, including after restart; recorded activity
does not establish current execution or acceptance. See
[Workflow E](../../docs/guides/USAGE.md#workflow-e-cross-harness-pi-subagents-codex-and-general-mcp-harnesses)
for concrete calls. Use bounded wait/select calls, never shell sleep polling.
The 3600-second host call timeout, observer `timeout_ms`, and child's no-progress watchdog are
independent; a host timeout is not proof of cancellation. Inspect and reconcile
effects before retrying or resuming uncertain work.

### Live activity panel and inline widget

MCP Apps hosts open the **Larva Subagents** thread side-panel tab through
the app-only `larva_subagent_panel` tool → `ui://larva-pi-subagent/panel-v2`.
The panel advertises fullscreen only and has no redundant Inline button.
Spawn, wait, select, and status tool cards attach
`ui://larva-pi-subagent/widget-v2` as a **collapsed-by-default inline card**.
The versioned URIs refresh Codex Desktop's cached UI resource. Legacy
`/panel` and `/widget` resource reads still return the same current app.

The compact card shows persona, model · thinking, tool count, elapsed time,
Cancel for active runs, and one activity or terminal-summary line. Details
opens a scrollable drawer capped at 340px; Hide details collapses it again.
Multiple runs use compact selectable rows. Only the widget offers Fullscreen /
Inline switching. The panel always keeps its workbench layout.

The **workbench** shows an All / Active / Done run filter, grouped run selector,
and an always-visible selected-run inspector. Below 680px, the selector stacks
above the inspector and scrolls within a 148px cap; the inspector fills the
remaining height. Wider windows use two columns. There is no list/detail
screen switch.

The inspector defaults to **All**, showing Task Prompt, Timeline, and Result
cards in that order, followed by a compact paired Session Metadata grid. Timeline, Result, and Task & Session filters each show only
their corresponding card. Task Prompt displays the full multiline
`task_prompt` (falling back to `task_preview` for older snapshots), with Copy
prompt and Expand prompt / Collapse prompt controls. Its text viewport starts
at a 110px maximum height; expansion removes that text height cap. Compact
run cards continue using bounded activity/task previews.

Timeline shows bounded assistant output and collapsible tool rows; expanding
a row reveals previews and Inspect args / result through
`larva_subagent_activity`. Result and session metadata offer Copy controls.
Refresh uses the host bridge. Host theme, style variables, and safe-area insets
apply to both layouts. Display, clipboard, and bridge availability depend on
host support.

The server advertises eleven tools: nine model-facing runtime tools and two
app-only tools (`search_mentions`, `larva_subagent_panel`). UI resources load
without importing `larva.ts`. The self-contained app uses only the parent
JSON-RPC bridge, makes no network requests, polls every second while active
and every 2.5 seconds while idle, and pauses polling in hidden documents.
Panel reads preserve the process-local outbox and never consume child output.
Restart loses live state; recorded historical activity remains separate.

Status, panel, and wait/select snapshots include the full initial `task_prompt`
with preserved newlines, alongside bounded `task_preview` and assistant previews,
startup model/requested and effective thinking levels, thinking/tool indicators,
the 25 most recent tool snapshots, last child activity, and terminal result
preview. External-host runs populate these fields directly from child RPC
frames without retaining native TUI presentation logs or spawning timeline
workers. Preview text is bounded; Inspect retrieves paged recorded segments.

### Child RPC readiness and timeout diagnostics

Child Pi initial RPC readiness has a separate 60-second window
(`CHILD_RPC_STARTUP_READY_TIMEOUT_MS = 60_000`): fresh `get_state` (`state-1`)
and resumed `switch_session` (`switch-1`) use it after spawn. Subsequent ordinary
RPC commands, including route-state checks, `set_model`, `set_thinking_level`,
and final-text collection, retain the 10-second
`CHILD_RPC_COMMAND_TIMEOUT_MS = 10_000` default. Model-map child route switches
explicitly use the 5-second `MODEL_MAP_CHILD_SWITCH_TIMEOUT_MS = 5_000`
override for their state/model/thinking commands and rollback. Prompt preflight
retains its separate 60-second window. These windows do not extend the no-progress watchdog
or observer deadlines.

RPC timeout errors report `id`, `type`, `stage`, `first_frame_received`,
`child_state`, and `elapsed_ms` (time since the RPC client was created).
Before readiness, `stage=startup_readiness`; afterward it identifies the current
run phase, falling back to `post_readiness` when no context exists.
With `LARVA_PI_CHILD_RPC_TRACE_FILE` enabled, the `rpc_timeout` event records
`pid`, `id`, `command_type` (the error's `type`), `stage`, `timeout_ms`,
`elapsed_ms`, `first_frame_received`, `frame_sequence`, `rpc_ready`,
`child_state`, `exit_code`, and `signal`. The child state is `running`,
`exited(code)`, or `signaled(signal)`.

## Verification boundary

`tests/shell/test_codex_plugin_contract.py` checks manifest/config structure,
resource paths, environment forwarding declarations, skill frontmatter, and a
regular-file-only cache startup without dependencies, runtime SHA-256 parity,
marketplace resolution, and real stdio initialize/tools-list/EOF shutdown.
It also validates Workflow E call arguments against the advertised tool schemas
and checks the example fan-out, resume and activity handle relationships; this
proves input consistency, without executing those documentation tasks.
The Pi runtime test also executes a child through the isolated cached plugin
with a controlled Pi RPC fixture. These checks do not prove Codex UI
installation, routing judgment, credential forwarding by every host, or live
provider execution. Runtime child behavior has separate Pi integration tests.
