# larva — Agent Usage Guide

**Audience:** AI agents (nervus, anima, and other opifex components) consuming larva as a tool.
**larva does:** validate, assemble, normalize, register, resolve PersonaSpec JSON.
**larva does NOT do:** call LLMs, execute agents, enforce runtime tool policy, store memory across runs.

---

## 1. How to Call larva

### Primary: MCP Server

larva runs as an MCP server (stdio, HTTP, or SSE). stdio is the default for CLI
usage. HTTP is the standard remote transport (MCP spec 2025-03-26+). SSE is legacy.
Prefer MCP for all programmatic access.

Available tools:
```
larva.validate(spec)              → ValidationReport
larva.assemble(components)        → PersonaSpec
larva.register(spec)              → {id, registered}
larva.resolve(id, overrides?)     → PersonaSpec
larva.list()                      → [{id, spec_digest, model}]
larva.delete(id)                  → {id, deleted}
larva.clear(confirm)              → {cleared, count}
larva.component_list()            → {prompts, toolsets, constraints, models}
larva.component_show(type, name)  → component content
```

### Fallback: CLI

```bash
larva validate <spec.json> [--json]
larva assemble --id <id> [--prompt <name>]... [--toolset <name>]... [--constraints <name>]... [--model <name>] [--override key=value]... [--var key=value]... [-o output.json]
larva register <spec.json> [--json]
larva resolve <id> [--override key=value]... [--json]
larva list [--json]
larva delete <id> [--json]
larva clear --confirm "CLEAR REGISTRY" [--json]
larva component list [--json]
larva component show <type>/<name> [--json]
```

Use `--json` for machine-readable output on all commands. All CLI commands exit 0 (success), 1 (domain error), 2 (input/critical failure).

### Fallback: Python API

```python
from larva.shell.python_api import (
    assemble, validate, register, resolve, list,
    delete, clear, component_list, component_show,
)
```

---

## 2. PersonaSpec — The Core Data Structure

