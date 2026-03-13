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
  "warnings": ["model 'gpt-6' not in known models list"]
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

```json
{
  "valid": true,
  "errors": [],
  "warnings": ["model 'gpt-6' not in known models list"]
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
shell scripting compatibility. With `--json`, errors include the full
error code from `errors.yaml` (100-110) in the JSON body. See Section G.

### `larva validate <spec.json> [--json]`

Validate a PersonaSpec JSON file. Checks schema conformance and semantic rules.

Exit codes: 0 valid, 1 invalid, 2 not found.

### `larva assemble [OPTIONS] -o <output>`

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
| `-o, --output` | path | Output file (default: stdout) |

Exit codes: 0 success, 1 error.

### `larva register <spec.json> [--json]`

Register a PersonaSpec in the global registry.

Exit codes: 0 success, 1 error.

### `larva resolve <id> [--override key=value...] [--json]`

Resolve a persona from the registry, optionally with overrides.

Exit codes: 0 success, 1 not found.

### `larva list [--json]`

List all registered personas.

Exit codes: 0 success.

### `larva component list [--json]`

List all available components.

### `larva component show <type>/<name> [--json]`

Show a component's content. Type is one of: `prompts`, `toolsets`,
`constraints`, `models`.

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

- CLI: `larva assemble --prompt my-prompt --var role=reviewer --var project_name=myapp`
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

If an app-layer error `code` is not mapped in this table, `numeric_code` defaults to `10` (`INTERNAL`).

### Error Response Format (--json / MCP)

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
