# larva -- Module Architecture

## Design Boundary

`larva` is a downstream admission and projection handler for PersonaSpec.

The **canonical PersonaSpec contract authority is `opifex`**. `larva` validates,
assembles, normalizes, and registers PersonaSpec artifacts as a downstream
consumer, not the contract owner.

Its scope is limited to:
- validating PersonaSpec artifacts
- assembling PersonaSpec from components
- normalizing PersonaSpec into canonical form
- registering and resolving canonical personas

Out of scope:
- runtime policy
- approval workflow
- gateway authorization
- concrete MCP tool semantics
- cross-run mutable memory

## Core Contract

PersonaSpec is capability-first.

```yaml
id: developer
capabilities:
  filesystem: read_write
  git: read_only
can_spawn: false
```

`larva` handles:
- validating PersonaSpec against the canonical opifex contract
- assembling PersonaSpec from components
- normalizing PersonaSpec into canonical form
- registering and resolving canonical personas in its local projection

It does not own:
- the canonical PersonaSpec schema (owned by opifex)
- runtime controls or gateway profile binding

## Layer Model

### `core/`

Pure domain logic:
- spec types
- validation
- assembly rules
- normalization

### `app/`

Use-case orchestration around canonical persona operations.

### `shell/`

I/O edges:
- component loading
- registry access
- CLI
- MCP
- Python API surface
- packaged web runtime in `src/larva/shell/web.py`
- contributor web runtime in `contrib/web/server.py`

## Web Runtime Boundary

- [Proven] `src/larva/shell/web.py` is the authoritative packaged web boundary
  for `larva serve` and owns the normative REST endpoint inventory for browser
  consumers.
- [Proven] `contrib/web/server.py` is a supported contributor convenience
  runtime for local review work. It mirrors the packaged surface where useful
  but may expose contributor conveniences that are not part of the packaged
  contract.
- [Proven] Both runtimes serve single-file HTML artifacts as shell-owned UI
  adapters; browser interactions such as copy-to-clipboard remain convenience
  behavior layered above the REST contract.
- [Likely] Downstream tests should split normative packaged-web coverage from
  contrib-only convenience coverage so batch-update review helpers do not become
  accidental public API commitments.

## Package-Root Policy

- [Proven] `src/larva/__init__.py` is metadata-only and currently exports only
  `__version__`.
- [Proven] The authoritative Python API surface lives under
  `src/larva/shell/python_api.py`, which matches README and user-guide import
  examples.
- [Likely] Package-root re-exports should remain disallowed for canonical API
  operations because they would create an unguarded public surface outside the
  configured `core/` and `shell/` review zones.
- [Proven] Legacy compatibility modules may exist at package root only when
  they preserve an already-published import or execution surface without
  becoming the canonical documentation target.
- [Likely] If package-root exports grow beyond metadata or compatibility shims,
  guard policy and docs must be updated in the same change so the new public
  surface is explicitly reviewed rather than silently bypassing guard scope.

## Dependency Rules

- `core/*` may not depend on shell or transport
- `app/*` orchestrates core logic
- `shell/*` adapts transports and storage, not domain semantics

## Architecture Basis -- Duplicate-Abstraction Guardrails Remediation

This basis freezes the structural decisions for the remediation campaign so
downstream refactors do not re-litigate authority boundaries while removing
duplicate shell logic.

