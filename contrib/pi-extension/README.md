# Larva Pi extension

This directory contains the bundled Pi Coding Agent extension used by
`larva pi`. The integration projects Larva persona identity, prompt, model, and
adapter-local tool rules into Pi at runtime. The canonical PersonaSpec schema and
field meanings remain owned by opifex; this extension does not add Pi policy,
active-persona, sidecar, or runtime-permission fields to PersonaSpec JSON.

## Launching Pi through Larva

Use the Larva launcher instead of loading this extension manually:

```bash
larva pi --persona python-senior --agent-persona-switch ask -- <pi args...>
```

`--persona` is optional. When omitted for a fresh Pi session, Pi starts with no
active Larva persona until one is selected in the session. When omitted while
opening an existing Pi `--session`, resuming, or reloading, the extension restores
the last active Larva persona recorded in that Pi session when possible.
`--agent-persona-switch off|ask|auto` is also optional and defaults to `off`; the
same default can be supplied through `LARVA_PI_AGENT_PERSONA_SWITCH=off|ask|auto`.
Arguments after `larva pi` are forwarded to the real Pi executable.

The launcher loads the bundled extension with Pi's documented extension flag,
preferring `-e` when supported and otherwise using `--extension`. It must not
fall back to writing `.pi/settings.json` or any other Pi settings file. The
design document is the normative authority for launcher/environment contracts;
this README is an operator-facing summary.

At launch, the environment records the resolved real Pi executable, selected
extension flag, absolute bundled extension entry, Larva CLI argv prefix, optional
initial persona id, optional explicit policy override, interactive-mode
classification, and `LARVA_PI_LAUNCHED=1`. The launched sentinel is consumed as a
recursion guard: child/RPC spawning trusts `LARVA_PI_REAL_BIN`,
`LARVA_PI_EXTENSION_FLAG`, and `LARVA_PI_EXTENSION_ENTRY` only when the sentinel
is present. Without it, child/RPC spawning fails closed with
`LARVA_CHILD_START_FAILED` instead of invoking a possibly recursive launcher
path.

The launcher passes `LARVA_PI_TOOL_POLICY_FILE` only when an explicit override is
set; otherwise the parent and child extensions each resolve the canonical
default policy path themselves. Child Pi RPC sessions reuse launcher-provided
executable, extension, CLI, persona, and interactive-mode values rather than
rediscovering Pi or deriving extension paths.

For `larva pi --persona <id>`, initial persona resolution/model/policy commit is
startup-critical. Extension-detected model or policy failures write
`larva pi: <ERROR_CODE>: <message>` to stderr and exit non-zero before the first
prompt/model turn when `LARVA_PI_LAUNCHED=1`. Manual extension loads without the
launcher sentinel may degrade to an unavailable status instead of being process
fatal.

## Adapter-local model map

PersonaSpec `model` remains canonical Larva data. Pi-provider aliases are
adapter-local Larva-Pi configuration and must not be added to PersonaSpec or
opifex shared contracts.

The canonical model-map path is:

```text
~/.pi/larva/model-map.json
```

Set `LARVA_PI_MODEL_MAP_FILE` to an absolute path to override the path for tests
or local adapter experiments. When it is set, the extension reads only that path
for the model map.

Shape:

```json
{
  "models": {
    "<PersonaSpec.model>": { "provider": "<pi-provider>", "model_id": "<pi-model-id>" }
  },
  "prefix_rules": [
    { "from_prefix": "<literal-prefix>", "to_provider": "<pi-provider>", "to_model_id_prefix": "<literal-prefix-or-empty>" }
  ]
}
```

Resolution rules:

- First check `models[spec.model]` for an exact mapping.
- If there is no exact hit, evaluate only literal `prefix_rules`.
- Choose the longest `from_prefix` that matches `spec.model`.
- If two or more matching prefixes have the same longest length, the config is
  invalid and must surface `LARVA_MODEL_MAP_INVALID`.
- Prefix rules only strip `from_prefix` and prepend `to_model_id_prefix` to the
  remaining model string. Embedded slashes in the remainder are preserved.
- Wildcards, regex, fuzzy matching, nearest-model behavior, and automatic guessing
  (including vendor guessing) are forbidden at runtime.
- After exact or prefix mapping, call Pi
  `modelRegistry.find(provider, model_id)` with the mapped values.
- If mapped values are valid but Pi registry lookup misses, or if `pi.setModel`
  rejects the model, keep using `LARVA_MODEL_UNAVAILABLE`.
- If the model-map file is missing, preserve the current fallback: split
  `PersonaSpec.model` on the first `/` into provider/model id.
