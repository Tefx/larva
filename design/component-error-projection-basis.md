# [Design] Component Error Projection Basis

## Re-anchor

Original request: design the shared error-projection seam for component operations, including the canonical component error factory surface, invariant fields across transports, wrapper rules for CLI/Web/MCP/Python API, and drift-free mapping for invalid kind, not found, and store-unavailable cases.

## Decision

- [Proven] **One shared seam:** component operations should project from a single transport-neutral component error factory, not from per-transport ad hoc dict building.
- [Proven] **Owner:** the canonical component error meaning belongs in the app-facing error seam consumed by shells; transports wrap it but do not redefine its code, numeric code, or semantic details.
- [Likely] **Recommended shape:** plain factory functions (or one small helper plus three named factories), not a new exception hierarchy, plugin system, or strategy layer. Anything heavier is `OVER_ENGINEERED` for a three-case taxonomy.

## Evidence of Current Drift

- [Proven] `src/larva/shell/components.py` collapses every `ComponentStoreError` to `code = 105`, so invalid name/path, missing component, and unavailable store all look like not-found.
- [Proven] `src/larva/app/facade.py::_component_error()` always returns `COMPONENT_NOT_FOUND` / `105`.
- [Proven] `src/larva/shell/python_api_components.py` maps invalid type, missing component, and list failures to the same `COMPONENT_NOT_FOUND` / `105` envelope.
- [Proven] `src/larva/shell/mcp_params.py::_component_store_error()` also collapses unsupported type and unavailable store to `COMPONENT_NOT_FOUND` / `105`, and mixes MCP-local `tool` / `reason` fields into shared `details`.
- [Proven] `src/larva/shell/web.py` bypasses the shared envelope entirely and emits raw HTTP 400/404 strings.

## Canonical Error Factory Surface

Recommended shared surface (signatures only, implementation intentionally out of scope):

```python
def component_invalid_kind(*, operation: str, component_type: str, component_name: str | None, valid_types: list[str]) -> LarvaError: ...
def component_not_found(*, operation: str, component_type: str, component_name: str) -> LarvaError: ...
def component_store_unavailable(*, operation: str, component_type: str | None, component_name: str | None, reason: str) -> LarvaError: ...
```

Design rules:

- [Likely] Named factories are preferable to a single catch-all `kind: str` function because the taxonomy is small and fixed.
- [Proven] `numeric_code` lookup must come from the central error-code table (`contracts/errors.yaml` projected through the app error mapping), not handwritten in each shell.
- [Likely] Store-layer exceptions may remain transport-local, but projection into `LarvaError` must happen through this seam only.

## Invariant Envelope Fields

Top-level fields invariant across CLI, Web, MCP, and Python API:

- `code`
- `numeric_code`
- `message`
- `details`

`details` ownership and contents:

- [Proven] `details` is owned by the shared component error factory, not by transports.
- [Likely] Required semantic keys for all component-operation errors:
  - `operation`
  - `reason`
  - `component_type`
  - `component_name`
- [Likely] Conditional semantic keys:
  - `valid_types` only for `invalid_kind`
  - no transport-local keys (`tool`, `http_status`, `exit_code`, exception class name) inside shared `details`

Rationale: if transports are allowed to inject shell-local metadata into shared `details`, the abstraction leaks and parity tests become impossible.

## Drift-Free Case Mapping

### 1. Invalid kind

- [Likely] Canonical code: `INVALID_INPUT`
- [Likely] Canonical numeric code: `1`
- [Likely] Canonical `details.reason`: `invalid_kind`

Required meaning:

- caller asked for a component kind outside the supported set
- this is an input-shape problem, not a lookup miss

### 2. Not found

- [Proven] Canonical code: `COMPONENT_NOT_FOUND`
- [Proven] Canonical numeric code: `105`
- [Likely] Canonical `details.reason`: `not_found`

Required meaning:

- kind is valid
- component store is available enough to perform lookup
- named component does not exist

### 3. Store unavailable

- [Likely] Canonical code: `INTERNAL`
- [Likely] Canonical numeric code: `10`
- [Likely] Canonical `details.reason`: `store_unavailable`

