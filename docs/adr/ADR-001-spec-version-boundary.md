# ADR-001: Pin PersonaSpec schema version to the larva v1 contract

## Status
Accepted

## Context
`larva` needs one unambiguous meaning for `spec_version`.

The current codebase already treats `spec_version` as a schema envelope rather than
persona release metadata:
- the canonical schema constrains `spec_version` to `"0.1.0"`
- validation rejects any other version
- normalization defaults the field to `"0.1.0"` when absent
- patch/update flows treat `spec_version` as protected and reject caller attempts to modify it

At the same time, a small set of clone tests had started assuming a different model:
that clone should transparently preserve arbitrary source versions such as `"0.2.0"`.
That assumption conflicts with the rest of the contract because clone validates the
cloned spec before saving it.

## Decision Drivers
- Keep PersonaSpec validation deterministic and simple in v1
- Preserve a single authoritative schema contract across validate/normalize/update/clone
- Avoid accidentally introducing multi-version compatibility through tests alone
- Keep persona content identity separate from schema compatibility identity

## Options Considered

### Option A: Single pinned schema version in v1
- **Mechanism**: `spec_version` remains the schema envelope for the canonical PersonaSpec contract and is pinned to `"0.1.0"` in v1.
- **Pros**: Matches existing schema, type definitions, validation, normalization, and patch protection; keeps consumer behavior simple.
- **Cons**: No transparent coexistence of multiple schema versions in the registry.
- **Fails if**: larva must simultaneously accept and round-trip multiple schema versions without an explicit version-dispatch and migration design.

### Option B: Treat `spec_version` as a pass-through spec field
- **Mechanism**: clone/registry/export flows preserve arbitrary incoming versions, and validation becomes version-aware or permissive.
- **Pros**: Creates room for future multi-version compatibility.
- **Cons**: Requires new architecture for version dispatch, migrations, type changes, and cross-version runtime rules; conflicts with current v1 contract.
- **Fails if**: the system continues to rely on a single canonical validator and `Literal["0.1.0"]` type boundary.

## Decision
Choose Option A.

`spec_version` means schema compatibility for the canonical PersonaSpec contract, not
persona release history. In larva v1, that schema version is fixed at `"0.1.0"`.

As a result:
- larva does not auto-bump `spec_version`
- clone does not introduce multi-version pass-through semantics
- update and patch flows must keep treating `spec_version` as protected and fail closed on attempted mutation
- persona content changes are tracked by `spec_digest`, not by `spec_version`

If larva later needs persona-level revisioning, it should use a separate field or
registry metadata rather than overloading `spec_version`.

## Consequences
- Validation, normalization, update, resolve, and clone all share one schema truth in v1.
- Tests and interface docs must describe clone as preserving source content while keeping the canonical schema version contract intact.
- Multi-version schema support remains a future architecture change, not an accidental emergent behavior.
- A future v2 schema would require an explicit ADR covering version dispatch, migration, and consumer compatibility rules.
