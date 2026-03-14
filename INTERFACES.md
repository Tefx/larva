# larva -- Interface Specification

This document defines the public interfaces of the larva PersonaSpec toolkit.

larva validates, assembles, normalizes, and registers PersonaSpec JSON.
It provides a component library for reusable prompt fragments, tool configs,
and constraint bundles. It admits canonical persona definitions and serves
them programmatically. It does not call LLMs, does not run agents, and has
no runtime dependencies on the other opifex components.

Cross-run mutable persona memory is out of scope for larva's active interface. Historical recall, search-heavy evidence retrieval, and memory-evolution workflows are also out of scope.

Larva validates canonical persona declarations, but it does not own provider-specific MCP semantics. Fine-grained tool-call classification and enforcement belong in the gateway/runtime layer.

Personas are typically LLM-generated or programmatically assembled, not
hand-written by humans.

---

## A. MCP Server Interface (primary)

larva runs as an MCP server (stdio or SSE). Other opifex components
(nervus, anima serve) call larva tools via MCP.

### larva.validate(spec)

Validate a PersonaSpec JSON object.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `spec` | object | yes | PersonaSpec JSON to validate |

**Returns:**

`larva.validate` returns a `ValidationReport` object:

```json
{
  "valid": false,
  "errors": [
    {
      "code": "INVALID_SPEC_VERSION",
      "message": "spec_version must be '0.1.0'",
      "details": {"field": "spec_version", "value": "0.2.0"}
    }
  ],
  "warnings": [
    "UNUSED_VARIABLES: supplied variables are not referenced by prompt: role"
  ]
}
```

Where each entry in `errors` is a `ValidationIssue`:

```json
{
  "code": "string",
  "message": "string",
  "details": {"key": "value"}
}
```

`warnings` is always present as `list[string]` and `errors` is always present as `list[ValidationIssue]`.

Authoritative warning semantics for v1:

- `warnings` is reserved for the deterministic `UNUSED_VARIABLES` family.
- Emit a warning when `spec.variables` provides one or more keys that are not
  referenced by any `{name}` placeholder in `spec.prompt`.
- Warning strings use this canonical format:
  `UNUSED_VARIABLES: supplied variables are not referenced by prompt: <sorted comma-separated keys>`.
