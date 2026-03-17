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

Capability intent remains family-level. Tool-level authorization and posture
exceptions belong to the gateway layer, not PersonaSpec.

## Invariants

- `capabilities` is the only tool-access declaration surface in PersonaSpec
- runtime approval semantics do not belong in PersonaSpec
- canonical persona authority remains separate from runtime and gateway layers
