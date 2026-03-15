# larva

PersonaSpec toolkit for LLM agents. Validate, assemble, normalize, register, and resolve canonical persona specifications.

## What larva Does

larva manages **PersonaSpec** — structured JSON definitions for AI agent personas. It provides:

- **Validate** — schema + semantic checks on PersonaSpec JSON
- **Assemble** — compose personas from reusable components (prompts, toolsets, constraints, models)
- **Register / Resolve** — store and retrieve personas from a global registry (`~/.larva/`)
- **Clone / Update / Delete** — full lifecycle management
- **Export** — bulk export for integrations
- **MCP server** — programmatic access for other tools

## Install

```bash
pip install larva
```

## Quick Start

```bash
# Register a persona
cat <<'EOF' > my-agent.json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code for correctness and style",
  "prompt": "You are a senior code reviewer...",
  "model": "openai/gpt-5.4",
  "can_spawn": false,
  "side_effect_policy": "read_only"
}
EOF

larva validate my-agent.json
larva register my-agent.json
larva resolve code-reviewer

# List all personas
larva list

# Clone and experiment
larva clone code-reviewer code-reviewer-exp
larva update code-reviewer-exp --set model=openai/gpt-5.4-pro

# Export all
larva export --all --json
```

## Interfaces

### MCP Server (primary)

```
larva.validate(spec)              → ValidationReport
larva.assemble(components)        → PersonaSpec
larva.register(spec)              → {id, registered}
larva.resolve(id, overrides?)     → PersonaSpec
larva.list()                      → [{id, spec_digest, model}]
larva.update(id, patches)         → PersonaSpec
larva.clone(source_id, new_id)    → PersonaSpec
larva.delete(id)                  → {id, deleted}
larva.clear(confirm)              → {cleared, count}
larva.export(all?, ids?)          → [PersonaSpec, ...]
larva.component_list()            → {prompts, toolsets, constraints, models}
larva.component_show(type, name)  → component content
```

### CLI

```bash
larva validate <spec.json> [--json]
larva register <spec.json> [--json]
larva resolve <id> [--override key=value]... [--json]
larva list [--json]
larva update <id> --set key=value [--set ...]  [--json]
larva clone <source-id> <new-id> [--json]
larva delete <id> [--json]
larva clear --confirm "CLEAR REGISTRY" [--json]
larva export --all [--json]
larva export --id <id> [--id <id>]... [--json]
larva assemble --id <id> [--prompt <name>]... [--toolset <name>]... [--constraints <name>]... [--model <name>] [--override key=value]... [--var key=value]... [-o output.json]
larva component list [--json]
larva component show <type>/<name> [--json]
```

### Python Library

```python
from larva.shell.python_api import (
    validate, assemble, register, resolve, list,
    update, clone, delete, clear,
    export_all, export_ids,
    component_list, component_show,
)

# Register
result = validate({"id": "my-agent", "spec_version": "0.1.0", "prompt": "..."})
register({"id": "my-agent", "spec_version": "0.1.0", "prompt": "..."})

# Resolve
spec = resolve("my-agent")

# Clone + update
clone("my-agent", "my-agent-exp")
updated = update("my-agent-exp", {"model": "openai/gpt-5.4-pro"})

# Export all
all_specs = export_all()
```

## Component Library

```
~/.larva/
  components/
    prompts/           # Prompt text fragments (.md files)
    toolsets/           # Tool permission maps (.yaml)
    constraints/        # can_spawn + side_effect_policy (.yaml)
    models/             # Model + inference params (.yaml)
  registry/             # Registered PersonaSpec JSON files
```

```bash
# Assemble from components
larva assemble --id code-reviewer \
  --prompt code-reviewer --prompt careful-reasoning \
  --toolset read-only \
  --constraints strict \
  --model claude-opus

# Browse components
larva component list
larva component show prompts/code-reviewer
```

## Web UI

A browser-based persona manager is included in `contrib/web/`:

```bash
pip install fastapi uvicorn
python contrib/web/server.py
# → opens http://localhost:7400
```

## OpenCode Plugin

An [OpenCode](https://opencode.ai) plugin that registers larva personas as agents:

```jsonc
// .opencode/opencode.json
{
  "plugin": ["file:///path/to/larva/contrib/opencode-plugin/larva.ts"]
}
```

See [contrib/opencode-plugin/README.md](contrib/opencode-plugin/README.md) for details.

## Architecture

larva follows a strict layered architecture enforced by [Invar](https://github.com/tefx/invar-tools):

| Layer | Path | Rules |
|-------|------|-------|
| Core | `src/larva/core/` | Pure logic, `@pre`/`@post` contracts, no I/O |
| Shell | `src/larva/shell/` | I/O adapters, returns `Result[T, E]` |
| App | `src/larva/app/` | Orchestration facade |

## Key Design Decisions

- **Composition, not inheritance.** No `base:` field. Components are orthogonal building blocks.
- **Error-on-conflict.** Two components setting the same scalar field → assembly fails. Use `overrides`.
- **Authority, not runtime.** larva owns persona definitions; execution belongs elsewhere.
- **No cross-run mutable state.** Persona changes require explicit `register`.

## License

AGPL-3.0-or-later
