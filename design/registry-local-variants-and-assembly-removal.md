# Registry-local Variants and Assembly Removal

Status: accepted design target  
Scope: `larva` registry, CLI, Python API, MCP, packaged Web REST/UI, and documentation  
Canonical contract authority: `../opifex/contracts/persona_spec.schema.json`

## Decision

`larva` will remove the assembly/component subsystem and replace name-based
persona variants with registry-local variants.

The canonical `PersonaSpec` shape does **not** change. `variant` is not a
PersonaSpec field, is not accepted inside `spec`, and is not owned by `opifex`.
Variant state belongs only to the `larva` registry boundary.

## Rationale

The old assembly/component subsystem attempted to build a PersonaSpec from
prompt, toolset, constraint, and model fragments. It has not proven useful in
practice and expands every public surface: core assembly logic, component file
loading, CLI commands, MCP tools, Web REST routes, Web UI compose flows, tests,
docs, and `opifex` conformance references.

The active operational problem is different: several personas with the same role
exist as separate ids, such as `blind-tester`, `blind-tester-tacit`,
`vectl-planner`, `vectl-planner-slim`, and `vectl-planner-tacit`. That flat list
forces agents to choose between implementation variants and causes unstable
selection. The simplest fix is to keep one base persona id and let `larva` route
that id to one active local variant.

## Non-goals

- No `PersonaSpec` schema changes.
- No `variant`, `_registry`, `active`, `manifest`, or local state fields inside
  canonical PersonaSpec JSON.
- No automatic migration from `*-tacit`, `*-slim`, or other naming conventions.
- No replacement templating, inheritance, component composition, diff UI,
  history, variant permissions, or variant-specific admin profile.
- No local interpretation of `opifex` canonical fields.

## Storage layout

The registry stores each base persona in a directory:

```text
~/.larva/registry/
  <persona-id>/
    manifest.json
    variants/
      <variant>.json
```

`manifest.json` contains only the active pointer:

```json
{"active": "default"}
```

The base persona id comes from the directory name. The variant list comes from
scanning `variants/*.json`. `index.json` is not used in this design; directory
scan is the only correctness source for enumeration.

## Storage invariants

- `<persona-id>` remains flat kebab-case, matching canonical `PersonaSpec.id`.
- Variant names use the same slug style as persona ids:
  `^[a-z0-9]+(-[a-z0-9]+)*$`. Empty names, path separators, uppercase letters,
  underscores, dots, `..`, and names longer than 64 characters are invalid and
  rejected with `INVALID_VARIANT_NAME`.
- Variant count is unbounded in v1. `variant_list` returns the complete local
  variant list without pagination.
- `manifest.active` names an existing file in `variants/`.
- Activation writes `manifest.json` with a same-directory write-then-rename
  strategy: write a complete temporary manifest, then atomically replace
  `manifest.json`.
- larva does not provide cross-process locking. Concurrent activations may race;
  the last write-then-rename wins. Variant enumeration is a point-in-time
  directory scan and is not serialized with manifest writes.
- Every `variants/<variant>.json` is a canonical PersonaSpec.
- Every variant file has `spec.id == <persona-id>`.
- Canonical validation rejects unknown top-level fields, including `variant`.
- `spec_digest` is computed from canonical PersonaSpec content; switching active
  variants changes the resolved digest whenever resolved content changes.
- Deleting the active variant is rejected.
- Deleting the last remaining variant is rejected; delete the persona instead.

If `manifest.json` is absent, malformed, or references a missing variant at load
time, the operation fails with `REGISTRY_CORRUPT`. larva must not auto-invent a
manifest.

## Public behavior

### Active-only persona operations

Existing persona operations keep their simple meaning for callers unaware of
variants:

- `list` shows base persona ids only.
- `resolve(id)` returns the active variant as a bare canonical PersonaSpec.
- `update(id, patches)` updates the active variant.
- `delete(id)` deletes the whole base persona directory, including variants.
- `export --all` exports active canonical PersonaSpecs only.

### Variant-aware operations

- `register(spec, variant=None)` writes `default` when `variant` is omitted.
  A new persona is activated automatically. An existing persona is not
  auto-activated by register. Registering under an explicit base id or variant
  path rejects `spec.id` mismatch with `PERSONA_ID_MISMATCH`.
- `resolve(id, variant=name)` returns that specific variant as a bare canonical
  PersonaSpec.
- `update(id, patches, variant=name)` updates that specific variant.
- `variant_list(id)` returns registry metadata: active variant and variant names.
- `variant_activate(id, variant)` changes only `manifest.json`.
- `variant_delete(id, variant)` deletes only an inactive, non-last variant.

## MCP surface

MCP remains a registry API. Variant operations are not given a special local
admin namespace because existing MCP already exposes registry mutations such as
register, update, delete, clear, and export. If future deployments need
authorization, they should add a global read-only/read-write MCP profile rather
than a variant-specific exception.

