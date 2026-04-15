# [Design] Component-Kind Alias Policy Basis

## Re-anchor

Original request: define the internal canonical component-kind vocabulary and the compatibility alias policy for public surfaces.

## Decision

- [Proven] **Canonical routing vocabulary:** `prompts | toolsets | constraints | models`.
- [Proven] **Public ingress:** Only canonical plural values are accepted. Singular aliases are rejected.
- [Proven] **Normalization:** Public-surface `component_type` input must be canonical plural vocabulary before loader selection, error classification, or downstream dispatch.
- [Proven] **Documentation/output rule:** Docs, enumerated valid-types lists, and success payload keys speak only in canonical plural vocabulary.

## Why this vocabulary

- [Proven] The filesystem component root already uses plural directory names: `prompts/`, `toolsets/`, `constraints/`, `models/`.
- [Proven] List-style outputs already expose plural inventory keys.
- [Proven] MCP and web component-show surfaces already route with plural keys.
- [Likely] Choosing plural collection keys as the canonical kind avoids a lying abstraction where one layer talks about collection families in plural while another invents a separate singular public enum for the same routing decision.

Vibe check: introducing a separate registry object, enum translation service, or strategy hierarchy here would be `OVER_ENGINEERED`. This is a four-value vocabulary problem, so a single normalization seam is the right weight.

## Boundary Rule

- [Proven] **Component kind** means the externally supplied family selector used for routing to the correct component loader.
- [Likely] Loader method names may remain singular (`load_prompt`, `load_toolset`, etc.) because they operate on one member of a canonical plural family. Those method names do not redefine the public component-kind vocabulary.

## Canonical Component-Kind Policy

### Accepted values at public ingress

| Canonical kind | Accepted values |
|---|---|
| `prompts` | `prompts` |
| `toolsets` | `toolsets` |
| `constraints` | `constraints` |
| `models` | `models` |

### Acceptance boundaries

- [Proven] Only canonical plural values are accepted at public ingress.
- [Proven] Internal modules receive only canonical plural kinds.
- [Proven] Stored payloads, docs, list responses, and typed `valid_types` metadata emit canonical plural kinds only.
- [Proven] Invalid-kind failures report only canonical plural valid values.

## Final State (Post-Cutover)

Only canonical plural values are accepted at all public surfaces:
- `prompts | toolsets | constraints | models`

Singular aliases (`prompt`, `toolset`, `constraint`, `model`) are rejected at ingress.
Docs, examples, and valid-type enumerations use only the canonical plural vocabulary.

## Failure Conditions

- [Likely] This basis is wrong if a required public surface must preserve singular values as part of a published wire contract that cannot change.
- [Likely] This basis is wrong if `component_type` is later split into two distinct concepts (for example, collection family vs entity label) and both must remain caller-visible.

## Trade-offs

- Gain: one routing vocabulary across filesystem layout, inventory keys, MCP, and web.
- Give up: invalid-kind errors now return only canonical plural values in details.

## Open Questions

- [Speculative] Whether Python API helper `type` should be renamed to `component_type` while the alias transition happens. This is naming cleanup, not a blocker for the vocabulary decision.

## Certainty

Overall certainty: [Proven] for canonical plural vocabulary choice; [Likely] for staged alias retirement sequencing.
