# Guard Diagnosis: full `invar guard --all`

## Scope

- Focus: root-cause diagnosis of remaining main-repo guard findings after `.vectl` exclusion tightening.
- Non-goal: product-code changes.

## Verification Snapshot

- Command: `invar guard --all`
- Result: failed status with `0 errors`, `11 warnings`, `9 infos`, `12 files checked`.
- Config scope: `core_paths = ["src/larva/core"]`, `shell_paths = ["src/larva/shell"]`, and `exclude_paths` includes `.vectl` in `pyproject.toml`.

## Root Cause Classification

### 1. Remaining main-repo `shell_complexity_debt`

This is real repo debt, not `.vectl` noise.

- `src/larva/shell/cli.py`
  - `shell_pure_logic` warnings on `_map_facade_error`, `_critical_error`, `_render_validation_report`, `_render_list_summaries`, `_render_payload_for_text`, `_map_component_error`, `_build_parser`, `build_default_facade`.
  - `shell_too_complex` infos on `_read_spec_json`, `_dispatch`, `validate_command`, `assemble_command`.
  - `file_size_warning` at 682 lines.
  - Root cause: the CLI module mixes transport orchestration with pure formatting/error-mapping helpers, then accumulates command dispatch branches in one file.

- `src/larva/core/validate.py`
  - `function_size` warning on `validate_spec`.
  - Root cause: validation rules are still concentrated in one function rather than factored helpers.

These are the main remaining repo-health issues surfaced by full guard.

### 2. Residual guard-scope config confirmation needed

Config tightening appears sound for `.vectl` noise removal, but one follow-up confirmation remains:

- `pyproject.toml` excludes `.vectl`, so worktree/orchestrator files are no longer part of guard scope.
- Full guard now reports only source-tree findings under configured `core_paths` and `shell_paths`, which confirms the ignore tightening worked.
- However, package-root modules outside those paths are still outside guard policy by configuration, not by `.vectl` exclusion alone.

Conclusion: `.vectl` scoping is confirmed, but broader source-root policy is still an explicit config decision that should remain visible.

### 3. Package-root re-exports: deferred future-policy follow-up

- `src/larva/__init__.py` is currently minimal (`__version__` only), so it is not today’s root cause.
- It is also outside `core_paths`/`shell_paths`, so future package-root re-export growth would not be guarded automatically.

Classification: deferred future-policy follow-up, not silent exclusion. If package-root API expands beyond metadata, guard policy should explicitly decide whether to include package-root modules.

### 4. `~/.larva/components` concerns: explicit investigation/cleanup/clarification bucket

- `src/larva/shell/components.py` anchors behavior to `Path.home() / ".larva" / "components"` and performs filesystem reads plus YAML parsing.
- Current full guard does not flag this file, but the module still owns user-home filesystem assumptions, directory layout assumptions, and external YAML trust boundaries.

Classification: explicit investigation/cleanup/clarification bucket. This is not the current top guard failure source, but it remains a boundary worth reviewing separately.

### 5. Sound exclusions to keep

- Registry init / registry storage work should stay treated as legitimate shell-boundary I/O. `src/larva/shell/registry.py` owns `~/.larva/registry`, `index.json`, and atomic file updates; nothing in the current full-guard result suggests `.vectl` tightening accidentally hid registry debt.
- `shell_mcp_runtime`-owned work should remain excluded from this follow-up. `src/larva/shell/mcp.py` explicitly states runtime startup (`stdio`/`SSE`) is out of scope for the contract step. Its current warning is a size warning, not evidence that the `.vectl` fix missed repo debt in this task boundary.

## Net Diagnosis

The full-guard failure is now primarily real codebase debt concentrated in `src/larva/shell/cli.py`, plus one core-size warning in `src/larva/core/validate.py`. The `.vectl` ignore tightening appears effective. What remains is not orchestrator pollution; it is mostly CLI transport layering debt, with package-root policy and `~/.larva/components` kept as explicit follow-up buckets rather than being silently excluded.
