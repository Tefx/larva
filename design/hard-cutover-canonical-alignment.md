# Larva Hard-Cutover Canonical Alignment

## Status

Target implementation plan for the no-compatibility cutover.

## Responsibility

`larva` is the canonical PersonaSpec admission authority.

It must emit only canonical persona vocabulary and reject legacy aliases.

## Canonical References

- `/Users/tefx/Projects/opifex/design/final-canonical-contract.md`
- `/Users/tefx/Projects/opifex/design/personaspec-v1.md`
- `/Users/tefx/Projects/opifex/design/larva-clean-architecture.md`
- `/Users/tefx/Projects/opifex/design/canonical-contract-boundaries.md`

Version pin for this cutover: canonical PersonaSpec `spec_version` remains
`0.1.0`.

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

The canonical output shape is the opifex PersonaSpec contract described by:

- `/Users/tefx/Projects/opifex/contracts/persona_spec.schema.json`
- `/Users/tefx/Projects/opifex/design/personaspec-v1.md`

It rejects:

- `tools`
- `side_effect_policy`

Its full MCP tool registry remains `snake_case` only. The authoritative tool
list is whatever is registered by `src/larva/shell/mcp_contract.py`; no larva
tool name may use dotted form.

`spec_version` remains required and `spec_digest` remains canonical output
metadata. Hard cutover changes capability vocabulary only; it does not weaken
or bypass existing spec-version and digest rules.

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

Production component loading reads runtime-provided toolset files from
`<components_dir>/toolsets/*.yaml`. This repo currently does not ship a checked-
in production toolset directory, so checked-in cleanup targets are test fixtures
and any future committed `toolsets/*.yaml` examples.

Concrete checked-in fixture cleanup begins with `tests/shell/test_components.py`,
which currently embeds a YAML toolset fixture inline.

### 3. Keep MCP surface strict and snake_case

`larva` already uses `snake_case` tool names. Do not add dotted aliases.

### 4. Tighten tests

Add or update tests so that:

- `tools` input is rejected at validation/admission
- assembled output contains `capabilities` only
- export/resolve/update payloads never contain `tools`
- component/toolset assembly fails if a component still declares `tools`

## Files In Scope

- `src/larva/core/spec.py`
- `src/larva/core/normalize.py`
- `src/larva/core/assemble.py`
- `src/larva/core/patch.py`
- `src/larva/core/validate.py`
- `src/larva/app/facade.py`
- `src/larva/shell/components.py`
- `src/larva/shell/mcp_contract.py`
- `tests/core/test_normalize.py`
- `tests/core/test_assemble.py`
- `tests/core/test_patch.py`
- `tests/core/test_validate.py`
- `tests/app/test_facade/test_register.py`
- `tests/app/test_facade/test_update.py`
- `tests/shell/test_components.py`
- `tests/shell/test_canonical_boundary_gaps.py`
- any committed runtime fixture/example under `**/toolsets/*.yaml`

Assertions for the cutover belong in these checked-in files, not in unnamed
future tests:

- `tests/core/test_validate.py`
- `tests/app/test_facade/test_update.py`
- `tests/shell/test_components.py`

## Deletions

Delete, do not deprecate:

- `tools -> capabilities` normalization in `src/larva/core/normalize.py`
- toolset `tools` fallback loading in `src/larva/core/assemble.py` and `src/larva/shell/components.py`
- patch/update merge support for `tools` in `src/larva/core/patch.py`
- any checked-in fixture/example that still contains a PersonaSpec or toolset `tools` field

## Rollback

If the hard cut causes a blocking regression, rollback is a git revert of the
cutover commit set followed by rerunning the full verification suite. Rollback
does not mean reintroducing partial compatibility logic by hand.

## Verification

Run and retain evidence for:

```bash
pytest tests/core/test_validate.py tests/core/test_assemble.py tests/core/test_patch.py tests/shell/test_components.py tests/app/test_facade/test_register.py tests/app/test_facade/test_update.py tests/shell/test_canonical_boundary_gaps.py
python - <<'PY'
from pathlib import Path
import re
matches = []
for root in [Path('src/larva'), Path('tests')]:
    for path in root.rglob('*'):
        if path.suffix not in {'.py', '.yaml', '.yml', '.json', '.md'}:
            continue
        text = path.read_text(encoding='utf-8')
        if re.search(r'^\s*tools\s*:', text, re.MULTILINE) or re.search(r'"tools"\s*:', text):
            matches.append(str(path))
print('\n'.join(matches))
raise SystemExit(1 if matches else 0)
PY
```

Success means:

1. `larva_validate` rejects a payload containing `tools`.
2. `larva_assemble` returns only `capabilities`.
3. `larva_resolve` returns only `capabilities`.
4. `larva_update` rejects patches that introduce `tools`.
5. checked-in fixtures/examples contain no legacy alias fields.

## Monitoring

During cutover validation, retain a tally of rejected canonical admission
attempts containing legacy fields, split by field name (`tools`,
`side_effect_policy`). Emit the tally as structured stdout or a CI artifact file
named `larva-canonical-conformance-findings.jsonl`; the cutover is not complete if the
tally cannot be produced.

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
