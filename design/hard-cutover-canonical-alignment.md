# Larva Hard-Cutover Canonical Alignment

## Status

Target implementation plan for the no-compatibility cutover.

## Responsibility

`larva` is the canonical PersonaSpec admission authority.

It must emit only canonical persona vocabulary and reject legacy aliases.

## Current Problems

1. Internal normalization still knows how to map `tools -> capabilities`.
2. Toolset assembly still has fallback logic that accepts `tools`.
3. Patch/update logic still carries `tools` merge semantics.
4. Some design/docs surfaces still describe transition behavior rather than the final rule.

## Target End State

`larva` accepts, stores, resolves, updates, exports, and assembles only:

- `capabilities`
- `spec_version`
- `spec_digest`

It rejects:

- `tools`
- `side_effect_policy`

Its MCP surface remains `snake_case` only:

- `larva_validate`
- `larva_assemble`
- `larva_resolve`
- `larva_register`
- ...

## Detailed Change Plan

### 1. Remove canonical alias handling

Delete all code paths that normalize or accept:

- `tools`
- `side_effect_policy`

This includes:

- normalization helpers
- toolset/component loading fallbacks
- patch/update deep-merge special cases

### 2. Make toolset components capability-only

Every toolset component must emit only:

```yaml
capabilities:
  filesystem: read_only
  shell: read_only
```

No component may publish `tools:`.

### 3. Keep MCP surface strict and snake_case

`larva` already uses `snake_case` tool names. Do not add dotted aliases.

### 4. Tighten tests

Add or update tests so that:

- `tools` input is rejected at validation/admission
- assembled output contains `capabilities` only
- export/resolve/update payloads never contain `tools`
- component/toolset assembly fails if a component still declares `tools`

## Files In Scope

- `src/larva/core/normalize.py`
- `src/larva/core/assemble.py`
- `src/larva/core/patch.py`
- `src/larva/core/validate.py`
- `src/larva/shell/components.py`
- `src/larva/shell/mcp_contract.py`
- canonical fixtures and toolset component files

## Deletions

Delete, do not deprecate:

- `tools -> capabilities` normalization
- toolset `tools` fallback loading
- patch/update merge support for `tools`
- any schema/doc examples that still show `tools`

## Verification

1. `larva_validate` rejects a payload containing `tools`.
2. `larva_assemble` returns only `capabilities`.
3. `larva_resolve` returns only `capabilities`.
4. `larva_update` rejects patches that introduce `tools`.
5. contract fixtures contain no legacy alias fields.

## Failure Conditions

The cutover is incomplete if any of the following remain true:

- a toolset file still uses `tools:`
- a resolved persona contains `tools`
- a patch path still accepts `tools`
- docs still say `tools` is accepted during transition

## Complexity Cost Receipt

1. **Parts Added**: none beyond stricter tests and updated docs
2. **Simplest Alternative**: keep internal alias normalization forever because public MCP input is already strict
3. **The Defense**: that naive alternative fails because hidden fallback logic keeps contaminating assembled/exported truth and misleads downstream repos about what is still valid
