# larva

`larva` is the PersonaSpec toolkit for the opifex stack. It validates,
normalizes, registers, resolves, updates, exports, and projects persona specs.

> Status: this document describes the implemented registry-local variants
> public surface and the target contract/variant registry storage model.
> Assembly/component public surfaces have been removed.

The canonical PersonaSpec contract authority is opifex. larva consumes that
contract; it does not redefine it.

## What larva is for

Use larva when you want a stable local registry/admission/projection authority
for registered agent persona instances instead of ad hoc prompt files scattered
across tools and repos.

- Validate PersonaSpec JSON before it reaches runtime
- Store canonical personas in a local registry under `~/.larva/`
- Manage registry-local variants without changing the PersonaSpec schema
- Resolve, clone, update, delete, and export personas across tools
- Project the active variant of each registered persona into OpenCode
- Expose the same operations through MCP, CLI, Python, and a small web UI

larva does not run agents, call LLMs, enforce gateway policy, or manage memory.
`larva opencode` is only a launcher for the real OpenCode runtime.

## Install

```bash
pip install larva
```

Development checkout:

```bash
uv sync
uv run larva --help
```

## Quick start

Create a complete PersonaSpec JSON file:

```json
{
  "spec_version": "0.1.0",
  "id": "code-reviewer",
  "description": "Reviews code changes with read-focused tooling.",
  "prompt": "You are a senior code reviewer.",
  "model": "openai/gpt-5.5",
  "capabilities": {"shell": "read_only"}
}
```

Then validate, register, and resolve:

```bash
larva validate code-reviewer.json
larva register code-reviewer.json
larva resolve code-reviewer --json
```

## Core concepts

### PersonaSpec

The main larva artifact is a flat JSON object called `PersonaSpec`.

Key rules:

- `id` is required and must be flat kebab-case
- `prompt` is opaque executable text; larva stores and validates it as text and
  does not parse placeholders or infer runtime behavior from it
- `spec_version` is schema identity, not persona revisioning
- v1 pins `spec_version` to `"0.1.0"`
- `spec_digest` is recomputed by larva from canonical content
- there is no inheritance, `base:`, or `variant` field in canonical output

### Registry-local variants

Variants are local registry metadata, not PersonaSpec fields. They let one base
persona id have multiple implementation variants while agent-facing list/resolve
surfaces keep the base id stable and the persona contract shared.

```text
~/.larva/
  registry/
    code-reviewer/
      manifest.json          # {"active": "default"}
      contract.json          # id, description, capabilities, can_spawn, spec_version
      variants/
        default.json         # prompt, model, model_params, compaction_prompt
        tacit.json           # prompt, model, model_params, compaction_prompt
```

Important behavior:

- `larva list` shows base persona ids, not variant metadata
- `larva resolve code-reviewer` materializes the active variant as a canonical PersonaSpec
- `larva resolve code-reviewer --variant tacit` returns a specific variant
- `variant` is passed as an operation parameter or registry envelope metadata;
  it is never accepted inside a PersonaSpec object
- `manifest.json` stores only the active pointer (`{"active": "default"}`);
  missing or corrupt manifests fail closed instead of being auto-created
- `contract.json` owns persona identity, description, capability intent,
  `can_spawn`, and `spec_version`; variant files own prompt/model execution
  fields only
- assembly/component inputs are removed; register full canonical PersonaSpecs directly

## Interfaces

### MCP

```text
larva_validate(spec)                    -> ValidationReport
larva_register(spec, variant?)          -> {id, registered}
larva_resolve(id, overrides?, variant?) -> PersonaSpec
larva_list()                            -> [{id, description, spec_digest, model}]
larva_update(id, patches, variant?)     -> PersonaSpec
larva_update_batch(where, patches, dry_run?) -> {items, matched, updated}
larva_clone(source_id, new_id)          -> PersonaSpec
larva_delete(id)                        -> {id, deleted}
larva_clear(confirm)                    -> {cleared, count}
larva_export(all?, ids?)                -> [PersonaSpec, ...]
larva_variant_list(id)                  -> registry variant metadata
larva_variant_activate(id, variant)     -> {id, active}
larva_variant_delete(id, variant)       -> {id, variant, deleted}
```

Removed MCP tools:

```text
larva_assemble
larva_component_list
larva_component_show
```

Start larva as an MCP server:

```bash
larva mcp
```

### CLI

```bash
larva validate <spec.json> [--json]
larva register <spec.json> [--variant <name>] [--json]
larva resolve <id> [--variant <name>] [--override key=value]... [--json]
larva list [--json]
larva update <id> [--variant <name>] --set key=value [--set ...] [--json]
larva clone <source-id> <new-id> [--json]
larva delete <id> [--json]
larva clear --confirm "CLEAR REGISTRY" [--json]
larva export --all [--json]
larva export --id <id> [--id <id>]... [--json]
larva variant list <id> [--json]
larva variant activate <id> <variant> [--json]
larva variant delete <id> <variant> [--json]
larva doctor [--json]
larva opencode [OPENCODE_ARG ...]
larva pi [--persona <id>] [--] <pi args...>
```

