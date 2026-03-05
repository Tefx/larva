# larva -- Interface Specification

This document defines the public interfaces of the larva PersonaSpec toolkit.

larva validates, assembles, normalizes, and registers PersonaSpec JSON.
It provides a component library for reusable prompt fragments, tool configs,
and constraint bundles. It does not call LLMs, does not run agents, and has
no runtime dependencies on the other opifex components.

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
```json
{
  "valid": true,
  "warnings": ["model 'gpt-6' not in known models list"]
}
```
or
```json
{
  "valid": false,
  "errors": ["spec_version must be '0.1.0'", "budget must be >= 0"]
}
```

### larva.assemble(components)

Assemble a PersonaSpec from named components.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `name` | string | yes | Persona name |
| `prompts` | list[string] | no | Prompt component names (concatenated in order) |
| `toolset` | string | no | Toolset component name |
| `constraints` | string | no | Constraint component name |
| `model` | string | no | Model component name |
| `overrides` | object | no | Field overrides (wins over components) |
| `variables` | object | no | Variable substitution in prompt text |

**Returns:** Complete PersonaSpec JSON (validated, with spec_id and spec_digest).

**Error:** `COMPONENT_NOT_FOUND` if a referenced component does not exist.
`COMPONENT_CONFLICT` if two components set the same scalar field without
an explicit override.

### larva.resolve(name, overrides?)

Resolve a pre-registered persona by name.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `name` | string | yes | Persona name in registry |
| `overrides` | object | no | Field overrides applied to the resolved spec |

**Returns:** PersonaSpec JSON. If overrides are applied, spec_digest is recomputed.

**Error:** `PERSONA_NOT_FOUND` if name not in registry.

### larva.register(spec)

Register a PersonaSpec in the global registry.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `spec` | object | yes | PersonaSpec JSON (must pass validation) |

**Returns:**
```json
{
  "spec_id": "code-reviewer@a1b2c3d4",
  "registered": true
}
```

### larva.list()

List all registered personas.

**Returns:**
```json
[
  {
    "name": "code-reviewer",
    "spec_id": "code-reviewer@a1b2c3d4",
    "spec_digest": "sha256:e3b0c442...",
    "model": "claude-opus-4-20250514"
  }
]
```

### larva.export(name, format)

Export a persona to a human-readable or tool-native format.

**Parameters:**

| Name | Type | Required | Description |
| ---- | ---- | -------- | ----------- |
| `name` | string | yes | Persona name in registry |
| `format` | string | yes | `claude-md`, `agents-md`, `summary` |

**Returns:**
```json
{
  "format": "claude-md",
  "content": "---\nname: code-reviewer\n..."
}
```

---

## B. CLI Interface

All commands support `--json` for machine-readable JSON output on stdout.

**Exit code strategy:** CLI uses standard small exit codes (0/1/2) for
shell scripting compatibility. With `--json`, errors include the full
error code from `errors.yaml` (100-106) in the JSON body. See Section H.

### `larva validate <spec.json> [--json]`

Validate a PersonaSpec JSON file. Checks schema conformance and semantic rules.

Exit codes: 0 valid, 1 invalid, 2 not found.

### `larva assemble [OPTIONS] -o <output>`

Assemble a PersonaSpec from components.

| Flag | Type | Description |
| ---- | ---- | ----------- |
| `--name` | str | Persona name (required) |
| `--prompt` | str (repeatable) | Prompt component name |
| `--toolset` | str | Toolset component name |
| `--constraints` | str | Constraint component name |
| `--model` | str | Model component name or literal model identifier |
| `--override` | str (repeatable) | Field override: `key=value` |
| `--var` | str (repeatable) | Variable substitution: `key=value` |
| `-o, --output` | path | Output file (default: stdout) |

Exit codes: 0 success, 1 error.

### `larva register <spec.json> [--json]`

Register a PersonaSpec in the global registry.

Exit codes: 0 success, 1 error.

### `larva resolve <name> [--override key=value...] [--json]`

Resolve a persona from the registry, optionally with overrides.

Exit codes: 0 success, 1 not found.

### `larva list [--json]`

List all registered personas.

Exit codes: 0 success.

### `larva export <name> --format <format> [--json]`

Export a persona to a target format.

Formats: `claude-md`, `agents-md`, `summary`.