- If the config file exists but has invalid JSON, invalid schema, or invalid
  rules, fail closed with `LARVA_MODEL_MAP_INVALID`.
- If there is no exact hit and no prefix hit, preserve the current split fallback.
- Startup persona application and `/larva-persona` switching must use the same
  resolver path.

Runtime-map draft helper policy:

- Use `larva pi-model-map draft` to build a redirect-safe draft from current
  Larva registry summaries, `pi --list-models --offline`, and an optional existing
  model-map file.
- The helper must not read personal scaffold files or apply provider-family
  preference tables. It may choose automatically only when the Pi inventory leaves
  exactly one target candidate.
- Add exact mappings only when the target provider/model id is present in Pi's
  offline registry. If no verified unique target exists, report the source model
  as unresolved instead of guessing.
- Existing exact mappings are preserved only when the source model is still used
  and the target appears in the current Pi inventory.
- Existing literal prefix rules may be preserved only when they cover current
  registry models, map them to current Pi targets, and do not conflict with another
  same-length prefix rule.
- The written `model-map.json` contains only runtime-compatible `models` and
  `prefix_rules`; report metadata belongs on stderr or in the CLI `--json`
  envelope.

Contract verification cases for the implementation step:

- Exact aliases resolve through `models` before any prefix rule is considered.
- Prefix rules preserve embedded slashes after the matched literal prefix is
  stripped.
- Two matching prefix rules with the same `from_prefix` length fail closed with
  `LARVA_MODEL_MAP_INVALID` at runtime and are rejected by the draft helper.
- Startup persona application and `/larva-persona` switching use the same model
  resolver and the same unavailable-model error projection.

## Adapter-local tool policy

Persona-specific Pi tool filtering is configured at the canonical path:

```text
~/.pi/larva/tool-policy.json
```

Set `LARVA_PI_TOOL_POLICY_FILE` to an absolute path to override the path.
Resolution order is:

1. If `LARVA_PI_TOOL_POLICY_FILE` is set, use only that path.
2. Else use only `~/.pi/larva/tool-policy.json`; a missing file means empty
   policy as today.

The extension must not read legacy `~/.pi/tool-policy.json` implicitly. That old
path is unsupported after operator migration. It is valid only when explicitly
named with `LARVA_PI_TOOL_POLICY_FILE`, which preserves strict test/operator
override behavior. The extension must not auto-migrate, rewrite, merge, or create
user policy files, and there is no compatibility window or background migration
daemon.

Operator migration guidance:

- If you still have `~/.pi/tool-policy.json`, move or copy its intended contents
  once to `~/.pi/larva/tool-policy.json`, then remove the old file after
  verifying the new canonical file is in use.
- If you intentionally need the old path for a test, temporary rollout, or local
  adapter experiment, set `LARVA_PI_TOOL_POLICY_FILE` to the absolute legacy path
  (for example, the shell-expanded value of `$HOME/.pi/tool-policy.json`) so the
  non-canonical path is explicit. Do not rely on the extension to discover it as
  a fallback.
- If both `~/.pi/larva/tool-policy.json` and `~/.pi/tool-policy.json` exist during
  migration, treat that as an operator conflict for migration guidance or a
  dedicated migration check: stop, report the two paths, and choose one policy
  file manually. This is not runtime probing. The extension/runtime must not read
  legacy `~/.pi/tool-policy.json` unless that exact file is explicitly named by
  `LARVA_PI_TOOL_POLICY_FILE`; do not merge, overwrite, or infer precedence
  between the two files at runtime.

This file is adapter-local Larva-Pi configuration. It is not a canonical
PersonaSpec field, is not interpreted by opifex, and does not change the meaning
of PersonaSpec `capabilities` or `can_spawn`.

Minimal shape:

```json
{
  "personas": {
    "python-senior": {
      "allow": ["read", "grep", "bash"],
      "deny": ["write", "edit"]
    },
    "doc-reviewer": {
      "allow": ["read", "grep"],
      "deny": ["bash", "write", "edit"]
    }
  }
}
```

Policy rules:

- The top level must be an object with exactly one key, `personas`.
- `personas` must be an object; an empty object is valid.
- Persona keys are canonical PersonaSpec ids.
- Only the active target persona entry is validated beyond top-level shape.
- An active target entry may contain only optional `allow` and `deny` arrays of
  non-empty strings.
- Duplicate names inside one active target `allow` or `deny` array are ignored
  after the first occurrence.
- Matching is exact Pi tool-name matching only. Wildcards, path-level rules,
  command-level bash rules, and project-level overrides are out of scope.
