# larva -- Module Architecture

This document defines the module boundaries, dependency direction, and
module-to-module interfaces for `larva`.

It is intentionally limited to structure:

- what modules exist
- what each module is responsible for
- what each module must not do
- how modules depend on each other
- what interfaces cross those boundaries

It does not define function bodies, algorithms, storage implementation
details, or transport-framework details.

---

## 1. Design Boundary

`larva` is the canonical PersonaSpec authority.

Its design scope is limited to:

- validating PersonaSpec JSON
- assembling PersonaSpec from components
- normalizing PersonaSpec into canonical form
- registering canonical personas
- resolving canonical personas by id
- listing registered personas

Out of scope:

- agent runtime behavior
- approval UI or workflow engines
- provider-specific MCP semantics
- host-native export tooling
- cross-run mutable memory

---

## 2. Invar Alignment

This module plan follows the project Core/Shell rule:

- `core/` contains pure logic only
- `shell/` contains filesystem/process/transport I/O
- shell interfaces return `Result[T, E]`

Design consequence:

- schema-adjacent validation, assembly rules, and normalization live in `core/`
- component loading, registry access, CLI, MCP, and Python entrypoints live in `shell/`
- no module in `core/` may depend on filesystem paths, environment variables,
  process state, or transport frameworks

---

## 3. Layer Model

```text
                    +-- [facade] --> app/facade --> core/spec
                    |                               core/validate
shell/cli ---------+|                               core/assemble
                    ||                              core/normalize
                    |+-- [components] --> shell/components
                    |                    shell/registry (via facade)
                    |
shell/mcp ----------+--> app/facade --> (same as above)
shell/python_api ----+

Dependency key:
  [facade]      = persona operations (validate/assemble/register/resolve/list)
  [components]  = component read operations (list/show components)
```

### Rationale

- `core/` stays deterministic and contract-friendly.
- `shell/` owns all external effects.
- `app/facade` centralizes persona use-case orchestration.
- CLI routes component reads directly to `shell.components` (bypassing facade)
  because component inspection is NOT use-case orchestration.

---
### Rationale

- `core/` stays deterministic and contract-friendly.
- `shell/` owns all external effects.
- `app/facade` centralizes use-case orchestration so CLI, MCP, and Python API
  do not duplicate business flow.

---

## 4. Dependency Rules

### Allowed

- `core/*` -> `core/*`
- `app/*` -> `core/*`
- `app/*` -> shell port interfaces
- `shell/*` -> `core/*`
- `shell/*` -> `app/*`

### Forbidden

- `core/*` -> `shell/*`
- `core/*` -> transport/framework/runtime libraries
- `shell/cli` -> `shell/mcp`
- `shell/mcp` -> `shell/cli`
- transport adapters owning validation/assembly/normalization logic

### Rationale

- Pure logic must remain testable independent of I/O.
- Each transport adapter should be thin and replaceable.
- Use-case flow should have one authoritative implementation path.

---

## 5. Proposed File Structure

```text
src/larva/
  core/
    spec.py
    validate.py
    assemble.py
    normalize.py
  app/
    facade.py
    types.py
  shell/
    components.py
    registry.py
    cli.py
    mcp.py
    python_api.py
    errors.py
```

---

## 6. Module Specifications

## Module: `larva.core.spec`

### Responsibility

Define the canonical in-memory domain types used by validation,
assembly, normalization, registry, and public APIs.

### Non-Responsibility

- no file I/O
- no JSON parsing/writing
- no registry lookup
- no transport concerns

### Depends on

- Python type system only

### Depended by

- `larva.core.validate`
- `larva.core.assemble`
- `larva.core.normalize`
- `larva.app.facade`
- `larva.shell.components`
- `larva.shell.registry`

### Public Interface

```python
type ToolPosture = Literal["none", "read_only", "read_write", "destructive"]
type SideEffectPolicy = Literal["allow", "approval_required", "read_only"]

class PersonaSpec(TypedDict, total=False):
    id: str
    description: str
    prompt: str
    model: str
    tools: dict[str, ToolPosture]
    model_params: dict[str, object]
    side_effect_policy: SideEffectPolicy
    can_spawn: bool | list[str]
    compaction_prompt: str
    spec_version: Literal["0.1.0"]
    spec_digest: str

class PromptComponent(TypedDict):
    text: str

class ToolsetComponent(TypedDict):
    tools: dict[str, ToolPosture]

class ConstraintComponent(TypedDict, total=False):
    can_spawn: bool | list[str]
    side_effect_policy: SideEffectPolicy
    compaction_prompt: str

class ModelComponent(TypedDict, total=False):
    model: str
    model_params: dict[str, object]

class AssemblyInput(TypedDict, total=False):
    id: str
    prompts: list[PromptComponent]
    toolsets: list[ToolsetComponent]
    constraints: list[ConstraintComponent]
    model: ModelComponent | str
    overrides: dict[str, object]
    variables: dict[str, str]
```