Exit codes: 0 success, 1 not found, 2 format not recognized.

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
| Prompt | `prompts/` | `.md` (plain text) | `system_prompt` |
| Toolset | `toolsets/` | `.yaml` | `tools_profile` |
| Constraint | `constraints/` | `.yaml` | `budget`, `can_spawn`, `scratchpad_*` |
| Model | `models/` | `.yaml` | `model`, `model_params` |

### Prompt Component

Just a markdown file. No wrapper, no metadata. The content IS the prompt.

```markdown
You are a senior code reviewer. Focus on correctness over style.
Always cite specific line numbers when pointing out issues.
```

### Toolset Component

```yaml
tools_profile: "filesystem,shell,git"
```

### Constraint Component

```yaml
budget: 30000
can_spawn: false
```

### Model Component

```yaml
model: "claude-opus-4-20250514"
model_params:
  temperature: 0.3
  max_tokens: 4096
```

### Assembly Rules

- **Prompts**: Concatenated in declared order (`\n\n` separator) → `system_prompt`
- **Scalars** (model, budget, tools_profile, can_spawn, sandbox, node,
  scratchpad_ref): Multiple sources for same field → error (`COMPONENT_CONFLICT`).
  Resolve via `overrides`.
- **model_params**: Deep-merged from model component. `overrides` can patch keys.
- **scratchpad_policy**: No merge. Single source or explicit override.

---

## D. Global Registry

### Location

`~/.larva/registry/`

Each registered persona is a JSON file: `<name>.json`.
An `index.json` maps names to spec_ids.

### Resolution

1. `larva resolve <name>` reads `~/.larva/registry/<name>.json`
2. If `overrides` are provided, fields are patched and spec_digest recomputed
3. Returns complete PersonaSpec JSON

### Name Rules

Names must match `[a-z0-9][a-z0-9-]*[a-z0-9]` (lowercase, hyphens,
no leading/trailing hyphens, minimum 2 characters).

---

## E. PersonaSpec Output Format

The output artifact. All assembly machinery is erased — the output is
a flat, self-contained PersonaSpec JSON.

```json
{
  "spec_version": "0.1.0",
  "name": "code-reviewer",
  "system_prompt": "You are a senior code reviewer...",
  "model": "claude-opus-4-20250514",
  "model_params": {
    "temperature": 0.3,
    "max_tokens": 4096
  },
  "tools_profile": "filesystem,shell,git",
  "budget": 50000,
  "can_spawn": false,
  "spec_id": "code-reviewer@a1b2c3d4",
  "spec_digest": "sha256:e3b0c442..."
}
```

No `base`, no component references, no assembly metadata in the output.

`spec_id` and `spec_digest` are optional in raw input (e.g., hand-written
or LLM-generated JSON passed to `larva.validate`). larva computes them
during normalization. All larva output (assemble, resolve, register)
always includes both fields.

### Normalization

- `spec_id`: `{name}@{short_hash}` where hash is derived from structural
  fields (name + model + tools_profile + can_spawn). Survives prompt edits.
- `spec_digest`: SHA-256 of canonical JSON (sorted keys, no whitespace,
  excluding the spec_digest field itself).
- `spec_version`: Set to `"0.1.0"` if not present.

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

## G. Export Formats

### Supported Formats

| Format | Output | Use case |
|--------|--------|----------|
| `claude-md` | Markdown + YAML frontmatter | Claude Code `.claude/agents/` |
| `agents-md` | AGENTS.md section | General agent docs |
| `summary` | One-line summary | Listing, dashboards |

Export is for human auditing of LLM-generated personas, not runtime use.

---

## H. Error Codes

larva uses the 100-range from `contracts/errors.yaml`.

| Code | Name | Description |
|------|------|-------------|
| 100 | `PERSONA_NOT_FOUND` | Persona name not found in registry |
| 101 | `PERSONA_INVALID` | PersonaSpec validation failed |
| 102 | `PERSONA_CYCLE` | Circular reference detected (reserved) |
| 103 | `VARIABLE_UNRESOLVED` | Unresolved variable in prompt text |
| 104 | `TARGET_UNKNOWN` | Export format not recognized |
| 105 | `COMPONENT_NOT_FOUND` | Component referenced in assembly not found |
| 106 | `COMPONENT_CONFLICT` | Multiple components set the same scalar field |

### Error Response Format (--json / MCP)

```json
{
  "error": {
    "code": "COMPONENT_CONFLICT",
    "numeric_code": 106,
    "message": "Field 'budget' set by both 'constraints/strict' and 'constraints/autonomous'",
    "details": {
      "field": "budget",
      "sources": ["constraints/strict", "constraints/autonomous"]
    }
  }
}
```
