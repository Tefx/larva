# larva — Agent Usage Guide

**Audience:** AI agents and operators consuming larva as a tool.
**larva does:** validate, normalize, register, resolve, update, export, and manage registry-local PersonaSpec variants.
**larva does NOT do:** call LLMs, execute agents, enforce runtime tool policy, store memory across runs, or change the opifex PersonaSpec schema.

---

## 1. How to Call larva

### Primary: MCP Server

Prefer MCP for programmatic access.

Available tools:

```text
larva_validate(spec)                         -> ValidationReport
larva_register(spec, variant?)               -> {id, registered}
larva_resolve(id, overrides?, variant?)      -> PersonaSpec
larva_list()                                 -> [{id, description, spec_digest, model}]
larva_update(id, patches, variant?)          -> PersonaSpec
larva_update_batch(where, patches, dry_run?) -> {items, matched, updated}
larva_clone(source_id, new_id)               -> PersonaSpec
larva_delete(id)                             -> {id, deleted}
larva_clear(confirm)                         -> {cleared, count}
larva_export(all?, ids?)                     -> [PersonaSpec, ...]
larva_variant_list(id)                       -> registry metadata
larva_variant_activate(id, variant)          -> {id, active}
larva_variant_delete(id, variant)            -> {id, variant, deleted}
```

Removed tools:

```text
larva_assemble
larva_component_list
larva_component_show
```

For every PersonaSpec input, forbidden legacy vocabulary is `tools` and
`side_effect_policy`. Unknown top-level fields, including `variant`, are rejected
as non-canonical. Pass `variant` as an operation parameter, never inside `spec`.

### Fallback: CLI

```bash
larva validate <spec.json> [--json]
larva register <spec.json> [--variant <name>] [--json]
larva resolve <id> [--variant <name>] [--override key=value]... [--json]
larva list [--json]
larva update <id> [--variant <name>] --set key=value [--set ...] [--json]
larva clone <source-id> <new-id> [--json]
larva delete <id> [--json]
larva clear --confirm "CLEAR REGISTRY" [--json]
larva export --all [--json]
larva export --id <id> [--id <id>]... [--json]
larva variant list <id> [--json]
larva variant activate <id> <variant> [--json]
larva variant delete <id> <variant> [--json]
larva doctor [--json]
larva opencode [OPENCODE_ARG ...]
```

### Fallback: Python API

```python
from larva.shell.python_api import (
    validate,
    register,
    resolve,
    update,
    update_batch,
    clone,
    list,
    delete,
    clear,
    export_all,
    export_ids,
    variant_list,
    variant_activate,
    variant_delete,
)
```

---

## 2. PersonaSpec — The Core Data Structure

