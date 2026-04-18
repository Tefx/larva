# [Design] Prompt Text Opacity and Template Boundary Basis

## Re-anchor

Original request: define the long-term correct architecture for prompt text that contains `{}` so larva stops misclassifying literal prompt content as unresolved template input.

## Problem

- [Proven] `larva` currently rejects single-brace prompt text such as `{http_code}` as `UNRESOLVED_PLACEHOLDER` during canonical validation.
- [Proven] `larva` simultaneously says placeholder-map inputs are not part of the canonical PersonaSpec contract.
- [Proven] This creates a contradiction: the product claims not to own templating, but the validator still imposes a hidden template language on plain prompt text.
- [Proven] The contradiction is operationally harmful: registry records that are readable from disk can still fail `list` / `serve` because prompt prose happens to contain brace-delimited examples.

## Decision

- [Proven] **Canonical `prompt` is opaque text.** Inside canonical PersonaSpec, `prompt: str` is plain content, not a template program.
- [Proven] **Single braces are literal by default.** `{name}` inside prompt text has no special meaning to larva core validation, normalization, registry storage, list, resolve, update, clone, export, MCP, CLI, or web surfaces.
- [Proven] **larva does not infer templating intent from prompt text.** The current regex-based unresolved-placeholder rejection is removed from canonical admission and assembly validation.
- [Proven] **No auto-escaping on import/register/update.** larva must not rewrite `{literal}` into `{{literal}}` because that mutates user-authored text, changes digest, and guesses semantics it cannot know.
- [Proven] **Placeholder-map inputs remain non-canonical.** Top-level or assembly-side variable bags such as `variables` stay forbidden. Upstream systems that want templating must render prompt text before passing it to larva.
- [Likely] **Future first-class templating, if ever introduced, must be explicit and separate.** It must use a dedicated field/object and must not overload canonical `prompt` text with inferred semantics.

Vibe check: adding `PromptTemplate`, `TemplateResolver`, or prompt-mode strategy classes right now would be `OVER_ENGINEERED`. This is not a runtime templating product today. The simplest correct move is to stop pretending that brace-shaped text is a template language.

## Why this is the simplest correct boundary

- [Proven] larva already rejects non-canonical placeholder-map inputs, so there is no complete templating feature to preserve.
- [Proven] Prompt content is authored prose and examples; braces appear naturally in code, config, regex, JSON-like snippets, and instructional text.
- [Proven] Automatic escaping is data mutation, not normalization.
- [Likely] A product that does not own templating should not guess which brace sequences are variables and which are examples.

## Canonical Contract After This Change

### PersonaSpec meaning

| Field | Canonical meaning |
|---|---|
| `prompt` | Opaque UTF-8 text payload consumed by downstream agents/models |
| `variables` | Forbidden non-canonical input |
| `spec_digest` | Digest of canonical stored content, including literal braces exactly as authored |

### Admission rules

- [Proven] `prompt` must be a string.
- [Proven] `prompt` may contain single braces, double braces, or no braces.
- [Proven] `prompt` is not scanned for unresolved placeholder tokens.
- [Proven] `variables` / placeholder-map style inputs remain rejected at admission and assembly boundaries.

### Assembly rules

- [Proven] Prompt components are concatenated/merged as text only.
- [Proven] Assembly does not reject prompt text because it contains brace-delimited substrings.
- [Proven] Assembly still rejects non-canonical structured placeholder inputs such as `variables`.

### Error code lifecycle

- [Proven] `UNRESOLVED_PLACEHOLDER` is retired from canonical validation. Its issue constructor path in `src/larva/core/validate.py` is removed rather than repurposed.
- [Proven] `UNRESOLVED_PROMPT_TEXT` is retired from canonical assembly. Its raise path in `src/larva/core/assemble.py` is removed rather than repurposed.
- [Proven] `VARIABLE_UNRESOLVED` numeric code `103` is retired from `src/larva/app/facade.py`, `USAGE.md`, and parity tests because it no longer corresponds to any live fail-closed behavior after prompt-text scanning is deleted.
- [Proven] Placeholder-specific code names are fully purged from active docs and parity tables in this change; they are not reserved for reuse.
- [Proven] `_PROMPT_PLACEHOLDER_PATTERN` is deleted from both `src/larva/core/validate.py` and `src/larva/core/assemble.py`; it has no remaining canonical contract role once brace scanning is removed.
- [Likely] Numeric-code policy for unrelated assembly-only names such as `VARIABLES_NOT_ALLOWED` is outside this design change and must not be silently reinvented here.

## Explicit Non-Goals

- [Proven] Do not introduce a built-in template engine.
- [Proven] Do not add implicit escaping of `{}` during register/import/update.
- [Proven] Do not add a compatibility layer that stores rewritten prompt text.
- [Proven] Do not add `prompt_mode`, `template_language`, or template AST objects in this change.

## Cross-Surface Behavioral Contract

The following surfaces must agree on the same rule: braces in canonical prompt text are data, not instructions.

