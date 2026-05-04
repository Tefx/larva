# larva -- Interface Specification

Status: implemented public interface plus target registry storage contract for
the registry-local variants cutover.
Assembly/component public surfaces have been removed.

## Purpose

`larva` validates, normalizes, registers, resolves, updates, exports, and
projects canonical PersonaSpec artifacts across CLI, MCP, Python, and Web
surfaces.

The canonical PersonaSpec schema authority is `opifex`. Registry-local variants
are larva-local routing metadata and never become PersonaSpec fields.

## PersonaSpec Contract

Canonical PersonaSpec fields are owned by `opifex`. larva must reject unknown
top-level fields, including `variant`, `_registry`, `active`, and manifest state.

Core required fields include:

- `id`
- `description`
- `prompt`
- `model`
- `capabilities`
- `spec_version`

Canonical optional fields include:

- `model_params`
- `can_spawn`
- `compaction_prompt`
- `spec_digest`

## MCP Surface

Primary MCP tools:

- `larva_validate(spec)`
- `larva_register(spec, variant?)`
- `larva_resolve(id, overrides?, variant?)`
- `larva_list()`
- `larva_update(id, patches, variant?)`
- `larva_update_batch(where, patches, dry_run?)`
- `larva_clone(source_id, new_id)`
- `larva_delete(id)`
- `larva_clear(confirm)`
- `larva_export(all?, ids?)`
- `larva_variant_list(id)`
- `larva_variant_activate(id, variant)`
- `larva_variant_delete(id, variant)`

Removed MCP tools:

- `larva_assemble`
- `larva_component_list`
- `larva_component_show`

All PersonaSpec-bearing tools reject forbidden legacy vocabulary:
`tools`, `side_effect_policy`. Unknown top-level fields such as `variables` and
`variant` are also rejected. Variant is a separate operation parameter or
registry metadata, never a field inside `spec`.

`larva_list()` returns base persona summaries only. It does not return variant
metadata. Use `larva_variant_list(id)` for registry-local variant names and
active status.

`larva_variant_list(id)` returns:

```json
{"id": "code-reviewer", "active": "tacit", "variants": ["default", "tacit"]}
```

`larva_variant_activate(id, variant)` returns:

```json
{"id": "code-reviewer", "active": "tacit"}
```

`larva_variant_delete(id, variant)` returns:

```json
{"id": "code-reviewer", "variant": "default", "deleted": true}
```

`larva_register(spec, variant?)` returns:

```json
{"id": "code-reviewer", "registered": true}
```

When registering a new base persona, larva writes the contract, writes the named
or `default` variant implementation, and activates that variant. When
registering an existing base persona, larva rejects any contract-field mismatch,
creates or replaces only the named variant implementation, and does not change
the active pointer. Replacing the active variant updates future resolves for the
same active name; running sessions that already consumed a resolved spec are out
of larva scope.

`larva_resolve(id, overrides?, variant?)` applies overrides after active/named
variant selection and before final validation/digest computation. Overrides are
ephemeral and never mutate registry files.

Allowed override fields:

- `prompt`
- `model`
- `model_params`
- `compaction_prompt`

Forbidden override fields include contract-owned fields (`id`, `description`,
`capabilities`, `can_spawn`, `spec_version`), derived fields (`spec_digest`),
registry metadata (`variant`, `_registry`, `active`, `manifest`), legacy fields
(`tools`, `side_effect_policy`), and unknown top-level fields. Invalid overrides
fail before returning a PersonaSpec. `spec_digest` is computed from the
materialized PersonaSpec after valid overrides are applied.

## CLI Surface

Representative CLI operations:

- validate a PersonaSpec
- register a canonical persona or named registry-local variant
- resolve the active variant or a named variant as canonical PersonaSpec JSON
- list canonical base personas
- activate, list, or delete registry-local variants
- launch OpenCode with active registry personas projected as agents

CLI is an operator interface over the same canonical contract. It does not add
new PersonaSpec fields.

The OpenCode launcher is a pass-through shell adapter. It forwards OpenCode
arguments after building a temporary config from the current Larva registry and
injecting the Larva OpenCode plugin. The OpenCode agent id is the Larva base
persona id; the runtime refresh hardening contract requires re-resolving that id
instead of consulting a process-global active persona.