```yaml
architecture_basis:
  system_layers:
    - layer: core
      paths:
        - src/larva/core/
      responsibility: >-
        Pure semantic authorities: PersonaSpec rules, validation, normalization,
        canonical component-kind vocabulary, and dotted-path patch application.
      non_responsibility: Transport envelopes, filesystem access, registry I/O, runtime startup.
    - layer: app
      paths:
        - src/larva/app/
      responsibility: >-
        Use-case orchestration over core semantics, including registration,
        resolve/update flows, and dotted lookup for batch-selection predicates.
      non_responsibility: Transport-specific request parsing, rendering, or runtime hooks.
    - layer: shell
      paths:
        - src/larva/shell/
        - contrib/web/
      responsibility: >-
        Adapter-local ingress/egress for CLI, MCP, packaged Web, contrib Web,
        Python API, component filesystem access, registry access, and process/runtime wiring.
      non_responsibility: Owning canonical PersonaSpec semantics or cross-surface contract truth.

  source_of_truth_matrix:
    - subject: packaged REST endpoint inventory
      owner: src/larva/shell/web.py
      consumers:
        - README.md
        - INTERFACES.md
        - larva serve
        - contrib/web/server.py
      rationale: >-
        Packaged web runtime is the user-facing shipped surface; contract ownership
        must live with the packaged adapter, not the contrib mirror.
    - subject: contrib web convenience runtime
      owner: contrib/web/server.py
      consumers:
        - local contributors
      rationale: >-
        This module is an extension consumer that may mirror packaged endpoints and
        add local-review conveniences, but it does not own the packaged contract.
    - subject: component-query semantics
      owner: src/larva/core/component_kind.py plus shell component-store contracts
      consumers:
        - src/larva/shell/cli*.py
        - src/larva/shell/mcp*.py
        - src/larva/shell/python_api*.py
        - src/larva/shell/web.py
        - contrib/web/server.py
      rationale: >-
        Component type normalization, accepted aliases, and lookup semantics are
        transport-neutral. Adapters may format local envelopes, but they must not
        redefine valid component kinds or lookup meaning.
    - subject: dotted-path patch semantics
      owner: src/larva/core/patch.py
      consumers:
        - src/larva/app/facade.py
        - all update-capable shell adapters via facade.update
      rationale: >-
        Patch expansion, protected-key stripping, and deep-merge semantics are core
        mutation rules and remain independent from query matching.
    - subject: dotted lookup for batch where clauses
      owner: src/larva/app/facade.py
      consumers:
        - CLI update-batch
        - MCP update-batch
        - contrib batch-update flows
      rationale: >-
        Batch selection is application orchestration over stored specs, not patch
        mutation. It remains a separate authority from core patch semantics unless
        later evidence proves a single semantic model is correct.

  service_catalog:
    - service: canonical persona operations
      owner_module: src/larva/app/facade.py
      entry_surfaces:
        - CLI
        - MCP
        - Python API
        - packaged Web
        - contrib Web
      notes: Success implies canonical validation after normalization.
    - service: component query service
      owner_module: transport-neutral semantics in src/larva/core/component_kind.py and shell component-store contracts
      entry_surfaces:
        - CLI component commands
        - MCP component tools
        - Python API component functions
        - packaged Web component endpoints
        - contrib Web component endpoints
      notes: >-
        Semantics are shared; envelopes and startup hooks stay local to each adapter.
    - service: packaged web runtime
      owner_module: src/larva/shell/web.py
      entry_surfaces:
        - larva serve
      notes: Authoritative packaged REST surface and packaged HTML delivery.
    - service: contrib web runtime
      owner_module: contrib/web/server.py
      entry_surfaces:
        - python contrib/web/server.py
      notes: >-
        Extension runtime for contributor review. May add convenience endpoints,
        including batch-update, without changing packaged-web contract ownership.

  runtime_contract:
    - CLI delegates to app facade and component-store seams, then renders text/json locally.
    - MCP delegates to app facade and component-store seams, then returns MCP-local schemas and error envelopes.
    - packaged Web delegates to Python API/app seams, then returns HTTP envelopes and owns uvicorn/browser startup hooks for larva serve.
    - contrib Web delegates to the same underlying app/Python API seams, then returns HTTP envelopes and local-review-only runtime conveniences.
    - Python API exposes direct function calls and exception-based failure projection; it does not own CLI/MCP/Web envelopes.
    - Runtime/deployability obligations to preserve during remediation:
      - larva serve remains packaged and authoritative.
      - python contrib/web/server.py remains runnable as a supported extension surface.
      - CLI and MCP remain first-class shipped adapters.
      - shared refactors must not collapse adapter-local runtime hooks into core/app modules.

  state_strata:
    - stratum: canonical domain state
      owner: core + app validation/normalization flow
      examples:
        - PersonaSpec semantic rules
        - validation invariants
        - patch semantics in src/larva/core/patch.py
    - stratum: persisted shell state
      owner: shell registry/components boundaries
      examples:
        - ~/.larva/registry
        - ~/.larva/components
      note: Component files are untrusted shell input until app/core admission succeeds.
    - stratum: transport-local projection state
      owner: each adapter module
      examples:
        - CLI stdout/stderr/json payloads
        - MCP tool schemas and error frames
        - HTTP status codes and {data}/{error} envelopes
        - browser copy-state and auto-open behavior
    - stratum: contrib-only extension behavior
      owner: contrib/web/server.py
      examples:
        - batch-update endpoint
        - local review UI affordances

  transport_boundary_rules:
    - rule: Packaged REST contract authority stays in src/larva/shell/web.py.
    - rule: contrib/web/server.py consumes and mirrors packaged behavior where useful but cannot redefine packaged-web contract truth.
    - rule: Component-query semantics are shared across transports and centralized outside adapter-local envelopes.
    - rule: CLI, MCP, Web, and Python API may each keep adapter-local envelopes, rendering, parameter coercion, and runtime hooks.
    - rule: Transport modules may project errors differently, but error meaning must trace back to app/core or shared component-query semantics.
    - rule: Dotted-path patch semantics and dotted lookup semantics remain separate authorities until evidence overturns that split.

  cross_cutting_governance:
    registries:
      - name: persona registry
        owner_module: src/larva/shell/registry.py
        write_policy: app facade writes through shell registry boundary only
      - name: component store
        owner_module: src/larva/shell/components.py
        write_policy: read-mostly shell boundary over user-managed filesystem content
    lifecycle_ordering:
      - shell entrypoints instantiate shell stores and facade dependencies before serving requests
      - packaged and contrib web runtimes initialize transport app objects before opening browser hooks
      - no runtime may bypass validation/normalization before persistence
    coordination_mechanisms:
      - explicit function delegation through LarvaFacade and component-store seams
      - no event bus
      - no DI container
    wiring_strategy: explicit construction in shell entrypoints and module-level adapter wiring
    governance_owner:
      - shell entrypoints own runtime startup/shutdown
      - app facade owns cross-operation orchestration
      - core owns semantic rules reused across all transports

  shared_abstractions:
    shared_types:
      - name: PersonaSpec
        owner_module: src/larva/core/spec.py
        consumers: [app facade, CLI, MCP, Python API, packaged Web, contrib Web]
        rationale: Canonical cross-surface persona payload type.
      - name: ValidationReport
        owner_module: src/larva/core/validate.py
        consumers: [app facade, CLI, MCP, Python API, packaged Web, contrib Web]
        rationale: Shared admission verdict shape.
      - name: LarvaError
        owner_module: src/larva/app/facade.py
        consumers: [CLI, MCP, Python API, packaged Web, contrib Web]
        rationale: Transport-neutral application error meaning before adapter projection.
    shared_protocols:
      - name: LarvaFacade
        owner_module: src/larva/app/facade.py
        consumers: [CLI, MCP, packaged Web via Python API/contrib, Python API]
        rationale: Common orchestration seam for persona operations.
      - name: ComponentStore
        owner_module: src/larva/shell/components.py
        consumers: [CLI, MCP, app facade assembly]
        rationale: Shared shell contract for component access independent of transport envelope.
      - name: RegistryStore
        owner_module: src/larva/shell/registry.py
        consumers: [app facade]
        rationale: Shared persistence seam for canonical personas.
    shared_utilities:
      - name: component-kind normalization
        owner_module: src/larva/core/component_kind.py
        consumers: [CLI, MCP, Python API, packaged Web, contrib Web]
        rationale: Prevents transport-specific drift in accepted component-type vocabulary.
      - name: component-store error projection
        owner_module: src/larva/core/component_error_projection.py
        consumers: [MCP, Python API, likely future shared web/CLI component-query seam]
        rationale: Keeps component lookup failure meaning aligned across surfaces.
    decision: >-
      Share only semantic authorities that already appear in multiple module
      interfaces; keep envelopes, rendering, and runtime startup local to each adapter.

  module_split_recommendations:
    - module: src/larva/shell/web.py
      owner: packaged web adapter
      keep_separate_from: contrib/web/server.py
      reason: Packaged web contract authority must not be coupled to contrib-only conveniences.
    - module: contrib/web/server.py
      owner: contrib extension adapter
      keep_separate_from: src/larva/shell/web.py
      reason: Local review runtime has different deployability and compatibility obligations.
    - module: src/larva/core/patch.py
      owner: core semantic layer
      keep_separate_from: src/larva/app/facade.py dotted lookup helpers
      reason: Mutation semantics and batch-selection semantics change for different reasons.
    - module: shared component-query seam (to be extracted under src/larva/shell/ only if remediation needs code movement)
      owner: shell architecture, consuming core.component_kind and shell.components
      keep_separate_from: CLI/MCP/Web/Python adapter modules
      reason: Remove duplicated routing/normalization logic without collapsing adapter-local envelopes.

  open_questions:
    - Non-blocking: the step input references a "Duplicate-abstraction audit" but no standalone artifact was provided in this worktree; downstream refactors should cite the concrete duplicate call sites they consolidate.
    - Non-blocking: if a future refactor proposes merging dotted query lookup with core patch semantics, it must first prove identical invariants and failure behavior across update and update_batch flows.

  readiness: READY
```