- Missing variables remain validation errors via `VARIABLE_UNRESOLVED`; they are
  not warnings.

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    "UNUSED_VARIABLES: supplied variables are not referenced by prompt: project_name, role"
  ]
}
```
or
```json
{
  "valid": false,
  "errors": [
    {
      "code": "INVALID_SPEC_VERSION",
      "message": "spec_version must be '0.1.0'",
      "details": {"field": "spec_version", "value": "0.2.0"}
    },
    {
      "code": "INVALID_SIDE_EFFECT_POLICY",
      "message": "side_effect_policy must be one of allow, approval_required, read_only",
      "details": {"field": "side_effect_policy", "value": "unsafe"}
    }
  ],
  "warnings": []
}
```

### larva.assemble(components)

Assemble a PersonaSpec from named components.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | yes | Persona id |
| `prompts` | list[string] | no | Prompt component names (concatenated in order) |
| `toolsets` | list[string] | no | Toolset component names |
| `constraints` | list[string] | no | Constraint component names |
| `model` | string | no | Model component name |
| `overrides` | object | no | Field overrides (wins over components) |
| `variables` | object | no | Variable substitution in prompt text |

**Returns:** Complete PersonaSpec JSON (validated, with spec_digest).

Implementation boundary: shell resolves component names to in-memory
component objects, then calls `larva.core.assemble.assemble_candidate`
with `larva.core.spec.AssemblyInput` and continues through
validate+normalize before returning the final PersonaSpec.

**Error:** `COMPONENT_NOT_FOUND` if a referenced component does not exist.
`COMPONENT_CONFLICT` if two components set the same scalar field without
an explicit override.

### larva.resolve(id, overrides?)

Resolve a pre-registered persona by id.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | yes | Persona id in registry |
| `overrides` | object | no | Field overrides applied to the resolved spec |

**Returns:** PersonaSpec JSON. If overrides are applied, spec_digest is recomputed.

**Error:** `PERSONA_NOT_FOUND` if id not in registry.

### larva.register(spec)

Register a PersonaSpec in the global registry.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `spec` | object | yes | PersonaSpec JSON (must pass validation) |

**Returns:**
```json
{
  "id": "code-reviewer",
  "registered": true
}
```

### larva.list()

List all registered personas.

**Returns:**
```json
[
  {
    "id": "code-reviewer",
    "spec_digest": "sha256:e3b0c442...",
    "model": "claude-opus-4-20250514"
  }
]
```

### larva.update(id, patches)

Update a registered persona by applying JSON merge patches.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | yes | Persona id in registry |
| `patches` | object | yes | JSON merge patches to apply to the persona |

**Returns:** Updated, validated, and normalized PersonaSpec JSON.

**Patches:**
- `patches` must be a JSON object (dictionary)
- Supported patch semantics:
  - **Scalar overwrite**: `{"model": "new-model"}` replaces the `model` field
  - **Deep merge**: Nested objects in `model_params` and `tools` are merged recursively
  - **Dot notation**: `{"model_params.temperature": 0.7}` sets nested values
  - **Protected fields**: `spec_digest` and `spec_version` are ignored and cannot be modified

**Revalidation and Normalization:**
1. Registry lookup by `id` → retrieve existing PersonaSpec
2. Apply patches via deep-merge semantics (see Patch Semantics below)
3. Revalidate the patched spec against the PersonaSpec schema
4. Renormalize: recompute `spec_digest` from canonical JSON
5. Save to registry and return the updated PersonaSpec

**Error:** `PERSONA_NOT_FOUND` (100) if id not in registry.
`PERSONA_INVALID` (101) if patched spec fails validation.
`REGISTRY_WRITE_FAILED` (109) if save fails.

```json
// Request
{
  "id": "code-reviewer",
  "patches": {
    "model": "claude-sonnet-4",
    "model_params": {
      "temperature": 0.5
    }
  }
}