- Tool names unknown to the current Pi runtime are ignored rather than rejected.
- `deny` wins over `allow`; if `allow` is present, only listed existing tools are
  allowed minus denied tools; if `allow` is absent, the current Pi tool baseline
  is allowed minus denied tools.
- There is no `ask` action.

Startup and switch behavior differ only for Pi builds that do not expose the tool
enumeration surface. During initial startup, an absent or unsupported enumerator
uses a startup-tolerant empty baseline so Pi can launch. If startup reaches
active-tool update but `setActiveTools` fails, startup leaves no active persona
committed and shows startup unavailable with `LARVA_TOOL_ENUMERATION_FAILED`.
For `/larva-persona` switching, genuine `getAllTools` failures or active-tool
update failures return `LARVA_TOOL_ENUMERATION_FAILED` and preserve the previous
active persona/model/tool state.

The launcher does not parse this file. It passes the policy path to the Pi
extension, and the extension owns JSON readability, shape validation, and commit
behavior for startup, `/larva-persona` switches, and child session startup.

## Switching personas in Pi

The extension registers this slash command:

```text
/larva-persona <persona-id>
/larva-persona --refresh-cache
```

`--refresh-cache` refreshes only the adapter-local persona candidate cache used
by completion, selector, and `@persona` autocomplete. It does not switch persona,
model, or active tools, does not change session state, and is not a model-facing
LLM tool. No separate refresh slash command or alias is registered.

Switching resolves the target persona through the Larva CLI context supplied by
the launcher, validates the target model and active policy entry, computes tool
rules, and commits the persona atomically. A successful commit applies the
persona's resolved Pi model as the default model for that activation, but it does
not create a per-turn model lock. If the operator later changes Pi's active model
with Pi's `/model` command or model-cycling shortcut, later prompt turns must not
silently reapply `PersonaSpec.model`; the manual Pi runtime choice remains active
until another explicit persona commit or fresh startup/session restore applies a
persona model again. If any step fails, the previous persona, model, and tool
rules remain active. This user-driven command is preserved in every agent
self-switch mode, including `off`.

With no argument, `/larva-persona` opens a selector only in interactive TUI mode.
The selector is populated from the same adapter-local persona candidate cache as
completion and mentions. When Pi exposes custom UI, the selector uses Pi TUI
`Input` plus `SelectList` with a detail panel showing id, model, description,
capabilities, and digest.
The selector renders as a boxed modal surface with an accent-colored border,
solid ANSI background, adaptive list viewport that expands to available terminal
height while keeping detail/footer bounded, and terminal-compatible drop shadow;
its frame height remains stable across filter, navigation, and width-safe render
states. `Enter` confirms and `Esc` cancels. Mouse clicks are intentionally
unsupported no-ops.

Interactive TUI mode also registers `ctrl+alt+p` as a conflict-screened Pi
extension shortcut for opening the same no-argument selector path. The shortcut
is intentionally an extension shortcut, not a `keybindings.json` command alias;
if Pi is not idle it shows a warning and leaves active state unchanged. If the
enhanced custom UI cannot be opened but Pi's simpler selector API is available,
the command or shortcut may fall back to that selector. In RPC, print, JSON, SDK,
malformed mode, unknown mode, or other non-interactive launcher classifications,
the command returns an input error and leaves active state unchanged. The Pi
status line shows:

```text
larva: <id>
```

or, when no persona is active:

```text
larva: none
```

### Session persona restore

Active persona selection is Pi-session-local adapter state. Successful persona
commits append a versioned custom session entry, `larva-active-persona-commit`,
containing the selected `persona_id`, current `spec_digest`, source, and commit
time. This entry records the user's/session's active persona choice; it is not a
PersonaSpec field, not an opifex/shared-contract surface, not a prompt block, and
not a child-session sidecar.

Startup restore precedence is:

```text
explicit --persona / LARVA_PI_INITIAL_PERSONA_ID
  > latest larva-active-persona-commit in the Pi session
  > no active persona
```

An explicit startup persona always wins over any stored session persona and writes
a new commit entry after a successful commit. Session restore never directly
mutates `state.envelope`; during the restore initialization pass it reruns the
same commit pipeline as `/larva-persona` so prompt injection, model selection,
tool policy, active tools, and status are reconstructed together. After that
initialization pass, ordinary prompt turns reuse the in-memory active persona and
must not rerun the commit pipeline merely because new session entries were
appended. The restore guard is keyed by the startup persona or the latest stored
active-persona entry's persona id, not by raw session entry count, so normal
conversation turns do not clobber a later manual Pi model choice while
branch/session changes whose latest stored persona id differs can still rehydrate
the correct persona.
The stored digest is diagnostic only: if the registry's current PersonaSpec
digest differs, restore uses the current registry definition for the stored
`persona_id`.