A PersonaSpec is a flat, self-contained JSON object. All canonical larva outputs
produce or consume this shape.

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code changes with read-focused tooling.",
  "prompt": "You are a senior code reviewer...",
  "model": "openai/gpt-5.5",
  "model_params": {"temperature": 0.3},
  "capabilities": {"filesystem": "read_write", "shell": "read_only"},
  "can_spawn": false,
  "compaction_prompt": "Summarize working context into concise carry-forward notes.",
  "spec_digest": "sha256:e3b0c442..."
}
```

Field constraints:

- `id`: required flat kebab-case; no namespaces.
- `spec_version`: canonical input must use `"0.1.0"`.
- `spec_digest`: computed by larva from canonical JSON, excluding itself.
- `capabilities`: required canonical capability map.
- `variant`: not a PersonaSpec field; registry-local only.

---

## 3. Core Operations

### 3.1 validate

Validate a PersonaSpec candidate.

```json
{
  "spec": {
    "id": "my-agent",
    "description": "Reviews code changes.",
    "prompt": "You are a senior code reviewer.",
    "model": "openai/gpt-5.5",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0"
  }
}
```

Returns `ValidationReport` with `valid`, `errors`, and `warnings`.

### 3.2 register

Store a PersonaSpec in the registry.

```json
{
  "spec": {
    "id": "code-reviewer",
    "description": "Reviews code changes.",
    "prompt": "You are a stricter senior code reviewer.",
    "model": "openai/gpt-5.5",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0"
  },
  "variant": "tacit"
}
```

- `variant` is optional and defaults to `default`.
- New persona: the registered variant becomes active automatically.
- Existing persona: register writes/replaces the named variant but does not auto-activate it.
- `spec.id` must equal the base persona id.

### 3.3 resolve

Fetch a registered persona by id.

```json
{ "id": "code-reviewer", "variant": "tacit", "overrides": { "model": "openai/gpt-5.5" } }
```

- Without `variant`, resolve uses the active variant.
- With `variant`, resolve returns that variant.
- Runtime overrides apply after variant selection and before final validation and
  digest computation. Allowed override fields are `prompt`, `model`,
  `model_params`, and `compaction_prompt`; contract fields, derived fields,
  registry metadata, legacy fields, and unknown fields are rejected.
- Return value is a bare canonical PersonaSpec, never a registry envelope.

### 3.4 list

List base personas only.

```json
[
  {"id": "code-reviewer", "description": "...", "spec_digest": "sha256:...", "model": "openai/gpt-5.5"}
]
```

`larva_list` intentionally does not return variant metadata.

### 3.5 update

Patch either contract-owned fields or implementation-owned fields. Mixed-scope
patches are rejected.

```json
{ "id": "code-reviewer", "variant": "tacit", "patches": { "model": "openai/gpt-5.5-pro" } }
```

Without `variant`, an implementation-only patch updates the active variant and a
contract-only patch updates the shared persona contract. With `variant`, only
implementation-owned fields are accepted. Protected fields such as `id`,
`spec_version`, and `spec_digest` are rejected.

Patchable fields:

| Scope | Patchable fields |
|-------|------------------|
| Contract, without `variant` | `description`, `capabilities`, `can_spawn` |
| Active or named variant | `prompt`, `model`, `model_params`, `compaction_prompt` |
| Never | `id`, `spec_version`, `spec_digest` |

`larva_update_batch(where, patches, dry_run?)` uses the same ownership rules as
`update` without a named variant: `where` matches active materialized
PersonaSpecs, contract-only patches update the shared contract for matched base
personas, implementation-only patches update matched active variants, and mixed
patches are rejected for the whole batch.

### 3.6 variant operations

```json
{ "id": "code-reviewer" }
```

`larva_variant_list` returns registry metadata:

```json
{ "id": "code-reviewer", "active": "tacit", "variants": ["default", "tacit"] }
```

`larva_variant_activate(id, variant)` changes only registry manifest state.
`larva_variant_delete(id, variant)` deletes only an inactive, non-last variant.

### 3.7 delete and clear

`larva_delete(id)` deletes the base persona and all variants.
`larva_clear(confirm="CLEAR REGISTRY")` removes the whole registry and requires
the exact confirmation token.

---

## 4. Registry-local Variants

Variants live under the registry and are selected by operation parameter. They
are not PersonaSpec fields.

```text
~/.larva/registry/<id>/
  manifest.json              # {"active": "default"}
  contract.json              # id, description, capabilities, can_spawn, spec_version
  variants/
    default.json             # prompt, model, model_params, compaction_prompt
    tacit.json               # prompt, model, model_params, compaction_prompt
```

Rules:

- default resolve/list/export/OpenCode behavior uses the active variant
- `larva_resolve(id, variant="name")` returns a specific variant as canonical PersonaSpec
- `larva_register(spec, variant="name")` validates a complete PersonaSpec, stores
  persona contract fields in `contract.json`, and creates or replaces the named
  implementation variant
- contract-owned fields are `id`, `description`, `capabilities`, `can_spawn`, and
  `spec_version`; implementation-owned fields are `prompt`, `model`,
  `model_params`, and `compaction_prompt`
- active and last variants cannot be deleted through `variant_delete`
- `index.json` is not used by the registry; directory scan is the enumeration source

---

## 5. Placeholder policy

Prompt text must already be fully composed before admission. Placeholder-map
inputs at validate/register/update boundaries are rejected as extra/forbidden
fields. Prompt text is opaque; `{placeholder}` style text is preserved as text,
not interpreted as variable injection.

---

## 6. Error Handling

Every error is a structured envelope with `code`, `numeric_code`, `message`, and
`details`.

Common codes:

| Code | Meaning |
|------|---------|
| `INVALID_INPUT` | malformed request or unsupported field |
| `PERSONA_NOT_FOUND` | base persona id not present |
| `VARIANT_NOT_FOUND` | named variant not present |
| `INVALID_VARIANT_NAME` | variant name is not lower-kebab slug or exceeds 64 characters |
| `PERSONA_ID_MISMATCH` | `spec.id` does not match the target base persona id |
| `BASE_CONTRACT_MISMATCH` | a new variant attempts to redefine existing contract-owned fields |
| `MIXED_SCOPE_PATCH` | an update patch mixes contract-owned and implementation-owned fields |
| `FIELD_SCOPE_VIOLATION` | a field is patched or stored outside its owning scope |
| `REGISTRY_CORRUPT` | manifest, contract, or selected variant state is absent, malformed, or violates ownership |
| `ACTIVE_VARIANT_DELETE_FORBIDDEN` | attempted to delete active variant |
| `LAST_VARIANT_DELETE_FORBIDDEN` | attempted to delete only remaining variant |
| `PERSONA_INVALID` | validation failed after override/update |
| `FORBIDDEN_FIELD` | legacy or unknown canonical field such as `tools` or `variant` |

Negative CLI examples:

```bash
# invalid variant slug -> INVALID_VARIANT_NAME
larva variant activate code-reviewer Bad_Name

