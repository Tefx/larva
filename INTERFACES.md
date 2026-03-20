# larva -- Interface Specification

## Purpose

`larva` validates, assembles, normalizes, and registers canonical PersonaSpec
artifacts.

It is the authority for persona identity and capability intent.

## PersonaSpec Contract

Normative shape:

```json
{
  "id": "developer",
  "description": "Local coding persona",
  "prompt": "...",
  "model": "claude-sonnet-4",
  "capabilities": {
    "filesystem": "read_write",
    "git": "read_only"
  },
  "can_spawn": false,
  "spec_version": "0.1.0",
  "spec_digest": "sha256:..."
}
```

### Field Details

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Required. Unique identifier matching `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `description` | string | Human-readable description of the persona |
| `prompt` | string | System prompt defining persona behavior |
| `model` | string | Model identifier (e.g., "claude-sonnet-4") |
| `capabilities` | dict[str, ToolPosture] | **Canonical** capability declaration: tool family -> posture |
| `tools` | dict[str, ToolPosture] | *Deprecated per ADR-002.* Retained for transition compatibility |
| `model_params` | dict | Additional model parameters (temperature, top_p, etc.) |
| `side_effect_policy` | string | *Deprecated per ADR-002.* Policy for side-effectful operations |
| `can_spawn` | bool \| list[str] | Whether persona can spawn sub-agents, or list of allowed persona IDs |
| `compaction_prompt` | string | Prompt used for state compaction |
| `spec_version` | string | Spec format version (default: "0.1.0") |
| `spec_digest` | string | SHA-256 digest of canonical JSON representation |

### ToolPosture Values

Valid capability posture values (from `ToolPosture` in `spec.py`):
- `"none"` — No tool access
- `"read_only"` — Read-only tool operations
- `"read_write"` — Read and write tool operations
- `"destructive"` — Tools that may cause irreversible side effects

### Key Rules
- `capabilities` is `family -> posture` (canonical field)
- `tools` is deprecated; use `capabilities` instead
- `side_effect_policy` is deprecated per ADR-002
- runtime controls are not PersonaSpec fields
- gateway profile semantics are not PersonaSpec fields

## MCP Surface

Primary MCP tools:
- `larva.validate(spec)`
- `larva.assemble(components)`
- `larva.resolve(id)`
- `larva.register(spec)`
- `larva.list()`

## CLI Surface

Representative CLI operations:
- validate a PersonaSpec
- assemble a PersonaSpec from components
- register a canonical persona
- resolve or list canonical personas

CLI is an operator interface over the same canonical contract. It does not add
new persona semantics.

### Web Runtime Surface

The web surface has two runnable entrypoints with one authoritative packaged
contract:

- `larva serve` -> packaged runtime and authoritative web contract
- `python contrib/web/server.py` -> contributor-facing direct script runtime

#### Startup contract

`larva serve`:

- binds `127.0.0.1` via uvicorn
- defaults to port `7400`
- accepts `--port <int>` and `--no-open`
- serves `src/larva/shell/web_ui.html` at `/`

`python contrib/web/server.py`:

- requires `fastapi` and `uvicorn` in the active environment
- defaults to port `7400`
- accepts `--port <int>` and `--no-open`
- serves `contrib/web/index.html` at `/`

#### Normative endpoint inventory

These endpoints are the authoritative REST contract for the packaged web
surface:

| Method | Path | Contract |
|-------|------|----------|
| `GET` | `/` | Return the packaged HTML UI artifact |
| `GET` | `/api/personas` | Return `{data: PersonaSummary[]}` |
| `GET` | `/api/personas/{persona_id}` | Return `{data: PersonaSpec}` or a 400 error payload |
| `POST` | `/api/personas` | Accept a PersonaSpec or `{spec: PersonaSpec}`; validate then register |
| `PATCH` | `/api/personas/{persona_id}` | Accept patch object; ignore protected `spec_version` and `spec_digest`; revalidate before register |
| `DELETE` | `/api/personas/{persona_id}` | Return `{data: {id, deleted}}` |
| `POST` | `/api/personas/clear` | Accept `{confirm}` and clear only on valid confirmation |
| `POST` | `/api/personas/validate` | Accept PersonaSpec candidate and return validation report |
| `POST` | `/api/personas/assemble` | Accept assembly request body and return assembled PersonaSpec |
| `GET` | `/api/components` | Return available prompt/toolset/constraint/model names |
| `GET` | `/api/components/{component_type}/{name}` | Return one component or a typed HTTP error |

Shared response envelope rules:

- success responses return `{"data": ...}`
- `LarvaApiError` maps to HTTP 400 with `{"error": ...}`
- component type validation may also raise typed HTTP errors from FastAPI

#### Convenience-only UI behavior

These behaviors are visible in the browser UI but are not separate normative API
guarantees:

- prompt copy button writes the current prompt with the browser clipboard API
- success icon feedback after copy is local UI state only
- browser auto-open on startup is operator convenience only

#### Contrib-only convenience surface

The direct script runtime exposes one extra convenience endpoint that is not part
of the authoritative packaged contract:

| Method | Path | Status |
|-------|------|--------|
| `POST` | `/api/personas/batch-update` | contrib-only convenience surface |

Downstream test scope should treat `/api/personas/batch-update` and its related
UI workflow as separate contrib coverage rather than normative `larva serve`
contract coverage.

## Assembly Contract

Assembly may combine:
- prompt fragments
- capability bundles
- constraint bundles
- model bundles

Assembly output is always a canonical PersonaSpec candidate that must still
satisfy PersonaSpec validation rules.

## Deprecation Warnings

Validation produces structured deprecation warnings (in `ValidationReport.warnings`):

| Condition | Warning Message |
|-----------|-----------------|
| `side_effect_policy` present | `DEPRECATED_FIELD: side_effect_policy is deprecated per ADR-002` |
| `tools` without `capabilities` | `DEPRECATED_FIELD: tools is deprecated; use capabilities instead` |
| Both `tools` and `capabilities` | `DEPRECATED_FIELD: tools is deprecated; use capabilities instead`<br>`MIGRATION_NOTE: both tools and capabilities present; capabilities takes precedence` |

## Precedence Rules (ADR-002)

When normalizing specs with `tools` and `capabilities`:

1. **tools-only input**: Copy `tools` to `capabilities`; mirror `capabilities` back to `tools`
2. **capabilities-only input**: Mirror `capabilities` to `tools` during transition
3. **Both fields present**: `capabilities` wins; `tools` mirrors `capabilities`

Example:
```python
# Input with both fields
{"tools": {"fs": "read_only"}, "capabilities": {"fs": "read_write"}}

# Normalized output (capabilities wins)
{"tools": {"fs": "read_write"}, "capabilities": {"fs": "read_write"}, "spec_version": "0.1.0", "spec_digest": "sha256:..."}
```

## Invariants

- `id` is stable identity
- `persona_ref` is the cross-system reference form
- `capabilities` is the only capability declaration surface (canonical)
- `tools` is deprecated but retained for transition compatibility
- approval and runtime gating stay outside larva
- concrete tool semantics stay outside larva
- `spec_digest` is computed after `tools` -> `capabilities` normalization
- `spec_digest` excludes itself from canonical JSON representation
