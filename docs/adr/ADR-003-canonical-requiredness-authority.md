# ADR-003: Canonical Requiredness Authority for PersonaSpec Admission

## Status

Accepted (2026-04-06); authority updated 2026-09-22 by user decision.
Larva is independent and Opifex is abandoned. No upstream schema checkout,
conformance packet or approval is required. Existing PersonaSpec meaning is unchanged.

## Context

`larva` had contradictory requiredness semantics across consumer-facing artifacts:

- canonical admission code requires `id`, `description`, `prompt`, `model`,
  `capabilities`, and `spec_version`, and rejects `tools` / `side_effect_policy`
  at admission (`src/larva/core/validate.py`)
- reference schema encodes the same required set and rejects extra top-level fields
  (`contracts/persona_spec.schema.json`)
- the interface document still described transition-era behavior where `tools`
  was accepted and requiredness was under-specified (`../reference/INTERFACES.md`)

This mismatch created ambiguity about which surface is authoritative for
requiredness and admission behavior.

This ADR records Larva-local requiredness. The former upstream adjudication
at `../../design/opifex-canonical-authority-basis.md` is retained as retired history.

## Decision

Canonical requiredness authority for admission is:

1. `src/larva/core/validation_contract.py` (metadata exposed through `validate.py`)
   and `src/larva/core/validate.py` (runtime admission enforcement)
2. `contracts/persona_spec.schema.json` (reference mirror, must match authority)

`../reference/INTERFACES.md` and MCP metadata are consumer documentation surfaces and must be
synchronized to that authority. They must not reintroduce transition-era
acceptance semantics.

Required fields at canonical admission are exactly:

- `id`
- `description`
- `prompt`
- `model`
- `capabilities`
- `spec_version`

Forbidden at canonical admission:

- `tools`
- `side_effect_policy`
- unknown top-level fields

## Consequences

- Consumer-facing docs and MCP tool descriptions must state canonical admission
  behavior (no `tools` fallback at admission).
- Transition compatibility, if needed, belongs to upstream assembly inputs and
  explicit migration flows, not canonical admission requiredness.
- Future authorized changes to admission requiredness must update local authority
  files and their projections together. `tests/core/test_schema_validation.py`
  compares schema fields with validator metadata and TypedDict required/optional
  keys, exercises malformed values against both schema and validator, and
  detects deliberate required/optional/forbidden/open-admission drift.
