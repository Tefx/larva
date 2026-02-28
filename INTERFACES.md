# larva Interface Specification

This document defines the public interfaces of the larva persona compiler.

larva is a **pure compiler**. It reads persona YAML definitions, resolves
inheritance, injects variables, validates schemas, and outputs PersonaSpec
JSON or tool-native agent configurations. It does not call LLMs, does not
run agents, and has no runtime dependencies on the other opifex components.

---

## A. CLI Interface

All commands support `--json` for machine-readable JSON output on stdout.

### `larva compile <name> [--vars key=val...] [--output path] [--json]`

Compile a persona YAML definition into a PersonaSpec JSON artifact.

- `<name>` -- persona name (resolved from registry) or path to `.yaml` file
- `--vars key=val` -- runtime variable injection (repeatable)
- `--output path` -- write output to file (default: stdout)
- `--json` -- JSON output format

Exit codes: 0 success, 1 error.

### `larva validate <name_or_file> [--json]`

Static validation of a persona definition. Checks schema conformance,
inheritance resolution, variable completeness (without injecting values),
and cycle detection.

- `<name_or_file>` -- persona name or path to `.yaml` file
- `--json` -- JSON output: `{valid: bool, errors: [...]}`

Exit codes: 0 valid, 1 invalid, 2 not found.

### `larva fmt <name_or_file>`

Normalize persona YAML format for byte-stable hashing. Applies canonical
key ordering, consistent quoting, and normalized whitespace. Preserves
comments (uses ruamel.yaml round-trip mode). Writes result back to the
source file (in-place).

- `<name_or_file>` -- persona name or path to `.yaml` file

Exit codes: 0 success, 1 error.

### `larva lock <name> [--output path] [--json]`

Generate a lock file with content-addressed artifact identification.
Compiles the persona, computes `spec_id` (deterministic identifier) and
`spec_digest` (sha256 of canonical JSON).

- `<name>` -- persona name
- `--output path` -- write lock file to path (default: `<name>.lock.json`)
- `--json` -- JSON output on stdout instead of file

Exit codes: 0 success, 1 error.

### `larva list [--json]`

List all available personas in the registry.

- `--json` -- JSON output: `[{name, base, model, ...}]`

Exit codes: 0 success, 1 error.

### `larva show <name> [--json]`

Show detailed information about a persona definition (pre-compilation).

- `<name>` -- persona name
- `--json` -- JSON output

Exit codes: 0 success, 1 not found.

### `larva install <target> <name> [OPTIONS]`

Compile a persona and install it into a target tool's configuration
directory in that tool's native format.

```
larva install <target> <name> [--vars key=val...] [--project | --user] [--stdout] [--json]
```

- `<target>` -- one of: `claude-code`, `opencode`, `codex`, `goose`,
  `cursor`, `windsurf`, `cline`
- `<name>` -- persona name
- `--vars key=val` -- variable injection (repeatable)
- `--project` -- install to project-level config (default)
- `--user` -- install to user-level config
- `--stdout` -- print generated content to stdout instead of writing file
  (for piping into other tools or dynamic injection)
- `--json` -- output `{"target": "...", "path": "...", "content": "..."}`

Exit codes: 0 success, 1 error, 2 target not recognized.

#### Target details

| Target | Project path | User path | Format |
|--------|-------------|-----------|--------|
| `claude-code` | `.claude/agents/<name>.md` | `~/.claude/agents/<name>.md` | Markdown + YAML frontmatter |
| `opencode` | `.opencode/agents/<name>.md` | `~/.config/opencode/agents/<name>.md` | Markdown + YAML frontmatter |
| `codex` | `.agents/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` | Agent Skills SKILL.md |
| `goose` | `.goose/recipes/<name>.yaml` | `~/.config/goose/recipes/<name>.yaml` | Goose recipe YAML |
| `cursor` | `.cursor/rules/<name>.mdc` | — | MDC (Markdown + YAML frontmatter) |
| `windsurf` | `.windsurf/rules/<name>.md` | — | Markdown |
| `cline` | `.clinerules/<name>.md` | — | Markdown |

