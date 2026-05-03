# larva User Guide

This guide explains how to use larva as the local authority for PersonaSpec
validation, registry storage, and registry-local variant routing.

## 1. What larva does

larva is a local authority for `PersonaSpec`, a flat JSON format used to define
LLM agent personas.

larva can:

- validate persona specs
- register personas in a local registry
- manage registry-local variants for a base persona id
- resolve a persona by id, using the active variant by default
- clone, update, delete, clear, and export personas
- expose the same model through MCP, CLI, Python, and a small web UI

larva does not:

- call models
- execute agents
- manage agent memory
- own runtime tool enforcement
- define provider-specific gateway behavior
- change the canonical PersonaSpec contract owned by opifex

## 2. Installation

```bash
pip install larva
```

Development checkout:

```bash
uv sync
uv run larva --help
```

## 3. Directory layout

larva stores state under `~/.larva/`.

```text
~/.larva/
  registry/
    <persona-id>/
      manifest.json
      variants/
        default.json
        tacit.json
```

- `registry/` holds registered canonical persona specs and registry-local variant metadata.
- Each variant file is a full canonical PersonaSpec whose `id` equals `<persona-id>`.
- `manifest.json` stores only the active variant pointer, for example `{"active": "default"}`.
- Variant names are registry-local metadata and are never PersonaSpec fields.

## 4. PersonaSpec basics

PersonaSpec is flat and self-contained:

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code for correctness and style",
  "prompt": "You are a senior code reviewer.",
  "model": "openai/gpt-5.5",
  "capabilities": {"shell": "read_only"},
  "can_spawn": false,
  "spec_digest": "sha256:..."
}
```

Important field rules:

- `id` must be flat kebab-case.
- `spec_version` is schema identity and is pinned to `"0.1.0"`.
- `spec_digest` is recomputed by larva.
- `capabilities` is the canonical capability declaration surface.
- `variant`, `_registry`, `active`, and manifest state are not PersonaSpec fields.

## 5. Your first persona

Validate and register a complete PersonaSpec:

```bash
larva validate code-reviewer.json
larva register code-reviewer.json
larva resolve code-reviewer --json
```

The first registration creates the `default` variant and makes it active.

## 6. Typical lifecycle

```bash
larva validate code-reviewer.json
larva register code-reviewer.json
larva register code-reviewer-tacit.json --variant tacit
larva variant activate code-reviewer tacit
larva update code-reviewer --set model=openai/gpt-5.5
larva resolve code-reviewer --json
larva export --id code-reviewer --json
```

## 7. Validation

```bash
larva validate code-reviewer.json
larva validate code-reviewer.json --json
```

Validation rejects unknown canonical fields, including `variant`. Pass variant
names as CLI/MCP/API parameters instead.

## 8. Register and resolve

Register default variant:

```bash
larva register code-reviewer.json
```

Register a named variant:

```bash
larva register code-reviewer-tacit.json --variant tacit
```

Resolve active variant:

```bash
larva resolve code-reviewer
```

Resolve a specific variant:

```bash
larva resolve code-reviewer --variant tacit
```

Apply temporary overrides during resolve:

```bash
larva resolve code-reviewer --override model=openai/gpt-5.5-pro
```

## 9. Clone, update, and variants

Use clone when you want a separate base persona id:

```bash
larva clone code-reviewer code-reviewer-exp
```

Use variants when you want several configurations behind one base id.

Patch the active variant:

```bash
larva update code-reviewer --set model=openai/gpt-5.5
```

Patch a named variant:

```bash
larva update code-reviewer --variant tacit --set model=openai/gpt-5.5-pro
```

## 10. Listing, deleting, clearing, and exporting

List base personas:

```bash
larva list
larva list --json
```

List variants for one persona:

```bash
larva variant list code-reviewer
```

Activate a variant:

```bash
larva variant activate code-reviewer tacit
```

Delete an inactive, non-last variant:

```bash
larva variant delete code-reviewer draft
```

Delete a base persona and all variants:

```bash
larva delete code-reviewer-exp
```

Export active canonical personas:

```bash
larva export --all --json
larva export --id code-reviewer --json
```

Export does not include registry metadata.

## 11. Working with registry-local variants

Variants replace name-based persona proliferation when the business role stays
the same but the preferred prompt/model/capability configuration changes.

Rules:

- every variant is a complete canonical PersonaSpec
- every variant for `code-reviewer` must have `"id": "code-reviewer"`
- variant names are lower-kebab slugs matching `^[a-z0-9]+(-[a-z0-9]+)*$`
  and at most 64 characters
- `variant` is registry metadata and must not appear inside PersonaSpec JSON
- `larva list`, `larva export`, and OpenCode projection use active variants only
- deleting the active variant and deleting the last variant are rejected

Manual migration from an old variant-like id:

```bash
larva export --id code-reviewer-tacit --json > code-reviewer-tacit.json
# edit JSON so "id" becomes "code-reviewer"
larva register code-reviewer-tacit.json --variant tacit
larva variant activate code-reviewer tacit
larva delete code-reviewer-tacit
```

## 12. Python API

```python
from larva.shell.python_api import (
    register,
    resolve,
    update,
    validate,
    variant_activate,
    variant_list,
)

