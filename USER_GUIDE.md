# larva User Guide

This guide is the human-oriented introduction to larva.

If you want the shortest entrypoint, read `README.md` first. If you want the
formal API contract, read `INTERFACES.md`. If you are integrating larva into an
agent system, `USAGE.md` is the agent-facing companion.

## 1. What larva does

larva is a local authority for `PersonaSpec`, a flat JSON format used to define
LLM agent personas.

larva can:

- validate persona specs
- assemble personas from reusable components
- register personas in a local registry
- resolve a persona by id
- clone, update, delete, clear, and export personas
- expose the same model through MCP, CLI, Python, and a small web UI

larva does not:

- call models
- execute agents
- manage agent memory
- own runtime tool enforcement
- define provider-specific gateway behavior

## 2. Installation

Install from Python:

```bash
pip install larva
```

Confirm the CLI is available:

```bash
larva --help
```

If you prefer ephemeral execution, you can also run larva with `uvx`:

```bash
uvx larva --help
```

## 3. Directory layout

larva stores state under `~/.larva/`.

```text
~/.larva/
  components/
    prompts/
    toolsets/
    constraints/
    models/
  registry/
```

- `components/` holds reusable building blocks for assembly
- `registry/` holds registered canonical persona specs

## 4. PersonaSpec basics

The canonical larva artifact is `PersonaSpec`.

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code changes with read-focused tooling.",
  "prompt": "You are a senior code reviewer.",
  "model": "openai/gpt-5.4",
  "tools": {
    "shell": "read_only",
    "filesystem": "read_write"
  },
  "model_params": {
    "temperature": 0.2,
    "max_tokens": 4096
  },
  "can_spawn": false,
  "side_effect_policy": "approval_required",
  "compaction_prompt": "Summarize working context into concise carry-forward notes.",
  "spec_digest": "sha256:..."
}
```

### Required mental model

- `id` is the stable persona identity
- `spec_version` is schema compatibility metadata
- `spec_version` is not persona revisioning
- v1 pins `spec_version` to `"0.1.0"`
- `spec_digest` is the content fingerprint for canonical output
- canonical output is flat and self-contained

### Important field rules

- `id` must match `^[a-z0-9]+(-[a-z0-9]+)*$`
- `side_effect_policy` must be one of `allow`, `approval_required`, `read_only`
- `can_spawn` is either `false`, `true`, or a list of persona ids
- `spec_digest` is computed by larva and should not be authored manually

## 5. Your first persona

Create a minimal persona file:

```bash
cat <<'EOF' > code-reviewer.json
{
  "id": "code-reviewer",
  "description": "Reviews code for correctness and style",
  "prompt": "You are a senior code reviewer.",
  "model": "openai/gpt-5.4",
  "tools": {"shell": "read_only"},
  "can_spawn": false,
  "side_effect_policy": "read_only"
}
EOF
```

Validate it:

```bash
larva validate code-reviewer.json
```

Register it:

```bash
larva register code-reviewer.json
```

Resolve it from the registry:

```bash
larva resolve code-reviewer
```

## 6. Typical lifecycle

The most common larva workflow is:

1. author or assemble a candidate persona
2. validate it
3. register it
4. resolve it by id when you need the canonical form
5. clone or update it for experiments
6. export it when another system needs the spec

### Example lifecycle

```bash
larva validate code-reviewer.json
larva register code-reviewer.json
larva clone code-reviewer code-reviewer-exp
larva update code-reviewer-exp --set model=openai/gpt-5.4-pro
larva resolve code-reviewer-exp --json
larva export --id code-reviewer-exp --json
```

## 7. Validation

Validation checks both schema shape and semantic rules.

```bash
larva validate code-reviewer.json --json
```

Typical outcomes:

- `valid: true` and no warnings
- `valid: true` with warnings, such as unused variables
- `valid: false` with one or more structured errors

Example validation response:

```json
{
  "valid": false,
  "errors": [
    {
      "code": "INVALID_SPEC_VERSION",
      "message": "spec_version must be '0.1.0'",
      "details": {
        "field": "spec_version",
        "value": "0.2.0"
      }
    }
  ],
  "warnings": []
}
```

## 8. Register and resolve

`register` writes a validated persona into the local registry.

```bash
larva register code-reviewer.json
```

`resolve` fetches a registered persona by id and returns canonical output.

```bash
larva resolve code-reviewer
```

You can apply temporary overrides during resolve:

```bash
larva resolve code-reviewer --override model=openai/gpt-5.4-pro
```

Important behavior:

- overrides trigger revalidation
- the returned `spec_digest` is recomputed
- invalid overrides fail with `PERSONA_INVALID`

## 9. Clone and update

Use clone when you want a safe branch for experimentation.

```bash
larva clone code-reviewer code-reviewer-exp
```

Use update to patch selected fields in a registered persona.

```bash
larva update code-reviewer-exp --set model=openai/gpt-5.4-pro
larva update code-reviewer-exp --set model_params.temperature=0.4
```

Important behavior:

- `id` cannot be changed through update patches
- `spec_version` is protected and cannot be bumped through update
- `spec_digest` is always recomputed after successful changes
- clone preserves source content, but still returns canonical v1 schema output

## 10. Listing, deleting, clearing, and exporting

List registered personas:

```bash
larva list
larva list --json
```

Delete one persona:

```bash
larva delete code-reviewer-exp
```

Clear the entire registry:

```bash
larva clear --confirm "CLEAR REGISTRY"
```

Export personas:

```bash
larva export --all --json
larva export --id code-reviewer --id code-reviewer-exp --json
```

## 11. Working with components

Components let you build personas from reusable parts instead of copying large
prompt files.

Component categories:

- `prompts/` for prompt text fragments
- `toolsets/` for tool posture maps
- `constraints/` for policy fields such as `can_spawn` and `side_effect_policy`
- `models/` for model name and inference parameter bundles

List available components:

```bash
larva component list
```

Inspect one component:

```bash
larva component show prompts/code-reviewer
larva component show toolsets/read-only
```

Assemble a persona from components:

```bash
larva assemble --id code-reviewer \
  --prompt code-reviewer \
  --prompt careful-reasoning \
  --toolset read-only \
  --constraints strict \
  --model gpt-5 \
  --override description="Reviews code changes with strict reasoning"