// Response (PersonaSpec on success)
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "model": "claude-sonnet-4",
  "model_params": {
    "temperature": 0.5,
    "max_tokens": 4096
  },
  "spec_digest": "sha256:..."
}
```

### larva.component_list()

List all available components by type.

**Parameters:** None

**Returns:**
```json
{
  "prompts": ["code-reviewer", "architect"],
  "toolsets": ["readonly", "readwrite"],
  "constraints": ["strict", "autonomous"],
  "models": ["default", "claude-opus"]
}
```

### larva.component_show(component_type, name)

Show a specific component's content.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `component_type` | string | yes | One of: `prompts`, `toolsets`, `constraints`, `models` |
| `name` | string | yes | Component name (without file extension) |

**Returns:** Component content as JSON object.

**Error:** `COMPONENT_NOT_FOUND` (105) if component does not exist or type is invalid.

### larva.delete(id)

Delete a registered persona from the registry.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `id` | string | yes | Persona id to delete |

**Returns:**
```json
{
  "id": "old-persona",
  "deleted": true
}
```

**Error:** `PERSONA_NOT_FOUND` (100) if persona does not exist.
`REGISTRY_DELETE_FAILED` (111) if file system deletion fails.

### larva.clear(confirm)

Clear all registered personas from the registry.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `confirm` | string | yes | Must be exactly `"CLEAR REGISTRY"` (safety confirmation) |

**Returns:**
```json
{
  "cleared": true,
  "count": 3
}
```

**Error:** `INVALID_CONFIRMATION_TOKEN` (112) if confirm token does not match.
`REGISTRY_DELETE_FAILED` (111) if file system deletion fails.

### App-Facade Seam-Proof Evidence Requirement

When `larva.app.facade` orchestration changes (assemble/register/list/resolve), seam proof must be reproducible:

- include one replayable command (copy-paste runnable)
- include verbatim output from that command
- include one artifact path containing the captured command and output payloads

This requirement prevents placeholder-only evidence and keeps gate reviews replayable.

---

## B. CLI Interface

All commands support `--json` for machine-readable JSON output on stdout.

**Exit code strategy:** CLI uses standard small exit codes (0/1/2) for
shell scripting compatibility.

**Numeric code strategy (`--json`):** Domain failures use mapped app codes
(`100-110`) from Section G. Transport/runtime failures with no mapped app code
(for example argument parsing failures and local input file I/O failures)
use fallback `INTERNAL` (`numeric_code: 10`).

**Dependency model:** Persona commands (validate, assemble, register, resolve, list)
route through `app.facade`. Component commands (component list, component show)
route directly to injected `ComponentStore` port. See ARCHITECTURE.md Decision 4.

### `larva validate <spec.json> [--json]`

Validate a PersonaSpec JSON file. Checks schema conformance and semantic rules.

Missing-id policy: `id` is mandatory. If absent or not flat kebab-case,
validation fails with `PERSONA_INVALID` and report error code
`INVALID_PERSONA_ID`.

Exit codes: 0 valid, 1 invalid, 2 input/critical failure.

### `larva assemble [OPTIONS]`

Assemble a PersonaSpec from components.

| Flag | Type | Description |
| ---- | ---- | ----------- |
| `--id` | str | Persona id (required) |
| `--prompt` | str (repeatable) | Prompt component name |
| `--toolset` | str (repeatable) | Toolset component name |
| `--constraints` | str (repeatable) | Constraint component name |
| `--model` | str | Model component name or literal model identifier |
| `--override` | str (repeatable) | Field override: `key=value` |
| `--var` | str (repeatable) | Variable substitution: `key=value` |
| `-o, --output` | path | Write assembled spec JSON to file; default writes to stdout |

Exit codes: 0 success, 1 domain error, 2 input/critical failure.

### `larva register <spec.json> [--json]`

Register a PersonaSpec in the global registry.

Exit codes: 0 success, 1 domain error, 2 input/critical failure.

### `larva resolve <id> [--override key=value...] [--json]`

Resolve a persona from the registry, optionally with overrides.

Exit codes: 0 success, 1 domain error, 2 input/critical failure.

### `larva list [--json]`

List all registered personas.

Exit codes: 0 success, 1 domain error, 2 input/critical failure.

### `larva update <id> --set key=value [--set ...] [--json]`

Update a registered persona by applying patches.

| Flag | Type | Description |
| ---- | ---- | ----------- |
| `--set` | str (repeatable) | Field patch: `key=value`. Can be repeated. |
| `--json` | flag | Output JSON on stdout |

**Type Inference for --set values:**
- `true` / `false` → boolean
- `null` → null
- Integer-parseable → int
- Float-parseable → float
- Otherwise → string

**Dot Notation:**
- `--set model_params.temperature=0.7` sets nested values
- Creates intermediate dicts as needed

**Protected Fields:**
- `spec_digest` and `spec_version` are ignored; cannot be modified via update

**Revalidation:**
- Patches are applied, then the result is re-validated
- Invalid patches (schema violations) return `PERSONA_INVALID` error

**Deep Merge:**
- `model_params` and `tools` fields are deep-merged
- Other fields are overwritten

**Routing:** Via facade to `RegistryStore.get()` → `core.patch.apply_patches()` → `validate` → `normalize` → `RegistryStore.save()`.

Exit codes: 0 success, 1 domain error (PERSONA_NOT_FOUND, PERSONA_INVALID), 2 input/critical failure.

```bash
# Simple field update
larva update my-persona --set model=claude-sonnet-4 --json

# Nested field with type inference
larva update my-persona --set model_params.temperature=0.5

