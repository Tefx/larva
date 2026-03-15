# larva-opencode-plugin

Bridges larva's PersonaSpec registry to opencode's agent system.

## How it works

```
Startup (config hook):
  1. Load tool-policy.yaml (optional deny/allow rules)
  2. larva export --all --json → get all persona specs in one call
  3. Register as opencode agents with permissions mapped
  4. Pre-cache prompts

Runtime (per API call):
  chat.params → detect larva agent → apply temperature (if set)
  system.transform → replace placeholder with full prompt + watermark
  (re-resolves from larva CLI only on cache expiry, 5 min)
```

## Install

```jsonc
// .opencode/opencode.json (project) or ~/.config/opencode/opencode.json (global)
{
  "plugin": ["file:///path/to/larva/contrib/opencode-plugin/larva.ts"]
}
```

larva CLI resolution (zero config):
1. If cwd is a larva project (pyproject.toml with `name = "larva"`) → `uv run --project . larva`
2. `larva` in PATH → direct
3. Fallback → `uvx larva`

## Permission mapping

### From PersonaSpec (larva)

| PersonaSpec | opencode permission | Notes |
|-------------|---------------------|-------|
| `side_effect_policy: read_only` | `edit: deny, bash: deny` | |
| `side_effect_policy: approval_required` | `edit: ask, bash: ask` | |
| `side_effect_policy: allow` | no restrictions | |
| `can_spawn: false` | `task: deny` | |

### From tool-policy.yaml (runtime)

Per-agent deny/allow rules for specific opencode tools. This is **not** part of the persona definition — it's runtime enforcement (tela's job in the full opifex system, approximated here for opencode).

**Search order:**
1. `.opencode/tool-policy.yaml` (project-level)
2. `~/.config/opencode/tool-policy.yaml` (global)

**Format:**
```yaml
agents:
  python-senior:
    deny: [vectl_vectl_claim, vectl_vectl_mutate, vectl_vectl_lifecycle]

  wiring-auditor:
    deny: [write, edit]

  vectl-orchestrator:
    deny: [serena_*, read, edit, write, glob, grep]
```

If the file doesn't exist, no tool restrictions are applied beyond what larva's `side_effect_policy` / `can_spawn` provide.

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
| `tools` | larva tool families don't map 1:1 to opencode permissions |
| `model_params.max_tokens` | opencode manages per-provider |
| `compaction_prompt` | opencode has its own compaction system |

## Watermark

Every larva-loaded prompt includes:

```xml
<larva-persona id="python-senior" />
```

## Limitations

- Agent list is fixed at startup. New `larva register` requires opencode restart.
- `tools` field (larva tool families) is not mapped to opencode permissions.
- Temperature is only applied if larva persona explicitly sets it.