## Cross-Surface Authority Rules

OpenCode startup projection is not runtime semantic authority. `export --all`
is used only to make current Larva base ids visible during OpenCode startup;
per-request prompt, temperature, and permission refreshes resolve the selected
placeholder id via `larva resolve <id> --json`. The plugin cache is
last-known-good performance state keyed by base id, deduplicates concurrent
same-id resolves, may fall back to a previous cached prompt only with
debug-visible warning, and otherwise fails closed rather than leaking a
`[larva:<id>]` placeholder. This runtime cache behavior is not registry storage
state and never repairs registry files. Hot-update scope is limited to prompt,
temperature, tool-policy,
`capabilities`, and `can_spawn`; added/deleted base ids and model/provider
startup fields require an OpenCode restart. There is no `larva-active` agent and
no global active variant state.

## Python API Surface

Python mirrors the same operation set:

```python
validate(spec)
register(spec, variant=None)
resolve(id, overrides=None, variant=None)
update(id, patches, variant=None)
update_batch(where, patches, dry_run=False)
clone(source_id, new_id)
list()
delete(id)
clear(confirm="CLEAR REGISTRY")
export_all()
export_ids(ids)
variant_list(id)
variant_activate(id, variant)
variant_delete(id, variant)
```

Removed Python API exports:

- `assemble`
- `component_list`
- `component_show`

## Web Runtime Surface

`larva serve` is the authoritative packaged runtime and web contract.
`python contrib/web/server.py` is a supported contributor convenience runtime,
not the canonical packaged entrypoint.

### Normative endpoint inventory

| Method | Path | Contract |
|-------|------|----------|
| `GET` | `/` | Return the packaged HTML UI artifact |
| `GET` | `/api/personas` | Return `{data: PersonaSummary[]}` for active base personas |
| `GET` | `/api/personas/{persona_id}` | Return `{data: PersonaSpec}` for the active variant |
| `POST` | `/api/personas` | Accept a PersonaSpec or `{spec: PersonaSpec}`; validate then register the default variant by splitting contract and implementation fields |
| `PATCH` | `/api/personas/{persona_id}` | Accept contract-only or implementation-only patch object; reject mixed-scope patches and protected `id`, `spec_version`, and `spec_digest` |
| `DELETE` | `/api/personas/{persona_id}` | Delete the base persona and all variants |
| `POST` | `/api/personas/clear` | Accept `{confirm}` and clear only on valid confirmation |
| `POST` | `/api/personas/validate` | Accept PersonaSpec candidate and return validation report |
| `POST` | `/api/personas/export` | Accept `{all: true}` or `{ids: [str]}` and return active canonical PersonaSpecs |
| `POST` | `/api/personas/update_batch` | Accept `{where: dict, patches: dict, dry_run?: bool}` and match active canonical specs |
| `GET` | `/api/registry/personas` | Return registry metadata summaries `{id, description, model, active, variants}` without full specs |
| `GET` | `/api/registry/personas/{persona_id}/variants` | Return `{data: {id, active, variants}}` registry metadata |
| `GET` | `/api/registry/personas/{persona_id}/variants/{variant}` | Return `{data: {_registry, spec}}`; `_registry` is local metadata, `spec` is materialized canonical PersonaSpec |
| `PUT` | `/api/registry/personas/{persona_id}/variants/{variant}` | Accept canonical PersonaSpec; split contract and implementation fields; reject if `spec.id` differs from `{persona_id}` or existing contract fields differ |
| `POST` | `/api/registry/personas/{persona_id}/variants/{variant}/activate` | Make an existing variant active by updating registry manifest state only |
| `DELETE` | `/api/registry/personas/{persona_id}/variants/{variant}` | Delete an inactive, non-last variant |

Successful base persona deletion returns `{data: {id, deleted}}`. Registry
variant read/list endpoints fail closed with `REGISTRY_CORRUPT` if
`manifest.json`, `contract.json`, or the selected variant file is absent,
malformed, violates ownership, or points at missing data; they do not
auto-create an empty variant set.

Removed endpoints:

- `/api/personas/assemble`
- `/api/components`
- `/api/components/{component_type}/{name}`
- `/api/components/projection`