# contract field with explicit variant -> FIELD_SCOPE_VIOLATION
larva update code-reviewer --variant tacit --set can_spawn=false

# mixed contract and implementation fields -> MIXED_SCOPE_PATCH
larva update code-reviewer --set can_spawn=false --set model=openai/gpt-5.5
```

Negative Web example:

```http
PUT /api/registry/personas/code-reviewer/variants/tacit
Content-Type: application/json

{"id":"code-reviewer-tacit","description":"...","prompt":"...","model":"...","capabilities":{},"spec_version":"0.1.0"}
```

returns `400` with `PERSONA_ID_MISMATCH` because the route base id and
`spec.id` differ.

---

## 7. File System Layout

```text
~/.larva/
  registry/
    <id>/
      manifest.json              # {"active": "default"}
      contract.json              # persona-level contract fields
      variants/
        <variant>.json           # variant implementation fields
```

`manifest.json` is the only correctness source for active variant selection.
`contract.json` is the only local source for identity, description, capability
intent, spawn boundary, and schema version. Variant lists are read from
`variants/*.json`. Variant names match
`^[a-z0-9]+(-[a-z0-9]+)*$`, are at most 64 characters, and the v1 registry
returns the complete variant list without pagination. Corrupt or missing
manifests, contracts, or selected variant files fail closed with
`REGISTRY_CORRUPT`; larva does not auto-repair them.

---

## 8. Common Workflows

### Workflow A: Generate and register a new persona

```text
1. Build PersonaSpec JSON
2. larva_validate(spec) -> check valid=true
3. larva_register(spec) -> writes default variant
4. larva_resolve(id) -> confirm active round-trip
```

### Workflow B: Add a named variant

```text
1. Build a complete PersonaSpec with the same base id
2. larva_validate(spec) -> check valid=true
3. larva_register(spec, variant="tacit") -> split into shared contract plus named implementation variant
4. larva_variant_list(id) -> confirm it exists
5. larva_variant_activate(id, "tacit") -> make it active when explicitly desired
```

The source filename may include the variant name, but `spec.id` inside the file
must remain the base persona id.

### Workflow C: Load for agent execution

```text
1. larva_resolve(id) -> active PersonaSpec
   OR larva_resolve(id, variant="tacit") -> explicit variant PersonaSpec
2. Pass spec to anima or agent runner
```

### Workflow D: OpenCode

```bash
larva opencode --agent python-senior
larva opencode run "check this bug" --agent python-senior
```

`--agent python-senior` selects the Larva base persona id `python-senior` as the
OpenCode agent. The wrapper projects active variants only; inactive variants are
not separate OpenCode agents.

The plugin replaces the selected `[larva:<id>]` placeholder at OpenCode's
system-prompt transform layer. The hardening contract is selected-id re-resolve
on runtime cache miss or expiry, no raw placeholder leakage, and fail-closed
behavior when no prompt can be resolved. Runtime cache fallback is not registry
storage state and never repairs registry files. Adding or deleting a persona id
changes the OpenCode agent list and requires restarting `larva opencode`.

---

## 9. Critical Constraints

- **No LLM calls.** larva is pure persona management.
- **No inheritance.** There is no `base:` field.
- **No assembly/components.** Register complete PersonaSpec JSON directly.
- **Ids are global and flat.** Ids must be kebab-case.
- **Variants are registry metadata.** `variant` is rejected inside PersonaSpec.
- **Contract fields are shared.** `capabilities` and `can_spawn` belong to the
  persona contract, not to an individual variant.
- **spec_version is schema identity, not persona revisioning.**
- **spec_digest is always recomputed.** Active variant switches must change resolved digest when canonical content changes.
- **Override revalidation is mandatory.** Forbidden override fields produce
  `FORBIDDEN_OVERRIDE_FIELD`; allowed override values that make the materialized
  spec invalid produce `PERSONA_INVALID`.
- **Active and last variants are protected.** Use `variant_activate` before deleting a former active variant; delete the base persona to remove the last variant.
- **`clear` requires confirmation.** The token `"CLEAR REGISTRY"` must match exactly.