Update rules: without `--variant`, contract-only patches update the shared
persona contract and implementation-only patches update the active variant. With
`--variant`, only `prompt`, `model`, `model_params`, and `compaction_prompt` are
patchable. `description`, `capabilities`, and `can_spawn` are contract patches;
`id`, `spec_version`, and `spec_digest` are never patchable. Mixed-scope patches
are rejected.

### Python API

```python
from larva.shell.python_api import (
    validate,
    register,
    resolve,
    update,
    update_batch,
    clone,
    list,
    delete,
    clear,
    export_all,
    export_ids,
    variant_list,
    variant_activate,
    variant_delete,
)
```

## Web UI

```bash
larva serve
```

The packaged web UI shows base persona ids and active variant state for human
management. Registry variant endpoints return `{_registry, spec}` envelopes;
`_registry` is local metadata and `spec` is canonical PersonaSpec.

## OpenCode plugin

```bash
larva opencode
larva opencode --agent python-senior
```

`larva opencode` launches the real OpenCode CLI with a temporary dynamic config
built from the active variant of each base persona id in the larva registry. The
OpenCode agent name is the Larva base persona id; inactive registry-local
variants are not projected as separate OpenCode agents.

The wrapper/plugin path uses placeholder agents at startup and replaces each
`[larva:<id>]` placeholder inside OpenCode's system-prompt transform before a
model request. This gives persona prompts system-prompt strength rather than
ordinary MCP/tool-result context.

The hardening contract for this path is: existing persona ids refresh by
re-resolving the selected id, cache is performance-only, raw placeholders must
never reach the model, and no `/larva refresh` command is required. Adding or
deleting persona ids still requires restarting `larva opencode` so OpenCode can
see the new agent list. See `contrib/opencode-plugin/README.md` for current
behavior, target refresh semantics, and failure handling.

## Pi Coding Agent integration

```bash
larva pi --persona python-senior --agent-persona-switch ask -- <pi args...>
```

`larva pi` launches the real Pi CLI with the bundled Larva Pi extension loaded
through Pi's extension flag (`-e` or `--extension`) and forwards user Pi
arguments after Larva-owned flags. It does not write `.pi/settings.json` or any
other Pi settings file as a fallback. The launcher-owned environment includes the
resolved real Pi binary, selected extension flag, bundled extension entry, Larva
CLI argv prefix, optional initial persona id, explicit adapter-config overrides,
interactive-mode classification, the agent self-switch default from
`--agent-persona-switch off|ask|auto` / `LARVA_PI_AGENT_PERSONA_SWITCH=off|ask|auto`,
and `LARVA_PI_LAUNCHED=1`. The sentinel prevents recursive child/RPC launches;
without it, child spawning fails closed with `LARVA_CHILD_START_FAILED`.

Persona-specific Pi tool rules live in adapter-local
`~/.pi/larva/tool-policy.json`, or the absolute path explicitly named by
`LARVA_PI_TOOL_POLICY_FILE`. Legacy `~/.pi/tool-policy.json` is not read as an
implicit fallback. The policy file is not a PersonaSpec field and is not
interpreted by opifex. The Pi extension validates the active persona entry and
supports only exact tool-name `allow` and `deny` arrays; there is no `ask` action,
wildcard matching, project-level policy hierarchy, or PersonaSpec schema change.

Inside Pi, `/larva-persona <id>` switches the active Larva persona atomically for
the next model invocation. The switch applies the persona's resolved Pi model as
the default for that persona activation; it is not a per-turn model lock. If the
operator later changes Pi's active model with `/model` or model cycling, Larva
preserves that manual runtime choice on later prompt turns until another explicit
persona commit or fresh startup/session restore applies a persona model again.
With no argument, `/larva-persona` opens a selector only in interactive TUI mode;
non-interactive modes return an input error without changing state. This manual
command remains available even when agent self-switch mode is `off`.

