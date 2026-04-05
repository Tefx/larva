# [Adjudication] Opifex Canonical Authority Basis

## Status

Accepted authority basis for downstream remediation planning.

## Decision

- [Proven] **Contract owner:** opifex canonical PersonaSpec prose/schema is the single contract authority.
- [Proven] **Larva role:** larva is a downstream consumer of that contract, the runtime admission authority for its own surfaces, and the projection handler that exposes the same contract through CLI, MCP, Python API, web, registry, and opencode-facing exports.
- [Proven] **Source-of-truth collapse rule:** larva local docs, TypedDicts, validators, and projections are derived artifacts. They are not independent authority and must collapse to upstream opifex contract ownership when drift exists.
- [Proven] **Admission rule:** success on any larva production admission path must imply conformance to the opifex-canonical PersonaSpec contract, not merely conformance to a local larva approximation.

## Contract Owner Decision

### Owner / consumer split

| Concern | Owner | Larva role |
|---|---|---|
| PersonaSpec field set and semantics | opifex canonical prose/schema | consume, enforce, project |
| Runtime admission verdict on larva surfaces | larva | apply upstream contract at ingress |
| Projection into opencode agent/runtime shapes | larva contrib/plugin layer | derived projection only |
| Local Python typing (`larva.core.spec`) | larva | convenience typing, not authority |
| Local docs (`README`, `INTERFACES`, `ARCHITECTURE`, `USAGE`) | larva | explanatory mirrors, must not drift |

### Required contract pins

For downstream remediation planning, treat the canonical PersonaSpec input contract as:

- **Required fields:** `id`, `prompt`, `model`, `capabilities`, `can_spawn`
- **Optional fields:** `description`, `model_params`, `compaction_prompt`
- **Derived/managed fields:** `spec_version`, `spec_digest`
- **Removed fields:** `tools`, `side_effect_policy`
- **Extra-field rule:** reject unknown top-level fields during admission rather than silently accepting or preserving them

Rationale:

- [Proven] Current larva materials already distinguish canonical fields from runtime policy and derived digest/version fields (`ADR-002`, `USAGE.md`, `INTERFACES.md`).
- [Likely] The only stable way to stop schema drift is to make requiredness and field closure come from the upstream contract owner, not from a permissive local `TypedDict(total=False)` or ad hoc transport behavior.

## Runtime Contract

### Real larva admission path

Primary runtime path for programmatic and shell admission:

1. **shell surfaces** accept external input
   - CLI entrypoint: `src/larva/cli_entrypoint.py`
   - Python API: `src/larva/shell/python_api.py`
   - Web REST: `src/larva/shell/web.py`
   - MCP stdio/server: `src/larva/shell/mcp.py` + `src/larva/shell/mcp_server.py`
2. shell surfaces construct or obtain a **`DefaultLarvaFacade`**
3. facade admission calls **`DefaultLarvaFacade.validate()`**
4. that delegates to **`larva.core.validate.validate_spec()`**
5. only then may larva normalize, register, resolve, or project the PersonaSpec

Pinned admission invariant:

> If any larva surface accepts a PersonaSpec as valid, that success must mean the spec conforms to the canonical opifex contract, including required fields, removed-field policy, and extra-field rejection.

This is the key authority lock. Downstream work must not preserve any alternate path where local larva validation succeeds while opifex-canonical validation would fail.

## Source-of-Truth Matrix

```yaml
system_layers:
  - layer: upstream_contract
    owner: opifex
    responsibility: canonical PersonaSpec prose/schema and error taxonomy
  - layer: larva_admission
    owner: larva
    responsibility: apply upstream contract at all larva ingress surfaces
  - layer: larva_projection
    owner: larva
    responsibility: expose/adapt canonical PersonaSpec through CLI/MCP/Python/web/registry/plugin outputs
  - layer: downstream_consumers
    owner: consumer-specific
    responsibility: use admitted canonical specs without redefining contract ownership

source_of_truth_matrix:
  persona_contract:
    owner: opifex upstream prose/schema
    larva_status: derived mirror only
    collapse_rule: upstream wins on any conflict
  admission_logic:
    owner: larva
    authority_limit: must enforce upstream contract exactly enough that admission success implies canonical conformance
  local_schema_types:
    owner: larva.core.spec
    authority_limit: typing aid only; may not widen or redefine canonical contract
  local_docs:
    owner: larva docs
    authority_limit: explanatory only; must be updated to match upstream and admission behavior
  projections:
    owner: larva shells/plugins
    authority_limit: no projection may reintroduce removed fields or alternate semantics
```

## Transport Boundary Rules

- [Proven] All shell surfaces are adapters only; they do not own PersonaSpec semantics.
- [Proven] `DefaultLarvaFacade` is the consolidation seam for admission across larva surfaces.
- [Likely] Each transport may reject malformed envelopes early, but none may accept a spec that the canonical admission contract would reject.
- [Proven] MCP already rejects unknown transport parameters at the tool boundary; the PersonaSpec body must apply the same closure principle at the spec boundary.
- [Proven] Web/CLI/Python/projection code must stop emitting or depending on `tools` and `side_effect_policy` as accepted contract fields.

## Error-Taxonomy Alignment Rule

- [Proven] `contracts/errors.yaml` already positions larva errors inside a wider opifex error space.
- [Likely] Larva should match upstream PersonaSpec validation/error taxonomy as completely as practical.
- [Proven] Any deliberate mismatch must be explicit, documented, and justified in the remediation set; silent divergence is not allowed.

Accepted rule:

> If upstream defines an error category, larva should reuse it where practical. If larva cannot match exactly, the delta must be called out with a reason, affected surface, and compatibility impact.

## Evidence

- [Proven] Current repo materials still claim larva itself is canonical authority (`ARCHITECTURE.md`, `INTERFACES.md`, `README.md`), which is precisely the drift this basis collapses.
- [Proven] Actual runtime wiring already converges on `DefaultLarvaFacade.validate()` -> `larva.core.validate.validate_spec()`.
- [Proven] The opencode plugin is a projection layer, not a contract owner; it maps PersonaSpec into opencode agent/runtime constructs.
- [Proven] ADR-002 already established that runtime policy does not belong in PersonaSpec, supporting removal of `side_effect_policy`.

## Explicit Non-Goals

- Designing internal remediation implementation steps
- Choosing validator algorithms or library mechanics
- Redesigning opencode permission mapping internals
- Defining new runtime-policy semantics in larva
- Re-adjudicating ownership in downstream phases

## Remaining Ambiguity Allowed

Only implementation-shaped ambiguity may remain downstream, for example:

- where to vend or reference the upstream canonical schema/prose inside larva
- exact test layout for conformance coverage
- exact migration sequencing for docs, validators, TypedDicts, and projections

The following are **not** allowed to remain ambiguous after this basis:

- who owns the PersonaSpec contract
- whether larva may accept `tools` / `side_effect_policy`
- whether unknown top-level fields must be rejected
- whether larva local schema can diverge from upstream authority
- whether admission success implies canonical conformance