`POST /api/personas/assemble` is retained only as an explicit fail-closed
404 tombstone for older callers. It is not an assembly API and never returns a
successful response. The tombstone returns a structured Web error envelope with
`INVALID_INPUT` / numeric code `1` and HTTP status `404`.

Web `PUT /api/registry/personas/{persona_id}/variants/{variant}` accepts a raw
canonical PersonaSpec JSON object, not a `{spec}` envelope. On success it returns
`{data: {id, registered}}`. Existing personas keep their current active pointer;
new personas activate the registered variant.

`POST /api/personas/update_batch` uses the same patch ownership rules as
`larva_update(id, patches)` without an explicit variant: contract-only patches
update the shared contract for each matched base persona, implementation-only
patches update each matched active variant, and mixed-scope patches are rejected
for the whole batch. `where` matches active materialized canonical PersonaSpecs,
not registry metadata or inactive variants.

### PersonaSummary Shape

```json
{
  "id": "developer",
  "description": "Local coding persona",
  "spec_digest": "sha256:...",
  "model": "openai/gpt-5.5"
}
```

Persona summaries are active canonical summaries. They do not contain variant
metadata.

### Registry Variant Envelope

```json
{
  "_registry": {"variant": "tacit", "is_active": true},
  "spec": {
    "id": "developer",
    "description": "Local coding persona",
    "prompt": "...",
    "model": "openai/gpt-5.5",
    "capabilities": {},
    "spec_version": "0.1.0",
    "spec_digest": "sha256:..."
  }
}
```

`_registry` never appears inside `spec`.

## Registry-local Variant Contract

Variant state is local registry metadata:

- active state lives in `~/.larva/registry/<id>/manifest.json`
- persona contract fields live in `~/.larva/registry/<id>/contract.json`
- variant implementation fields live in
  `~/.larva/registry/<id>/variants/<variant>.json`
- variant names must match `^[a-z0-9]+(-[a-z0-9]+)*$` and be at most 64
  characters; violations return `INVALID_VARIANT_NAME`
- variant count is unbounded in v1; `variant_list` returns the complete local list
- registry envelopes may contain `_registry`, but canonical PersonaSpec objects never do
- `variant` is an operation parameter, not a PersonaSpec field
- assembly and component surfaces are removed; callers register complete PersonaSpecs directly

Field ownership is exact:

| Storage file | Allowed fields |
|--------------|----------------|
| `contract.json` | `id`, `description`, `capabilities`, `can_spawn`, `spec_version` |
| `variants/<variant>.json` | `prompt`, `model`, `model_params`, `compaction_prompt` |

Update mutability is exact:

| Scope | Patchable fields |
|-------|------------------|
| Contract, without explicit `variant` | `description`, `capabilities`, `can_spawn` |
| Variant implementation, active or named | `prompt`, `model`, `model_params`, `compaction_prompt` |
| Never patchable | `id`, `spec_version`, `spec_digest` |

`resolve`, `list`, `export`, and registry variant detail responses materialize
`contract.json` plus the selected variant implementation into a complete
canonical PersonaSpec and compute `spec_digest` from that materialized content.
No storage schema, manifest state, active pointer, or variant name enters the
canonical PersonaSpec.

`larva_update(id, patches, variant?)` applies the same ownership rules:

- contract-only patches without `variant` update `contract.json`
- implementation-only patches update the active variant or the named `variant`
- mixed contract/implementation patches are rejected
- contract-owned patches with an explicit `variant` are rejected

Variant-specific error codes are stable across CLI, MCP, Python, and Web
projections:

| Code | Meaning |
|------|---------|
| `INVALID_VARIANT_NAME` | `variant` is missing where required, not a lower-kebab slug, or exceeds 64 characters |
| `VARIANT_NOT_FOUND` | requested variant file does not exist under the base persona id |
| `PERSONA_ID_MISMATCH` | supplied `spec.id` differs from the target base persona id |
| `BASE_CONTRACT_MISMATCH` | supplied canonical PersonaSpec attempts to redefine existing persona contract fields during variant registration |
| `MIXED_SCOPE_PATCH` | update patch contains both contract-owned and implementation-owned fields |
| `FIELD_SCOPE_VIOLATION` | contract-owned field is patched while an explicit variant is selected, or storage file contains fields outside its ownership |
| `REGISTRY_CORRUPT` | `manifest.json`, `contract.json`, or selected variant file is absent, malformed, violates field ownership, or points at missing data; larva does not auto-invent or repair registry files |
| `ACTIVE_VARIANT_DELETE_FORBIDDEN` | attempted to delete the active variant |
| `LAST_VARIANT_DELETE_FORBIDDEN` | attempted to delete the only remaining variant |

