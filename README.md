# larva

PersonaSpec toolkit for LLM agents. Validate, assemble, register, and export agent persona specifications.

Part of the [opifex](https://github.com/tefx/opifex) system — four independent Unix tools composing into an autonomous agent OS.

## What larva Does

- **Validate** any PersonaSpec JSON (schema + semantic checks)
- **Assemble** PersonaSpec from reusable components (prompt fragments, toolsets, constraints)
- **Register** pre-compiled personas in a global registry (`~/.larva/`)
- **Resolve** personas by name with optional runtime overrides
- **Export** to CLAUDE.md, AGENTS.md, and other tool-native formats
- **MCP server** for programmatic access by nervus, anima, and other tools

## Key Design Decisions

- **Composition, not inheritance.** No `base:` field. Components are orthogonal building blocks assembled explicitly.
- **Personas are LLM-generated, not hand-written.** larva's value is validation and consistency, not authoring ergonomics.
- **Error-on-conflict.** When two components set the same scalar field, assembly fails. Explicit overrides resolve conflicts.
- **Global registry.** Personas live in `~/.larva/registry/`. anima loads one persona per instance — registry size has zero context cost.
- **MCP-first interface.** Other opifex components call larva tools via MCP.

## Interfaces

### MCP Server (primary)

```
larva.validate(spec)          → Ok | ValidationErrors
larva.assemble(components)    → PersonaSpec JSON
larva.resolve(name)           → PersonaSpec JSON (from registry)
larva.register(spec)          → spec_id
larva.list()                  → [{name, spec_id, spec_digest, model}]
larva.export(name, format)    → formatted content
```

### CLI

```bash
larva validate <spec.json>
larva assemble --prompt <name> --toolset <name> --constraints <name> -o <output>
larva register <spec.json>
larva resolve <name> [--override key=value]
larva list
larva export <name> --format claude-md
larva component list
larva component show <type>/<name>
```

### Python Library

```python
from larva import assemble, validate, resolve

spec = assemble(
    name="code-reviewer",
    prompts=["code-reviewer", "careful-reasoning"],
    toolset="code-tools",
    constraints="strict",
    overrides={"model": "claude-opus-4-20250514"},
)

result = validate(some_json)
spec = resolve("code-reviewer", overrides={"budget": 100000})
```

## Component Library

```
~/.larva/
  components/
    prompts/           # Prompt text fragments (.md files)
    toolsets/           # tools_profile values (.yaml)
    constraints/        # Runtime constraint bundles (.yaml)
    models/             # Model + inference params (.yaml)
  registry/             # Pre-compiled PersonaSpec JSON
```

Components are simple, single-concern files. A prompt component is just a markdown file. A constraint component is a yaml with 2-3 fields.

## Install

```bash
pip install larva
```

## License

MIT
