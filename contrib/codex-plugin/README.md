# Larva subagents for Codex and other MCP hosts

The `larva-pi-subagent` stdio server runs persona-scoped Pi child sessions
from Codex, Claude Code, Cursor, or OpenCode. The Codex plugin adds a routing
skill and presentation assets; direct MCP configuration needs no plugin.

## Prerequisites and capability boundary

Keep a Larva checkout available and install its extension dependencies:

```sh
npm --prefix /absolute/path/to/larva/contrib/pi-extension ci
```

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

Use your actual Pi package bin path; the example is a placeholder. The bundle's
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

**The plugin depends on the separate Pi extension checkout.** Its source MCP
configuration uses `cwd: "."` (resolved from the plugin root by Codex) and
`../pi-extension/subagent-mcp-server.mjs`. Codex copies installed plugins to a
cache without that sibling directory. Before installing, stage a copy of
`contrib/codex-plugin/` in a local marketplace and change the staged
`.mcp.json` server's `args[0]` to the absolute runtime script in your retained
checkout. Keep `cwd: "."`, `env_vars`, and the 3600-second timeout. Set the
CLI/Pi paths in the launching environment or staged server `env` as above.
Copying only the unmodified plugin directory is insufficient.

For example, put the prepared copy at `plugins/larva-subagent/` inside a
marketplace root, then add `.agents/plugins/marketplace.json` in that root:

```json
{
  "name": "local-larva",
  "interface": {"displayName": "Local Larva"},
  "plugins": [{
    "name": "larva-subagent",
    "source": {"source": "local", "path": "./plugins/larva-subagent"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
    "category": "Productivity"
  }]
}
```

Register that root with `codex plugin marketplace add /absolute/marketplace-root`
on clients supporting the command. Restart the desktop client, select the local
marketplace in the plugin directory, and install Larva Subagents. Start a new
conversation and verify that the skill and nine runtime tools appear. Refresh
the staged copy and reinstall/refresh after updates. If your client lacks local
plugins, use the direct MCP configuration instead. Configure only one runtime
connection to avoid splitting process-local task handles across duplicate servers.

These are operator instructions; repository checks never install a plugin or
edit your live `~/.codex/config.toml` or `~/.codex/plugins/`.

## Result delivery and lifecycle

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
real stdio initialize/tools-list/EOF shutdown. It does not prove Codex UI
installation, routing judgment, credential forwarding by every host, or live
provider execution. Runtime child behavior has separate Pi integration tests.