---

## Module: `larva.core.validate`

### Responsibility

Apply deterministic validation rules to PersonaSpec candidates and
produce a validation report.

### Non-Responsibility

- no filesystem access
- no registry persistence
- no component lookup
- no CLI/MCP error formatting

### Depends on

- `larva.core.spec`

### Depended by

- `larva.app.facade`
- `larva.shell.python_api`

### Public Interface

```python
class ValidationIssue(TypedDict):
    code: str
    message: str
    details: dict[str, object]

class ValidationReport(TypedDict):
    valid: bool
    errors: list[ValidationIssue]
    warnings: list[str]

def validate_spec(spec: PersonaSpec) -> ValidationReport: ...
```

---

## Module: `larva.core.assemble`

### Responsibility

Combine already-loaded components and explicit overrides into a
PersonaSpec candidate.

### Non-Responsibility

- no component file discovery
- no registry writes
- no transport parsing

### Depends on

- `larva.core.spec`

### Depended by

- `larva.app.facade`

### Public Interface

Component input contracts are owned by `larva.core.spec`.

```python
def assemble_candidate(data: AssemblyInput) -> PersonaSpec: ...
```

---

## Module: `larva.core.normalize`

### Responsibility

Transform PersonaSpec candidates into canonical PersonaSpec output.

### Non-Responsibility

- no persistence
- no component discovery
- no transport formatting

### Depends on

- `larva.core.spec`

### Depended by

- `larva.app.facade`

### Public Interface

```python
def normalize_spec(spec: PersonaSpec) -> PersonaSpec: ...
```

---

## Module: `larva.app.facade`

### Responsibility

Own the authoritative use-case flow for `validate`, `assemble`,
`register`, `resolve`, and `list`.

### Non-Responsibility

- no direct CLI parsing
- no direct MCP protocol handling
- no direct filesystem implementation details

### Depends on

- `larva.core.spec`
- `larva.core.validate`
- `larva.core.assemble`
- `larva.core.normalize`
- component-store and registry-store interfaces

### Depended by

- `larva.shell.cli`
- `larva.shell.mcp`
- `larva.shell.python_api`

### Public Interface

```python
class AssembleRequest(TypedDict, total=False):
    id: str
    prompts: list[str]
    toolsets: list[str]
    constraints: list[str]
    model: str
    overrides: dict[str, object]
    variables: dict[str, str]

class RegisteredPersona(TypedDict):
    id: str
    registered: bool

class PersonaSummary(TypedDict):
    id: str
    spec_digest: str
    model: str

class LarvaFacade(Protocol):
    def validate(self, spec: PersonaSpec) -> ValidationReport: ...
    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]: ...
    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]: ...
    def resolve(
        self,
        id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]: ...
    def list(self) -> Result[list[PersonaSummary], LarvaError]: ...
```

### Rationale

- This layer prevents transport adapters from reimplementing flow.
- It preserves Invar purity in `core/` while keeping shell adapters thin.

---

## Module: `larva.shell.components`

### Responsibility

Load prompt, toolset, constraint, and model components from the external
component store.

### Non-Responsibility

- no assembly rule ownership
- no validation rule ownership
- no registry mutation

### Depends on

- `larva.core.spec`

### Depended by

- `larva.app.facade`

### Public Interface

```python
class ComponentStore(Protocol):
    def load_prompt(self, name: str) -> Result[PromptComponent, ComponentStoreError]: ...
    def load_toolset(self, name: str) -> Result[ToolsetComponent, ComponentStoreError]: ...
    def load_constraint(self, name: str) -> Result[ConstraintComponent, ComponentStoreError]: ...
    def load_model(self, name: str) -> Result[ModelComponent, ComponentStoreError]: ...
    def list_components(self) -> Result[dict[str, list[str]], ComponentStoreError]: ...
```

---

## Module: `larva.shell.registry`

### Responsibility

Read, write, and enumerate canonical PersonaSpec records in the registry.

### Non-Responsibility

- no semantic validation
- no component assembly
- no transport adaptation

### Depends on

- `larva.core.spec`

### Depended by