```

Assembly rules to remember:

- prompts concatenate in order
- conflicting scalar fields fail assembly unless you resolve them with `--override`
- canonical output contains concrete fields, not component references

## 12. Python API

The Python API mirrors the main persona operations.

```python
from larva.shell.python_api import clone, register, resolve, update, validate

report = validate({
    "id": "code-reviewer",
    "description": "Reviews code for correctness and style",
    "prompt": "You are a senior code reviewer.",
    "model": "openai/gpt-5.4",
    "tools": {"shell": "read_only"},
    "can_spawn": False,
    "side_effect_policy": "read_only",
})

if report["valid"]:
    register({
        "id": "code-reviewer",
        "description": "Reviews code for correctness and style",
        "prompt": "You are a senior code reviewer.",
        "model": "openai/gpt-5.4",
        "tools": {"shell": "read_only"},
        "can_spawn": False,
        "side_effect_policy": "read_only",
    })

spec = resolve("code-reviewer")
clone("code-reviewer", "code-reviewer-exp")
updated = update("code-reviewer-exp", {"model": "openai/gpt-5.4-pro"})
```

## 13. MCP surface

larva's primary programmatic interface is MCP.

Available tools:

```text
larva.validate(spec)
larva.assemble(components)
larva.register(spec)
larva.resolve(id, overrides?)
larva.list()
larva.update(id, patches)
larva.clone(source_id, new_id)
larva.delete(id)
larva.clear(confirm)
larva.export(all?, ids?)
larva.component_list()
larva.component_show(type, name)
```

If you need exact parameter and return contracts, read `INTERFACES.md`.

Typical local startup commands:

```bash
larva mcp
larva serve
uvx larva mcp
uvx larva serve
```

## 14. Web UI and plugin

The repository includes a lightweight web UI in `contrib/web/`:

```bash
pip install fastapi uvicorn
python contrib/web/server.py
```

The repository also includes an OpenCode plugin in `contrib/opencode-plugin/`.

## 15. Troubleshooting

### `INVALID_PERSONA_ID`

Your id is missing or not kebab-case.

Valid example:

```text
code-reviewer
```

Invalid examples:

```text
CodeReviewer
code_reviewer
team/code-reviewer
```

### `INVALID_SPEC_VERSION`

You supplied a non-v1 schema version. In current larva, `spec_version` must be
`"0.1.0"` if present.

### `PERSONA_NOT_FOUND`

You resolved, cloned, updated, deleted, or exported an id that is not present in
the local registry.

### `COMPONENT_NOT_FOUND`

One of the component names in an assemble request does not exist under
`~/.larva/components/`.

### `PERSONA_INVALID` after resolve or update

Your overrides or patches produced an invalid PersonaSpec. Validate the full
resulting object or remove the offending override.

## 16. Design notes worth remembering

- larva is an authority for persona definitions, not a runtime
- canonical output is flat and self-contained
- `spec_version` describes schema compatibility, not release cadence
- `spec_digest` tracks canonical content changes
- no hidden mutable state is applied to personas between calls

## 17. Recommended reading order

If you are new to the repo:

1. `README.md`
2. `USER_GUIDE.md`
3. `INTERFACES.md`
4. `ARCHITECTURE.md`

If you are integrating larva into another agent system:

1. `README.md`
2. `USAGE.md`
3. `INTERFACES.md`
