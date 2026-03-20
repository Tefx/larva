# larva -- Module Architecture

## Design Boundary

`larva` is the canonical PersonaSpec authority.

Its scope is limited to:
- validating PersonaSpec artifacts
- assembling PersonaSpec from components
- normalizing PersonaSpec into canonical form
- registering and resolving canonical personas

Out of scope:
- runtime policy
- approval workflow
- gateway authorization
- concrete MCP tool semantics
- cross-run mutable memory

## Core Contract

PersonaSpec is capability-first.

```yaml
id: developer
capabilities:
  filesystem: read_write
  git: read_only
can_spawn: false
```

`larva` owns:
- persona identity
- prompt/model/default execution identity
- capability intent

It does not own runtime controls or gateway profile binding.

## Layer Model

### `core/`

Pure domain logic:
- spec types
- validation
- assembly rules
- normalization

### `app/`

Use-case orchestration around canonical persona operations.

### `shell/`

I/O edges:
- component loading
- registry access
- CLI
- MCP
- Python API surface
- packaged web runtime in `src/larva/shell/web.py`
- contributor web runtime in `contrib/web/server.py`

## Web Runtime Boundary

- [Proven] `src/larva/shell/web.py` is the authoritative packaged web boundary
  for `larva serve` and owns the normative REST endpoint inventory for browser
  consumers.
- [Proven] `contrib/web/server.py` is a repository-local direct script runtime
  that mirrors the packaged surface for review work and may expose contributor
  conveniences that are not part of the packaged contract.
- [Proven] Both runtimes serve single-file HTML artifacts as shell-owned UI
  adapters; browser interactions such as copy-to-clipboard remain convenience
  behavior layered above the REST contract.
- [Likely] Downstream tests should split normative packaged-web coverage from
  contrib-only convenience coverage so batch-update review helpers do not become
  accidental public API commitments.

## Package-Root Policy

- [Proven] `src/larva/__init__.py` is metadata-only and currently exports only
  `__version__`.
- [Proven] The authoritative Python API surface lives under
  `src/larva/shell/python_api.py`, which matches README and user-guide import
  examples.
- [Likely] Package-root re-exports should remain disallowed for canonical API
  operations because they would create an unguarded public surface outside the
  configured `core/` and `shell/` review zones.
- [Proven] Legacy compatibility modules may exist at package root only when
  they preserve an already-published import or execution surface without
  becoming the canonical documentation target.
- [Likely] If package-root exports grow beyond metadata or compatibility shims,
  guard policy and docs must be updated in the same change so the new public
  surface is explicitly reviewed rather than silently bypassing guard scope.

## Dependency Rules

- `core/*` may not depend on shell or transport
- `app/*` orchestrates core logic
- `shell/*` adapts transports and storage, not domain semantics

## Component Model

Assembly inputs may include:
- prompt fragments
- capability bundles
- constraint bundles for fields such as `can_spawn` and `compaction_prompt`
- model bundles

## Component Root Boundary

- [Proven] `src/larva/shell/components.py` owns the default component root at
  `~/.larva/components/` and is the shell boundary for filesystem path
  resolution, file reads, and YAML parsing.
- [Proven] CLI, MCP, and Python assembly flows consume components through shell
  adapter operations rather than treating user-home files as core state.
- [Likely] The correct boundary is: filesystem layout belongs to shell,
  assembled `PersonaSpec` acceptance belongs to app/core, and user-home YAML is
  local input that must be treated as untrusted until normalization and
  validation succeed.
- [Proven] Current tests already exercise traversal rejection and typed missing
  component failures, which is enough to document the trust boundary without a
  new implementation phase in this step.

Capability intent remains family-level. Tool-level authorization and posture
exceptions belong to the gateway layer, not PersonaSpec.

## Invariants

- `capabilities` is the only tool-access declaration surface in PersonaSpec
- runtime approval semantics do not belong in PersonaSpec
- canonical persona authority remains separate from runtime and gateway layers
