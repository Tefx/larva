# Legacy PersonaSpec Hard-Cut Policy Matrix

## Authority Adjudication: Canonical Cutover Prep

**Status**: Policy Pin for `canonical_cutover_prep.policy_pin`  
**Rule Type**: Hard-Cut (No Silent Compatibility)  
**Scope**: Registry-sourced PersonaSpec records and legacy toolset components  
**Surfaces**: resolve, export, clone, component_show, and related read paths

---

## The Singular Hard-Cut Rule

> **If a PersonaSpec or toolset component contains legacy fields (`tools`, `side_effect_policy`) or conflicts with canonical requiredness, the operation MUST reject with a structured error. No silent normalization, no field dropping, no auto-repair, no fallback compatibility.**

---

## Policy Matrix

### 1. resolve (facade.resolve)

| Attribute | Value |
|-----------|-------|
| **Surface** | `DefaultLarvaFacade.resolve(id, overrides)` |
| **Legacy input kind** | Registry-stored PersonaSpec containing `tools` or `side_effect_policy` |
| **Hard-cut behavior** | Reject with `PERSONA_INVALID` error. Do not load, do not normalize, do not attempt repair. |
| **Error/output shape** | `{"code": "PERSONA_INVALID", "numeric_code": 101, "message": "<first_error_message>", "details": {"report": <ValidationReport>}}` |
| **Why this matches canonical docs** | Aligns with `docs/adr/ADR-003-canonical-requiredness-authority.md`: "reject-immediate semantics" for forbidden fields. Matches `design/opifex-canonical-authority-basis.md`: "presence of `tools` **must** fail admission." Validation happens at facade boundary where `validate()` is called before return. |

### 2. export (facade.export_all / export_ids)

| Attribute | Value |
|-----------|-------|
| **Surface** | `DefaultLarvaFacade.export_all()` / `export_ids(ids)` |
| **Legacy input kind** | Registry-stored PersonaSpec containing `tools` or `side_effect_policy` |
| **Hard-cut behavior** | Reject entire export with `PERSONA_INVALID` if any exported persona contains legacy fields. Do not filter silently, do not normalize entries. |
| **Error/output shape** | `{"code": "PERSONA_INVALID", "numeric_code": 101, "message": "<first_error_message>", "details": {"report": <ValidationReport>, "id": "<offending_persona_id>"}}` |
| **Why this matches canonical docs** | Aligns with `design/hard-cutover-canonical-alignment.md`: "No output or projection claiming canonical PersonaSpec conformance may emit `tools` or `side_effect_policy`." Export is a projection surface; legacy fields make the record non-conforming. |

### 3. clone (facade.clone)

| Attribute | Value |
|-----------|-------|
| **Surface** | `DefaultLarvaFacade.clone(source_id, new_id)` |
| **Legacy input kind** | Source PersonaSpec containing `tools` or `side_effect_policy` |
| **Hard-cut behavior** | Reject with `PERSONA_INVALID` before creating clone. Do not copy legacy fields to new record. |
| **Error/output shape** | `{"code": "PERSONA_INVALID", "numeric_code": 101, "message": "<first_error_message>", "details": {"report": <ValidationReport>, "source_id": "<source_id>"}}` |
| **Why this matches canonical docs** | Cloning is not migration. Per `design/opifex-canonical-authority-basis.md`: "No output or projection... may emit `tools` or `side_effect_policy`." Clone creates new canonical output; source must be valid first. |

### 4. component_show (MCP/Python API)

| Attribute | Value |
|-----------|-------|
| **Surface** | `MCPHandlers.handle_component_show()` / `python_api.component_show()` |
| **Legacy input kind** | Toolset component YAML containing `tools` field instead of `capabilities` |
| **Hard-cut behavior** | Reject with `COMPONENT_NOT_FOUND` (code 105). Do not fall back to `tools` field. Do not normalize silently. |
| **Error/output shape** | `{"code": "COMPONENT_NOT_FOUND", "numeric_code": 105, "message": "Toolset not found: <name> (invalid format: missing capabilities)", "details": {"component_type": "toolset", "component_name": "<name>"}}` |
| **Why this matches canonical docs** | Aligns with `design/hard-cutover-canonical-alignment.md`: "Every toolset component must emit only `capabilities`. No component may publish `tools:`." Component loading is pre-admission; malformed components are "not found" per strict canonical interpretation. |