Numeric error codes are stable:

| Code | Numeric code |
|------|--------------|
| `INVALID_INPUT` | `1` |
| `INTERNAL` | `10` |
| `PERSONA_NOT_FOUND` | `100` |
| `PERSONA_INVALID` | `101` |
| `PERSONA_CYCLE` | `102` |
| `INVALID_PERSONA_ID` | `104` |
| `REGISTRY_INDEX_READ_FAILED` | `107` |
| `REGISTRY_SPEC_READ_FAILED` | `108` |
| `REGISTRY_WRITE_FAILED` | `109` |
| `REGISTRY_UPDATE_FAILED` | `110` |
| `REGISTRY_DELETE_FAILED` | `111` |
| `INVALID_CONFIRMATION_TOKEN` | `112` |
| `FORBIDDEN_OVERRIDE_FIELD` | `113` |
| `FORBIDDEN_PATCH_FIELD` | `114` |
| `FORBIDDEN_FIELD` | `115` |
| `MISSING_SPEC_VERSION` | `116` |
| `REGISTRY_CORRUPT` | `117` |
| `INVALID_VARIANT_NAME` | `118` |
| `VARIANT_NOT_FOUND` | `119` |
| `ACTIVE_VARIANT_DELETE_FORBIDDEN` | `120` |
| `LAST_VARIANT_DELETE_FORBIDDEN` | `121` |
| `PERSONA_ID_MISMATCH` | `122` |
| `BASE_CONTRACT_MISMATCH` | `123` |
| `MIXED_SCOPE_PATCH` | `124` |
| `FIELD_SCOPE_VIOLATION` | `125` |

Error projection by surface:

| Surface | Projection |
|---------|------------|
| MCP | returns the same structured `{code, numeric_code, message, details}` error envelope as facade failures |
| Python | raises `LarvaApiError` carrying the structured error envelope |
| CLI | exits non-zero; `--json` prints the structured error envelope, text mode prints code and message |
| Web REST | returns `{"error": {code, numeric_code, message, details}}` |

Web REST status mapping:

| Error class | HTTP status |
|-------------|-------------|
| missing persona or variant | `404` |
| invalid input, forbidden field, protected field, mismatch, mixed scope, invalid variant name, validation failure | `400` |
| active-variant delete or last-variant delete | `409` |
| registry read/write/delete/corrupt/internal failures | `500` |

Negative Web examples:

```http
PUT /api/registry/personas/code-reviewer/variants/tacit
Content-Type: application/json

{"id":"code-reviewer-tacit","description":"...","prompt":"...","model":"...","capabilities":{},"spec_version":"0.1.0"}
```

returns `400` with `PERSONA_ID_MISMATCH` because `spec.id` differs from the
route base id.

```http
PATCH /api/personas/code-reviewer
Content-Type: application/json

{"can_spawn": false, "model": "openai/gpt-5.5"}
```

returns `400` with `MIXED_SCOPE_PATCH` because the patch mixes contract and
implementation fields.

## Invariants

- `id` is stable identity
- `capabilities` is the only capability declaration surface
- `description`, `capabilities`, `can_spawn`, and `spec_version` are persona
  contract fields shared by all variants for a base id
- `prompt`, `model`, `model_params`, and `compaction_prompt` are variant
  implementation fields
- `tools` is rejected — not a canonical PersonaSpec field
- `variant` is rejected inside PersonaSpec; it is only registry-local metadata
- register/update for a named base persona rejects mismatched `spec.id` with
  `PERSONA_ID_MISMATCH`
- approval and runtime gating stay outside larva
- concrete tool semantics stay outside larva
- `spec_digest` is computed from canonical JSON representation
- `spec_digest` excludes itself from canonical JSON representation
- active variant changes must change resolved `spec_digest` whenever materialized canonical content changes
- larva is a downstream admission/projection layer; opifex owns the canonical contract
