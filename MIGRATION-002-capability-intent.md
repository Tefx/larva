# Migration: Persona Capability Intent Cleanup

## Status: COMPLETED ✓

**Completed:** 2026-03-19  
**Migration ADR:** ADR-002-capability-intent-without-runtime-policy.md

### Progress Summary

| Phase | Status | Notes |
|-------|--------|-------|
| Core type migration | ✓ Done | `spec.py` uses `capabilities` as canonical, `tools` deprecated |
| Validation updates | ✓ Done | `validate.py` emits deprecation warnings for `side_effect_policy` and `tools` |
| Normalization | ✓ Done | `normalize.py` mirrors `capabilities` to `tools` for backward compatibility |
| Assembly updates | ✓ Done | `assemble.py` merges capabilities from toolsets |
| Component loading | ✓ Done | `components.py` prefers `capabilities`, falls back to `tools` |
| Python API | ✓ Done | All facade operations use canonical `capabilities` field |
| MCP contract | ✓ Done | Tool descriptions reference `capabilities` as canonical |
| CLI | ✓ Done | All commands work with `capabilities` |
| Documentation | ✓ Done | All docs updated to reflect ADR-002 model |
| Tests | ✓ Done | Comprehensive test coverage for deprecation behavior |

### Residual Follow-ups

- **None blocking** — Migration is functionally complete
- `tools` and `side_effect_policy` retained for backward compatibility with deprecation warnings
- Future major version may remove deprecated fields entirely (tracked as future cleanup)

---

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