# Multiple patches
larva update my-persona --set can_spawn=true --set side_effect_policy=read_only
```

### `larva component list [--json]`

List all available components.

**Routing:** Direct to injected `ComponentStore.list_components()`. Bypasses facade.

Exit codes: 0 success, 1 domain error, 2 input/critical failure.

### `larva component show <type>/<name> [--json]`

Show a component's content. Type is one of: `prompts`, `toolsets`,
`constraints`, `models`.

**Routing:** Direct to `ComponentStore.load_<type>(name)`. Bypasses facade.

Exit codes: 0 success, 1 domain error, 2 input/critical failure.

### `larva delete <id> [--json]`

Delete a persona from the registry by id.

**Routing:** Via facade to `RegistryStore.delete()`.

Exit codes: 0 success, 1 domain error (PERSONA_NOT_FOUND, REGISTRY_DELETE_FAILED), 2 input/critical failure.

### `larva clear --confirm "CLEAR REGISTRY" [--json]`

Clear all personas from the registry. The `--confirm` flag must be passed
exactly with value `"CLEAR REGISTRY"` as a safety measure.

**Routing:** Via facade to `RegistryStore.clear()`.

Exit codes: 0 success, 1 domain error (INVALID_CONFIRMATION_TOKEN, REGISTRY_DELETE_FAILED), 2 input/critical failure.

---

## C. Component Library

Components are stored in `~/.larva/components/` organized by type.

### Component Types

| Type | Directory | File Format | Contributes to |
|------|-----------|-------------|----------------|
| Prompt | `prompts/` | `.md` (plain text) | `prompt` |
| Toolset | `toolsets/` | `.yaml` | `tools` |
| Constraint | `constraints/` | `.yaml` | `can_spawn`, `side_effect_policy`, `compaction_prompt` |
| Model | `models/` | `.yaml` | `model`, `model_params` |

Type ownership is explicit:
- File-backed component payload semantics are defined in this section.
- Canonical in-memory component contracts (`PromptComponent`,
  `ToolsetComponent`, `ConstraintComponent`, `ModelComponent`,
  `AssemblyInput`) are owned by `larva.core.spec` and consumed by
  `larva.core.assemble` / `larva.shell.components`.

### Prompt Component

Just a markdown file. No wrapper, no metadata. The content IS the prompt.

```markdown
You are a senior code reviewer. Focus on correctness over style.
Always cite specific line numbers when pointing out issues.
```

### Toolset Component

```yaml
tools:
  filesystem: read_write
  shell: read_only
  git: read_only
```

### Constraint Component

```yaml
can_spawn: false
side_effect_policy: approval_required
compaction_prompt: |
  Summarize the working context into concise carry-forward notes.
```

### Model Component

```yaml
model: "claude-opus-4-20250514"
model_params:
  temperature: 0.3
  max_tokens: 4096
```

### Assembly Rules

- **Prompts**: Concatenated in declared order (`\n\n` separator) → `prompt`
- **Scalars** (model, can_spawn, side_effect_policy): Multiple sources for same field → error (`COMPONENT_CONFLICT`).
  Resolve via `overrides`.
- **tools**: Multiple toolset components may be merged only if they do not define contradictory posture values for the same tool family. Contradictions → `COMPONENT_CONFLICT`.
- **model_params**: Deep-merged from model component. `overrides` can patch keys.

---

## D. Global Registry

### Location

`~/.larva/registry/`

Each registered persona is a JSON file: `<id>.json`.
An `index.json` maps ids to canonical `spec_digest` values (`sha256:<64-hex>`).

### Resolution

1. `larva resolve <id>` reads `~/.larva/registry/<id>.json`
2. If `overrides` are provided, fields are patched and spec_digest recomputed
3. Returns complete PersonaSpec JSON

### Id Rules

Ids must match `^[a-z0-9]+(-[a-z0-9]+)*$` (flat kebab-case, no namespaces in v1).

---

## E. PersonaSpec Output Format

The output artifact. All assembly machinery is erased — the output is
a flat, self-contained PersonaSpec JSON.

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code changes with read-focused tooling and concise findings.",
  "prompt": "You are a senior code reviewer...",
  "model": "claude-opus-4-20250514",
  "model_params": {
    "temperature": 0.3,
    "max_tokens": 4096
  },
  "tools": {
    "filesystem": "read_write",
    "shell": "read_only",
    "git": "read_only"
  },
  "can_spawn": false,
  "side_effect_policy": "approval_required",
  "compaction_prompt": "Summarize the working context into concise carry-forward notes.",
  "spec_digest": "sha256:e3b0c442..."
}
```

No `base`, no component references, no assembly metadata in the output.