A PersonaSpec is a flat, self-contained JSON object. All larva operations produce or consume this shape.

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code changes with read-focused tooling.",
  "prompt": "You are a senior code reviewer...",
  "model": "claude-opus-4-20250514",
  "model_params": {
    "temperature": 0.3,
    "max_tokens": 4096
  },
  "capabilities": {
    "filesystem": "read_write",
    "shell": "read_only",
    "git": "read_only"
  },
  "can_spawn": false,
  "compaction_prompt": "Summarize working context into concise carry-forward notes.",
  "spec_digest": "sha256:e3b0c442..."
}
```

**Field constraints:**
- `id`: required, must match `^[a-z0-9]+(-[a-z0-9]+)*$` (flat kebab-case, no namespaces)
- `spec_version`: must be `"0.1.0"` if present; larva sets it automatically if absent
- `spec_digest`: computed by larva during normalization (SHA-256 of canonical JSON, sorted keys, no whitespace, excluding spec_digest itself). Do not set manually.
- `side_effect_policy`: **DEPRECATED** — runtime approval policy now belongs to anima runtime controls, not larva persona artifacts
- `can_spawn`: boolean or list of persona ids the persona may spawn

**No assembly metadata in output.** No `base:`, no component references. Output is always flat.

---

## 3. Core Operations

### 3.1 validate

Check a PersonaSpec for schema conformance and semantic validity.

**MCP:**
```json
{ "spec": { "id": "my-agent", "spec_version": "0.1.0", "prompt": "You are..." } }
```

**Returns:** `ValidationReport`
```json
{
  "valid": true,
  "errors": [],
  "warnings": ["UNUSED_VARIABLES: supplied variables are not referenced by prompt: role"]
}
```

- `errors` is always present (empty list when valid).
- `warnings` is always present (only `UNUSED_VARIABLES` family in v1).
- Missing `{variable}` placeholders → `VARIABLE_UNRESOLVED` error (not a warning).

**Decision:** Use `valid` field to gate next action. `valid: true` with warnings is still valid.

---

### 3.2 assemble

Compose a PersonaSpec from named components stored in `~/.larva/components/`.

**MCP:**
```json
{
  "id": "code-reviewer",
  "prompts": ["code-reviewer", "careful-reasoning"],
  "toolsets": ["code-tools"],
  "constraints": ["strict"],
  "model": "claude-opus-4",
  "overrides": { "description": "Custom description" },
  "variables": { "role": "reviewer" }
}
```

All fields except `id` are optional.

**Returns:** Complete, validated, normalized PersonaSpec JSON (ready to register or use directly).

**Error triggers:**
- `COMPONENT_NOT_FOUND` — named component does not exist in `~/.larva/components/`
- `COMPONENT_CONFLICT` — two components set the same scalar field without an `overrides` key resolving it

**Conflict resolution:** Use `overrides` to explicitly win over conflicting component values.

---

### 3.3 register

Store a PersonaSpec in the global registry at `~/.larva/registry/`.

**MCP:**
```json
{ "spec": { <PersonaSpec> } }
```

**Returns:**
```json
{ "id": "code-reviewer", "registered": true }
```

- Spec must pass validation. larva revalidates before writing.
- Overwrites existing registration for the same `id`.
- Registry index at `~/.larva/registry/index.json` maps `id → spec_digest`.

---

### 3.4 resolve

Fetch a registered persona by id, optionally patching fields at call time.

**MCP:**
```json
{ "id": "code-reviewer", "overrides": { "model": "claude-opus-4-20250514" } }
```

**Returns:** PersonaSpec with overrides applied. `spec_digest` is recomputed after override.

**Error triggers:**
- `PERSONA_NOT_FOUND` — id not in registry

**Key behavior:** Overrides trigger revalidation and renormalization. A null/falsey override value is applied as-is (not ignored).

---

### 3.5 list

Enumerate all registered personas.

**MCP:** no parameters

**Returns:**
```json
[
  { "id": "code-reviewer", "spec_digest": "sha256:e3b0c442...", "model": "claude-opus-4-20250514" }
]
```

---

### 3.6 delete

Remove a registered persona from the registry.

**MCP:**
```json
{ "id": "old-persona" }
```

**Returns:**
```json
{ "id": "old-persona", "deleted": true }
```

**Error triggers:**
- `PERSONA_NOT_FOUND` (100) — id not in registry
- `INVALID_PERSONA_ID` (104) — id format invalid
- `REGISTRY_DELETE_FAILED` (111) — file system deletion failed

**Key behavior:** Deletion is atomic (index-first). If deletion partially fails, the registry remains consistent for `list()`.

---

### 3.7 clear

Remove ALL registered personas from the registry. Irreversible.

**MCP:**
```json
{ "confirm": "CLEAR REGISTRY" }
```

**Returns:**
```json
{ "cleared": true, "count": 7 }
```

**Safety guard:** The `confirm` parameter must be exactly `"CLEAR REGISTRY"`. Any other value is rejected immediately without touching the file system.

**Error triggers:**
- `INVALID_CONFIRMATION_TOKEN` (112) — confirm string does not match
- `REGISTRY_DELETE_FAILED` (111) — file system deletion failed (partial failure possible; `details.failed_ids` lists which ids could not be removed)

**Python API:** `confirm` is keyword-only: `clear(confirm="CLEAR REGISTRY")`

---

### 3.8 component_list

Discover all available components by type. Call this before `assemble` to know what component names are valid.

**MCP:** no parameters

**Returns:**
```json
{
  "prompts": ["code-reviewer", "architect"],
  "toolsets": ["readonly", "readwrite"],
  "constraints": ["strict", "autonomous"],
  "models": ["default", "claude-opus"]
}
```

---

### 3.9 component_show

Inspect a specific component's content.

**MCP:**
```json
{ "component_type": "prompts", "name": "code-reviewer" }
```

**Returns:** Component content dict. Shape varies by type:
- Prompt: `{"text": "You are a senior code reviewer..."}`
- Toolset: `{"capabilities": {"filesystem": "read_write", ...}}`
- Constraint: `{"can_spawn": false, "compaction_prompt": "...", ...}`
- Model: `{"model": "claude-opus-4-20250514", "model_params": {...}}`

**Error triggers:**
- `COMPONENT_NOT_FOUND` (105) — component does not exist or type is invalid

**Note:** Components are read-only through larva. larva does not create or delete components — they are managed as files in `~/.larva/components/`.

---

## 4. Component Library

Components live in `~/.larva/components/` organized by type. Component names are bare filenames without extensions.

| Type | Directory | File format | Contributes to |
|------|-----------|-------------|----------------|
| Prompt | `prompts/` | `.md` (plain text) | `prompt` |
| Toolset | `toolsets/` | `.yaml` | `capabilities` |
| Constraint | `constraints/` | `.yaml` | `can_spawn`, `compaction_prompt` |
| Model | `models/` | `.yaml` | `model`, `model_params` |

### Prompt Component (`prompts/code-reviewer.md`)
```markdown
You are a senior code reviewer. Focus on correctness over style.
Always cite specific line numbers when pointing out issues.
```

### Toolset Component (`toolsets/code-tools.yaml`)
```yaml
capabilities:
  filesystem: read_write
  shell: read_only
  git: read_only
