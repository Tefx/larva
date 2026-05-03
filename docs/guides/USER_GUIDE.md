# larva User Guide

This guide is the human-oriented introduction to larva.

If you want the shortest entrypoint, read `../../README.md` first. If you want
the formal API contract, read `../reference/INTERFACES.md`. If you are
integrating larva into an agent system, `USAGE.md` is the agent-facing companion.

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

Component boundary note:

- `~/.larva/components/` is user-managed local input, not canonical larva state
- larva reads prompt markdown and YAML component files from that root but does
  not treat them as trusted until assembly, normalization, and validation finish
- larva does not create, migrate, or enforce ownership outside that documented
  directory layout in this release

## 4. PersonaSpec basics

The canonical larva artifact is `PersonaSpec`.

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code changes with read-focused tooling.",
  "prompt": "You are a senior code reviewer.",
  "model": "openai/gpt-5.4",
  "capabilities": {
    "shell": "read_only",
    "filesystem": "read_write"
  },
  "model_params": {
    "temperature": 0.2,
    "max_tokens": 4096
  },
  "can_spawn": false,
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
- `capabilities` is required; `capabilities: {}` means no declared capability postures, not unrestricted access
- `model_params` is an optional canonical field; nested `model_params.*` update patches deep-merge instead of replacing the whole object
- `tools` and `side_effect_policy` are forbidden legacy PersonaSpec vocabulary at every canonical admission surface
- `side_effect_policy` is **not a PersonaSpec field** — runtime approval policy belongs to anima runtime controls, not larva
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
  "capabilities": {"shell": "read_only"},
  "can_spawn": false,
  "spec_version": "0.1.0"
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
- `valid: true` with warnings, such as:
  - unknown model ids
  - empty/all-`none` capabilities
  - read-focused reviewer/auditor personas that still declare `read_write`/`destructive` capability postures
  - `can_spawn` targets missing from the current registry snapshot
  - descriptions that read like prompt text instead of short operational summaries
  - unknown capability-family identifiers outside the local vocabulary snapshot
- `valid: false` with one or more structured errors

Example validation response:

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    "unknown model identifier 'custom-model-x' is outside the known-model snapshot",
    "can_spawn references ids outside the current registry snapshot: missing-child"
  ]
}
```

Warnings are advisory only; they do not relax canonical admission.

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
- `constraints/` for policy fields such as `can_spawn` and `compaction_prompt`
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
- component files are shell-boundary input; the assembled result becomes
  authoritative only after larva accepts the normalized `PersonaSpec`

## 12. Python API

The Python API mirrors the main persona operations.

```python
from larva.shell.python_api import clone, register, resolve, update, validate

report = validate({
    "id": "code-reviewer",
    "description": "Reviews code for correctness and style",
    "prompt": "You are a senior code reviewer.",
    "model": "openai/gpt-5.4",
    "capabilities": {"shell": "read_only"},
    "can_spawn": False,
})

if report["valid"]:
    register({
        "id": "code-reviewer",
        "description": "Reviews code for correctness and style",
        "prompt": "You are a senior code reviewer.",
        "model": "openai/gpt-5.4",
        "capabilities": {"shell": "read_only"},
        "can_spawn": False,
    })