- `larva.app.facade`

### Public Interface

```python
class RegistryStore(Protocol):
    def save(self, spec: PersonaSpec) -> Result[None, RegistryError]: ...
    def get(self, id: str) -> Result[PersonaSpec, RegistryError]: ...
    def list(self) -> Result[list[PersonaSpec], RegistryError]: ...
```

---

## Module: `larva.shell.cli`
## Module: `larva.shell.cli`

### Responsibility

Adapt CLI input/output to facade calls (persona operations) and
ComponentStore calls (component read operations).

### Non-Responsibility

- no business-rule ownership
- no registry logic
- no assembly logic

### Depends on

- `larva.app.facade` — for persona operations (validate, assemble, register, resolve, list personas)
- `shell.components ComponentStore` — for component inspection (list components, show component)

### Shell-Boundary Error Handling

CLI commands map shell errors directly to exit codes and stderr:

**Persona commands (facade-routed):**
- Convert `Result[T, LarvaError]` to exit code and JSON/text output
- Exit code 0 for success, 1 for application error, 2 for critical failure

**Component commands (ComponentStore-routed):**
- Convert `Result[T, ComponentStoreError]` to exit code
- Exit code 0 for success, 1 for component not found or parse error

---
### Responsibility

Adapt CLI input/output to facade calls.

### Non-Responsibility

- no business-rule ownership
- no registry logic
- no assembly logic

### Depends on

- `larva.app.facade`

---

## Module: `larva.shell.mcp`

### Responsibility

Adapt MCP tool calls to facade calls.

### Non-Responsibility

- no business-rule ownership
- no registry logic
- no assembly logic

### Depends on

- `larva.app.facade`

---

## Module: `larva.shell.python_api`

### Responsibility

Expose a small in-process Python API aligned with the public larva use
cases.

### Non-Responsibility

- no separate flow logic from facade
- no transport-specific behavior

### Depends on

- `larva.app.facade`

---

## 7. Cross-Module Interface Contracts

### Component Loading -> Assembly

- `shell.components` returns parsed component objects
- `core.assemble` accepts in-memory component values only

This keeps path and format concerns out of `core.assemble`.

### Assembly -> Validation -> Normalization

- `core.assemble` produces a candidate PersonaSpec
- `core.validate` evaluates deterministic validity
- `core.normalize` produces canonical output

Recommended use-case order:

1. assemble
2. validate
3. normalize
4. persist or return

### Registry Read -> Override -> Revalidation

- `shell.registry.get(id)` returns canonical PersonaSpec
- override application belongs in `app.facade`
- any override path must pass through revalidation and renormalization

This prevents registry and transport adapters from owning semantic rules.

---

## 8. Error Boundary Model

### Core

- returns domain values and validation reports
- does not own filesystem/process/transport failures

### Shell

- converts external failures into typed shell errors
- returns `Result[T, E]`

### App

- composes shell failures and core validation outcomes into use-case level
  errors suitable for transport adapters

### Rationale

- This matches Invar's rule that `shell/` owns I/O and returns `Result`.
- It keeps core contracts independent of transport and persistence details.

---

## 9. Dependency Analysis

### Module Graph

```text
core/spec
  ^      ^          ^
  |      |          |
  |   core/validate |
  |   core/assemble |
  |   core/normalize
  |        ^
  |        |
  +----- app/facade -----+
          ^              ^
          |              |
 shell/components   shell/registry
          ^              ^
          +------ shell transports -----+
                 cli / mcp / python_api
```

### Circular Dependency Policy

- No circular dependencies are allowed between `core` modules.
- `app.facade` may depend downward on core and shell ports.
- shell transports must not depend on each other.

### Change Impact

- changes to PersonaSpec shape affect `core.spec`, then cascade to
  validation, assembly, normalization, registry serialization, and public
  adapters
- changes to component storage affect `shell.components` only if the
  `ComponentStore` contract remains stable
- changes to registry persistence affect `shell.registry` only if the
  `RegistryStore` contract remains stable

---

## 10. Final Decisions
## 10. Final Decisions

### Decision 1: Keep an explicit `app/` layer

- `app/` remains a first-class layer.
- `app.facade` owns use-case orchestration across transports.
- CLI, MCP, and Python entrypoints must remain thin adapters.

Rationale:

- Multiple public entrypoints already exist in the design.
- Without an application layer, orchestration logic would drift into
  transport adapters or shell storage modules.
- This keeps `core/` pure and `shell/` thin while preserving one
  authoritative use-case path.

