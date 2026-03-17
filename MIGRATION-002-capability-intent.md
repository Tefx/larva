# Migration: Persona Capability Intent Cleanup

## Goal

Remove runtime policy from larva persona specs and constraint components.

## Old Model

```yaml
tools:
  filesystem: read_write
side_effect_policy: approval_required
```

## New Model

```yaml
capabilities:
  filesystem: read_write
```

Runtime policy moves out of larva and into anima job/runtime controls.

## Mapping

| Old field | New home |
|-----------|----------|
| `tools` | `capabilities` |
| `side_effect_policy` | anima runtime controls |

If an old persona declared `side_effect_policy: read_only`, migration should
also review its capability intent. A persona that declares destructive or
read_write capabilities while simultaneously demanding read-only runtime policy
is a mixed-concern artifact and should be split into:

- capability intent in larva
- runtime controls in anima

## Component Library Impact

Old component split:

- `toolsets/`: family posture maps
- `constraints/`: `can_spawn`, `side_effect_policy`, `compaction_prompt`

Target split:

- `toolsets/`: `capabilities`
- `constraints/`: `can_spawn`, `compaction_prompt`

`side_effect_policy` should not survive in constraint components.

## Rollout Recommendation

1. Accept both `tools` and `capabilities` during transition.
2. Normalize to `capabilities` in emitted/flattened persona artifacts.
3. Warn on `side_effect_policy` in persona or constraint inputs.
4. Remove `side_effect_policy` from schema once anima runtime controls are in place.
