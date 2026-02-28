# larva

Persona compiler for LLM applications. Manage, validate, and compile YAML persona definitions into structured PersonaSpec JSON artifacts — then install them into any AI coding tool.

larva treats agent personas as source code: version-controlled YAML files that compile into deterministic, content-addressed build artifacts.

## Features

- **YAML persona definitions** with inheritance and composition
- **Variable injection** with whitelist enforcement
- **Install** into Claude Code, OpenCode, Codex, Goose, Cursor, Windsurf, Cline
- **Format normalization** (`larva fmt`) for byte-stable hashing
- **Content-addressed locking** (`larva lock`) with `spec_id` + `spec_digest`
- **Static validation** for catching errors before runtime
- **Custom templates** (Jinja2) for new export targets

## Quick Start

```bash
pip install larva
```

### Define a persona

```yaml
# personas/code-reviewer.yaml
spec_version: "1"
base: base-engineer
system_prompt: |
  You are a senior code reviewer for the {project_name} project.
  Review code for correctness, security, and maintainability.
model: claude-sonnet-4-20250514
tools_profile: read-only
budget:
  max_tokens: 8192
```

### Compile it

```bash
larva compile code-reviewer --vars project_name=myapp
```

### Install into Claude Code

```bash
# Writes .claude/agents/code-reviewer.md with proper frontmatter
larva install claude-code code-reviewer --vars project_name=myapp
```

### Install into other tools

```bash
larva install opencode code-reviewer --vars project_name=myapp
larva install codex code-reviewer --vars project_name=myapp
larva install cursor code-reviewer --vars project_name=myapp
larva install goose code-reviewer --vars project_name=myapp
```

### Dynamic injection (piping)

```bash
# Inject into Claude Code at launch without writing files
claude --agents "$(larva install claude-code code-reviewer --stdout)"
```

## Persona Inheritance

Personas can inherit from a base, overriding specific fields:

```yaml
# personas/base-engineer.yaml
spec_version: "1"
system_prompt: |
  You are a software engineer. Write clean, tested code.
model: claude-sonnet-4-20250514

# personas/senior-engineer.yaml
base: base-engineer
system_prompt: |
  You are a senior software engineer. Write clean, tested code.
  Mentor junior developers. Make architecture decisions.
budget:
  max_tokens: 16384
```

## CLI Reference

```
larva compile <name> [--vars key=val...] [--output path] [--json]
larva validate <name_or_file> [--json]
larva fmt <name_or_file>
larva lock <name> [--output path] [--json]
larva list [--json]
larva show <name> [--json]
larva install <target> <name> [--vars key=val...] [--project | --user] [--stdout] [--json]
larva install --template <path> <name> --output <path>
```

Targets: `claude-code`, `opencode`, `codex`, `goose`, `cursor`, `windsurf`, `cline`.

All commands support `--json` for machine-readable output.

## License

MIT