```

### Constraint Component (`constraints/strict.yaml`)
```yaml
can_spawn: false
compaction_prompt: |
  Summarize the working context into concise carry-forward notes.
```

### Model Component (`models/claude-opus-4.yaml`)
```yaml
model: "claude-opus-4-20250514"
model_params:
  temperature: 0.3
  max_tokens: 4096
```

### Assembly Rules

- **Prompts**: Concatenated in declared order, `\n\n` separator → single `prompt` string.
- **Scalars** (`model`, `can_spawn`): Multiple component sources for same field → `COMPONENT_CONFLICT`. Resolve with `overrides`.
- **capabilities**: Multiple toolsets may merge only if no contradictory posture for same tool family. Contradiction → `COMPONENT_CONFLICT`.
- **model_params**: Deep-merged from model component. `overrides` can patch individual keys.

### Browsing Components via CLI

```bash
larva component list                          # list all components
larva component show prompts/code-reviewer    # show a prompt component
larva component show toolsets/code-tools      # show a toolset component
larva component show --json prompts/base      # machine-readable
```

---

## 5. Variable Injection

Prompt text may contain `{variable_name}` placeholders (Python `str.format_map` compatible).

**MCP assemble:**
```json
{
  "id": "project-agent",
  "prompts": ["my-prompt"],
  "variables": { "role": "reviewer", "project_name": "myapp" }
}
```

**CLI assemble:**
```bash
larva assemble --id project-agent --prompt my-prompt --var role=reviewer --var project_name=myapp
```

**Enforcement:**
- All `{variable}` placeholders in prompt text must be supplied → missing = `VARIABLE_UNRESOLVED` error
- Extra variables (provided but not referenced) → `UNUSED_VARIABLES` warning, not an error

---

## 6. Error Handling

All errors use a single envelope shape:

```json
{
  "code": "COMPONENT_CONFLICT",
  "numeric_code": 106,
  "message": "Field 'can_spawn' set by both 'constraints/strict' and 'constraints/autonomous'",
  "details": {
    "field": "can_spawn",
    "sources": ["constraints/strict", "constraints/autonomous"]
  }
}
```

**Transport wrapping:**
- MCP: error payload returned directly as above
- CLI `--json`: payload wrapped as `{ "error": <above> }`

**Error code table:**

| Code | Name | Typical cause |
|------|------|---------------|
| 10 | `INTERNAL` | Unmapped fallback |
| 100 | `PERSONA_NOT_FOUND` | `resolve` id not in registry |
| 101 | `PERSONA_INVALID` | validation failed |
| 102 | `PERSONA_CYCLE` | circular reference (reserved) |
| 103 | `VARIABLE_UNRESOLVED` | `{var}` placeholder missing from variables |
| 104 | `INVALID_PERSONA_ID` | id violates kebab-case rules |
| 105 | `COMPONENT_NOT_FOUND` | named component not on disk |
| 106 | `COMPONENT_CONFLICT` | two components set same scalar field |
| 107 | `REGISTRY_INDEX_READ_FAILED` | `~/.larva/registry/index.json` unreadable |
| 108 | `REGISTRY_SPEC_READ_FAILED` | `<id>.json` unreadable |
| 109 | `REGISTRY_WRITE_FAILED` | cannot write spec file |
| 110 | `REGISTRY_UPDATE_FAILED` | cannot update index |
| 111 | `REGISTRY_DELETE_FAILED` | persona file deletion failed |
| 112 | `INVALID_CONFIRMATION_TOKEN` | confirm token for `clear` does not match |

---

## 7. File System Layout

```
~/.larva/
  components/
    prompts/<name>.md          # prompt fragments
    toolsets/<name>.yaml       # tool posture maps
    constraints/<name>.yaml    # can_spawn + compaction_prompt
    models/<name>.yaml         # model + model_params
  registry/
    <id>.json                  # one file per registered persona
    index.json                 # {id: spec_digest} mapping