- [Proven] `core/validate.py`: delete unresolved-placeholder prompt rejection.
- [Proven] `core/assemble.py`: delete unresolved-prompt-text rejection.
- [Proven] `app/facade.py`: no special-case escape or rewrite path during register/list/resolve/update/clone/export.
- [Proven] `shell/web.py`, `shell/mcp.py`, `shell/cli_commands.py`, `shell/python_api.py`: surface behavior inherits the same opaque-text rule with no transport-specific escaping.
- [Proven] Registry diagnostics should follow the same canonical validation path as `list` / `serve`; the public CLI now exposes a single `larva doctor` surface for that check.

## Migration Plan

### Runtime migration

- [Proven] Remove brace-regex validation from core admission and assembly code.
- [Proven] Update these exact doc targets:
  - `USAGE.md:127` — replace the current bullet with: `Prompt text is opaque and may contain literal braces; {placeholder} style text is not interpreted as a template variable.`
  - `USAGE.md:367-374` — replace the current placeholder policy with: larva rejects placeholder-map inputs such as `variables`, but does not interpret brace-shaped prompt text.
  - `USAGE.md:406` — remove error-table row `103 | VARIABLE_UNRESOLVED | unresolved {placeholder} remains in canonical prompt text`.
  - `INTERFACES.md:84-86` — no semantic change required; this section already documents `variables` as rejected unknown input and does not require brace-text rejection language.
- [Proven] Keep `variables` / placeholder-map rejection unchanged.

### Stored-data migration

- [Proven] No registry rewrite is required.
- [Proven] Existing stored personas containing literal braces should become valid automatically once placeholder rejection is deleted.
- [Likely] `spec_digest` values may change only when a persona is later re-normalized through a write path for unrelated reasons; this design does not require forced re-save of every registry entry.

### Compatibility stance

- [Likely] Historical personas that already doubled braces remain valid text.
- [Likely] larva does not promise to collapse `{{literal}}` into `{literal}` because that would also be silent content mutation.

## Verification Plan

### Core tests

- [Proven] Add/adjust tests showing `prompt: "HTTP status example: {http_code}"` is valid.
- [Proven] Add/adjust tests showing assembly accepts prompt component text with literal braces.
- [Proven] Keep tests proving `variables` and other placeholder-map inputs are rejected.

### Function-level implementation map

| Function / symbol | File | Disposition | Notes |
|---|---|---|---|
| `_PROMPT_PLACEHOLDER_PATTERN` | `src/larva/core/validate.py` | DELETE | Remove constant; no remaining validator should scan prompt text for brace tokens. |
| `_validate_prompt_semantics` | `src/larva/core/validate.py` | DELETE | Remove placeholder-specific function entirely. |
| `_validate_prompt_semantics` callsite in `validate_spec` | `src/larva/core/validate.py` | DELETE | Remove `errors.extend(_validate_prompt_semantics(spec))`. |
| `_REQUIRED_STRING_TYPE_FIELDS` | `src/larva/core/validation_field_shapes.py` | SIMPLIFY | Add `prompt` here so prompt type validation survives after deleting `_validate_prompt_semantics`; `id` and `spec_version` remain in `validate.py` because they already have specialized identity/version validators. |
| `_PROMPT_PLACEHOLDER_PATTERN` | `src/larva/core/assemble.py` | DELETE | Remove constant; no remaining assembly code should scan prompt text. |
| `_find_unresolved_placeholders` | `src/larva/core/assemble.py` | DELETE | Delete helper and doctest because assembly no longer rejects brace text. |
| `_collect_prompt_texts` | `src/larva/core/assemble.py` | SIMPLIFY | Keep function, but remove call to `_find_unresolved_placeholders` and append text directly after existing string coercion. |
| `ERROR_NUMERIC_CODES["VARIABLE_UNRESOLVED"]` | `src/larva/app/facade.py` | DELETE | Remove dead placeholder-specific numeric code and downstream parity expectations. |

### Test fixtures

#### Fixture A — canonical validation accepts literal single braces

```json
{
  "id": "http-status-helper",
  "description": "Explains HTTP status placeholders as literal content.",
  "prompt": "When documenting APIs, show examples such as {http_code} and {reason_phrase} literally.",
  "model": "gpt-4o-mini",
  "capabilities": {"shell": "read_only"},
  "spec_version": "0.1.0"
}
```

Expected result: `validate_spec(...)` returns `valid: true`, `errors: []`.

#### Fixture B — doubled braces remain valid literal text

```json
{
  "id": "literal-brace-helper",
  "description": "Shows doubled braces without special handling.",
  "prompt": "Template docs may mention {{literal}} and {single} in the same prompt.",
  "model": "gpt-4o-mini",
  "capabilities": {"shell": "read_only"},
  "spec_version": "0.1.0"
}
```

Expected result: `validate_spec(...)` returns `valid: true`, `errors: []`.

#### Fixture C — assembly accepts brace text in prompt components