#### PersonaSpec → target format mapping

| PersonaSpec field | Claude Code | OpenCode | Codex (SKILL.md) | Goose recipe |
|-------------------|------------|----------|-------------------|-------------|
| `name` | frontmatter `name` | filename | frontmatter `name` | `name` |
| `system_prompt` | Markdown body | Markdown body | Markdown body | `instructions` |
| `model` | frontmatter `model` | frontmatter `model` | — (not in spec) | `settings.goose_model` |
| `tools_profile` | frontmatter `tools` | frontmatter `tools` | frontmatter `allowed-tools` | `extensions` |
| `budget` | — | — | — | — |
| `can_spawn` | — (implicit via tools) | — | — | `sub_recipes` |

### `larva install --template <path> <name> [OPTIONS]`

Install using a custom Jinja2 template. The template receives the compiled
PersonaSpec as context.

- `--template path` -- path to a `.j2` template file
- `--output path` -- write result to this path (required with `--template`)

---

## B. Persona YAML Format

Persona definitions are YAML files stored in the persona registry.

### Full Schema

```yaml
# Required
spec_version: "0.1.0"                # Schema version (semver)
system_prompt: |                     # System prompt text
  You are a {role} for {project}.    # Supports {variable} injection

# Optional -- inheritance
base: parent-persona-name            # Inherits from parent, overrides listed fields

# Optional -- model configuration
model: claude-sonnet-4-20250514      # Target LLM model identifier

# Optional -- tool access
tools_profile: coder                 # tela profile name or tool set identifier

# Optional -- execution context
node: default                        # Execution node identifier
sandbox: docker                      # Sandbox strategy: "docker", "bubblewrap", or "none"

# Optional -- scratchpad
scratchpad_ref: shared-notes         # Logical scratchpad reference
scratchpad_policy:                   # Scratchpad access policy (object)
  mode: append                       #   Write mode: "append", "overwrite", "versioned"
  max_size: "1MB"                    #   Maximum size (optional)
  format: markdown                   #   Content format (optional)
  retention: "7d"                    #   Retention policy (optional)

# Optional -- resource limits
budget: 8192                         # Token budget limit (integer)

# Optional -- agent spawning
can_spawn:                           # true = any, false = none, list = named allowlist
  - sub-agent-name
  - another-agent
# can_spawn: true                   # Alternative: allow spawning any persona
```

### Field Semantics

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `spec_version` | `str` | required | Schema version (semver). Must be `"0.1.0"`. |
| `system_prompt` | `str` | required | System prompt text. May contain `{variable}` placeholders. |
| `base` | `str \| null` | `null` | Parent persona name for inheritance. |
| `model` | `str \| null` | `null` | Target LLM model identifier. |
| `tools_profile` | `str \| null` | `null` | Tool access profile name. |
| `node` | `str \| null` | `null` | Execution node identifier. |
| `sandbox` | `str \| null` | `null` | Sandbox strategy: `docker`, `bubblewrap`, or `none`. |
| `scratchpad_ref` | `str \| null` | `null` | Scratchpad reference. |
| `scratchpad_policy` | `object \| null` | `null` | Scratchpad access policy. Object with `mode`, `max_size`, `format`, `retention`. |
| `budget` | `int \| null` | `null` | Token budget limit. |
| `can_spawn` | `bool \| list[str] \| null` | `null` | Spawn permission. `true` = any, `false`/`null` = forbidden, `list` = named allowlist. |

### Inheritance Rules

1. `base: parent_name` resolves `parent_name.yaml` in the same registry directory.
2. All fields except `spec_version` and `base` are inherited from the parent.
3. Child fields override parent fields (no deep merge -- full replacement at field level).
4. `system_prompt` is fully replaced, not appended.
5. Inheritance chains are resolved recursively (grandparent -> parent -> child).
6. Circular inheritance is a compile-time error (`PERSONA_CYCLE`).

---

## C. PersonaSpec Output Format

The compiled output artifact. All optional fields that were `null` after
compilation are omitted from the output.

