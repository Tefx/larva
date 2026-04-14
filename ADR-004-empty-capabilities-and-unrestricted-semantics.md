# ADR-004: Empty Capabilities Means No Declared Capability Postures

## Status

Accepted (2026-04-15)

## Context

`larva` currently requires `capabilities` at canonical admission, but most
registry personas use an empty object:

```json
"capabilities": {}
```

This created ambiguity for operators and downstream UIs: does an empty mapping
mean the persona has no declared capability requirements, or does it mean the
persona is unrestricted and may use every capability family?

The existing code provides no wildcard or unrestricted sentinel in
`ToolPosture`, and ADR-002 already established that runtime policy does not
belong in PersonaSpec.

## Decision Drivers

- Preserve compatibility with existing registry data
- Align documentation with actual validation and normalization behavior
- Avoid overloading PersonaSpec with runtime authorization semantics
- Prevent `{}` from silently implying "all capabilities"

## Options Considered

### Option A: Interpret `{}` as unrestricted capabilities
- **Mechanism**: treat an empty `capabilities` mapping as "all capability families allowed"
- **Pros**: simple to author; matches some operators' intuition
- **Cons**: not encoded anywhere in the type system; contradicts capability-as-declaration intent; turns absence of declarations into maximal permission semantics
- **Fails if**: downstream code assumes capability keys are explicit declarations rather than implicit wildcards

### Option B: Add an unrestricted wildcard inside `capabilities`
- **Mechanism**: invent a sentinel such as `{"*": "destructive"}` or a new posture like `"unrestricted"`
- **Pros**: explicit unrestricted marker
- **Cons**: requires canonical schema/type changes in upstream authority; mixes declaration with broad runtime allowance; introduces open-ended wildcard semantics over non-enumerated capability families
- **Fails if**: other consumers reject the new sentinel or interpret it inconsistently

### Option C: Keep `{}` as "no declared capability postures" and keep unrestricted outside PersonaSpec
- **Mechanism**: document empty `capabilities` as an empty declaration set; if a deployment needs unrestricted execution, represent that in runtime/deployment policy rather than PersonaSpec
- **Pros**: matches current code; preserves ADR-002 boundary; does not widen canonical schema; keeps persona declaration and runtime policy separate
- **Cons**: PersonaSpec still lacks a built-in way to express unrestricted execution intent
- **Fails if**: the product genuinely requires unrestricted capability intent to be a stable persona-level concept rather than a runtime policy

## Decision

Choose **Option C**.

`capabilities: {}` means **no declared capability postures**. It does **not**
mean unrestricted capability access and must not be interpreted as "all
capabilities".

If a deployment needs an unrestricted execution mode, that concern belongs to a
runtime/deployment policy surface outside PersonaSpec unless and until upstream
canonical authority (`opifex`) introduces an explicit unrestricted construct.

## Consequences

- Existing registry personas with `capabilities: {}` remain valid and gain a clear documented meaning
- Downstream UIs should avoid labeling empty capabilities as unrestricted or all-access
- larva should not invent wildcard or unrestricted semantics locally inside PersonaSpec
- Future work, if needed, should target a separate runtime policy layer or an upstream canonical schema change rather than a local larva-only shortcut