Agent self-switch is session-level Pi policy, not PersonaSpec policy. The default
is `off`; it can be set at launch with `--agent-persona-switch off|ask|auto`, by
setting `LARVA_PI_AGENT_PERSONA_SWITCH=off|ask|auto`, or during the session with
`/larva-mode [off|ask|auto]`. In `off`, model-facing autonomous
switch tools are hidden from the active tool set and stale or forged calls are
rejected while manual `/larva-persona <id>` still works. In `ask`,
`larva_persona_switch(persona_id, reason, handoff?, continue_task?, max_switches_per_chain?)` and the
bounded read-only `larva_personas(query?, limit?)` discovery tool are exposed, but
the switch commits only after UI approval and fails safely without UI, rejection,
cancel, or timeout. In `auto`, those tools are exposed and an allowed switch
commits without UI approval while the request-chain switch budget remains. The
default is 20 successful committed switches; `max_switches_per_chain: 0` means
unlimited for the current request chain. A successful autonomous switch returns
`terminate=true` with active persona proof (`previous_persona`, `active_persona`,
`spec_digest`, `commit_source`); if `continue_task` is true, Larva queues an
explicit `[Larva-generated continuation after persona switch]` follow-up for the
new persona with generic hard-boundary text rather than pretending a human wrote a
new request. Child subagent Pi
sessions currently start with agent self-switch mode `off`; there is no
implemented child inherit/ask/auto switch policy, no PersonaSpec/opifex contract
change, and no direct model-facing `commitPersona` tool.

Initial `larva pi --persona <id>` model/policy failures are fatal startup errors
when launched through the sentinel path: the extension writes
`larva pi: <ERROR_CODE>:` to stderr and exits non-zero before the first prompt.
Pi status shows `larva: <id>` or `larva: none`.

For Tab completion, the bundled extension preserves Pi's command-level
`/larva-persona` argument completer and, when the Pi TUI exposes
`ctx.ui.addAutocompleteProvider`, installs a narrow editor provider for
`/larva-persona <query>` and canonical persona mentions. Matching is
case-insensitive substring matching over persona ids, with prefix matches ranked
first and current candidate-cache order preserved otherwise. Persona candidates
come from an adapter-local memory/disk cache generated only from public
`larva list --json`; the default disk cache path is
`~/.pi/larva/persona-candidates-cache.json`, with test override
`LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE`. Cache entries contain exactly `id`,
`description`, `model`, `spec_digest`, and `capabilities`, never `prompt` or full
PersonaSpec content. `/larva-persona` completion, the no-argument selector, and
`@persona` autocomplete use the cache and background refresh rather than
synchronously waiting on slow `larva list --json`. `/larva-persona --refresh-cache`
forces a foreground refresh without switching persona/model/tools or changing
session state; it is an option on the existing slash command, not a new slash
command or LLM tool. If live Pi does not expose `ctx.ui.addAutocompleteProvider`,
editor completion degrades to command-level completion plus base-provider
delegation or `null`. Mock/local hook evidence is not enough to claim live editor
support.

Persona mentions insert id-only values exactly shaped as `@persona:<id>`. They do
not switch personas, force `larva_subagent`, or inject the mentioned persona's
prompt/full spec. Raw short forms such as `@python-senior` remain delegated to
Pi-owned file-reference completion.

The bundled extension exposes `larva_subagent(persona_id, task, task_id?)` when
the active parent persona and tool policy allow it. Results are Pi ToolResult
wrappers around `LarvaSubagentResult`; `task_id` is the public resume handle and
is the child Pi `.jsonl` session path under `~/.pi/larva/child-sessions`. Resumes
reuse that path, append the new `task`, and re-resolve the requested child
persona from the current registry. The authorized `/larva-log [task_id?]`
slash command is a view-only, user-visible overlay over the parent extension's
in-memory presentation log; it is not a model-facing tool, not resume authority,
and not a shared opifex surface.

Runtime proof summaries live in `design/pi-coding-agent-integration.md` under
"Runtime capability and provenance matrix". See `contrib/pi-extension/README.md`
for operator-facing details and the exact smoke commands. There is no Larva
sidecar metadata guarantee, batch subagent scheduler, worktree isolation,
credential isolation, filesystem lock, MCP transport, or Pi permission platform
in this integration.

## Architecture

larva uses a strict layered structure enforced by Invar.

| Layer | Path | Role |
| --- | --- | --- |
| Core | `src/larva/core/` | Pure logic, contracts, no I/O |
| App | `src/larva/app/` | Use-case orchestration |
| Shell | `src/larva/shell/` | CLI, MCP, filesystem, web adapters |

## Read next

- `docs/README.md` - documentation map by category
- `docs/guides/USER_GUIDE.md` - detailed human-oriented usage guide
- `docs/guides/USAGE.md` - agent-oriented operational guide
- `docs/reference/INTERFACES.md` - public interface specification
- `docs/reference/ARCHITECTURE.md` - module boundaries and dependency design
- `design/registry-local-variants-and-assembly-removal.md` - accepted design for variant routing and assembly removal
- `docs/adr/ADR-001-spec-version-boundary.md` - `spec_version` design decision
- `docs/adr/ADR-002-capability-intent-without-runtime-policy.md` - capability intent model
- `docs/adr/ADR-003-canonical-requiredness-authority.md` - canonical requiredness authority
- `docs/adr/ADR-004-empty-capabilities-and-unrestricted-semantics.md` - empty capability semantics and unrestricted boundary

## License

AGPL-3.0-or-later