spec = resolve("code-reviewer")
clone("code-reviewer", "code-reviewer-exp")
updated = update("code-reviewer-exp", {"model": "openai/gpt-5.4-pro"})
```

## 13. MCP surface

larva's primary programmatic interface is MCP.

Available tools:

```text
larva_validate(spec)
larva_assemble(components)
larva_register(spec)
larva_resolve(id, overrides?)
larva_list()
larva_update(id, patches)
larva_update_batch(where, patches, dry_run?)
larva_clone(source_id, new_id)
larva_delete(id)
larva_clear(confirm)
larva_export(all?, ids?)
larva_component_list()
larva_component_show(type, name)
```

For every MCP PersonaSpec input, forbidden legacy vocabulary is `tools` and
`side_effect_policy`. Unknown top-level fields are rejected as non-canonical.

If you need exact parameter and return contracts, read
`../reference/INTERFACES.md`.

Typical local startup commands:

```bash
larva mcp
larva serve
uvx larva mcp
uvx larva serve
```

## 14. Web UI and plugin

The authoritative packaged web runtime entrypoint is:

```bash
larva serve
larva serve --port 7400 --no-open
```

Runtime assumptions:

- binds `127.0.0.1` by default
- uses port `7400` unless `--port` is provided
- auto-opens the browser unless `--no-open` is provided
- serves the packaged single-file UI from `src/larva/shell/web_ui.html`

The repository also includes a supported contributor convenience entrypoint in
`contrib/web/` for local review of the same general UI surface:

```bash
pip install fastapi uvicorn
python contrib/web/server.py
```

Verified contract notes for downstream tests and reviews:

- normative web API coverage belongs to the packaged `larva serve` surface
- the normative endpoint inventory lives in `../reference/INTERFACES.md`
- `python contrib/web/server.py` is supported as a contributor convenience entrypoint, not as the canonical packaged startup path
- the prompt copy button is convenience UI behavior; docs do not promise more than the browser affordance exists
- the packaged web UI uses an output-first **Compose Persona** flow: toolsets are
  shown as capability presets, constraints are represented as optional behavior
  presets, and selecting a behavior preset may prefill `can_spawn` /
  `compaction_prompt` without changing the canonical backend assemble fields
- batch update is a contrib-only convenience surface, not part of `larva serve`
- preserved runnable liveness proof for both entrypoints lives in `../../tests/shell/artifacts/web_runtime_liveness.md`

### OpenCode wrapper

The repository includes an OpenCode plugin in `contrib/opencode-plugin/` and a
wrapper command that injects registry personas into OpenCode without writing
project config:

```bash
larva opencode
larva opencode --agent python-senior
larva opencode run "check this bug" --agent python-senior
larva opencode -- run "check this bug" --agent python-senior
```

What the wrapper does:

- exports currently active registered personas through larva's normal facade path
- builds a temporary `OPENCODE_CONFIG_CONTENT` with `[larva:<id>]` placeholder agents keyed by Larva base id
- injects the bundled or source-tree `larva.ts` OpenCode plugin
- forwards remaining arguments to the real `opencode` binary
- strips a leading `--` after `opencode` when present

What it does not do:

- it does not write `.opencode/opencode.json`
- it does not call an LLM itself
- it does not turn PersonaSpec into runtime gateway policy
- it does not create a `larva-active` pseudo-agent
- it does not maintain a global active variant for concurrent requests
- it does not treat `export --all` as runtime semantic authority; `export --all` is startup projection only

Runtime refresh behavior:

- startup projection uses `larva export --all --json` only so OpenCode sees base ids before `--agent <larva-id>` validation
- each selected request resolves the chosen base id with `larva resolve <id> --json`
- cache entries are last-known-good performance data, keyed by base id, and remember prompt, optional temperature, optional `spec_digest`, derived permissions, and timestamp
- same-id concurrent resolves share one in-flight request
- if resolve fails and a previous good prompt exists, the stale prompt is used with a debug warning; without a previous good prompt, the plugin fails closed instead of leaking `[larva:<id>]`
- prompts are watermarked with both `<larva-persona id="..." />` and an instruction to identify as the named persona loaded from larva

Environment knobs:

- `LARVA_OPENCODE_DEBUG=1` enables cache/fallback/hardening warnings
- `LARVA_OPENCODE_CACHE_TTL_MS` defaults to `300000`; nonzero values allow last-known-good cache storage, `0` disables storing new cache entries, and invalid or negative values fall back to the default

Hot-updated on the next selected-id runtime request: prompt text,
`model_params.temperature`, tool-policy rules, permission derivation from
`capabilities`, and `can_spawn` task denial. Added/deleted base ids and
model/provider startup fields require restarting OpenCode because agent
registration is a startup boundary.

Plugin path resolution order:

1. `LARVA_OPENCODE_PLUGIN=/absolute/path/to/contrib/opencode-plugin/larva.ts`
2. bundled wheel resource at `larva/shell/opencode_plugin/larva.ts`
3. source-tree fallback at `contrib/opencode-plugin/larva.ts`

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

1. `../../README.md`
2. `USER_GUIDE.md`
3. `../reference/INTERFACES.md`
4. `../reference/ARCHITECTURE.md`

If you are integrating larva into another agent system:

1. `../../README.md`
2. `USAGE.md`
3. `../reference/INTERFACES.md`