Required meaning:

- component directory missing, unreadable, undecodable, or the store dependency is absent
- failure is infrastructural, not user lookup failure

Rationale:

- [Proven] `contracts/errors.yaml` already defines `INVALID_INPUT`, `INTERNAL`, and `COMPONENT_NOT_FOUND`.
- [Likely] Reusing those existing codes is simpler and safer than inventing a new component-specific unavailable code for this narrow seam.

## Transport Wrapper Mapping

### CLI

- [Proven] CLI owns process exit semantics, not component meaning.
- [Likely] Wrapper rule:
  - `INVALID_INPUT` -> CLI failure envelope with shared error under `error`, exit code `1`
  - `COMPONENT_NOT_FOUND` -> CLI failure envelope with shared error under `error`, exit code `1`
  - `INTERNAL` / store unavailable -> CLI failure envelope with shared error under `error`, exit code `2`
- [Likely] Text mode may prefix human context (`component show failed:`), but JSON mode must emit the shared envelope unchanged under `error`.

### Web

- [Likely] Web owns HTTP status, not component meaning.
- [Likely] Wrapper rule:
  - `INVALID_INPUT` -> HTTP 400 with body `{ "error": <shared envelope> }`
  - `COMPONENT_NOT_FOUND` -> HTTP 404 with body `{ "error": <shared envelope> }`
  - `INTERNAL` / store unavailable -> HTTP 503 if treated as dependency outage, otherwise HTTP 500; choose one once and keep it uniform. Preferred here: **503** because the component store is a required backing dependency for this route.
- [Likely] Raw `detail="..."` strings should not be used for component routes once this seam exists.

### MCP

- [Proven] MCP already returns structured envelopes.
- [Likely] Wrapper rule:
  - return the shared envelope directly as the tool error result
  - do not inject MCP-only `tool` metadata into shared `details`
  - malformed MCP params remain a separate MCP-boundary concern and continue to use the existing malformed-params error path

### Python API

- [Proven] Python API owns exception wrapping, not component meaning.
- [Likely] Wrapper rule:
  - raise `LarvaApiError(shared_envelope)`
  - do not rewrite `code`, `numeric_code`, `message`, or `details`

## Numeric Code Ownership

- [Proven] Numeric code ownership belongs to `contracts/errors.yaml` and its central app-level projection table, not to transport modules.
- [Proven] Transport modules may select exit code / HTTP status / exception type, but they may not choose or rewrite `numeric_code`.
- [Likely] Any component error factory should accept a semantic case and derive `numeric_code` from the shared code mapping once.

## Details Ownership

- [Proven] Semantic `details` ownership belongs to the shared component error seam.
- [Likely] Transports may add wrapper metadata only outside the shared error envelope:
  - CLI: sibling `exit_code`
  - Web: HTTP status
  - Python API: exception wrapper type
  - MCP: tool-call channel itself
- [Proven] This prevents drift where one transport adds `tool`, another adds `path`, and a third omits reason entirely.

## Dependency Direction

Allowed:

```text
component store exceptions
        -> shared component error factory
        -> app/shell shared LarvaError envelope
        -> CLI / Web / MCP / Python API wrappers
```

Not allowed:

```text
CLI / Web / MCP / Python API
        -> define their own component semantic codes/details
```

## Trade-offs

- Gain: one semantic mapping, easier parity testing, less transport drift.
- Gain: invalid-kind vs not-found vs unavailable becomes observable to callers.
- Give up: some existing tests that currently pin `COMPONENT_NOT_FOUND/105` for invalid kind or unavailable store will need to be updated.
- Give up: web can no longer stay on ad hoc `HTTPException(detail=...)` strings for component routes.

## Open Questions

- [Likely] Whether web should map store-unavailable to HTTP 503 or HTTP 500. This does **not** affect shared code/numeric_code ownership; only transport wrapper policy remains to pin. Preferred: 503.

## Certainty

Overall certainty: [Proven] on drift evidence and ownership boundaries; [Likely] on the exact reuse of `INVALID_INPUT` and `INTERNAL` for invalid-kind and store-unavailable projections.
