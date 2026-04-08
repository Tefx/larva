# [Design] Component-Kind Alias Policy Basis

## Re-anchor

Original request: define the internal canonical component-kind vocabulary and the compatibility alias policy for public surfaces.

## Decision

- [Proven] **Canonical routing vocabulary:** `prompts | toolsets | constraints | models`.
- [Proven] **Compatibility aliases at public ingress only:** `prompt -> prompts`, `toolset -> toolsets`, `constraint -> constraints`, `model -> models`.
- [Proven] **Normalization rule:** any public-surface `component_type` input must normalize to the canonical plural vocabulary before loader selection, error classification, or downstream dispatch.
- [Likely] **Documentation/output rule:** docs, enumerated valid-types lists, and success payload keys should speak only in canonical plural vocabulary once normalization is in place.

## Why this vocabulary

- [Proven] The filesystem component root already uses plural directory names: `prompts/`, `toolsets/`, `constraints/`, `models/`.
- [Proven] List-style outputs already expose plural inventory keys.
- [Proven] MCP and web component-show surfaces already route with plural keys.
- [Likely] Choosing plural collection keys as the canonical kind avoids a lying abstraction where one layer talks about collection families in plural while another invents a separate singular public enum for the same routing decision.

Vibe check: introducing a separate registry object, enum translation service, or strategy hierarchy here would be `OVER_ENGINEERED`. This is a four-value vocabulary problem, so a single normalization seam is the right weight.

## Boundary Rule

- [Proven] **Component kind** means the externally supplied family selector used for routing to the correct component loader.
- [Likely] Loader method names may remain singular (`load_prompt`, `load_toolset`, etc.) because they operate on one member of a canonical plural family. Those method names do not redefine the public component-kind vocabulary.

## Compatibility Alias Policy

### Accepted aliases

| Canonical kind | Accepted compatibility alias | Acceptance scope |
|---|---|---|
| `prompts` | `prompt` | public request/command parameter only |
| `toolsets` | `toolset` | public request/command parameter only |
| `constraints` | `constraint` | public request/command parameter only |
| `models` | `model` | public request/command parameter only |

### Acceptance boundaries

- [Proven] Alias acceptance belongs only at transport or shell ingress where a caller supplies a component kind string.
- [Likely] Internal modules should receive only canonical plural kinds after normalization.
- [Likely] Stored payloads, docs, list responses, and typed `valid_types` metadata should emit canonical plural kinds only.
- [Likely] Invalid-kind failures should report canonical valid values even if the caller used a legacy singular alias family elsewhere.

## Cleanup Strategy

1. [Likely] First remediation release: accept both singular and plural at public ingress, but normalize immediately and document plural as canonical.
2. [Likely] During transition: update docs/examples/tests so new material uses only plural kinds; treat singular forms as compatibility-only.
3. [Likely] After downstream callers and tests no longer rely on singular input forms, remove singular alias acceptance from ingress validation.
4. [Likely] Final state: only `prompts | toolsets | constraints | models` remain accepted anywhere a public component kind is enumerated.

## Failure Conditions

- [Likely] This basis is wrong if a required public surface must preserve singular values as part of a published wire contract that cannot change.
- [Likely] This basis is wrong if `component_type` is later split into two distinct concepts (for example, collection family vs entity label) and both must remain caller-visible.

## Trade-offs

- Gain: one routing vocabulary across filesystem layout, inventory keys, MCP, and web.
- Gain: compatibility preserved for singular callers during migration.
- Give up: short-term dual acceptance at ingress adds a small amount of boundary logic.
- Give up: error/details payloads that currently expose singular loader labels may need tightening to avoid mixed terminology.

## Open Questions

- [Speculative] Whether Python API helper `type` should be renamed to `component_type` while the alias transition happens. This is naming cleanup, not a blocker for the vocabulary decision.

## Certainty

Overall certainty: [Proven] for canonical plural vocabulary choice; [Likely] for staged alias retirement sequencing.