### Decision 2: `resolve(..., overrides=...)` is part of v1

- `resolve` includes optional overrides in the v1 module contract.
- Override application belongs in `app.facade`, not in registry or
  transport adapters.
- Any override path must re-enter validation and normalization before
  returning a result.

Rationale:

- The public design already exposes resolve-with-overrides.
- Making overrides part of the architecture now avoids a later interface
  fork between documented and implemented behavior.
- Revalidation and renormalization preserve canonical semantics.

### Decision 3: Python API is a thin facade export

- Python API remains part of the public surface.
- It should begin as a thin export over `app.facade`, exposed from
  `__init__.py`.
- A thicker `shell.python_api` module is only justified if the Python
  surface later needs behavior not shared with CLI and MCP.

Rationale:

- Current Python API needs are small and aligned with the same use cases.
- A thin export avoids duplicating orchestration logic.
- This keeps the public surface simple while preserving a path to split
  later if real divergence appears.

### Decision 4: CLI component subcommands use injected ComponentStore port

- CLI `component list` and `component show` are NOT facade operations.
- These commands route through an injected `ComponentStore` port directly.
- `LarvaFacade` does NOT own component listing or component reading.

**Dependency Model:**

```text
shell/cli depends on:
  - larva.app.facade (for persona operations: list, resolve, register)
  - shell/components ComponentStore (for component operations: list, show)
```

**Rationale:**

1. **Separation of concerns:** Component read operations are NOT use-case
   orchestration. They are direct storage reads without validation,
   assembly, or normalization.
2. **Facade scope:** `LarvaFacade` owns persona-centric orchestration
   (validate → assemble → normalize → persist). Component inspection
   is outside this scope.
3. **Error boundary:** Component read failures (file not found, parse
   error) are shell-level `ComponentStoreError` values, returned as
   `Result[T, ComponentStoreError]`. CLI adapts these directly to exit
   codes and stderr without facade intermediation.
4. **No feature creep:** Adding component reads to facade would grow
   facade indefinitely. Injected ports keep facade focused.

**Exit-code mapping for CLI component commands:**

| Error | Exit Code | Notes |
|-------|-----------|-------|
| Component not found | 1 | Path resolution failure |
| Parse error (malformed YAML/markdown) | 1 | Component content invalid |
| Success | 0 | JSON output on stdout (or formatted text without `--json`) |

**No facade intermediation:** CLI converts `Result[T, ComponentStoreError]`
directly to process exit, matching pattern of `shell.components` owning
all I/O and format concerns.

---
### Decision 1: Keep an explicit `app/` layer

- `app/` remains a first-class layer.
- `app.facade` owns use-case orchestration across transports.
- CLI, MCP, and Python entrypoints must remain thin adapters.

Rationale:

- Multiple public entrypoints already exist in the design.
- Without an application layer, orchestration logic would drift into
  transport adapters or shell storage modules.
- This keeps `core/` pure and `shell/` thin while preserving one
  authoritative use-case path.

### Decision 2: `resolve(..., overrides=...)` is part of v1

- `resolve` includes optional overrides in the v1 module contract.
- Override application belongs in `app.facade`, not in registry or
  transport adapters.
- Any override path must re-enter validation and normalization before
  returning a result.

Rationale:

- The public design already exposes resolve-with-overrides.
- Making overrides part of the architecture now avoids a later interface
  fork between documented and implemented behavior.
- Revalidation and renormalization preserve canonical semantics.

### Decision 3: Python API is a thin facade export

- Python API remains part of the public surface.
- It should begin as a thin export over `app.facade`, exposed from
  `__init__.py`.
- A thicker `shell.python_api` module is only justified if the Python
  surface later needs behavior not shared with CLI and MCP.

Rationale:

- Current Python API needs are small and aligned with the same use cases.
- A thin export avoids duplicating orchestration logic.
- This keeps the public surface simple while preserving a path to split
  later if real divergence appears.

---

## 11. Implementation Handoff

### Design Scope

Module boundaries, dependency direction, and cross-module interfaces for
`larva`.

### Suggested Build Order

1. `core/spec`
2. `core/normalize`
3. `core/validate`
4. `core/assemble`
5. shell storage ports: `shell/components`, `shell/registry`
6. `app/facade`
7. transports: `shell/python_api`, `shell/cli`, `shell/mcp`

### Watch For

- Do not let `core/` import filesystem, path, environment, or transport code.
- Do not let CLI or MCP adapters own validation or normalization flow.
- Keep shell interfaces `Result`-based to stay aligned with Invar rules.