`spec_digest` is optional in raw input (e.g., hand-written
or LLM-generated JSON passed to `larva.validate`). larva computes it
during normalization. All larva output (assemble, resolve, register)
always includes spec_digest.

`id` is required in raw input and must match
`^[a-z0-9]+(-[a-z0-9]+)*$`.

### Normalization

- `spec_digest`: `sha256:` plus SHA-256 of canonical JSON (sorted keys, no whitespace,
  excluding the spec_digest field itself).
- `spec_version`: Set to `"0.1.0"` if not present.

`spec_version = "0.1.0"` is the canonical v1 schema version.

---

## F. Variable Injection

### Syntax

Variables in prompt text use `{variable_name}` syntax (Python
`str.format_map` compatible).

```markdown
You are a {role} working on {project_name}.
```

### Injection

- CLI: `larva assemble --id reviewer-persona --prompt my-prompt --toolset python-core --constraints safe-default --var role=reviewer --var project_name=myapp`
- MCP: `larva.assemble(prompts=["my-prompt"], variables={"role": "reviewer"})`

### Enforcement

- All `{variable}` placeholders must be provided.
- Missing variables → `VARIABLE_UNRESOLVED` error.
- Extra variables (provided but not referenced) are silently ignored.

---

## G. Error Codes

larva uses the 100-range from `contracts/errors.yaml`.

| Code | Name | Description |
|------|------|-------------|
| 10 | `INTERNAL` | Unknown/unmapped app-layer code fallback (`numeric_code`) |
| 100 | `PERSONA_NOT_FOUND` | Persona id not found in registry |
| 101 | `PERSONA_INVALID` | PersonaSpec validation failed |
| 102 | `PERSONA_CYCLE` | Circular reference detected (reserved) |
| 103 | `VARIABLE_UNRESOLVED` | Unresolved variable in prompt text |
| 104 | `INVALID_PERSONA_ID` | Persona id violates flat kebab-case rules |
| 105 | `COMPONENT_NOT_FOUND` | Component referenced in assembly not found |
| 106 | `COMPONENT_CONFLICT` | Multiple components set the same scalar field |
| 107 | `REGISTRY_INDEX_READ_FAILED` | Registry `index.json` could not be read or decoded |
| 108 | `REGISTRY_SPEC_READ_FAILED` | Registry `<id>.json` file could not be read or validated |
| 109 | `REGISTRY_WRITE_FAILED` | Registry `<id>.json` file could not be written |
| 110 | `REGISTRY_UPDATE_FAILED` | Registry `index.json` could not be updated |
| 111 | `REGISTRY_DELETE_FAILED` | Registry persona file deletion failed after index was updated |
| 112 | `INVALID_CONFIRMATION_TOKEN` | Confirm token for clear operation does not match required value |

If an app-layer error `code` is not mapped in this table, `numeric_code` defaults to `10` (`INTERNAL`).

### Error Response Format

`larva` uses one error envelope payload (`code`, `numeric_code`, `message`, `details`) across
all transports. Wrapping differs by transport boundary:

- CLI `--json`: payload is wrapped as `{ "error": <LarvaError> }`
- MCP tool handler return: payload is returned directly as `<LarvaError>`

CLI `--json` example:

```json
{
  "error": {
    "code": "COMPONENT_CONFLICT",
    "numeric_code": 106,
    "message": "Field 'side_effect_policy' set by both 'constraints/strict' and 'constraints/autonomous'",
    "details": {
      "field": "side_effect_policy",
      "sources": ["constraints/strict", "constraints/autonomous"]
    }
  }
}
```

MCP handler example:

```json
{
  "code": "COMPONENT_CONFLICT",
  "numeric_code": 106,
  "message": "Field 'side_effect_policy' set by both 'constraints/strict' and 'constraints/autonomous'",
  "details": {
    "field": "side_effect_policy",
    "sources": ["constraints/strict", "constraints/autonomous"]
  }
}
```

---

## H. Python API Interface

The Python API provides direct function access for programmatic use via `larva.shell.python_api`.

### component_list()

List all available components by type.

**Returns:** `dict[str, list[str]]` — Dictionary mapping component type keys to lists of component names:
- `"prompts"`: list of available prompt names
- `"toolsets"`: list of available toolset names
- `"constraints"`: list of available constraint names
- `"models"`: list of available model names