If explicit startup persona commit fails, launcher startup remains fatal as
documented above. If session restore fails because the stored persona is missing
or current model/policy/tool activation fails, startup is non-fatal: the extension
keeps no active persona, shows restore-unavailable status/notification, and does
not silently claim the old persona. Restore does not recover one-turn
self-switch guards, does not parse prompt blocks, does not scan JSONL history,
and does not use adapter-local subagent presentation cache or `larva_subagent`
task ids as authority.

### Agent persona self-switch

Agent persona self-switch is session-level Pi extension policy. It does not add
fields to PersonaSpec, does not change opifex shared contracts, and does not give
the model direct access to the internal `commitPersona` primitive.

Configure the launch default with either surface:

```text
larva pi --agent-persona-switch off|ask|auto ...
LARVA_PI_AGENT_PERSONA_SWITCH=off|ask|auto
```

Change the current Pi session mode with:

```text
/larva-mode [off|ask|auto]
```

Mode behavior:

- `off` is the default. `larva_persona_switch` and `larva_personas` are hidden
  from the active model-facing tool set, and stale or forged calls to those
  autonomous tools are rejected with `LARVA_AGENT_PERSONA_SWITCH_OFF`. Manual
  `/larva-persona <id>` remains available.
- `ask` exposes `larva_persona_switch(persona_id, reason, handoff?,
  continue_task?, max_switches_per_chain?)` and read-only
  `larva_personas(query?, limit?)`. A requested switch commits only after UI
  confirmation. Rejection, cancellation, timeout, or missing UI fails safely
  without changing persona, model, or tool state.
- `auto` exposes the same tools and commits an allowed self-switch without UI
  confirmation while the request-chain switch budget remains. The default is 20
  successful committed switches. `max_switches_per_chain: 0` means unlimited for
  the current request chain. The budget is a tool parameter, not an environment
  variable.

`larva_personas` is bounded discovery metadata; it is not a prompt/spec catalogue
injection surface. `larva_persona_switch` requires a non-empty `reason`; `handoff`
is optional and bounded. Failed, rejected, and same-persona no-op calls do not
consume switch budget. A successful autonomous switch returns a tool result with
`terminate=true` because the current provider turn started under the old persona
prompt. The success `details` include generic active-persona proof:
`previous_persona`, `active_persona`, `spec_digest`, and
`commit_source: "self-switch"`. If `continue_task` is true, the extension sends an
explicit Larva-authored follow-up using Pi's follow-up delivery:

```text
[Larva-generated continuation after persona switch]
Switched from <old-persona> to <new-persona>.
Reason: <reason>
Handoff: <handoff>
You are now operating under the NEW active Larva persona.
Treat the persona switch as a hard boundary: the new persona's instructions now take priority.
If any previous execution plan conflicts with the new persona's mandatory startup or decision protocol, discard that plan.
Before taking further action, follow the new persona's opening/startup protocol if it defines one.
Continue the user's original task under the new persona.
Do not switch again unless newly justified.
```

That continuation is auditable runtime orchestration text, not a human-authored
request. The current implementation also enforces the first-target child boundary:
child Pi sessions spawned by `larva_subagent` always start with
`LARVA_PI_AGENT_PERSONA_SWITCH=off`. There is no implemented
`LARVA_PI_CHILD_AGENT_PERSONA_SWITCH` environment variable, no child
inherit/ask/auto mode, and no child self-switch policy beyond this default-off
boundary.

### Prompt identity composition

When a Larva persona is active, the extension keeps Pi's operational prompt
intact and adds Larva-owned identity blocks around it. This is intentionally not a
replacement of Pi's full system prompt: Pi still owns the tool list, guidelines,
Pi documentation notes, project context, skills, date, and working directory.

The effective prompt shape is:

```text
<!-- larva:identity-policy:begin -->
Active Larva persona is the primary identity. Pi's generic coding-assistant
wording describes the runtime harness and tools only.
<!-- larva:identity-policy:end -->

<current Pi chained system prompt, unchanged>

<!-- larva:active-persona:begin -->
<!-- larva-spec: <persona-id>@<spec-digest> -->
<committed PersonaSpec prompt text>
Use Larva MCP or the larva CLI (`larva`, fallback `uvx larva`) to discover and
resolve personas when needed.
<!-- larva:active-persona:end -->
```

Prompt injection is idempotent by removing only previous Larva-managed blocks
bounded by the `larva:identity-policy` and `larva:active-persona` markers before
adding the current blocks. The extension must not match or rewrite Pi's default
identity sentence, rebuild Pi's prompt builder, or edit provider-specific request
payloads to make persona identity work.