```

---

## 8. Common Workflows

### Workflow A: Generate and register a new persona

```
1. Build PersonaSpec JSON (LLM-generated or hand-written)
2. larva.validate(spec) → check valid=true
3. larva.register(spec) → get id back
4. larva.resolve(id) → confirm round-trip
```

### Workflow B: Compose from components

```
1. larva.component_list() → discover available components
2. larva.assemble({id, prompts, toolsets, constraints, model}) → PersonaSpec
3. Inspect returned spec; adjust overrides if COMPONENT_CONFLICT
4. larva.register(spec)
```

### Workflow C: Load for agent execution

```
1. larva.resolve(id) → PersonaSpec
   OR
   larva.resolve(id, overrides={model: "..."}) → PersonaSpec with runtime patch
2. Pass spec to anima or agent runner
```

### Workflow D: Discover available personas

```
1. larva.list() → [{id, spec_digest, model}, ...]
2. larva.resolve(id) → full spec for chosen persona
```

### Workflow E: Remove a persona

```
1. larva.delete(id) → {id, deleted: true}
```

### Workflow F: Reset registry

```
1. larva.clear(confirm="CLEAR REGISTRY") → {cleared: true, count: N}
```

---

## 9. Critical Constraints

- **No LLM calls.** larva is pure persona management. It does not execute or call any model.
- **No inheritance.** There is no `base:` field. Composition is explicit.
- **Error-on-conflict.** Conflicting scalar fields from multiple components always error. Use `overrides` to resolve.
- **Ids are global and flat.** No namespacing in v1. Ids must be kebab-case: `^[a-z0-9]+(-[a-z0-9]+)*$`.
- **spec_version is schema identity, not persona revisioning.** In v1 it is pinned to `"0.1.0"`, defaults when absent, and is not auto-bumped by clone/update.
- **spec_digest is always recomputed.** Do not pass stale digest values; larva overwrites them.
- **Override revalidation is mandatory.** When overrides are applied via `resolve`, the result is revalidated and renormalized. Invalid overrides produce `PERSONA_INVALID`.
- **No cross-run persona memory.** Persona changes require explicit `register`. There is no hidden mutable state.
- **Components are read-only.** larva reads components from `~/.larva/components/` but does not create, modify, or delete them. Component file management is external.
- **`clear` requires confirmation.** The confirm token `"CLEAR REGISTRY"` must be passed exactly. This is irreversible.
