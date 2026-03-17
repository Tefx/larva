# ADR-002: Capability Intent Without Runtime Policy

## Status

Proposed

## Context

larva defines persona artifacts. A persona should describe identity, prompt,
model selection, and required tool capabilities. It should not encode runtime
workflow behavior such as human approval gating.

The previous design placed `side_effect_policy` in persona constraints, which
mixed runtime execution policy into persona declaration.

## Decision

larva personas will declare **capability intent only**.

Target shape:

```yaml
id: developer
capabilities:
  filesystem: read_write
  git: read_only
can_spawn: false
```

Key rules:

1. `capabilities` is the only tool-access declaration surface.
2. Capability keys are tool families, not concrete provider tool names.
3. Runtime concerns such as approval are not persona identity and do not belong
   in larva constraints.
4. Component assembly may still keep prompt/model/can_spawn as independent
   concepts.

## Rationale

- Persona artifacts should be stable declarations of needed capability.
- Approval is situational deployment/runtime policy, not enduring persona truth.
- Removing runtime policy from persona specs reduces cross-repo concept leakage.

## Consequences

Positive:

- larva becomes a cleaner declaration layer
- fewer cross-system translation rules are needed
- persona review becomes simpler: what the persona needs, not how jobs run

Negative:

- existing constraint components using `side_effect_policy` need migration
- some deployments may need a separate runtime control source during assembly

## Non-Goals

- larva does not choose tela profiles
- larva does not classify concrete MCP tools
- larva does not implement runtime approval flows