### `/larva-persona` Tab completion

The supported editor-autocomplete target is Pi interactive TUI with a runtime UI
context that exposes `ctx.ui.addAutocompleteProvider`. In that target, the
command keeps Pi's command-level argument completer and installs a narrow TUI
autocomplete provider for editor Tab completion. In non-TUI modes, or when that
hook is unavailable, the extension does not provide editor autocomplete; it keeps
the command-level completer only and delegates or returns `null` for editor
autocomplete. The provider intercepts only a slash-command line shaped as:

```text
/larva-persona <query>
```

Implemented behavior:

- Typing `/larva-persona <query>` and pressing Tab shows matching persona ids
  from the adapter-local persona candidate cache when the runtime exposes the
  editor provider hook. The cache source is public `larva list --json`.
- Matching is case-insensitive substring matching over persona ids, not only
  prefix matching. For example, `senior` should match `python-senior`.
- Prefix matches rank before non-prefix substring matches. Otherwise preserve the
  latest accepted candidate-cache order.
- Forced Tab and regular completion use the same matching path.
- All non-`/larva-persona` editor input is delegated to Pi's base provider so
  global and file completion remain Pi-owned.

Completion candidates have Pi's command item shape:

```json
{"value": "persona-id", "label": "persona-id", "description": "optional description or model"}
```

Performance target:

- The extension keeps a two-tier adapter-local persona candidate cache: process
  memory and a Pi-owned Larva cache file. The default disk path is
  `~/.pi/larva/persona-candidates-cache.json`; tests may set the absolute-path
  override `LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE`.
- The cache is generated only from public `larva list --json`; the Pi extension
  must not directly read `~/.larva/registry` for candidate population.
- Cache entries are prompt-free UI projections containing exactly `id`,
  `description`, `model`, `spec_digest`, and `capabilities`. They never contain
  `prompt` or full PersonaSpec content.
- Completion, no-argument selector, and `@persona` autocomplete hot paths return
  memory cache when present, else disk cache when present, and trigger background
  refresh when data is stale or missing. They must not synchronously wait on slow
  `larva list --json`.
- If both caches are empty, the provider returns `null` or a bounded empty result
  compatible with the calling UI and starts background refresh.
- Background refresh failure preserves stale cache and does not throw through the
  Pi TUI.
- `/larva-persona --refresh-cache` forces a foreground refresh through public
  `larva list --json`. Success updates memory and disk cache; failure keeps the
  old cache and reports a bounded failure reason. This option is part of the
  existing `/larva-persona` command; it is not a new slash command, not an LLM
  tool, and not a persona/model/tool-policy/session-state change.
- Tests must be able to reset process-local cache state and redirect disk cache
  to a temp path via `LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE`.

This is substring matching, not fuzzy matching: no edit distance, wildcard,
regex, nearest-persona guessing, or hidden aliases.

Troubleshooting commands for runtime autocomplete behavior:

```bash
node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl
node scripts/pi-extension-autocomplete-smoke.mjs --case tab-regular --prefix vectl
node scripts/pi-extension-autocomplete-smoke.mjs --case delegate-other-input
node scripts/pi-extension-autocomplete-smoke.mjs --case list-failure
uv run pytest tests/shell/test_pi_extension_real_runtime.py -k autocomplete -v
```

The runtime gate for editor autocomplete must prove the tested Pi build exposes
`ctx.ui.addAutocompleteProvider` before claiming editor-autocomplete support. The
local Node harness intentionally reports mock-only hook provenance as degraded:
`capability-gates.runtime.hardGates.uiAutocompleteProvider.supported` stays
`false` when the only observed hook is `runtimeHarness.mock`. Mock/local hook
proof is useful for provider behavior, but it is never sufficient to claim live
Pi interactive TUI editor-autocomplete support.

### `@persona:<id>` mentions

When Pi interactive TUI exposes `ctx.ui.addAutocompleteProvider`, the extension
adds a narrow autocomplete provider for Larva persona mentions in the editor:

```text
@persona:<persona-id>
```

The mention is only an id-only user-facing reference to a Larva persona. It is
not a command, does not switch the active parent persona, does not automatically
call `larva_subagent`, and does not inject the mentioned persona's prompt or full
spec into the parent context. The parent agent decides normally whether the
mention is relevant and whether calling `larva_subagent` is useful.

Autocomplete uses the same adapter-local persona candidate cache and matching
rules as `/larva-persona` completion. Candidate `value` and dedupe identity are
exactly `@persona:<id>`. Any trailing space or suffix after insertion is Pi UI
behavior outside the Larva candidate value. Candidates may include the persona
description or model in the completion description. When persona candidates and Pi
file-reference candidates are both present, Pi file-reference candidates keep
their original order, persona candidates are appended after them, and exact
duplicate insertion `value`s across the merged list are removed by keeping the
first candidate.