### 5. Registry-backed read paths (list, get)

| Attribute | Value |
|-----------|-------|
| **Surface** | `FileSystemRegistryStore.list()` / `get()` |
| **Legacy input kind** | Stored JSON spec containing `tools` or `side_effect_policy` |
| **Hard-cut behavior** | Per-record validation at load time. Reject individual record with `REGISTRY_SPEC_READ_FAILED` if legacy fields present. Do not return invalid spec to caller. |
| **Error/output shape** | `{"code": "REGISTRY_SPEC_READ_FAILED", "message": "spec contains legacy field 'tools' which is not permitted at canonical boundary", "persona_id": "<id>", "path": "<path>"}` |
| **Why this matches canonical docs** | Aligns with `docs/adr/ADR-003-canonical-requiredness-authority.md`: "success on any larva production admission path must imply conformance." Registry is part of the production path; stored legacy specs are invalid inputs, not grandfathered exceptions. |

---

## Conflict Resolution Summary

### Conflicts Adjudicated

| Conflict | Current State | Hard-Cut Decision |
|----------|---------------|-------------------|
| `normalize_spec()` has ADR-002 transition logic | Silently converts `tools`→`capabilities`, drops `side_effect_policy` | **Remove normalization**. Validation-only at admission. Legacy fields → rejection. |
| `FilesystemComponentStore.load_toolset()` | Falls back to `tools` if `capabilities` absent | **Remove fallback**. Toolset must have `capabilities`. Legacy `tools` field → rejection. |
| Registry loads specs without validation | Legacy specs can be read then rejected at facade | **Add registry-level validation**. Reject at read time, not deferred to facade. |
| `side_effect_policy` stripped silently | Field removed during normalization | **Reject at admission**. No silent dropping. Must not be present in input. |

### Rationale

Per `design/opifex-canonical-authority-basis.md`:

> "The compatibility window for admitting `tools` and `side_effect_policy` is **zero**. There is no transitional deprecate-and-accept period and no output-only preservation period."

Per `design/hard-cutover-canonical-alignment.md`:

> "Delete, do not deprecate: `tools -> capabilities` normalization, toolset `tools` fallback loading, patch/update merge support for `tools`."

This policy matrix enforces that rationale across all read surfaces.

---

## Coverage Checklist

- [x] resolve — Reject legacy fields at facade validation
- [x] export — Reject if any exported spec contains legacy fields
- [x] clone — Reject source if contains legacy fields
- [x] component_show — Reject toolsets with `tools` instead of `capabilities`
- [x] registry-backed read paths — Validate at load time, reject legacy records

---

## Implementation Notes

### Files Requiring Modification

1. `src/larva/core/normalize.py` — Remove ADR-002 transition logic; make normalization validation-only
2. `src/larva/shell/components.py` — Remove `tools` fallback in `load_toolset()`
3. `src/larva/shell/registry_fs.py` — Add legacy field validation in `read_spec_payload()`
4. `src/larva/shell/registry.py` — Update error mapping for legacy field rejection

### Error Code Alignment

- `PERSONA_INVALID` (101) — Facade validation failures (resolve, export, clone)
- `COMPONENT_NOT_FOUND` (105) — Component loading failures (component_show)
- `REGISTRY_SPEC_READ_FAILED` — Registry load failures (list, get)

---

## Canonical References

- `design/opifex-canonical-authority-basis.md` — Authority basis
- `design/hard-cutover-canonical-alignment.md` — Cutover plan
- `docs/adr/ADR-002-capability-intent-without-runtime-policy.md` — Policy removal
- `docs/adr/ADR-003-canonical-requiredness-authority.md` — Requiredness authority