```json
{
  "spec_version": "0.1.0",
  "name": "code-reviewer",
  "system_prompt": "You are a senior code reviewer for the myapp project.\n...",
  "model": "claude-sonnet-4-20250514",
  "tools_profile": "read-only",
  "budget": 8192
}
```

### Lock File Format

```json
{
  "spec_id": "code-reviewer@a1b2c3d4",
  "spec_digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "locked_at": "2026-02-28T10:30:00Z",
  "spec": { "...PersonaSpec as above..." }
}
```

- `spec_id`: `<name>@<first 8 hex chars of spec_digest>`
- `spec_digest`: `sha256:<hex digest of canonical JSON of spec>`
- `locked_at`: ISO 8601 UTC timestamp
- `spec`: the full PersonaSpec object

---

## D. Persona Registry

### Resolution

1. Check `$LARVA_PERSONAS` environment variable for registry directory path.
2. Fall back to `./personas/` relative to the current working directory.
3. Persona name `foo` resolves to `<registry_dir>/foo.yaml`.

### File Naming

- File names are the persona name with `.yaml` extension.
- Names must match `[a-z0-9][a-z0-9-]*[a-z0-9]` (lowercase, hyphens,
  no leading/trailing hyphens, minimum 2 characters).

### Inheritance Resolution

- `base: parent_name` resolves to `<registry_dir>/parent_name.yaml`.
- Parent must exist in the same registry directory.
- Maximum inheritance depth: 10 (to prevent deep chains).

---

## E. Variable Injection

### Syntax

Variables in `system_prompt` use `{variable_name}` syntax (Python
`str.format_map` compatible).

```yaml
system_prompt: |
  You are a {role} working on {project_name}.
```

### Injection

- CLI: `larva compile my-persona --vars role=reviewer project_name=myapp`
- Python: `larva.compile("my-persona", vars={"role": "reviewer", "project_name": "myapp"})`

### Whitelist Enforcement

Variable injection is **whitelist-only**:
- All `{variable_name}` placeholders in the system_prompt are extracted
  at compile time.
- All extracted variables must be provided via `--vars` or the `vars`
  parameter.
- Unresolved variables produce a `VARIABLE_UNRESOLVED` error with the
  list of missing variable names.
- Extra variables (provided but not referenced) are silently ignored.

---

## F. Install Templates

larva uses Jinja2 templates to render PersonaSpec into tool-native formats.
Templates are bundled with the package in `src/larva/templates/`.

### Bundled templates

| File | Target | Output format |
|------|--------|---------------|
| `claude-code.md.j2` | Claude Code | `.claude/agents/<name>.md` with YAML frontmatter |
| `opencode.md.j2` | OpenCode | `.opencode/agents/<name>.md` with YAML frontmatter |
| `codex-skill.md.j2` | Codex CLI | `.agents/skills/<name>/SKILL.md` (Agent Skills format) |
| `goose-recipe.yaml.j2` | Goose | Goose recipe YAML |
| `cursor.mdc.j2` | Cursor | `.cursor/rules/<name>.mdc` with frontmatter |
| `windsurf.md.j2` | Windsurf | `.windsurf/rules/<name>.md` |
| `cline.md.j2` | Cline | `.clinerules/<name>.md` |

### Example: Claude Code output

For a persona named `code-reviewer`, `larva install claude-code code-reviewer`
generates:

```markdown
---
name: code-reviewer
description: Senior code reviewer for the myapp project
model: sonnet
tools: Read, Grep, Glob, Bash
maxTurns: 50
---

You are a senior code reviewer for the myapp project.
Review code for correctness, security, and maintainability.
Be thorough but constructive.
```

### Example: Codex SKILL.md output

```markdown
---
name: code-reviewer
description: |
  Senior code reviewer. Use when reviewing PRs or code changes.
allowed-tools: Bash(git:*) Read
---

## Instructions

You are a senior code reviewer for the myapp project.
Review code for correctness, security, and maintainability.
Be thorough but constructive.
```

### Custom templates