Larva handles only these mention tokens:

| Token shape | Larva behavior |
| --- | --- |
| `@` | Show persona candidates after Pi file-reference candidates. |
| Prefix of literal `@persona:` such as `@p`, `@pe`, `@per`, `@persona` | Show namespace/persona candidates. |
| `@persona:<query>` | Match persona ids using `<query>`. |
| Id-like or file-like raw short forms such as `@py`, `@python`, `@doc`, `@python-senior`, `@foo/bar` | Delegate only to Pi file-reference completion. |

The raw short form `@<id>` is reserved for a possible future usability pass and
is not part of the first target. Id-like raw short-form prefixes must not trigger
Larva persona matching until short form is explicitly implemented.

## Supplemental local/CI runtime gate

Pi extension work is not complete with source-token contract checks or Invar
alone. Run the supplemental runtime gate before handing off Pi extension changes:

```bash
uv run pytest tests/shell/test_pi_extension_real_runtime.py -v
```

CI runs the combined gate so legacy contract coverage and supplemental runtime
coverage stay distinct and additive:

```bash
uv run pytest tests/shell/test_pi_extension_contract.py tests/shell/test_pi_extension_real_runtime.py -v
```

Runtime capability/provenance is summarized by:

```bash
node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates
```

The capability-gates output is evidence, not a replacement contract. Normative
behavior for async/background subagents, targeted cancellation, and the unified
`/larva-subagent` UX lives in
`docs/reference/PI_EXTENSION_ASYNC_SUBAGENTS.md`. Older runtime capability notes
in `design/pi-coding-agent-integration.md` remain historical unless they agree
with that design basis.

The supplemental gate uses `--offline` runtime scenarios and the deterministic
fake Larva CLI bridge under `tests/fixtures/pi/fake-larva-cli.mjs`; it does not
require live network access or session credentials. If the real Pi binary is not
available or cannot report an extension flag, real-Pi scenarios skip with the
captured availability evidence. If Pi is present but its RPC runtime does not
expose extension UI/custom-command observability, those scenarios xfail with RPC
evidence. Plugin load, slash-command liveness, and other product/runtime failures
must fail the gate rather than being hidden behind unconditional skips.

For controlled child RPC liveness, run:

```bash
node scripts/pi-extension-runtime-smoke.mjs --scenario live-child-rpc-proof
```

A PASS requires the `runtime.controlledLive` checks to prove fresh child startup,
resume, abort propagation, and orphan-free cleanup. If Pi or extension loading is
unavailable, the proof is blocked rather than silently passed.

## Pi TUI dependency and UI component policy

The Pi extension is a Node/TypeScript runtime surface and formally depends on
exact `@earendil-works/pi-tui@0.78.0` for terminal UI correctness. That exact
version is declared in `contrib/pi-extension/package.json` and locked by
`contrib/pi-extension/package-lock.json`. Local development and CI must install
the extension dependency set before Pi-extension UI work:

```bash
npm --prefix contrib/pi-extension ci
```

Version governance: keep `@earendil-works/pi-tui` pinned to exactly `0.78.0` for
this integration target. Do not use a semver range until compatibility is proven
against the live Pi runtime. When Pi is upgraded, update both the package file and
lockfile in the same implementation pass and rerun the Pi-extension UI/runtime
gates.

UI rendering rules:

- Import Pi TUI primitives directly from `@earendil-works/pi-tui`; do not rely on
  host-global module resolution or local text-width shims for this target.
- Use Pi TUI `visibleWidth`, `truncateToWidth`, and `wrapTextWithAnsi` for all
  width-sensitive text, border rows, wrapping, and truncation.
- Use Pi TUI `matchesKey`/`Key` and injected Pi keybindings for keyboard input;
  raw ANSI fallbacks may remain only for runtime compatibility gaps.
- Prefer Pi TUI `Markdown`, `Text`, `TruncatedText`, `Input`, `SelectList`,
  `Container`, and `Box` over handwritten equivalents.
- Every custom component `render(width)` line must satisfy visible width `<= width`.
- Modal custom overlays should use terminal-compatible surface cues: full-row
  solid ANSI background, accent-colored border, stable frame height, and optional
  right/bottom drop shadow that stays within the provided render width.
- Persona selector layouts should allocate fixed/bounded space for filter,
  detail, and footer rows, then give remaining rows to an adaptive list viewport
  so tall terminals show more candidates instead of unused bottom padding.