## Component Model

Assembly inputs may include:
- prompt fragments
- capability bundles
- constraint bundles for fields such as `can_spawn` and `compaction_prompt`
- model bundles

## Component-Kind Vocabulary

- [Proven] The canonical internal routing vocabulary is the plural family set
  `prompts | toolsets | constraints | models`.
- [Proven] Public surfaces accept only canonical plural values at ingress;
  singular aliases are rejected.
- [Proven] Docs, examples, and enumerated valid-type metadata use only the
  canonical plural vocabulary.

## Component Root Boundary

- [Proven] `src/larva/shell/components.py` owns the default component root at
  `~/.larva/components/` and is the shell boundary for filesystem path
  resolution, file reads, and YAML parsing.
- [Proven] CLI, MCP, and Python assembly flows consume components through shell
  adapter operations rather than treating user-home files as core state.
- [Likely] The correct boundary is: filesystem layout belongs to shell,
  assembled `PersonaSpec` acceptance belongs to app/core, and user-home YAML is
  local input that must be treated as untrusted until normalization and
  validation succeed.
- [Proven] Current tests already exercise traversal rejection and typed missing
  component failures, which is enough to document the trust boundary without a
  new implementation phase in this step.

Capability intent remains family-level. Tool-level authorization and posture
exceptions belong to the gateway layer, not PersonaSpec.

## Invariants

- `capabilities` is the only tool-access declaration surface in PersonaSpec
- runtime approval semantics do not belong in PersonaSpec
- canonical persona authority remains separate from runtime and gateway layers