Removed tools:

- `larva_assemble`
- `larva_component_list`
- `larva_component_show`

Changed tools:

- `larva_register(spec, variant?)`
- `larva_resolve(id, overrides?, variant?)`
- `larva_update(id, patches, variant?)`

Added tools:

- `larva_variant_list(id)`
- `larva_variant_activate(id, variant)`
- `larva_variant_delete(id, variant)`

`larva_list` does not return variant metadata. `larva_variant_list` returns
registry metadata, not PersonaSpecs.

## CLI and Python surface

CLI mirrors the MCP behavior:

```bash
larva register spec.json --variant tacit
larva resolve blind-tester --variant tacit
larva update blind-tester --variant tacit --set model=openai/gpt-5.5
larva variant list blind-tester
larva variant activate blind-tester tacit
larva variant delete blind-tester tacit
```

Python API mirrors the same operations:

```python
register(spec, variant=None)
resolve(id, overrides=None, variant=None)
update(id, patches, variant=None)
variant_list(id)
variant_activate(id, variant)
variant_delete(id, variant)
```

## Web REST surface

Canonical active-spec routes remain focused on bare PersonaSpec data:

```http
GET    /api/personas
GET    /api/personas/{id}
POST   /api/personas
PATCH  /api/personas/{id}
DELETE /api/personas/{id}
```

Registry-local variant routes use a separate namespace and envelope:

```http
GET    /api/registry/personas
GET    /api/registry/personas/{id}/variants
GET    /api/registry/personas/{id}/variants/{variant}
PUT    /api/registry/personas/{id}/variants/{variant}
POST   /api/registry/personas/{id}/variants/{variant}/activate
DELETE /api/registry/personas/{id}/variants/{variant}
```

Variant detail responses separate local metadata from canonical data:

```json
{
  "_registry": {"variant": "tacit", "is_active": true},
  "spec": {
    "id": "blind-tester",
    "description": "...",
    "prompt": "...",
    "model": "...",
    "capabilities": {},
    "spec_version": "0.1.0",
    "spec_digest": "sha256:..."
  }
}
```

`_registry` never appears inside `spec`.

## Web UI behavior

The Web UI is a human registry-management view, so it may show active variant
state that agent-facing list surfaces hide.

- Sidebar shows the base id and active variant as muted secondary text.
- Detail header shows base id, a variant selector, and Active/Inactive badge.
- Registry controls and PersonaSpec editor are visually separated.
- The editor edits the selected variant; `id` is locked/read-only.
- Non-active variants show a persistent banner: "You are viewing an inactive
  variant. Changes here will not affect the active persona."
- Saving a non-active variant shows: "Saved. This variant is not currently
  active."
- New/import/duplicate/delete live in a low-frequency menu, not the primary
  action row.
- Active and last variants have disabled delete controls with explanatory text.
- Deleting a base persona remains the only operation that removes all variants.

## Opifex boundary

This decision does not change `../opifex/contracts/persona_spec.schema.json` or
canonical PersonaSpec meaning. `opifex` may update design and conformance text to
stop listing removed larva assembly/component surfaces and to describe variants
as larva-local registry metadata. It must not accept `variant` inside a
PersonaSpec or add compatibility aliases.

## Manual migration

No automatic migration guesses naming conventions. A user migrates a historical
variant-shaped id manually:

```bash
larva export --id blind-tester-tacit --json > blind-tester-tacit.json
# edit JSON: set "id" to "blind-tester"
larva register blind-tester-tacit.json --variant tacit
larva variant activate blind-tester tacit
larva resolve blind-tester --json
larva delete blind-tester-tacit
```

## Verification checklist

- Assembly/component commands, MCP tools, Python API exports, REST routes, Web
  UI flows, tests, and docs are removed.
- `variant` inside a PersonaSpec is rejected.
- `register`, `resolve`, and `update` variant defaults are identical across CLI,
  Python, MCP, and REST.
- `list` and `export` return active canonical specs without registry metadata.
- `variant_list` returns registry metadata only.
- PUT/register variant rejects mismatched `spec.id`.
- Activate is atomic: failure leaves the previous active variant intact.
- Delete rejects active and last variants.
- OpenCode receives one agent entry per base persona id and the active spec
  digest changes when active content changes.

## Complexity Cost Receipt

1. **Parts Added**: `manifest.json`, `variants/<variant>.json`, variant-aware
   register/resolve/update parameters, three variant operations, registry REST
   envelopes, and a small Web UI variant selector/action area.
2. **Simplest Alternative**: Continue registering every variant as a separate
   persona id such as `blind-tester-tacit`.
3. **The Defense**: Separate ids have already made agent selection unstable.
   A named file plus active pointer is the smallest mechanism that hides variants
   from agent routing while preserving canonical PersonaSpec purity.