spec = {
    "id": "code-reviewer",
    "description": "Reviews code for correctness and style",
    "prompt": "You are a senior code reviewer.",
    "model": "openai/gpt-5.5",
    "capabilities": {"shell": "read_only"},
    "can_spawn": False,
    "spec_version": "0.1.0",
}

report = validate(spec)
if report["valid"]:
    register(spec)
    register({**spec, "prompt": "You are a stricter senior code reviewer."}, variant="tacit")

variant_activate("code-reviewer", "tacit")
active_spec = resolve("code-reviewer")
default_spec = resolve("code-reviewer", variant="default")
variants = variant_list("code-reviewer")
updated = update("code-reviewer", {"model": "openai/gpt-5.5-pro"})
```

## 13. MCP surface

```text
larva_validate(spec)
larva_register(spec, variant?)
larva_resolve(id, overrides?, variant?)
larva_list()
larva_update(id, patches, variant?)
larva_update_batch(where, patches, dry_run?)
larva_clone(source_id, new_id)
larva_delete(id)
larva_clear(confirm)
larva_export(all?, ids?)
larva_variant_list(id)
larva_variant_activate(id, variant)
larva_variant_delete(id, variant)
```

Removed tools:

```text
larva_assemble
larva_component_list
larva_component_show
```

## 14. Web UI and plugin

Start the packaged Web UI:

```bash
larva serve
larva serve --port 7400 --no-open
```

The Web UI may show active variant state for human management. Registry variant
endpoints return `{_registry, spec}` envelopes where `_registry` is local
metadata and `spec` is canonical PersonaSpec.

OpenCode wrapper:

```bash
larva opencode
larva opencode --agent python-senior
```

OpenCode projection uses the active variant of each base persona id. Inactive
variants do not appear as separate OpenCode agents, and there is no global
`larva-active` agent.

- exports currently active registered personas through larva's normal facade path
- builds a temporary `OPENCODE_CONFIG_CONTENT` with `[larva:<id>]` placeholder agents keyed by Larva base id
- injects the bundled or source-tree `larva.ts` OpenCode plugin
- forwards remaining arguments to the real `opencode` binary
- strips a leading `--` after `opencode` when present

At startup, the wrapper projects current base persona ids as OpenCode agents with
placeholder prompts. Before model requests, the plugin replaces the selected
`[larva:<id>]` placeholder through OpenCode's system-prompt transform, so persona
instructions are stronger than ordinary MCP/tool-result context.

What it does not do:

- it does not write `.opencode/opencode.json`
- it does not call an LLM itself
- it does not turn PersonaSpec into runtime gateway policy
- it does not create a `larva-active` pseudo-agent
- it does not maintain a global active variant for concurrent requests
- it does not treat `export --all` as runtime semantic authority; `export --all` is startup projection only

Runtime refresh behavior:

- startup projection uses `larva export --all --json` only so OpenCode sees base ids before `--agent <larva-id>` validation
- each selected request resolves the chosen base id with `larva resolve <id> --json`
- cache entries are last-known-good performance data, keyed by base id, and remember prompt, optional temperature, optional `spec_digest`, derived permissions, and timestamp
- same-id concurrent resolves share one in-flight request
- if resolve fails and a previous good prompt exists, the stale prompt is used with a debug warning; without a previous good prompt, the plugin fails closed instead of leaking `[larva:<id>]`
- prompts are watermarked with both `<larva-persona id="..." />` and an instruction to identify as the named persona loaded from larva

Environment knobs:

- `LARVA_OPENCODE_DEBUG=1` enables cache/fallback/hardening warnings
- `LARVA_OPENCODE_CACHE_TTL_MS` defaults to `300000`; nonzero values allow last-known-good cache storage, `0` disables storing new cache entries, and invalid or negative values fall back to the default

Hot-updated on the next selected-id runtime request: prompt text,
`model_params.temperature`, tool-policy rules, permission derivation from
`capabilities`, and `can_spawn` task denial. Added/deleted base ids and
model/provider startup fields require restarting OpenCode because agent
registration is a startup boundary.

Plugin path resolution order:

1. `LARVA_OPENCODE_PLUGIN=/absolute/path/to/contrib/opencode-plugin/larva.ts`
2. bundled wheel resource at `larva/shell/opencode_plugin/larva.ts`
3. source-tree fallback at `contrib/opencode-plugin/larva.ts`

## 15. Troubleshooting

### `INVALID_PERSONA_ID`

Your id is missing or not kebab-case.

### `INVALID_SPEC_VERSION`

You supplied a non-v1 schema version. In current larva, `spec_version` must be
`"0.1.0"` if present.

### `PERSONA_NOT_FOUND`

You resolved, cloned, updated, deleted, or exported an id that is not present in
the registry.

### `VARIANT_NOT_FOUND`

You requested a named variant that does not exist under the base persona id.
Use `larva variant list <id>` to see local variants.

### `PERSONA_ID_MISMATCH`

You tried to write a variant under one base persona id while the PersonaSpec
contains a different `id`. Edit the PersonaSpec so `spec.id` matches the target
base id.

### `INVALID_VARIANT_NAME`

Variant names must be lower-kebab slugs up to 64 characters, for example
`default` or `tacit-review`.

### `REGISTRY_CORRUPT`

The registry manifest is absent, malformed, or points at a missing variant.
Inspect `~/.larva/registry/<id>/manifest.json` and verify that the `active`
variant file exists under `variants/`.

### `ACTIVE_VARIANT_DELETE_FORBIDDEN`

You tried to delete the active variant. Activate another variant first.

### `LAST_VARIANT_DELETE_FORBIDDEN`

You tried to delete the only remaining variant. Delete the base persona instead.

### `variant` rejected in PersonaSpec

`variant` is registry-local metadata. Pass it as a CLI/MCP/API parameter, not as
a key inside PersonaSpec JSON.

## 16. Design notes worth remembering

- larva is an authority for persona definitions, not a runtime
- canonical output is flat and self-contained
- `spec_version` describes schema compatibility, not release cadence
- `spec_digest` tracks canonical content changes, including active variant switches
- registry-local variants are named files plus an active pointer
- `variant` and `_registry` are not PersonaSpec fields
- no hidden mutable state is applied to personas between calls except explicit registry operations

## 17. Recommended reading order

1. `../../README.md`
2. `USER_GUIDE.md`
3. `USAGE.md`
4. `../reference/INTERFACES.md`
5. `../reference/ARCHITECTURE.md`
6. `../../design/registry-local-variants-and-assembly-removal.md`
