# [Design] Single-Source Contract Metadata Seam

## Re-anchor

Original request: design the single-source metadata seam that all local projections must consume for PersonaSpec field partitions, validation report shapes, reusable canonical error phrases, and the schema-snapshot/MCP-contract relationship.

## Decision

- [Proven] **Metadata owner:** `src/larva/core/validate.py` is the local single-source metadata seam for canonical admission metadata.
- [Proven] **Owned by that seam:**
  - required / optional / forbidden top-level field partitions
  - `ValidationIssue` and `ValidationReport` structural shapes
  - canonical validation phrase stems used to describe those failures in transport projections
- [Proven] **Derived projections:**
  - `contracts/persona_spec.schema.json` is a reference snapshot derived from the validator seam for field closure and requiredness.
  - `src/larva/shell/mcp_contract.py` is a transport projection derived from the validator seam for report shape and user-facing contract text.
  - facade- and shell-level error envelopes may wrap validator issues, but must not redefine field partitions or invent alternate canonical wording.

## Ownership Matrix

| Concern | Owner | Allowed consumers | Not allowed to own |
|---|---|---|---|
| Required field set | `larva.core.validate` | schema snapshot, facade docs, MCP contract text, tests | schema snapshot, MCP text, transport handlers |
| Optional field set | `larva.core.validate` | schema snapshot, assembly docs, transport docs | shell projections |
| Forbidden field set | `larva.core.validate` | schema snapshot, normalize/assemble guards, transport docs | shell projections |
| `ValidationIssue` shape | `larva.core.validate` | facade, MCP, CLI/web/python adapters, tests | transport-specific copies with divergent keys |
| `ValidationReport` shape | `larva.core.validate` | facade, MCP, CLI/web/python adapters, tests | transport-specific copies with divergent keys |
| Canonical validation phrase stems | `larva.core.validate` | facade wrappers, CLI/web/MCP error rendering | shell-specific rewritten canonical reasons |
| Numeric top-level app error codes | `larva.app.facade` / `contracts/errors.yaml` | CLI/MCP/web envelopes | validator seam |

## Field-Partition Rule

- [Proven] The validator seam is the only local place allowed to declare the canonical top-level field partition.
- [Proven] Current partition:
  - required: `id`, `description`, `prompt`, `model`, `capabilities`, `spec_version`
  - optional: `can_spawn`, `model_params`, `compaction_prompt`, `spec_digest`
  - forbidden: `tools`, `side_effect_policy`
- [Likely] If upstream opifex contract changes, the update order must be:
  1. validator seam
  2. schema snapshot
  3. MCP contract text and other transport projections
  4. surface tests and docs

Rationale: the validator is the only local artifact that can actually decide admission. Letting schema prose or MCP copy own these sets would create lying abstractions where docs claim one contract and runtime enforces another.

## Validation Shape Rule

- [Proven] `ValidationIssue` remains the canonical fine-grained issue shape: `{code, message, details}`.
- [Proven] `ValidationReport` remains the canonical admission verdict shape: `{valid, errors, warnings}`.
- [Likely] Local projections may rename enclosing transport envelopes (`error`, `data`, HTTP status, MCP tool result) but must embed these shapes without structural drift.

Rationale: one issue/report shape keeps CLI, web, Python API, and MCP from each inventing slightly different validation payloads.

## Canonical Error Phrase Rule

- [Likely] Reusable canonical error phrases should be owned as validator message stems, not as transport copy.
- [Likely] Transport projections must reuse validator-authored phrases for canonical admission failures, optionally prefixing context but not changing the semantic reason.

Pinned phrase families:

| Condition | Canonical phrase stem owner | Projection rule |
|---|---|---|
| Missing required field | validator issue message | may wrap, must preserve missing-field reason |
| Forbidden field present | validator issue message | may wrap, must preserve reject-on-presence reason |
| Unknown top-level field | validator issue message | may wrap, must preserve extra-field rejection reason |
| Invalid `id` | validator issue message | may wrap, must preserve kebab-case rule |
| Invalid `spec_version` | validator issue message | may wrap, must preserve exact version requirement |

This is intentionally lighter than a separate phrase registry. A new phrase registry would be `OVER_ENGINEERED` because the problem is metadata consistency, not localization or multi-channel copy authoring.

## Schema Snapshot / MCP Projection Relationship

- [Proven] `contracts/persona_spec.schema.json` is a **snapshot projection**: useful for reference, tooling, and parity checks, but not an independent contract owner.
- [Proven] `src/larva/shell/mcp_contract.py` is a **transport projection**: useful for MCP tool registration and typed transport shapes, but not an independent contract owner.
- [Proven] Relationship rule: both consume the validator seam; neither may derive semantics from the other.

Allowed dependency direction:

```text
larva.core.validate  -->  contracts/persona_spec.schema.json
larva.core.validate  -->  larva.shell.mcp_contract

NOT ALLOWED:
contracts/persona_spec.schema.json --> larva.shell.mcp_contract
larva.shell.mcp_contract --> contracts/persona_spec.schema.json
contracts/persona_spec.schema.json --> larva.core.validate
larva.shell.mcp_contract --> larva.core.validate semantics ownership
```

Rationale: schema snapshot and MCP text have different audiences, but the same source semantics. Peer ownership between them would guarantee drift.

## Parity Requirements

- [Proven] Admission success must imply conformance to the validator seam.
- [Likely] Schema snapshot parity checks should compare requiredness, forbidden-field closure, and allowed optional fields against validator constants.
- [Likely] MCP contract parity checks should compare:
  - validation report key set
  - validation issue key set
  - tool descriptions for canonical field/forbidden-field wording

## Drift Prevention Strategy

1. [Likely] Treat validator constants/types/messages as the first edit site for contract metadata changes.
2. [Likely] Keep schema and MCP text explicitly labeled as derived projections.
3. [Likely] Add or maintain parity tests that fail when required/optional/forbidden sets diverge across validator, schema snapshot, and MCP contract text.
4. [Likely] Do not create a new shared "metadata service" or runtime registry; static source ownership is sufficient here.

## Trade-offs

- Gain: one local authority for contract metadata, simpler drift detection.
- Gain: MCP/schema/docs stay projections instead of competing authorities.
- Give up: some duplication still exists in projections, but it is controlled duplication.
- Give up: schema-only contributors cannot change contract semantics without touching validator authority first.

## Open Questions

- [Speculative] Whether canonical phrase stems should stay as inline validator messages or move to named validator-level constants. This is implementation detail, not a blocker for ownership.

## Certainty

Overall certainty: [Proven] for ownership and dependency direction; [Likely] for parity-test and phrase-governance recommendations.
