# larva -- Module Architecture

Status: implemented architecture for the registry-local variants cutover.
## Design Boundary

`larva` is a downstream admission, registry, and projection handler for
PersonaSpec.

The **canonical PersonaSpec contract authority is `opifex`**. `larva` validates,
normalizes, registers, resolves, and projects PersonaSpec artifacts as a
downstream consumer, not the contract owner.

Its scope is limited to:

- validating PersonaSpec artifacts
- normalizing PersonaSpec into canonical form
- registering and resolving canonical personas
- managing registry-local variants as local routing metadata
- projecting active variants through CLI, MCP, Python, Web, and OpenCode surfaces

Out of scope:

- changing the PersonaSpec schema
- accepting `variant` or registry metadata inside PersonaSpec
- component-based PersonaSpec assembly
- runtime policy
- approval workflow
- gateway authorization
- concrete runtime tool semantics
- cross-run mutable memory

## Core Contract

Core code remains pure and side-effect free. The Invar boundary is still:

| Zone | Path | Responsibility |
|------|------|----------------|
| Core | `src/larva/core/` | Pure validation, normalization, patch semantics, and small value checks |
| App | `src/larva/app/` | Use-case orchestration over core and shell protocols |
| Shell | `src/larva/shell/` | CLI, MCP, Python API, filesystem registry, web runtime, OpenCode launcher |

Core must not read or write registry files. Registry I/O belongs to shell.

## Registry-local Variant Model

Variants are registry metadata, not PersonaSpec fields.

```text
~/.larva/registry/<id>/
  manifest.json          # {"active": "default"}
  variants/<variant>.json
```

`manifest.json` stores only the active variant name. The base persona id comes
from the directory name, and variant names come from scanning `variants/*.json`.
Every variant file contains a canonical PersonaSpec whose `id` equals the base
persona id.

## Variant Vocabulary

- `id` means the canonical base PersonaSpec id and remains flat kebab-case.
- `variant` means a registry-local file name under `variants/`; it is never a
  PersonaSpec field.
- `active` means the variant named by `manifest.json` and used by default
  resolve/list/export/OpenCode projection behavior.
- `larva_list` and canonical exports expose base personas only; variant metadata
  is available through variant-specific registry operations.

## Registry Root Boundary

- `src/larva/shell/registry.py` owns filesystem access under `~/.larva/registry/`.
- Registry files are shell-boundary state and are untrusted until loaded,
  normalized, and validated.
- `manifest.json` is the only correctness source for the active variant.
- `index.json` is not used in this design; list/resolve behavior derives from
  `manifest.json` plus the `variants/*.json` directory scan.
- Missing, malformed, or stale `manifest.json` state fails closed with
  `REGISTRY_CORRUPT`; registry loaders must not auto-invent a manifest or
  derive an active variant from filenames.
- Public registry operations must reject mismatched `spec.id`, invalid variant
  names, active-variant deletion, and last-variant deletion.

## Interface Boundaries

### MCP

MCP is a registry API. It exposes variant operations as ordinary registry
operations because existing MCP already exposes register, update, delete, clear,
and export. If deployment needs authorization, it should be a global MCP
read-only/read-write profile rather than a variant-specific exception.

### Web REST

Canonical active-spec routes stay under `/api/personas*` and return bare
PersonaSpec data. Registry-local variant routes stay under
`/api/registry/personas*` and return envelopes with separate `_registry` and
`spec` keys.

### OpenCode

OpenCode projection uses the active variant of each base persona id. Inactive
variants must not appear as separate OpenCode agents.

The wrapper owns startup projection only: it exports current base ids, builds a
temporary OpenCode config, and uses `[larva:<id>]` placeholders so early
`--agent <id>` validation succeeds. The plugin owns runtime prompt injection: it
replaces the selected placeholder in OpenCode's system-prompt transform. This
keeps persona instructions at system prompt strength instead of relying on
MCP/tool-result context.

- [Proven] `src/larva/shell/opencode.py` is a shell adapter for launching the
  real OpenCode CLI with larva registry personas projected into the child
  process config.
- [Proven] The launcher owns process/env concerns only: plugin path resolution,
  `OPENCODE_CONFIG_CONTENT` assembly, argument forwarding, and `execvpe`.
- [Proven] Plugin path resolution checks `LARVA_OPENCODE_PLUGIN`, then the
  bundled wheel resource at `larva/shell/opencode_plugin/larva.ts`, then the
  source-tree fallback at `contrib/opencode-plugin/larva.ts`.
- [Proven] The launcher must not write `.opencode/opencode.json` and must not
  redefine PersonaSpec semantics; persona data still flows through the app
  facade and canonical registry/export paths.
- [Proven] Runtime prompt replacement and tool-policy checks remain in
  `contrib/opencode-plugin/larva.ts`, not in core/app code.
- [Proven] OpenCode `export --all` is startup projection only. Runtime prompt,
  temperature, and permission refreshes use selected-id `resolve`, so export-all
  output is not runtime semantic authority.
- [Proven] Plugin cache state is last-known-good performance state keyed by
  Larva base id, with same-id in-flight resolve deduplication, debug-gated stale
  fallback warnings, and fail-closed behavior when no prior prompt exists.
- [Proven] Hot updates are bounded to prompt, `model_params.temperature`,
  tool-policy rules, `capabilities`, and `can_spawn`; added/deleted base ids and
  model/provider startup fields require OpenCode restart.
- [Proven] The OpenCode integration has no `larva-active` pseudo-agent and no
  module-global active variant authority; selected request state is derived from
  `[larva:<id>]` placeholders.

The hardening contract for this path is that caching is a performance detail,
not a semantic authority. A stale or missing cache must trigger selected-id
re-resolve; placeholder leakage to the model is a failure; no previous prompt
means fail closed. Adding or deleting persona ids remains startup-bound because
it changes OpenCode's agent list.

## Removed Subsystem

Assembly/component construction is removed from the authority surface. The
following concepts are not active architecture:

- prompt/toolset/constraint/model component stores
- component assembly commands and MCP tools
- Web compose-persona routes and UI flows
- component-kind public vocabulary

Callers register complete canonical PersonaSpec JSON directly.

## Invariants

- `capabilities` is the only tool-access declaration surface in PersonaSpec.
- Runtime approval semantics do not belong in PersonaSpec.
- `variant` and `_registry` are registry-local metadata and must never enter canonical PersonaSpec.
- Active variant resolution returns bare canonical PersonaSpec JSON.
- Active variant changes must update resolved `spec_digest` whenever canonical content changes.
- Canonical persona authority remains separate from runtime and gateway layers.
