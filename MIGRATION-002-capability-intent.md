# Migration: Persona Capability Intent Cleanup

## Goal

Remove runtime policy from larva persona specs and constraint components.

## Legacy Model

```yaml
tools:
  filesystem: read_write
side_effect_policy: approval_required
```

## Target Model

```yaml
capabilities:
  filesystem: read_write
```

Runtime policy belongs to anima runtime controls, not larva persona artifacts.

## Field Replacement

| Legacy field | Target field / owner |
|--------------|----------------------|
| `tools` | `capabilities` |
| `side_effect_policy` | anima runtime controls |

## Constraint Cleanup

Legacy constraint components that carried `side_effect_policy` must be removed
or rewritten.

Target component split:

- capability bundles declare `capabilities`
- constraint bundles may declare fields such as `can_spawn` and
  `compaction_prompt`

`side_effect_policy` is not part of the target larva model.

## Mixed-Concern Inputs

If a legacy persona combined high capability posture with a read-only runtime
policy, that input represented two different concerns in one artifact.

The target split is:

- capability intent stays in larva
- runtime restriction moves to anima

## Final State

The target larva contract is capability-only.
Legacy `tools` and `side_effect_policy` are historical input shapes, not active
architecture.
