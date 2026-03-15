# larva-opencode-plugin

Bridges larva's PersonaSpec registry to opencode's agent system.

## How it works

```
Startup (config hook):
  larva list → get all persona ids
  larva resolve <id> (for each) → full spec
  → register as opencode agents with permissions + model mapped
  → pre-cache prompts

Runtime (per API call):
  chat.params → detect larva agent → apply temperature (if set)
  system.transform → replace placeholder with full prompt + watermark
  (re-resolves from larva CLI only on cache expiry, 5 min)
```

## Install

```jsonc
// opencode.jsonc (project or global)
{
  "plugin": ["file:///absolute/path/to/larva/contrib/opencode-plugin/larva.ts"]
}
```

Make sure `larva` CLI is in PATH, or set `LARVA_CMD`:

```bash
export LARVA_CMD="uv run larva"
```

## What gets mapped

| PersonaSpec | opencode Agent | Notes |
|-------------|---------------|-------|
| `id` | agent name | direct |
| `description` | `description` | prefixed with `[larva]` |
| `prompt` | system prompt | injected on-demand via system.transform |
| `model` | `model` | auto-prefixed: `claude-*` → `anthropic/...` |
| `model_params.temperature` | `temperature` | only if explicitly set; omitted → provider default |
| `side_effect_policy: read_only` | deny edit + bash | |
| `side_effect_policy: approval_required` | ask edit + bash | |
| `side_effect_policy: allow` | no restrictions | |
| `can_spawn: false` | deny task | |

### Not mapped

| PersonaSpec | Reason |
|-------------|--------|
| `tools` | larva tool families (`filesystem: read_write`) don't map 1:1 to opencode permissions |
| `model_params.max_tokens` | opencode manages per-provider |
| `compaction_prompt` | opencode has its own compaction system |

## Watermark

Every larva-loaded prompt includes a watermark tag at the end:

```xml
<larva-persona id="python-senior" />
```

Ask the agent "do you see a larva-persona tag in your system prompt?" to verify loading.

## Collision with .opencode/agents/

If a `.opencode/agents/foo.md` file and a larva persona `foo` share the same name,
the plugin (loaded last) wins. Remove the `.md` file or rename one to avoid ambiguity.

## Limitations

- Agent list is fixed at startup. New `larva register` requires opencode restart.
- `tools` field is not mapped (permission granularity mismatch).
- Temperature is only applied if larva persona explicitly sets it; otherwise opencode's provider default is used.
