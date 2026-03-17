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
  "spec_version": "0.1.0"
}
```

Key rules:
- `capabilities` is `family -> posture`
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

## Assembly Contract

Assembly may combine:
- prompt fragments
- capability bundles
- constraint bundles
- model bundles

Assembly output is always a canonical PersonaSpec candidate that must still
satisfy PersonaSpec validation rules.

## Invariants

- `id` is stable identity
- `persona_ref` is the cross-system reference form
- `capabilities` is the only capability declaration surface
- approval and runtime gating stay outside larva
- concrete tool semantics stay outside larva