- Adapter-local shortcuts should use `pi.registerShortcut` and conflict-screened
  key combinations. The persona selector shortcut is `ctrl+alt+p` (`p` for
  persona); it reuses the `/larva-persona` no-argument selector path and is not a
  `keybindings.json` command alias.
- Mouse wheel is supported by overlay-scoped SGR mouse reporting. Mouse click is
  intentionally unsupported for this target.

The extension should keep custom code only for adapter-specific state and layout
that Pi TUI does not provide directly, such as subagent presentation-log scroll
state, tab state, and mouse-reporting lifecycle cleanup.

Enhanced UI proof is split between deterministic component harnesses and runtime
smoke provenance. Harnesses prove direct Pi TUI imports, width-safe rendering,
Markdown output, overlay tabs, selector detail behavior, and mouse-click no-op
behavior. `node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates`
records runtime hard-gate provenance; mock-only or unavailable Pi/TUI evidence
must be reported as unsupported or blocked rather than as live support.

## `larva_subagent` custom tool

The accepted design basis for the current subagent work is
[`docs/reference/PI_EXTENSION_ASYNC_SUBAGENTS.md`](../../docs/reference/PI_EXTENSION_ASYNC_SUBAGENTS.md).
That document is authoritative for async/background behavior, targeted
cancellation, result callback semantics, and the unified `/larva-subagent` UX.

Target design: when the active parent persona and Pi tool policy allow it, the
extension will expose these model-facing tools after the async subagent work is
implemented:

```text
larva_subagent(persona_id, task, task_id?)
larva_subagent_status(task_id?, limit?)
larva_subagent_cancel(task_id, reason)
```

`larva_subagent` starts or resumes one child Pi session and returns after the
child prompt has been accepted, not after the child finishes. Its successful tool
result is an accepted receipt with:

- `status: "accepted"`
- `result_pending: true`
- non-null public `task_id`
- `persona_id`
- `error: null`

The accepted result is not task evidence. The child final result returns later as
a Larva custom runtime event delivered through Pi `sendMessage` with a hard
boundary that the child output is data/evidence, not a user instruction. Pi stores
that event as a custom message, but it is still converted into LLM-compatible
user-role content before provider calls, so the boundary text is required.

The public `task_id` is the child Pi `.jsonl` session file path under the child
session root. It is the only durable public resume/status/cancel handle. The
extension must not expose public `run_id`, `last`, fuzzy matching, sidecar
provenance handles, or batch cancellation. Internal private operation keys may
exist before `task_id` allocation but must not appear in user-facing or
model-facing APIs.

The child session root defaults to:

```text
~/.pi/larva/child-sessions
```

`larva_subagent_status` is read-only process-local inspection. With `task_id`, it
reports the exact observed run. Without `task_id`, it reports newest observed
runs up to `limit`; `limit` defaults to 10 and must be an integer from 1 to 25.
It does not scan child session directories and does not infer resume provenance.
A well-formed but unobserved exact `task_id` returns an empty result rather than a
guess.

`larva_subagent_cancel` cancels one exact active child by `task_id` and requires a
non-empty bounded reason. Cancellation must target only that child: it must not
abort the parent agent, reset every child, delete child session files, or cancel
sibling subagents. The adapter waits 1500 ms after child RPC abort before killing
the child process as fallback. If the model-facing cancel tool returns a terminal
result, duplicate terminal callback is suppressed; if it returns non-terminal
`cancelling`, the eventual terminal result still delivers one callback. User
command/Console cancellation delivers one terminal callback unless the parent
session becomes stale. The stable terminal cancellation code is
`LARVA_CHILD_CANCELLED`.

The extension keeps active subagents in the process-local `activeSubagentRuns`
registry keyed by the public `task_id` once known. `moveSubagentRunToTaskId`
transfers startup records to that public key, `activeSubagentRunByTaskId` owns
exact lookup, and `cancelSubagentByTaskId` owns targeted cancellation. Terminal
states are immutable for control purposes: stale or late child completions must
not duplicate callbacks or revive cancelled tasks. Same-process duplicate resumes
of an active `task_id` return `LARVA_SESSION_BUSY`.

Failure and cancellation paths return renderer-safe Pi ToolResult wrappers with
stable error text in `content` and machine-readable state in `details`. Existing
stable errors such as `LARVA_NO_ACTIVE_PERSONA`, `LARVA_BAD_INPUT`,
`LARVA_CHILD_PROTOCOL_FAILED`, `LARVA_CHILD_CANCELLED`, and
`LARVA_SESSION_BUSY` remain stable.

