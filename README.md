# larva

larva is a PersonaSpec toolkit for LLM agent systems. It gives you one place to
validate, assemble, normalize, register, resolve, clone, update, and export
canonical persona definitions.

## What larva is for

Use larva when you want a stable authority for agent persona definitions instead
of ad hoc prompt files scattered across tools and repos.

- Validate PersonaSpec JSON before it reaches runtime
- Assemble personas from reusable components
- Store canonical personas in a local registry under `~/.larva/`
- Resolve, clone, update, delete, and export personas across tools
- Project registered personas into OpenCode with a temporary wrapper config
- Expose the same operations through MCP, CLI, Python, and a small web UI

larva does not run agents, call LLMs, enforce gateway policy, or manage memory.
`larva opencode` is only a launcher for the real OpenCode runtime.

## Install

Install into your Python environment:

```bash
pip install larva
```

Or run larva without a persistent install:

```bash
uvx larva --help
```

## Quick start

The example below creates a minimal persona, validates it, stores it in the
local registry, and resolves the canonical output back out.

Create a minimal persona:

```bash
cat <<'EOF' > code-reviewer.json
{
  "id": "code-reviewer",
  "description": "Reviews code for correctness and style",
  "prompt": "You are a senior code reviewer.",
  "model": "openai/gpt-5.4",
  "capabilities": {"shell": "read_only"},
  "spec_version": "0.1.0"
}
EOF
```

Validate, register, and resolve it:

```bash
larva validate code-reviewer.json
larva register code-reviewer.json
larva resolve code-reviewer
```

Clone and modify it for experimentation:

```bash
larva clone code-reviewer code-reviewer-exp
larva update code-reviewer-exp --set model=openai/gpt-5.4-pro
larva list --json
```

## Core concepts

### PersonaSpec

The main larva artifact is a flat JSON object called `PersonaSpec`.

The canonical PersonaSpec schema is defined by `opifex`. larva validates,
assembles, and normalizes PersonaSpec as a downstream admission and projection
layer, not the contract authority.

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code changes with read-focused tooling.",
  "prompt": "You are a senior code reviewer...",
  "model": "openai/gpt-5.4",
  "capabilities": {
    "shell": "read_only",
    "filesystem": "read_write"
  },
  "spec_digest": "sha256:..."
}
```

Key rules:

- `id` is required and must be flat kebab-case
- `spec_version` is schema identity, not persona revisioning
- v1 pins `spec_version` to `"0.1.0"`
- `spec_digest` is recomputed by larva from canonical content
- there is no inheritance or `base:` field in canonical output

### Components

larva can also assemble personas from reusable components stored in
`~/.larva/components/`:

```text
~/.larva/
  components/
    prompts/
    toolsets/
    constraints/
    models/
  registry/
```

Example assembly command:

```bash
larva assemble --id code-reviewer \
  --prompt code-reviewer \
  --prompt careful-reasoning \
  --toolset read-only \
  --constraints strict \
  --model gpt-5
