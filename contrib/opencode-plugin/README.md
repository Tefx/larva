# larva-opencode-plugin

Bridges larva's PersonaSpec registry to opencode's agent system.

## How it works

```
Launcher (`larva opencode`):
  1. Read registered personas through larva's normal facade/export path
  2. Build a temporary OPENCODE_CONFIG_CONTENT with placeholder agents
  3. Inject this plugin and exec the real opencode binary

Plugin startup (config hook):
  1. Load tool-policy.json (optional deny/allow rules)
  2. larva export --all --json → refresh persona specs in one call
  3. Register/refresh opencode agents with permissions mapped
  4. Pre-cache prompts

Runtime (per API call):
  chat.params → detect larva agent → apply temperature (if set)
  system.transform → replace placeholder with full prompt + watermark
  (re-resolves from larva CLI only on cache expiry, 5 min)
```

The launcher exists because some OpenCode versions validate `--agent` before
plugin config hooks finish. Early `OPENCODE_CONFIG_CONTENT` injection makes
`--agent <larva-id>` visible without writing `.opencode/opencode.json`.

## Install

Preferred wrapper (no `.opencode/opencode.json` write required):

```bash
larva opencode
larva opencode --agent python-senior
larva opencode run "check this bug" --agent python-senior
larva opencode -- run "check this bug" --agent python-senior
```

Arguments after `larva opencode` are forwarded to OpenCode. The explicit `--`
separator is optional; when present, larva strips it before forwarding.

The wrapper builds a temporary `OPENCODE_CONFIG_CONTENT` value from the larva
registry, injects this plugin, and execs the real `opencode` process.

Plugin path resolution order:

1. `LARVA_OPENCODE_PLUGIN=/absolute/path/to/larva.ts`
2. bundled wheel resource at `larva/shell/opencode_plugin/larva.ts`
3. source-tree fallback at `contrib/opencode-plugin/larva.ts`

Manual plugin install remains possible for sessions that do not rely on early
`--agent <larva-id>` validation:

```jsonc
// .opencode/opencode.json (project) or ~/.config/opencode/opencode.json (global)
{
  "plugin": ["file:///path/to/larva/contrib/opencode-plugin/larva.ts"]
}
```

larva CLI resolution inside the plugin:
1. If cwd is a larva project (pyproject.toml with `name = "larva"`) → `uv run --project . larva`
2. `larva` in PATH → direct
3. Fallback → `uvx larva`

## Permission mapping

### From PersonaSpec (larva)

| PersonaSpec | opencode permission | Notes |
|-------------|---------------------|-------|
| `capabilities: {fs: "read_only", git: "read_only"}` | `edit: deny, bash: deny` | If ALL capabilities are none/read_only |
| `capabilities: {fs: "read_write"}` | no restrictions | ANY read_write/destructive = no restriction |
| `can_spawn: false` | `task: deny` | |

`side_effect_policy` is not a live PersonaSpec input here. Larva rejects it at
canonical admission, so this plugin derives permissions from `capabilities`
only.

### From tool-policy.json (runtime)

Per-agent deny/allow rules for specific opencode tools. This is **not** part of the persona definition — it's runtime enforcement (tela's job in the full opifex system, approximated here for opencode).

**Search order:**
1. `.opencode/tool-policy.json` (project-level)
2. `~/.config/opencode/tool-policy.json` (global)

**Format:**
```json
{
  "agents": {
    "python-senior": {
      "deny": ["vectl_vectl_claim", "vectl_vectl_mutate"]
    },
    "wiring-auditor": {
      "deny": ["write", "edit"]
    },
    "vectl-orchestrator": {
      "deny": ["serena_*", "read", "edit", "write", "glob", "grep"]
    }
  }
}
```

If the file doesn't exist, no tool restrictions are applied beyond what larva's
`capabilities` and `can_spawn` provide. `side_effect_policy` is invalid at the
larva canonical boundary and must not be treated as PersonaSpec input.

## Other mappings

| PersonaSpec | opencode Agent | Notes |
|-------------|---------------|-------|
| `id` | agent name | direct |
| `description` | `description` | prefixed with `[larva]` |
| `prompt` | system prompt | injected on-demand via system.transform |
| `model` | `model` | passed as-is |
| `model_params.temperature` | `temperature` | only if explicitly set |

### Not mapped

| PersonaSpec | Reason |
|-------------|--------|
| `tools` | Invalid legacy field; larva canonical admission rejects it |
| `side_effect_policy` | Invalid legacy field; larva canonical admission rejects it |
| `capabilities` | Used for permission derivation (see above) |
| `model_params.max_tokens` | opencode manages per-provider |
| `compaction_prompt` | opencode has its own compaction system |

## Watermark

Every larva-loaded prompt includes:

```xml
<larva-persona id="python-senior" />
```

## Limitations

- Agent list is fixed at OpenCode startup. New `larva register` requires an
  OpenCode restart.
- The wrapper requires the real `opencode` executable to be available in `PATH`.
- Manual plugin-only install may be too late for `--agent <larva-id>` validation
  in OpenCode versions that validate agents before plugin config hooks finish;
  prefer `larva opencode` for that path.
- `capabilities` field is used for permission derivation but does not map 1:1 to
  OpenCode tool names.
- Temperature is only applied if larva persona explicitly sets it.