`larva install --template <path> <name>` renders a user-provided Jinja2
template with the compiled PersonaSpec as context. This enables
project-specific or new-tool export formats without modifying larva.

Available template variables:

| Variable | Type | Description |
|----------|------|-------------|
| `spec` | PersonaSpec | The full compiled PersonaSpec object |
| `spec.name` | str | Persona name |
| `spec.system_prompt` | str | Compiled system prompt (variables injected) |
| `spec.model` | str \| None | Model identifier |
| `spec.tools_profile` | str \| None | Tool profile name |
| `spec.budget` | int \| None | Token budget limit |
| `spec.can_spawn` | bool \| list[str] \| None | Spawn permission |
| `spec.sandbox` | bool \| None | Sandbox flag |
| `spec.scratchpad_ref` | str \| None | Scratchpad reference |

---

## G. Dynamic Persona Injection (via other tools)

larva itself does not call LLMs or inject personas at runtime. Dynamic
injection is achieved by piping larva output into tools that support it.

### Claude Code: `--agents` flag

```bash
# Compile persona and inject into Claude Code at launch
larva install claude-code reviewer --stdout | \
  claude --agents "$(cat)"  --task "Review PR #123"
```

Or programmatically (nervus / anima):

```bash
SPEC=$(larva compile reviewer --json)
claude --agents "{\"reviewer\": $(larva install claude-code reviewer --json | jq .content)}" \
  --task "Review PR #123"
```

### OpenCode: `OPENCODE_CONFIG_INLINE` env var

```bash
AGENT_JSON=$(larva install opencode reviewer --json | jq -c '{agent: {(.target_name): .content_parsed}}')
OPENCODE_CONFIG_INLINE="$AGENT_JSON" opencode
```

### Codex: file-based (write then run)

```bash
larva install codex reviewer --project
codex --enable skills "Review the latest PR"
```

### anima: direct PersonaSpec consumption

```bash
larva compile reviewer --output /tmp/reviewer.json
anima run --persona-file /tmp/reviewer.json --task "Review PR #123"
```

anima accepts PersonaSpec JSON natively — no install step needed.

---

## H. Dynamic Persona Generation (outside larva)

larva does not generate personas. Dynamic generation is the responsibility
of the runtime layer (anima / nervus):

1. nervus dispatches an anima agent with a meta-task: "generate a
   persona YAML for: <description>"
2. The anima agent (which has pydantic-ai / LLM access) produces a
   persona YAML file
3. nervus calls `larva validate` to verify the generated YAML
4. nervus calls `larva compile` to produce the PersonaSpec
5. nervus dispatches the actual agent using the compiled PersonaSpec

This keeps larva as a pure compiler with zero LLM dependencies. The
PersonaSpec schema supports optional provenance fields for generated
personas:

```yaml
# These fields are set by the generator, not by larva
_generated: true                     # Marks this as LLM-generated
_source_description: "a code reviewer that focuses on security"
_generated_by: "anima:ag_abc123"     # Which agent generated this
_generated_at: "2026-02-28T10:30:00Z"
```

Fields prefixed with `_` are metadata preserved through compilation but
not included in the PersonaSpec output JSON. They are recorded in lock
files for audit purposes.

---

## I. Error Codes

| Code | Description | Context |
|------|-------------|---------|
| `PERSONA_NOT_FOUND` | Persona name does not resolve to a file in the registry. | compile, validate, lock, show, install |
| `PERSONA_INVALID` | Persona YAML fails schema validation. | compile, validate |
| `PERSONA_CYCLE` | Circular inheritance detected in `base` chain. | compile, validate |
| `VARIABLE_UNRESOLVED` | One or more `{variable}` placeholders have no provided value. | compile |
| `TARGET_UNKNOWN` | Install target not recognized. | install |

### Error Response Format (JSON mode)

```json
{
  "error": {
    "code": "VARIABLE_UNRESOLVED",
    "message": "Unresolved variables in system_prompt: role, project_name",
    "details": {
      "missing_variables": ["role", "project_name"]
    }
  }
}
```