```

Components are read from the user-managed shell boundary at
`~/.larva/components/`. Those files are local input, not canonical larva state;
only the assembled and validated `PersonaSpec` is authoritative at runtime.

## Interfaces

### MCP

Primary programmatic surface:

```text
larva_validate(spec)                    -> ValidationReport
larva_assemble(components)              -> PersonaSpec
larva_register(spec)                    -> {id, registered}
larva_resolve(id, overrides?)           -> PersonaSpec
larva_list()                            -> [{id, description, spec_digest, model}]
larva_update(id, patches)               -> PersonaSpec
larva_update_batch(where, patches, dry_run?) -> {items, matched, updated}
larva_clone(source_id, new_id)          -> PersonaSpec
larva_delete(id)                        -> {id, deleted}
larva_clear(confirm)                    -> {cleared, count}
larva_export(all?, ids?)                -> [PersonaSpec, ...]
larva_component_list()                  -> {prompts, toolsets, constraints, models}
larva_component_show(type, name)        -> component content
```

For every MCP PersonaSpec input, forbidden legacy vocabulary is `tools` and
`side_effect_policy`. Unknown top-level fields are rejected as non-canonical.

Start larva as an MCP server over stdio:

```bash
larva mcp
```

Or with `uvx`:

```bash
uvx larva mcp
```

If you want the packaged local web UI/runtime instead of stdio, start:

```bash
larva serve
```

Or with `uvx`:

```bash
uvx larva serve
```

### CLI

```bash
larva validate <spec.json> [--json]
larva register <spec.json> [--json]
larva resolve <id> [--override key=value]... [--json]
larva list [--json]
larva update <id> --set key=value [--set ...] [--json]
larva clone <source-id> <new-id> [--json]
larva delete <id> [--json]
larva clear --confirm "CLEAR REGISTRY" [--json]
larva export --all [--json]
larva export --id <id> [--id <id>]... [--json]
larva assemble --id <id> [--prompt <name>]... [--toolset <name>]... [--constraints <name>]... [--model <name>] [--override key=value]... [-o output.json]
larva component list [--json]
larva component show <type>/<name> [--json]
larva doctor [--json]
larva opencode [OPENCODE_ARG ...]
```

`larva opencode` launches the real OpenCode CLI with a temporary dynamic config
built from the larva registry. Arguments after `opencode` are forwarded to
OpenCode; a leading `--` is optional and is stripped before forwarding.

## Repo-local CI gate

Source basis:

- `design/opifex-frozen-authority-packet.json`
- `../opifex/design/final-canonical-contract.md`
- `../opifex/design/cross-repo-followup-packet.md`
- `../opifex/contracts/persona_spec.schema.json`
- `../opifex/conformance/shared_surfaces.yaml`
- `../opifex/conformance/case_matrix/larva/*`

Trusted repo-local commands:

```bash
uv run pytest -q tests/shell/test_repo_local_ci_gate.py
uv run python scripts/ci/larva_repo_local_gate.py expected-red --opifex-root ../opifex
uv run python scripts/ci/larva_repo_local_gate.py verify --opifex-root ../opifex
```

These checks are intentionally opifex-authoritative. They fail closed on:

- floating or mismatched frozen `opifex` authority refs
- canonical PersonaSpec schema mirror drift
- capabilities-only admission drift as derived from `opifex` `shared_surfaces` + `case_matrix` authority (`capabilities` required; `tools` and `side_effect_policy` forbidden)
- authority-derived shared MCP surface drift, including missing shared tool registration
- dotted or non-`snake_case` MCP tool naming
- repo-facing docs drift away from shared naming and invalid-field wording

### Python API

```python
from larva.shell.python_api import (
    assemble,
    clear,
    clone,
    component_list,
    component_show,
    delete,
    export_all,
    export_ids,
    list,
    register,
    resolve,
    update,
    validate,
)
```

The Python API mirrors the main CLI and MCP operations and returns the same
canonical PersonaSpec shapes.

The package root is not the authoritative Python API surface. Keep imports on
`larva.shell.python_api`; `larva.__init__` remains metadata-only (`__version__`)
unless guard policy and architecture docs are updated together.

## Other surfaces

### Web UI

The authoritative packaged startup path is:

```bash
larva serve
```

`larva serve` binds `127.0.0.1:7400` by default, accepts `--port` and
`--no-open`, and serves the packaged single-file UI plus the normative REST
surface documented in `docs/reference/INTERFACES.md`.

The repository also includes a supported contributor convenience entrypoint for
local review work:

```bash
pip install fastapi uvicorn
python contrib/web/server.py
```

Scope note:

- `larva serve` is the canonical packaged web runtime users should target
- `python contrib/web/server.py` is supported for contributor/local-review use, not the canonical packaged entrypoint
- documented REST endpoints are the verified contract surface
- the prompt copy button is documented only as browser convenience UI behavior
- batch update is documented only for the contrib runtime, not for `larva serve`
- component query semantics are shared across transports and should be centralized outside adapter-local envelopes
- CLI, MCP, Web, and Python API keep their own rendering, error envelopes, and runtime hooks
- preserved runnable liveness proof for both entrypoints lives in `tests/shell/artifacts/web_runtime_liveness.md`

### OpenCode plugin

larva ships an OpenCode plugin plus a thin wrapper that exposes registered larva
personas as OpenCode agents.

```bash
# TUI with every registry persona available as --agent <id>
larva opencode

# TUI pinned to a persona
larva opencode --agent python-senior

# Non-interactive OpenCode run
larva opencode run "check this bug" --agent python-senior

# Optional explicit separator; useful when a future larva flag could conflict
larva opencode -- run "check this bug" --agent python-senior
```

The wrapper injects `OPENCODE_CONFIG_CONTENT` for the child OpenCode process, so
personas are visible early enough for OpenCode's `--agent <persona-id>`
validation. It does **not** write `.opencode/opencode.json`, and it does not run
agents itself; after config assembly it execs the real `opencode` binary.

Plugin path resolution:

1. `LARVA_OPENCODE_PLUGIN=/absolute/path/to/larva.ts`
2. bundled wheel resource at `larva/shell/opencode_plugin/larva.ts`
3. source-tree lookup for `contrib/opencode-plugin/larva.ts`

See `contrib/opencode-plugin/README.md` for plugin internals and tool-policy
mapping.

## Architecture

larva uses a strict layered structure enforced by Invar.

| Layer | Path | Role |
| --- | --- | --- |
| Core | `src/larva/core/` | Pure logic, contracts, no I/O |
| App | `src/larva/app/` | Use-case orchestration |
| Shell | `src/larva/shell/` | CLI, MCP, filesystem, web adapters |

Structural guardrails frozen for the remediation campaign:

- `src/larva/shell/web.py` is the authoritative packaged REST surface
- `contrib/web/server.py` is an extension consumer, not the contract owner
- `src/larva/core/patch.py` dotted-path patch semantics stay separate from
  `src/larva/app/facade.py` dotted lookup semantics unless later evidence says otherwise

## Read next

If you are just getting started, read `README.md` then
`docs/guides/USER_GUIDE.md`.

- `docs/README.md` - documentation map by category
- `docs/guides/USER_GUIDE.md` - detailed human-oriented usage guide
- `docs/guides/USAGE.md` - agent-oriented operational guide
- `docs/reference/INTERFACES.md` - public interface specification
- `docs/reference/ARCHITECTURE.md` - module boundaries and dependency design
- `docs/adr/ADR-001-spec-version-boundary.md` - `spec_version` design decision
- `docs/adr/ADR-002-capability-intent-without-runtime-policy.md` - capability intent model
- `docs/adr/ADR-003-canonical-requiredness-authority.md` - canonical requiredness authority
- `docs/adr/ADR-004-empty-capabilities-and-unrestricted-semantics.md` - empty capability semantics and unrestricted boundary

## License

AGPL-3.0-or-later
