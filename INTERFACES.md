# larva -- Interface Specification

## Purpose

`larva` validates, assembles, normalizes, and registers canonical PersonaSpec
artifacts.

It is a downstream admission and projection handler, not the contract owner.
The canonical PersonaSpec schema authority is `opifex`. `larva` implements
validation, normalization, and registry projection as a consumer of the opifex
canonical contract.

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
| `description` | string | Required. Human-readable description of the persona |
| `prompt` | string | Required. System prompt defining persona behavior |
| `model` | string | Required. Model identifier (e.g., "claude-sonnet-4") |
| `capabilities` | dict[str, ToolPosture] | Required. **Canonical** capability declaration: tool family -> posture |
| `tools` | dict[str, ToolPosture] | **Rejected** at admission boundary — never accepted as canonical input |
| `model_params` | dict | Additional model parameters (temperature, top_p, etc.) |
| `side_effect_policy` | string | **Rejected** at admission boundary — not a PersonaSpec field |
| `can_spawn` | bool \| list[str] | Whether persona can spawn sub-agents, or list of allowed persona IDs |
| `compaction_prompt` | string | Prompt used for state compaction |
| `spec_version` | string | Required. Spec format version (must be "0.1.0") |
| `spec_digest` | string | SHA-256 digest of canonical JSON representation |

### ToolPosture Values

Valid capability posture values (from `ToolPosture` in `spec.py`):
- `"none"` — No tool access
- `"read_only"` — Read-only tool operations
- `"read_write"` — Read and write tool operations
- `"destructive"` — Tools that may cause irreversible side effects

### Key Rules
- `capabilities` is `family -> posture` (canonical field, defined by opifex)
- `tools` is rejected at admission boundary — not part of canonical PersonaSpec
- `side_effect_policy` is rejected at admission boundary — belongs to runtime controls
- runtime controls are not PersonaSpec fields
- gateway profile semantics are not PersonaSpec fields
- larva validates against the opifex canonical schema; it does not define the schema

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

- `larva serve` -> authoritative packaged runtime and web contract
- `python contrib/web/server.py` -> supported contributor convenience runtime for local review; not the canonical packaged entrypoint
- preserved runnable liveness proof for both entrypoints is kept with the test-suite artifacts in `tests/shell/artifacts/web_runtime_liveness.md`

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

Component-kind rule for public surfaces:

- [Proven] Canonical `component_type` vocabulary is `prompts | toolsets | constraints | models`.
- [Likely] Compatibility aliases `prompt | toolset | constraint | model` may be accepted at ingress during transition, but must normalize immediately to the canonical plural vocabulary.
- [Likely] Public docs and valid-type enumerations should advertise only canonical plural values.

Shared response envelope rules:

- success responses return `{"data": ...}`
- `LarvaApiError` maps to HTTP 400 with `{"error": ...}`
- component type validation may also raise typed HTTP errors from FastAPI

#### Convenience-only UI behavior

These behaviors are visible in the browser UI and covered only at convenience-UI
fidelity, not as separate normative API guarantees:

- prompt copy affordance is present in the served HTML and uses the browser clipboard API
- success icon feedback after copy is local UI state only
- browser auto-open on startup is operator convenience only

#### Contrib-only convenience surface

The supported direct script runtime exposes one extra convenience endpoint that
is not part of the authoritative packaged contract:

| Method | Path | Status |
|-------|------|--------|
| `POST` | `/api/personas/batch-update` | contrib-only convenience surface |

Downstream test scope should treat `/api/personas/batch-update` and its related
UI hooks as separate contrib coverage rather than normative `larva serve`
contract coverage.

## Assembly Contract

Assembly may combine:
- prompt fragments
- capability bundles
- constraint bundles
- model bundles

Assembly output is always a canonical PersonaSpec candidate that must still
satisfy PersonaSpec validation rules.

## Canonical Admission Rules

Validation enforces strict canonical admission semantics against the opifex
PersonaSpec contract:

- Required fields: `id`, `description`, `prompt`, `model`, `capabilities`, `spec_version`
- Optional fields: `can_spawn`, `model_params`, `compaction_prompt`, `spec_digest`, `variables`
- Rejected fields: `tools`, `side_effect_policy` — these are not canonical PersonaSpec fields
- Unknown top-level fields are rejected

Note: larva implements validation as a downstream consumer. The canonical schema
authority is opifex.

## Invariants

- `id` is stable identity
- `persona_ref` is the cross-system reference form
- `capabilities` is the only capability declaration surface (canonical, per opifex)
- `tools` is rejected — not a canonical PersonaSpec field
- approval and runtime gating stay outside larva
- concrete tool semantics stay outside larva
- `spec_digest` is computed from canonical JSON representation
- `spec_digest` excludes itself from canonical JSON representation
- larva is a downstream admission/projection layer; opifex owns the canonical contract