For runtime proof probes only, tests may set `LARVA_PI_CHILD_RPC_TRACE_FILE` to
an explicit trace path. The trace is diagnostic only: it is for runtime proof
probes only, not a public resume handle, not a provenance record, not sidecar
metadata, not model-facing helper state, and not authority for `larva_subagent_sessions`.
Trace write failures are ignored so proof instrumentation cannot change child
runtime behavior.

### `/larva-subagent` console

Target design: the canonical user command after the async subagent work is
implemented is:

```text
/larva-subagent
/larva-subagent <task_id>
/larva-subagent --cancel <task_id>
/larva-subagent --clear
```

In TUI mode, `/larva-subagent` opens the Subagent Console through Pi custom TUI
overlay support (`ctx.ui.custom(..., { overlay: true })`). The Console keeps the
concise `Larva subagent log` chrome title for continuity with the persona
selector visual language: accent-colored border, solid ANSI background, stable
frame height, terminal-compatible drop shadow, 90% width, and 90% max-height. The
Console is an event-driven view over adapter-local presentation state, with
bounded Markdown-capable panes for Summary, Prompt, Output, Timeline, and
Metadata; the Prompt pane contains the full initial prompt. It is not timer polling.
It can cancel the selected exact running child after confirmation, and mouse click
input remains unsupported/no-op.

In RPC mode, Pi does not support custom overlays; command handlers return
textual summaries, exact-task summaries, cancellation results, or cache-clear
results. In print/json mode, interactive console actions return
`LARVA_SUBAGENT_UI_UNAVAILABLE`; non-interactive exact summaries may still be
returned for `/larva-subagent <task_id>`.

Current implementations may still expose `/larva-log` until the async subagent
work lands. In the target design, `/larva-log` is no longer the canonical UX. It
may remain as a deprecated compatibility alias to `/larva-subagent` view mode,
but new docs, tests, and user flows should use `/larva-subagent`.

The Console and its Persistent cache are adapter-local UI inspection surfaces
only. The cache target is `subagent-presentation-log.json`; optional adapter-local
configuration remains `subagent-log.json`, and invalid config surfaces
`LARVA_SUBAGENT_LOG_CONFIG_INVALID`. They are not resume authority, not
model-visible log streams, not shared Larva/opifex schemas, and not child-session
sources of truth. Clearing the Console/cache with `--clear` must not delete child
Pi session files or mutate persona/model/tool-policy state.

### Verification requirements

The async subagent implementation is not complete until tests or runtime smoke
prove:

1. `larva_subagent` returns accepted while the child remains running.
2. The parent agent can continue after the accepted result.
3. Final child output returns through one bounded Larva custom runtime event.
4. Cancelling child A does not cancel child B or the parent agent.
5. Model-facing cancel suppresses duplicate callback only when the tool result is
   already terminal; non-terminal `cancelling` later delivers one terminal
   callback.
6. User command/Console cancel emits one terminal callback unless the parent
   session becomes stale.
7. Stale/late completions do not duplicate callbacks or revive cancelled tasks.
8. Reload/new/resume/fork/quit abort active children and never send callbacks
   through stale Pi contexts.
9. RPC and print/json command behavior matches the documented mode matrix.
10. During parent streaming, `/larva-subagent` executes as an extension command
    and can open the TUI overlay.

## Explicit non-goals and unsupported guarantees

Do not infer these guarantees from `larva pi` or this extension:

- No PersonaSpec schema changes, Pi-specific PersonaSpec fields, or Pi-specific
  policy fields in PersonaSpec.
- No opifex shared-contract changes for Pi model aliases or tool policy.
- No automatic migration or writes to user config files under `~/.pi`.
- No wildcard, regex, fuzzy, nearest-model, automatic guessing, or
  vendor-guessing semantics for model-map resolution.
- No `ask` permission action; tool policy is exact `allow`/`deny` only.
- No Pi settings fallback for extension loading.
- No Pi prompt-builder replacement, Pi default identity sentence matching, or
  provider-payload rewrite for persona identity.
- No worktree isolation, file locking, merge management, sandboxing, or credential
  isolation.
- No project-level policy hierarchy.
- No batch subagent tool or job scheduler.
- No subagent catalogue dumped into the system prompt.
- No Larva sidecar metadata or provenance file for child sessions.
- No model-visible overlay log stream; `/larva-subagent` is the canonical
  user-visible adapter-local presentation/control surface. `/larva-log`, if
  retained, is only a deprecated view-mode alias. Persistent cache entries are UI
  inspection state only, and live stream previews are process-local only.
- No mouse click support for this target; keyboard controls and overlay mouse
  wheel scrolling are the supported TUI interactions.
- No MCP transport implementation inside this integration; users may install a Pi
  MCP bridge separately.