**Raises:** `LarvaApiError` with code `COMPONENT_NOT_FOUND` (105) on failure.

```python
from larva.shell.python_api import component_list

components = component_list()
assert "prompts" in components
```

### component_show(type, name)

Show a specific component's content.

**Parameters:**

| Name | Type | Description |
| ---- | ---- | ----------- |
| `type` | str | Component type: `"prompt"`, `"toolset"`, `"constraint"`, or `"model"` |
| `name` | str | Component name (without file extension) |

**Returns:** `dict[str, object]` — Component content as dictionary.

**Raises:** `LarvaApiError` with code `COMPONENT_NOT_FOUND` (105) if component does not exist or type is invalid.

```python
from larva.shell.python_api import component_show

prompt = component_show("prompt", "code-reviewer")
assert "text" in prompt
```

### update(persona_id, patches)

Update a registered persona by applying patches.

**Parameters:**

| Name | Type | Description |
| ---- | ---- | ----------- |
| `persona_id` | str | Unique identifier of the persona to update |
| `patches` | dict[str, Any] | Dictionary of patches to apply (supports JSON merge semantics) |

**Returns:** `PersonaSpec` — Updated, validated, and normalized persona specification.

**Raises:** `LarvaApiError` with code `PERSONA_NOT_FOUND` (100) if persona does not exist, `PERSONA_INVALID` (101) if validation fails after patching, `REGISTRY_WRITE_FAILED` (109) on save failure.

**Patch Semantics:**
- **Scalar overwrite**: Non-dict values replace existing values
- **Deep merge**: `model_params` and `tools` fields are deep-merged recursively
- **Dot notation**: Keys like `"model_params.temperature"` are expanded to nested dicts
- **Protected fields**: `spec_digest` and `spec_version` are stripped from patches

**Revalidation:** After patches are applied, the resulting spec is validated. If validation fails, the update is rejected and the original persona is unchanged.

```python
from larva.shell.python_api import update

# Simple field update
spec = update("my-persona", {"model": "claude-sonnet-4"})
assert spec["model"] == "claude-sonnet-4"

# Nested update with deep merge
spec = update("my-persona", {"model_params": {"temperature": 0.7}})
# model_params.temperature is updated, other model_params fields preserved

# Dot notation for nested updates
spec = update("my-persona", {"model_params.temperature": 0.5})
```

### delete(persona_id)

Delete a registered persona from the registry.

**Parameters:**

| Name | Type | Description |
| ---- | ---- | ----------- |
| `persona_id` | str | Unique identifier of the persona to delete |

**Returns:** `DeletedPersona` — `{"id": str, "deleted": bool}` on success.

**Raises:** `LarvaApiError` with code `PERSONA_NOT_FOUND` (100) if persona does not exist, `REGISTRY_DELETE_FAILED` (111) on deletion failure.

```python
from larva.shell.python_api import delete

result = delete("old-persona")
assert result["deleted"] is True
```

### clear(*, confirm)

Clear all registered personas from the registry.

**Parameters:**

| Name | Type | Description |
| ---- | ---- | ----------- |
| `confirm` | str | Keyword-only argument. Must be exactly `"CLEAR REGISTRY"` (safety confirmation) |

**Returns:** `int` — Number of personas that were removed.

**Raises:** `LarvaApiError` with code `INVALID_CONFIRMATION_TOKEN` (112) if confirm token does not match, `REGISTRY_DELETE_FAILED` (111) on deletion failure.

```python
from larva.shell.python_api import clear

count = clear(confirm="CLEAR REGISTRY")
print(f"Removed {count} personas")
```

### Python API Error Format

All `LarvaApiError` exceptions contain structured error info:

```python
class LarvaApiError(Exception):
    error: dict  # {"code": str, "numeric_code": int, "message": str, "details": dict}
```

Access error details:
```python
try:
    delete("nonexistent")
except LarvaApiError as e:
    assert e.error["code"] == "PERSONA_NOT_FOUND"
    assert e.error["numeric_code"] == 100
```
```