```json
{
  "id": "assembled-literal-braces",
  "prompts": [{"text": "Render the example {role} literally in output."}]
}
```

Expected result: `assemble_candidate(...)` succeeds and output `prompt` retains `{role}` unchanged.

#### Fixture D — placeholder-map input remains forbidden

```json
{
  "id": "assembled-noncanonical-variables",
  "prompts": [{"text": "Render {role} literally in output."}],
  "variables": {"role": "assistant"}
}
```

Expected result: `assemble_candidate(...)` still raises `VARIABLES_NOT_ALLOWED`.

### Existing test migration

| Existing test | Current behavior asserted | New disposition |
|---|---|---|
| `tests/core/test_validate.py::test_unresolved_prompt_placeholders_produce_canonical_error` | `{role}` invalid at validate boundary | REPLACE with acceptance test using Fixture A |
| `tests/core/test_validate.py::TestPlaceholderSemantics::test_placeholder_like_tokens_are_rejected_without_variables` | brace tokens rejected | REPLACE with acceptance property test proving brace tokens stay valid text |
| `tests/core/test_assemble.py::test_unresolved_prompt_placeholders_rejected` | assembly raises `UNRESOLVED_PROMPT_TEXT` | REPLACE with success test using Fixture C |
| `tests/app/test_facade/test_assemble.py::test_assemble_rejects_unresolved_placeholder_without_variables_escape_hatch` | facade assembly fails on brace text | REPLACE with facade success test showing assembled prompt keeps literal braces |
| `tests/repro/cross_surface_consistency_verify.py` placeholder-specific parity references | placeholder-specific code contract retained | MODIFY to remove `VARIABLE_UNRESOLVED` requirement and add literal-brace acceptance parity checks |
| `tests/shell/test_cli.py::test_error_envelope_numeric_codes_match_spec` | code `VARIABLE_UNRESOLVED = 103` required | MODIFY to remove retired row 103 |
| `tests/shell/test_mcp.py::test_all_required_error_codes_present` | `VARIABLE_UNRESOLVED` required | MODIFY to remove retired placeholder-specific code |

Modify existing test files in place. `REPLACE` means delete the old rejection assertion and add the new acceptance assertion in the same file.

### Cross-surface tests

- [Proven] Register/list/resolve/update/clone/export should succeed for personas whose prompt contains literal single braces.
- [Proven] `larva serve` must list registry entries with brace-containing prompt text instead of failing closed on the entire library.
- [Proven] Add one end-to-end regression proving a previously stored brace-containing persona no longer breaks `list` / `serve`.
- [Proven] Registry diagnostics should replay canonical validation through the same facade-backed path as `list` / `serve`.

## Rejected Alternatives

### Alternative A — Keep current regex rule and require escaping

- Rejected because it makes larva a de facto template parser while claiming templating is unsupported.
- Rejected because it misclassifies valid prompt prose and breaks read/list surfaces for stored data.

### Alternative B — Auto-escape on import/register/update

- Rejected because it silently mutates user content.
- Rejected because it changes `spec_digest` and stored semantics without explicit user consent.
- Rejected because larva cannot reliably distinguish literal content from intended templating.

### Alternative C — Add explicit template mode now

- Rejected for current scope because larva does not yet own templating as a shipped feature.
- Rejected because it adds schema, docs, migration, and surface complexity to solve a problem that disappears if prompt text is treated as opaque data.

## Implementation Slice

Minimal code slice:

1. Delete brace placeholder regex checks from `src/larva/core/validate.py` and `src/larva/core/assemble.py`.
2. Preserve prompt type validation by moving `prompt` into `src/larva/core/validation_field_shapes.py` required string coverage.
3. Remove dead placeholder-specific numeric code `VARIABLE_UNRESOLVED` from `src/larva/app/facade.py` and its parity tests/docs.
4. Update `USAGE.md` placeholder policy and error table; no semantic `INTERFACES.md` change required beyond optional wording sync.
5. Replace placeholder-rejection tests with literal-brace acceptance tests across `tests/core/`, `tests/app/`, `tests/shell/`, and `tests/repro/`.

This is intentionally one deletion-heavy boundary correction, not a templating subsystem.

## Complexity Cost Receipt

1. **Parts Added**: one design document.
2. **Simplest Alternative**: delete unresolved-placeholder validation and treat `prompt` as plain text everywhere.
3. **The Defense**: the current regex-based alternative fails a hard requirement because it rejects valid prompt content and can take down `list` / `serve` for an otherwise readable registry.

## Open Questions

- [Likely] If larva later wants first-class templating, should that live in assembly-only inputs instead of canonical PersonaSpec storage?

## Explicitly Deferred

- [Proven] Public diagnostics should stay collapsed to a single `larva doctor` surface that replays canonical validation rather than exposing separate shallow/deep modes.

## Certainty

Overall certainty: [Proven] for treating canonical prompt text as opaque data, deleting inferred placeholder validation, and keeping diagnostics on a single canonical-validation surface.
