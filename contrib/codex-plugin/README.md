# Larva subagents for Codex and other MCP hosts

The `larva-pi-subagent` stdio server runs persona-scoped Pi child sessions
from Codex, Claude Code, Cursor, or OpenCode. The Codex plugin adds a routing
skill and presentation assets; direct MCP configuration needs no plugin.

## Prerequisites and capability boundary

The MCP tool descriptions are harness-neutral: hosts with built-in subagents
use those by default. The Codex plugin adds Strategy B routing guidance: use
native `spawn_agent` / `wait` / `send_input` / `close_agent` for ordinary
delegation; opt into Larva for an explicit Larva/Pi request or persona
`model-map.json` cross-provider routing, persistent `.jsonl` resume,
`can_spawn` parent policy, or `larva_subagent_activity` inspection.
Keep handles separate: Larva `.jsonl` `task_id` values belong only to Larva
subagent tools (including resume); native agent IDs belong to native tools.

Without an explicit CLI override, PATH discovery supports the Pi Managed
Installer: `~/.local/bin/pi` may point to `~/.pi/agent/bin/pi`; Larva reads
`~/.pi/agent/install/current-version` and verifies the selected release's
package name and `bin.pi` identity before launching its JavaScript entry.
`LARVA_PI_CLI_SCRIPT` (or `LARVA_PI_REAL_BIN`) overrides discovery strictly:
it must identify the real package bin script, never a shell launcher, and an
invalid override fails closed without managed indirection or PATH fallback.
Native Pi continues using its captured package/bin identity.

The plugin bundles its runtime as regular files and runs from Codex's cache
without `node_modules`, a sibling Pi extension checkout, or edits to `.mcp.json`.
Use Node with native TypeScript and `node:module.registerHooks` support.
The headless entry point supplies a TUI fallback only if normal package
resolution cannot find `@earendil-works/pi-tui`; native Pi keeps its TUI import.

Install the Python Larva CLI and Pi separately. The checkout lock records Pi
0.85.1 as build context; installed versions are not rejected by version number.
`LARVA_PI_CLI_SCRIPT` must identify the real Pi package's `bin.pi` JavaScript
entry, not a shell shim. Package/bin identity is verified at runtime.
The MCP host's Node must support the extension's TypeScript imports.

These two servers have independent responsibilities:

| Server | Entry point | Capability |
| --- | --- | --- |
| Registry | `larva mcp` | PersonaSpec validation, resolve, list, CRUD and variants |
| Child runtime | `node /absolute/path/to/larva/contrib/pi-extension/subagent-mcp-server.mjs` | Persona discovery and spawn/resume, wait/select, status/events/sessions, cancel, activity |

The runtime's `larva_personas` discovers resolved candidates through the Larva
CLI; it supplies no registry mutation tools. Configure both servers if you need
both capabilities. The Python server does not run Pi children.

## Direct Codex MCP configuration

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

[mcp_servers.larva-pi-subagent.env]
LARVA_CLI_ARGV_JSON = '["/absolute/path/to/larva-cli"]'
LARVA_PI_CLI_SCRIPT = "/absolute/path/to/pi/package/dist/cli.js"
```

The CLI override is optional for PATH or Managed Installer discovery; omit its
example line to use automatic discovery. Otherwise use your actual Pi package
bin path; the example is a placeholder. The bundle's
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

## Claude Code, Cursor, and OpenCode

For Claude Code or Cursor, merge this entry into the host's MCP settings
(Claude Code project `.mcp.json`; Cursor project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "larva-pi-subagent": {
      "command": "node",
      "args": ["/absolute/path/to/larva/contrib/pi-extension/subagent-mcp-server.mjs"],
      "env": {
        "LARVA_CLI_ARGV_JSON": "[\"/absolute/path/to/larva-cli\"]",
        "LARVA_PI_CLI_SCRIPT": "/absolute/path/to/pi/package/dist/cli.js"
      }
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
      "environment": {
        "LARVA_CLI_ARGV_JSON": "[\"/absolute/path/to/larva-cli\"]",
        "LARVA_PI_CLI_SCRIPT": "/absolute/path/to/pi/package/dist/cli.js"
      },
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

## Install the Codex plugin

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
The five bundled runtime files are byte-identical to the Pi extension sources;
no `node_modules` or `../pi-extension` is needed. Pi and the Python Larva CLI
remain separately installed executables. Configure their paths and credentials
in the launching environment as above. The MCP host appends existing
`~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` to PATH, preserving
explicit PATH prefix precedence. External-host runs skip TUI presentation and
timeline workers; dangling base-agent symlinks are ignored when creating capsules.

Restart the desktop client, start a new conversation, and verify that the skill
and nine runtime tools appear. Refresh/reinstall the plugin after updates.
If your client lacks local plugins, use direct MCP configuration instead.
Configure only one runtime connection to avoid splitting process-local handles.

These are operator instructions; repository checks never install a plugin or
edit your live `~/.codex/config.toml` or `~/.codex/plugins/`.

## Result delivery and lifecycle

The server loads `larva.ts` only after a tool call passes tool lookup and input
schema validation. Initialization, ping, discovery and rejected calls leave the
runtime unloaded. Idle EOF exits without importing it; after loading starts,
shutdown awaits `resetExtensionUI("mcp_shutdown")` to reap children and capsules.

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
Use bounded wait/select calls, never shell sleep polling. The 3600-second host
call timeout, observer `timeout_ms`, and child's no-progress watchdog are
independent; a host timeout is not proof of cancellation. Inspect and reconcile
effects before retrying or resuming uncertain work.

## Verification boundary

`tests/shell/test_codex_plugin_contract.py` checks manifest/config structure,
resource paths, environment forwarding declarations, skill frontmatter, and a
regular-file-only cache startup without dependencies, runtime SHA-256 parity,
marketplace resolution, and real stdio initialize/tools-list/EOF shutdown.
The Pi runtime test also executes a child through the isolated cached plugin
with a controlled Pi RPC fixture. These checks do not prove Codex UI
installation, routing judgment, credential forwarding by every host, or live
provider execution. Runtime child behavior has separate Pi integration tests.
