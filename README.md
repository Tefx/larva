# larva

PersonaSpec toolkit for LLM agents. Validate, assemble, normalize, register, and resolve canonical persona specifications.

Part of the [opifex](https://github.com/tefx/opifex) system — four independent Unix tools composing into an autonomous agent OS.

## What larva Does

- **Validate** any PersonaSpec JSON (schema + semantic checks)
- **Assemble** PersonaSpec from reusable components (prompt fragments, toolsets, constraints)
- **Register** pre-compiled personas in a global registry (`~/.larva/`)
- **Resolve** personas by id with optional runtime overrides
- **Admit canonical personas** via validate + register (no separate staging or governance step)
- **MCP server** for programmatic access by nervus, anima, and other tools

## Key Design Decisions

- **Composition, not inheritance.** No `base:` field. Components are orthogonal building blocks assembled explicitly.
- **Personas are LLM-generated, not hand-written.** larva's value is validation and consistency, not authoring ergonomics.
- **Error-on-conflict.** When two components set the same scalar field, assembly fails. Explicit overrides resolve conflicts.
- **Global registry.** Personas live in `~/.larva/registry/`. anima loads one persona per instance — registry size has zero context cost.
- **MCP-first interface.** Other opifex components call larva tools via MCP.
- **Authority, not runtime.** larva owns canonical persona definitions; runtime execution and gateway enforcement belong elsewhere.
- **No cross-run mutable persona memory.** Lasting persona change happens through explicit `validate` + `register`, not through hidden mutable state layers.
- **Minimal semantics, not heavy taxonomy.** PersonaSpec should stay small; fine-grained MCP call semantics belong to the gateway/enforcement layer, not to larva.
- **Compaction is persona-level.** If a persona needs a custom compaction/summarization prompt, that belongs in the canonical definition rather than runtime-local config.

## Interfaces

### MCP Server (primary)

```
larva.validate(spec)          → ValidationReport
larva.assemble(components)    → PersonaSpec JSON
larva.resolve(id)             → PersonaSpec JSON (from registry)
larva.register(spec)          → id
larva.list()                  → [{id, spec_digest, model}]
```

### CLI

```bash
larva validate <spec.json>
larva assemble --prompt <name> --toolset <name> --constraints <name> -o <output>
larva register <spec.json>
larva resolve <id> [--override key=value]
larva list
larva component list
larva component show <type>/<name>
```

### Python Library

```python
from larva import assemble, validate, resolve

spec = assemble(
    id="code-reviewer",
    prompts=["code-reviewer", "careful-reasoning"],
    toolset="code-tools",
    constraints="strict",
    overrides={"model": "claude-opus-4-20250514"},
)

result = validate(some_json)
spec = resolve("code-reviewer")
```

## Component Library

```
~/.larva/
  components/
    prompts/           # Prompt text fragments (.md files)
    toolsets/           # tool declarations / posture defaults (.yaml)
    constraints/        # Runtime posture bundles (.yaml)
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
