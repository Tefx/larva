# Migration: Persona Capability Intent Cleanup

## Status: COMPLETED ✓

**Completed:** 2026-03-19  
**Migration ADR:** ADR-002-capability-intent-without-runtime-policy.md

### Progress Summary

| Phase | Status | Notes |
|-------|--------|-------|
| Core type migration | ✓ Done | `spec.py` uses `capabilities` as canonical; `tools` is historical migration terminology only and is now rejected at admission |
| Validation updates | ✓ Done | `validate.py` rejects `side_effect_policy` and `tools` at admission (forbidden fields) |
| Normalization | ✓ Done | `normalize.py` maintains internal `capabilities`↔`tools` compatibility (not at admission) |
| Assembly updates | ✓ Done | `assemble.py` merges capabilities from toolsets |
| Component loading | ✓ Done | `components.py` prefers `capabilities`, falls back to `tools` |
| Python API | ✓ Done | All facade operations use canonical `capabilities` field |
| MCP contract | ✓ Done | Tool descriptions reference `capabilities` as canonical |
| CLI | ✓ Done | All commands work with `capabilities` |
| Documentation | ✓ Done | All docs updated to reflect ADR-002 model |
| Tests | ✓ Done | Comprehensive test coverage for forbidden-field rejection at admission |

### Residual Follow-ups

- **None blocking** — Migration is functionally complete
- `tools` and `side_effect_policy` are rejected at the larva admission boundary
- These fields are not canonical PersonaSpec fields (owned by opifex, not larva)
- Future major version may remove any internal compatibility code entirely (tracked as future cleanup)

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

The target larva contract is capability-only, aligned with the opifex canonical
PersonaSpec schema. `larva` is a downstream admission and projection layer; it
does not own the PersonaSpec contract.

`tools` and `side_effect_policy` are removed fields in larva PersonaSpec
admission. Presence at the canonical boundary requires rejection rather than
compatibility interpretation.
