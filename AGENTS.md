# Larva repository instructions

## Local contract authority

Larva is independent. Opifex is abandoned and supplies no current authority,
required checkout, schema, conformance input, or approval prerequisite.
Use `contracts/persona_spec.schema.json`, `src/larva/core/validation_contract.py`,
`src/larva/core/validate.py`, and `src/larva/core/spec.py` as the local contract
and enforcement surfaces. Preserve their existing meaning; report discrepancies
rather than silently broadening admission. See `docs/adr/ADR-003-canonical-requiredness-authority.md`.

All admission paths must reject malformed input, forbidden fields and unknown
top-level fields. Do not add compatibility aliases or accept-and-clean behavior.
Schema, typing, validator, transport and documentation changes need meaningful
consistency checks and malformed-input/drift counterexamples. Historical Opifex
references record retired decisions and never impose an external prerequisite.

## Architecture and verification

- Core (`**/core/**`) is pure: write `@pre`/`@post` contracts and at least one
  doctest before implementing a Core function; no I/O imports.
- Shell (`**/shell/**`) owns filesystem, network, environment, time and process
  effects and returns `Result[T, E]`.
- Run Invar after changes. Use `invar sig`, `invar map`, and `invar refs` for
  structure and references. Contract syntax and exceptions are in `INVAR.md`.
- Pi dependency locks reproduce local builds; they do not restrict installed Pi
  versions. Record versions as context. Do not add version-based runtime
  rejection, compatibility matrices/probes, speculative adaptation, automatic
  upgrades, or global installation/configuration changes. Verify actual native
  behavior in isolated fixtures; preserve package/bin identity checks.

## Managed execution plan

`plan.yaml` belongs exclusively to Vectl. Never edit it with file tools.
Prefer Vectl MCP; CLI fallback is `uv run vectl`, then `vectl`, then `uvx vectl`.
Follow the claimed step's paths, authority, evidence and ownership. Claim at most
one step at a time; completion requires commands, observed results and gaps.
Step IDs must be globally unique. Use `vectl_guide` for planning or recovery.
Completed Plan history and original observations remain immutable.
