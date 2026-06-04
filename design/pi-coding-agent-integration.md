# Pi Coding Agent Integration

Status: implementation authority for the current `larva pi` target
Scope: `larva pi` launcher, bundled Pi extension, persona switching, adapter-local Pi tool policy keyed by persona id, and Larva-backed subagent spawning  
Canonical contract authority: opifex-owned PersonaSpec schema

## Decision

`larva` will support Pi Coding Agent through a small launcher plus a bundled Pi
extension.

The integration projects Larva personas into Pi at runtime. It does not change
the canonical `PersonaSpec` shape and does not make Larva a workspace sandbox,
task scheduler, or general Pi permission platform.

The integration owns six runtime behaviors:

1. start Pi with an optional active Larva persona;
2. switch the active persona in-place during a Pi session;
3. apply persona-specific model-map and tool rules;
4. spawn a child Pi session as a Larva persona through one subagent tool;
5. surface canonical persona mention autocomplete in Pi's interactive editor;
6. keep persona selector/autocomplete hot paths fast with an adapter-local,
   prompt-free candidate cache sourced only from public `larva list --json`.

## Rationale

Pi keeps its core small and exposes extension hooks for commands, system-prompt
updates, model changes, tool-call interception, UI status, and custom tools. The
simplest integration is therefore a Pi extension loaded by a `larva pi` launcher.

OpenCode is useful precedent but not a template to copy wholesale. OpenCode has a
native agent/subagent/permission runtime. Pi does not. The Larva-Pi path should
only project Larva persona identity and persona-owned runtime rules into Pi. It
must not recreate OpenCode's full runtime or add unrelated workspace management.

## Non-goals

- No `PersonaSpec` schema changes.
- No `tools`, `side_effect_policy`, local policy, active persona, variant, or Pi
  state fields inside canonical PersonaSpec JSON.
- No Pi-specific PersonaSpec fields.
- No `ask` permission action. Tool rules are only `allow` and `deny`.
- No worktree isolation, file locking, merge management, sandboxing, or credential
  isolation.
- No project-level policy hierarchy.
- No batch subagent tool.
- No subagent catalogue dumped into the system prompt.
- No direct private-registry parsing by the Pi extension for persona candidates.
- No `PersonaCandidateIndex`, persistent Pi bridge daemon, or registry revision
  invalidation for the first candidate-cache pass.
- No MCP transport implementation inside this integration. A Pi MCP bridge may be
  installed separately by the user.

## Evidence and constraints

- [Proven] `../opifex/contracts/persona_spec.schema.json` makes `id`,
  `description`, `prompt`, `model`, `capabilities`, and `spec_version` canonical
  PersonaSpec fields. It also defines optional `can_spawn`. `tools` and
  `side_effect_policy` are invalid canonical fields.
- [Proven] `../opifex/design/final-canonical-contract.md` states that
  `capabilities` expresses an intent ceiling, not runtime approval policy.
- [Proven] Larva exposes persona registry access through MCP/facade surfaces such
  as `larva_list`, `larva_export`, and `larva_resolve` in `src/larva/shell`.
- [Proven] `uv run larva resolve --help` documents
  `larva resolve <id> --json`; `uv run larva resolve software-architect --json`
  returns `{"data": <PersonaSpec>}`.
- [Proven] `https://pi.dev` describes Pi extensions as TypeScript modules with
  access to tools, commands, keyboard shortcuts, events, and the TUI. It also
  lists interactive, print/JSON, RPC, and SDK modes and advertises mid-session
  model switching.
- [Proven] `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md`
  documents `pi -e ./path.ts` / `--extension` for loading an extension without
  editing settings, `before_agent_start` system-prompt modification,
  `pi.setModel(model)`, `ctx.ui.setStatus(...)`, `pi.getAllTools()`,
  `pi.setActiveTools(...)`, command registration, and `tool_call` interception.
  It also states sibling tool calls are preflighted sequentially and then
  executed concurrently in default parallel tool mode.
- [Proven] `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md`
  documents `pi --mode rpc`, JSONL commands (`prompt`, `switch_session`,
  `get_state`, `get_last_assistant_text`, `abort`), and `agent_end` events.
- [Proven] `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts`
  shows extension event hooks, `tool_call` interception with block reasons,
  custom tool registration, command registration, and SDK
  `DefaultResourceLoader.additionalExtensionPaths`.
- [Likely] Pi has no native MCP, subagent, or permission-popup layer; these are
  extension/package concerns unless verified otherwise in Pi's source.

## Runtime UX

### Launch

Preferred entry point:

```bash
larva pi --persona python-senior -- <pi args...>
```

`--persona` is optional. When omitted, Pi starts without an active Larva persona
until the user chooses one inside the session.

Arguments after `larva pi` are forwarded to the real Pi executable. The launcher
does not write `.pi/settings.json` or any user Pi config file.

Bundled extension loading:

- The launcher invokes the real Pi CLI with Pi's documented extension flag:
  `<real-pi-bin> <extension-flag> <absolute path to bundled Larva extension> ...`.
- The absolute bundled extension path is passed to the extension as
  `LARVA_PI_EXTENSION_ENTRY`. Child/RPC sessions must use that path instead of
  deriving it from module metadata or argv inspection.
- User Pi arguments are preserved after Larva-owned flags. The launcher may
  prepend its own `<extension-flag> <bundled extension>` pair before forwarded
  user arguments.
- The launcher detects extension loading support by running the real `pi --help`
  during preflight. If `-e` is present, use `-e`; otherwise if `--extension` is
  present, use `--extension`. If neither flag is present, exit before Pi starts
  with `LARVA_PI_EXTENSION_LOAD_UNSUPPORTED`.
- If the target Pi version does not support an extension flag, the launcher must
  not fall back to writing user or project Pi settings.
- Parent and child/RPC sessions must use the same resolved real Pi executable,
  selected extension flag, and bundled extension entry from launcher-provided
  environment.

Launch failure rules:

- Invalid launcher syntax exits before Pi starts with `LARVA_PI_BAD_ARGS`.
- Missing real `pi` executable exits before Pi starts with `LARVA_PI_NOT_FOUND`.
- Missing bundled extension exits before Pi starts with `LARVA_PI_EXTENSION_NOT_FOUND`.
- If `--persona <id>` is supplied, persona resolution is a mandatory launcher
  preflight check using the same Larva CLI argv prefix later passed to the
  extension. Failure exits before Pi starts with `LARVA_PERSONA_NOT_FOUND`.
- Initial persona commit happens during Pi extension initialization before the
  first user prompt, selector, or `larva: none` status is exposed. If no explicit
  initial persona is supplied while an existing Pi session is opened/resumed or
  the extension is reloaded, the extension may restore the latest adapter-local
  active persona commit stored in that Pi session.
- Tool-policy file parsing and validation happen inside the Pi extension. For
  initial `--persona`, unreadable, malformed, or structurally invalid policy is
  fatal: the extension writes `larva pi: LARVA_POLICY_INVALID: <message>` to
  stderr and terminates startup with a non-zero exit instead of continuing as
  `larva: none`.
- Policy tool names that are not currently registered in Pi are ignored, not
  fatal. During initial startup only, an absent or unsupported Pi tool
  enumeration surface is tolerated by using a startup-tolerant empty baseline so
  older Pi builds can still launch. If startup reaches tool activation but
  `setActiveTools` fails, the extension must leave no active startup persona and
  show startup unavailable with `LARVA_TOOL_ENUMERATION_FAILED` rather than
  committing a false active persona. For in-session switching, genuine
  `getAllTools` failures or active-tool update failures return
  `LARVA_TOOL_ENUMERATION_FAILED` and preserve the previous active state.
- If Pi rejects the requested model for initial `--persona`, the extension writes
  `larva pi: LARVA_MODEL_UNAVAILABLE: <message>` to stderr and terminates startup
  with a non-zero exit. For an in-session switch, it preserves the previous active
  state instead.

Larva-owned startup errors are written to stderr as:

```text
larva pi: <ERROR_CODE>: <human-readable message>
```

For launcher-detected errors, the launcher exits with the codes defined in
Launcher contract. For extension-detected fatal startup errors after Pi has
started, the extension must make the Pi process exit non-zero; if it can choose
the code, it uses `2`. A zero exit after a Larva fatal startup error is invalid.

### Persona switching

The Pi extension registers one slash command for persona selection and cache
maintenance:

```text
/larva-persona <persona-id>
/larva-persona --refresh-cache
```

No additional persona-list refresh slash command or alias is introduced. Keeping
refresh under `/larva-persona` preserves the small command surface: `/larva-persona`,
`/larva-mode`, and `/larva-log`.

The command supports argument completion for persona ids.

Completion target behavior:

- The supported editor-autocomplete target is Pi interactive TUI with a runtime
  UI context that exposes `ctx.ui.addAutocompleteProvider`. TUI/editor completion
  is Tab-driven through Pi's command completer and that narrow hook integration.
- In non-TUI modes, or when `ctx.ui.addAutocompleteProvider` is unavailable, the
  extension does not provide editor autocomplete; it keeps the command-level
  `/larva-persona` completer only and delegates or returns `null` for editor
  autocomplete.
- The narrow provider handles only `/larva-persona <query>` editor input; all
  other editor input delegates to Pi's base provider so global and file
  completion remain Pi-owned.
- The `/larva-persona` completer performs case-insensitive substring matching over
  persona ids. Prefix matches rank before non-prefix substring matches; remaining
  order follows the latest accepted persona candidate cache order, whose source is
  public `larva list --json` output.
- Persona candidate discovery uses an adapter-local stale-while-revalidate cache,
  not direct reads from `~/.larva/registry`. The cache has two tiers:
  process-local memory and an adapter-local disk cache. The default disk path is
  `~/.pi/larva/persona-candidates-cache.json`; tests may redirect it with the
  absolute-path env seam `LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE`.
- Cache entries are a prompt-free UI projection with exactly these candidate
  fields: `id`, `description`, `model`, `spec_digest`, and `capabilities`. The
  projection must not include `prompt`, cache prompt text, or retain full
  PersonaSpec content.
- UI hot paths must not synchronously wait for slow `larva list --json`. Completion
  and selector population return memory cache when present, else disk cache when
  present, and trigger a background refresh when data is missing or stale. If no
  cache exists, they return a bounded empty/loading-compatible result and start a
  background refresh rather than blocking the editor.
- Background refresh runs public `larva list --json`, validates the result shape,
  strips all fields outside the UI projection, updates memory cache, then writes
  the disk cache. Refresh failure keeps the previous cache and records only
  bounded diagnostics.
- `/larva-persona --refresh-cache` is the explicit user freshness escape hatch for
  registry mutations. It is an option on the existing `/larva-persona` command,
  not a new slash command or LLM tool. It forces a foreground refresh through
  public `larva list --json`; success updates memory and disk cache and notifies
  the user; failure preserves the old cache and reports a bounded failure reason.
  It does not change the active persona, selected model, active tool policy, or
  session state.
- Registry mutation is intentionally weakly consistent for this UI surface.
  Newly-added or removed personas need not appear instantly until background
  refresh, TTL expiry, reload, or `/larva-persona --refresh-cache`.
- Tests must be able to reset process-local cache state and direct the disk cache
  path to a test location via `LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE`. Tests
  must also prove the extension never reads the private registry path for
  candidate population.
- This is not fuzzy matching: no edit distance, wildcard, regex, nearest-persona
  guessing, or hidden aliases.

No-argument behavior:

- In interactive TUI mode only, the extension opens a selector populated from the
  same persona candidate cache used by completion and mention autocomplete.
- When Pi custom UI is available, the selector is a Pi TUI component using
  `Input` for filtering, `SelectList` for candidates, and a detail panel showing
  id, model, description, capabilities, and digest. It renders as a boxed modal
  surface with an accent-colored border, solid ANSI background, adaptive list
  viewport that expands to available terminal height while keeping detail/footer
  bounded, and terminal-compatible drop shadow; frame height remains stable
  across filter, navigation, and width-safe render states. `Enter` confirms,
  `Esc` cancels, and mouse-click SGR events are intentionally unsupported
  no-ops. Interactive TUI mode also registers `ctrl+alt+p` as a conflict-screened
  Pi extension shortcut for opening the same no-argument selector path. The
  shortcut is not a `keybindings.json` command alias; when Pi is not idle it
  warns and leaves active state unchanged.
- If the enhanced custom UI cannot be opened but Pi's simpler selector API is
  available, the command may fall back to that selector without changing the
  non-interactive contract.
- RPC `ctx.hasUI` is not enough to open the selector. In RPC, print, or JSON mode,
  no argument returns `ok: false` with `LARVA_BAD_INPUT` and leaves active state
  unchanged.
- Selecting a persona is equivalent to running `/larva-persona <selected-id>`.
- Cancelling the selector returns `ok: false` with `LARVA_BAD_INPUT` and leaves
  active state unchanged.

Switching is in-place and takes effect on the next model invocation. The active
conversation history is not rewritten.

Switch commit is atomic:

1. resolve the target persona;
2. validate that Pi can select the persona model;
3. load and validate adapter-local model-map and tool-policy config if present;
4. compute the active tool rules for the target persona, ignoring policy names for
   tools Pi does not currently expose;
5. commit active persona state and update Pi model/status.

If any step fails, the previous active persona, model, and tool rules remain in
effect. The command returns a user-visible error with one of these stable codes:
`LARVA_BAD_INPUT`, `LARVA_PERSONA_NOT_FOUND`, `LARVA_MODEL_UNAVAILABLE`,
`LARVA_POLICY_INVALID`, or `LARVA_TOOL_ENUMERATION_FAILED`.

### Session-local active persona restore

Active persona choice is represented as an adapter-local Pi session custom entry,
not as PersonaSpec data and not as shared opifex contract data. After each
successful persona commit, the extension appends a versioned entry:

```json
{
  "customType": "larva-active-persona-commit",
  "details": {
    "schema_version": 1,
    "persona_id": "frontend-engineer",
    "spec_digest": "sha256:...",
    "source": "startup|slash-command|selector|self-switch",
    "committed_at": "2026-06-04T00:00:00.000Z"
  }
}
```

This entry records only the session's selected persona id and diagnostic digest.
The Larva registry remains the source of truth for PersonaSpec content. On
restore, the extension resolves the stored `persona_id` against the current
registry and reruns the full commit pipeline: model resolution, `pi.setModel`,
tool-policy filtering, active tool update, prompt-overlay state, and status. It
must not restore by assigning `state.envelope` directly.

Restore precedence is:

```text
explicit --persona / LARVA_PI_INITIAL_PERSONA_ID
  > latest valid larva-active-persona-commit in ctx.session
  > no active persona
```

An explicit startup persona wins over session state and writes a new session
commit entry after success. Digest drift is non-fatal: if the stored digest
differs from the current registry digest, restore uses the current registry
PersonaSpec and may notify that the persona definition changed. If the stored
persona no longer exists, the mapped model is unavailable, policy is invalid, or
active-tool update fails, session restore is non-fatal: the extension leaves no
active persona, shows restore-unavailable status/notification, and never silently
claims the previous persona. Explicit `--persona` failures keep the existing fatal
startup behavior.

Session restore does not parse Larva prompt blocks, scan arbitrary JSONL history,
read `/larva-log` cache, use `larva_subagent` task ids, mutate PersonaSpec, or
restore one-turn agent self-switch guards. `/larva-mode` continues to use its own
session-level mode entry and is restored independently from extension initialization,
`session_start`, or `before_agent_start` event contexts so reload paths that lack
factory-time session entries still recover the latest mode before model startup.

### Agent persona self-switch

The implemented self-switch policy is a Pi session mode, not a PersonaSpec field
or opifex shared-contract change. Launch-time configuration accepts
`larva pi --agent-persona-switch off|ask|auto ...` and
`LARVA_PI_AGENT_PERSONA_SWITCH=off|ask|auto`; the in-session command is
`/larva-mode [off|ask|auto]`.

Mode contract:

- `off` is the default. Autonomous model-facing switch tools are hidden from the
  active tool set and defensive gates reject stale/forged calls. Manual
  `/larva-persona <id>` switching remains available and atomic.
- `ask` exposes `larva_persona_switch(persona_id, reason, handoff?,
  continue_task?, max_switches_per_chain?)` plus read-only bounded
  `larva_personas(query?, limit?)`. Commit requires UI approval; rejection,
  cancellation, timeout, or no UI leaves persona/model/tool state unchanged.
- `auto` exposes the same tools and commits an allowed self-switch without UI
  approval while the request-chain switch budget remains. The default budget is
  20 successful committed switches; `max_switches_per_chain: 0` means unlimited
  for the current request chain. The budget is a tool parameter, not an env var
  or PersonaSpec/opifex field.

A successful model-facing switch returns `terminate=true` so the old persona turn
stops before any continuation under the new prompt. Failed, rejected, and
same-persona no-op requests do not consume switch budget. Success details include
generic active-persona proof: `previous_persona`, `active_persona`,
`spec_digest`, and `commit_source: "self-switch"`. If `continue_task` is true,
the extension sends an explicit Larva-generated Pi follow-up (`deliverAs: "followUp"`)
containing the reason, handoff, and generic hard-boundary text: the new persona's
instructions take priority, and any old execution plan that conflicts with the
new persona's startup or decision protocol must be discarded. This continuation
is auditable runtime text and must not be represented as human-authored input.
The model-facing surface remains the facade tool only; there is no direct
model-facing `commitPersona` tool.

Child subagent Pi processes start with `LARVA_PI_AGENT_PERSONA_SWITCH=off` even
when the parent session is `ask` or `auto`. The current implementation does not
provide `LARVA_PI_CHILD_AGENT_PERSONA_SWITCH` and does not implement child
inherit/ask/auto self-switch modes.

### Persona mentions

The Pi extension supports canonical persona mentions in the interactive TUI
editor:

```text
@persona:<persona-id>
```

This is a mention-only UX feature. It is not a command and has no automatic
runtime side effect. A mention does not switch the active parent persona, does not
force a `larva_subagent` tool call, and does not inject the mentioned persona's
prompt or full PersonaSpec into the parent context. The parent agent should treat
it as user intent/context and decide normally whether calling `larva_subagent` is
useful.

Autocomplete target behavior:

- Persona mention editor autocomplete is available only when the interactive TUI
  runtime exposes `ctx.ui.addAutocompleteProvider`; otherwise, Larva does not add
  mention autocomplete and leaves Pi-owned editor behavior unchanged.
- The provider may surface persona candidates only for the token classes in the
  table below.
- Candidate ids come from the same adapter-local persona candidate cache used by
  `/larva-persona` completion and selector. The cache source is public
  `larva list --json`; the mention provider must not read `~/.larva/registry`.
- Matching and ordering follow `/larva-persona`: case-insensitive substring
  matching, prefix matches first, then current candidate-cache order.
- When persona candidates and Pi file-reference candidates are both present, the
  provider preserves Pi's file-reference candidates in their original order,
  appends Larva `@persona:<id>` candidates after them, and removes exact
  duplicate insertion `value`s across the merged list by keeping the first
  candidate.
- Larva candidate `value` and dedupe identity are exactly `@persona:<id>`. Any
  trailing space or suffix after insertion is Pi UI behavior outside the Larva
  candidate value.
- Candidate descriptions may show persona description or model.
- Unrelated `@...` editor input delegates to Pi's base provider, preserving
  Pi-owned `@` file references. When raw `@` suggestions are shown, persona
  candidates must not replace Pi-owned file-reference suggestions wholesale.

Deterministic mention-token classification:

| Token shape | Larva behavior |
| --- | --- |
| `@` | Show persona candidates after Pi file-reference candidates. |
| Prefix of literal `@persona:` such as `@p`, `@pe`, `@per`, `@persona` | Show namespace/persona candidates. |
| `@persona:<query>` | Match persona ids using `<query>`. |
| Id-like or file-like raw short forms such as `@py`, `@python`, `@doc`, `@python-senior`, `@foo/bar` | Delegate only to Pi file-reference completion. |

The raw short form `@<id>` is reserved for a later usability pass. It is not part
of the first target because it can conflict with Pi's built-in file-reference
syntax. Id-like raw short-form prefixes must not trigger Larva persona matching
until short form is explicitly implemented.

### UI status

In Pi interactive UI, the extension always sets a footer/status entry:

```text
larva: <persona-id>
```

When no Larva persona is active, the status is:

```text
larva: none
```

Print mode may not render this status. JSON/RPC clients may receive UI events and
choose how to display them.

Subagent execution details are shown in the `larva_subagent` tool row through
custom tool rendering and partial updates. The optional `/larva-log`
command may show the same adapter-local presentation log as a view-only,
user-visible overlay. Neither surface replaces this footer status:
`larva: <persona-id>` continues to mean the active parent persona.


### Pi TUI dependency and reusable UI components

The bundled Pi extension is a Node/TypeScript runtime surface and formally
depends on exact `@earendil-works/pi-tui@0.78.0` for terminal UI correctness.
This is an adapter-local runtime dependency, not a Larva/opifex shared-surface
dependency. The exact version is declared under `contrib/pi-extension` in both
`package.json` and `package-lock.json`, and installed with:

```bash
npm --prefix contrib/pi-extension ci
```

Version governance: keep `@earendil-works/pi-tui` pinned to exactly `0.78.0` for
this integration target. Do not switch to a semver range until live Pi runtime
compatibility is proven; Pi upgrades must update both package and lock files in
the same pass and rerun the Pi-extension UI/runtime gates.

The adapter must prefer Pi TUI primitives over handwritten terminal UI code:

- Import primitives directly from `@earendil-works/pi-tui`; host-global module
  resolution and local text-width shims are not acceptable for this target.
- `visibleWidth`, `truncateToWidth`, and `wrapTextWithAnsi` own display-width,
  wrapping, and truncation behavior.
- `matchesKey`/`Key` plus injected Pi keybindings own keyboard matching.
- `Markdown`, `Text`, `TruncatedText`, `Input`, `SelectList`, `Container`, and
  `Box` should be used where they fit the UI surface.
- Custom components remain allowed only for Larva-specific state/layout not
  provided by Pi TUI, including the subagent log overlay's scroll state, keyboard
  tab state, and mouse-reporting lifecycle.

Every component returned through `ctx.ui.custom()` or tool rendering must satisfy
Pi TUI's `render(width)` contract: each returned line's visible width is less
than or equal to `width`. Tests should include CJK text, emoji, ANSI-stripped
input, long task ids, and Markdown output.

Terminal-modal overlays should provide figure/ground separation without relying
on CSS: use a full-row solid ANSI background, accent-colored border, stable frame
height, and optional right/bottom terminal-compatible drop shadow that remains
within the supplied render width. Persona selector layouts should reserve
fixed/bounded rows for filter, detail, and footer content, then give remaining
vertical capacity to an adaptive list viewport so tall terminals show additional
persona candidates rather than unused bottom padding. Adapter-local shortcuts
must use `pi.registerShortcut` with conflict-screened key combinations; the
persona selector shortcut is `ctrl+alt+p` (`p` for persona), reuses the
`/larva-persona` selector path, and is not a `keybindings.json` command alias.

Mouse wheel support is allowed for scrollable overlays by enabling SGR mouse
reporting while the overlay is open and disabling it on dispose. Mouse click
handling is explicitly out of scope for this implementation target.

## Persona runtime projection

Persona projection is snapshot-based for a running process, not live-reloaded every
turn.

The extension resolves a persona and builds a runtime envelope only at these
commit points:

- initial `larva pi --persona <id>` startup;
- successful `/larva-persona <id>` switch;
- new `larva_subagent` child startup;
- resumed `larva_subagent` child startup.

A committed envelope has this shape:

```json
{
  "persona_id": "python-senior",
  "spec_digest": "sha256:...",
  "model": "provider/model-id",
  "prompt": "opaque PersonaSpec prompt text",
  "tool_policy": {
    "allow": ["read", "grep"],
    "deny": ["write", "edit"]
  }
}
```

Registry edits after commit do not affect the active Pi process until the user
runs another explicit switch or resumes a child session in a new child process.
On resume, the child conversation file is reused, but the target persona id is
resolved from the current registry so prompt/model/tool-policy hot fixes apply.

The first design target projects only `prompt`, `model`, `id`, `spec_digest`, and
adapter-local tool policy. Canonical optional fields such as `model_params` and
`compaction_prompt` are intentionally not projected until Pi has a verified place
to apply them.

Prompt projection uses Pi's `before_agent_start` extension hook. On each agent
turn, the extension returns a `systemPrompt` that keeps Pi's current chained
system prompt intact and wraps it with Larva-managed identity blocks. This
preserves Pi's tool list, guidelines, documentation notes, project context,
skills, date, and working directory while making the active Larva persona the
primary identity.

The prompt shape is:

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

Prompt injection must be idempotent. If the incoming `event.systemPrompt` already
contains previous Larva-managed identity or active-persona blocks, the extension
removes only those marker-bounded blocks before adding the current committed
envelope. It must not match or rewrite Pi's default identity sentence, rebuild
Pi's prompt builder from `systemPromptOptions`, or modify provider-specific
request payloads to make persona identity work.

Model projection uses Pi's documented `pi.setModel(model)` API. The PersonaSpec
`model` string stays canonical Larva data; Pi-provider aliases are adapter-local
Larva-Pi configuration only.

Adapter-local model map:

- canonical path: `~/.pi/larva/model-map.json`;
- env override: `LARVA_PI_MODEL_MAP_FILE`; when set, it must be an absolute path
  and the extension reads only that path;
- no PersonaSpec schema change and no opifex shared-contract change.

Model-map shape:

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

Model-map resolution rules:

- First check `models[spec.model]` for an exact hit.
- If there is no exact hit, evaluate only literal `prefix_rules`.
- Pick the longest `from_prefix` that matches `spec.model`.
- Same-length matching prefix conflict is invalid and must surface
  `LARVA_MODEL_MAP_INVALID`, even if either rule would otherwise map to a valid
  Pi model.
- Prefix rules may only strip `from_prefix` and prepend `to_model_id_prefix` to
  the remaining model string; embedded slashes in the remainder are preserved.
- Wildcards, regex, fuzzy matching, nearest-model behavior, and automatic guessing
  (including vendor guessing) are forbidden at runtime.
- After exact or prefix mapping, call Pi `modelRegistry.find(provider, model_id)`
  with the mapped values (via the runtime registry lookup, such as
  `ctx.modelRegistry.find(provider, model_id)`), then call `pi.setModel(model)`.
- Mapped values valid but missing from Pi's registry, or rejected by
  `pi.setModel`, remain `LARVA_MODEL_UNAVAILABLE`.
- Missing model-map file preserves the current fallback: split
  `PersonaSpec.model` on the first `/` into provider/model id.
- Existing config with invalid JSON, invalid schema, or invalid rules fails closed
  with `LARVA_MODEL_MAP_INVALID`.
- Key miss with no prefix hit preserves the current split fallback.
- Startup persona application and `/larva-persona` switching must share the same
  resolver path.

The split fallback parses at the first slash: provider is the substring before the
first slash and model id is the remaining substring after it. Both parts must be
non-empty. This supports current Larva model strings such as
`openrouter/google/gemini-3.1-pro-preview`. Missing slash, empty provider, or
empty model id maps to `LARVA_MODEL_UNAVAILABLE`.

Runtime-map draft helper policy:

- Use `larva pi-model-map draft` to build a redirect-safe draft from current
  Larva registry summaries, `pi --list-models --offline`, and an optional
  existing model-map file.
- The helper must not read personal scaffold files or apply provider-family
  preference tables. It may choose automatically only when the Pi inventory
  leaves exactly one target candidate.
- Add exact mappings only when the target provider/model id is present in Pi's
  offline registry. If no verified unique target exists, report the source model
  as unresolved instead of guessing.
- Existing exact mappings are preserved only when the source model is still used
  and the target appears in the current Pi inventory.
- Existing literal prefix rules may be preserved only when they cover current
  registry models, map them to current Pi targets, and do not conflict with
  another same-length prefix rule.
- The written `model-map.json` contains only runtime-compatible `models` and
  `prefix_rules`; report metadata belongs on stderr or in the CLI `--json`
  envelope.

Current verified model-map example:

```json
{
  "models": {
    "ollama-cloud/glm-5.1": { "provider": "openrouter", "model_id": "z-ai/glm-5.1" },
    "ollama-cloud/kimi-k2.6": { "provider": "openrouter", "model_id": "moonshotai/kimi-k2.6" },
    "ollama-cloud/minimax-m2.7": { "provider": "openrouter", "model_id": "minimax/minimax-m2.7" },
    "openai/gpt-5.5": { "provider": "openai-codex", "model_id": "gpt-5.5" }
  },
  "prefix_rules": [
    { "from_prefix": "openrouter/", "to_provider": "openrouter", "to_model_id_prefix": "" }
  ]
}
```

`openrouter/google/gemini-3.1-pro-preview`,
`openrouter/google/gemini-3.1-flash-lite`, and
`openrouter/google/gemini-3.5-flash` are covered by the `openrouter/` prefix
rule. The old `ollama-cloud/kimi-k2.6:cloud` spelling is not mapped unless an
exact entry is added and verified against Pi's registry.

The active persona block contains the low-noise watermark:

```html
<!-- larva-spec: python-senior@abc123 -->
```

The extension must not inject a full list of available subagents. Instead, it may
include one short instruction:

```text
Use Larva MCP or the larva CLI (`larva`, fallback `uvx larva`) to discover and
resolve personas when needed.
```

This keeps context use bounded when the registry contains many personas.

## Tool policy

### Ownership

`~/.pi/larva/tool-policy.json` is the canonical Larva-Pi adapter file. It is not a canonical
PersonaSpec field and is not interpreted by opifex.

`LARVA_PI_TOOL_POLICY_FILE` remains the absolute-path env override. Resolution order:

1. If `LARVA_PI_TOOL_POLICY_FILE` is set, use only that path.
2. Else use only `~/.pi/larva/tool-policy.json`; missing file means empty policy
   as today.

The adapter must not read legacy `~/.pi/tool-policy.json` implicitly. That old
path is unsupported after operator migration and is valid only when explicitly
named with `LARVA_PI_TOOL_POLICY_FILE`. The adapter must not auto-migrate,
rewrite, merge, or create user policy files, and there is no compatibility window
or background migration daemon.

Operator migration is explicit and one-time:

- Move or copy the intended legacy `~/.pi/tool-policy.json` content to the
  canonical `~/.pi/larva/tool-policy.json`, then remove the old file after
  confirming the canonical file is active.
- Use `LARVA_PI_TOOL_POLICY_FILE` set to the absolute legacy path (for example,
  the shell-expanded value of `$HOME/.pi/tool-policy.json`) only when an operator
  intentionally chooses that non-canonical file for a test, temporary rollout, or
  local adapter experiment. The env var is an explicit override, not an automatic
  fallback signal.
- If both canonical and legacy files exist during migration, fail the migration
  check and report both paths to the operator. This is operator migration guidance
  or a dedicated migration check, not extension/runtime probing. The extension
  runtime must not read legacy `~/.pi/tool-policy.json` unless that exact file is
  explicitly named by `LARVA_PI_TOOL_POLICY_FILE`; do not merge the two files, do
  not overwrite either file, and do not infer precedence between conflicting
  policy files at runtime.

Changed requirement traceability:

| requirement_id | source_ref + key passage | obligation | owning_step_id | evidence_field | status | non_intersection_or_escalation |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | user requirement: no legacy fallback | Runtime MUST NOT read `~/.pi/tool-policy.json` unless explicitly set via `LARVA_PI_TOOL_POLICY_FILE`. | `pi_tool_policy_no_fallback_python_impl_20260601`, `pi_tool_policy_no_fallback_extension_impl_20260601` | `runtime_path_matrix` | OWNED | n/a |
| R2 | user requirement: canonical default | Env absent defaults to `~/.pi/larva/tool-policy.json` only. | `pi_tool_policy_no_fallback_extension_impl_20260601` | `extension_path_matrix` | OWNED | n/a |
| R3 | user requirement: launcher env behavior | Launcher must preserve explicit env override and otherwise not force old path; acceptable choices: do not set env by default or set canonical only. | `pi_tool_policy_no_fallback_python_impl_20260601` | `launcher_env_matrix` | OWNED | n/a |
| R4 | user requirement: direct migration/operator proof | Old-only local state moves to canonical and removes old; both-files conflict fails/reports without merge/overwrite. | `pi_tool_policy_operator_migration_proof_20260601` | `migration_report` | OWNED | n/a |
| R5 | user requirement: docs | Docs state old path unsupported after migration, not fallback. | `pi_tool_policy_no_legacy_docs_20260601` | `docs_diff_summary` | OWNED | n/a |
| R6 | user requirement: tests | Tests prove old-only absent env does NOT apply old policy; canonical applies; explicit env old applies. | `pi_tool_policy_no_legacy_tests_20260601`, `pi_tool_policy_no_legacy_runtime_guard_20260601` | `test_matrix` | OWNED | n/a |

The policy is keyed by canonical persona id. It expresses Pi tool rules for that
persona.

### Shape

Minimal file shape:

```json
{
  "personas": {
    "python-senior": {
      "allow": ["read", "grep", "find", "ls", "bash"],
      "deny": ["write", "edit"]
    },
    "doc-reviewer": {
      "allow": ["read", "grep", "find", "ls"],
      "deny": ["bash", "write", "edit"]
    }
  }
}
```

Policy contract:

- Top level must be a JSON object with exactly one key: `personas`.
- `personas` must be an object. Empty `personas: {}` is valid.
- Persona keys are treated as PersonaSpec ids.
- Only the active target persona entry is validated beyond top-level shape.
- If the active target entry exists, it must be an object with optional `allow` and
  `deny` arrays.
- Unknown keys inside the active target persona policy are invalid.
- `allow` and `deny`, when present in the active target entry, must contain only
  non-empty strings.
- Duplicate names inside one active target `allow` or `deny` array are ignored
  after the first occurrence. This keeps duplicate entries harmless without adding
  another error.
- Non-target persona entries are not inspected during the current commit.
- The Pi extension validates JSON readability and structural shape. The launcher
  does not parse the policy file.
- Policy tool names are applied as exact string filters over Pi's currently
  registered model-facing tools. Names not present in the current Pi registry are
  ignored.
- If Pi cannot enumerate model-facing tool names, the attempted strict commit
  fails with `LARVA_TOOL_ENUMERATION_FAILED` and preserves the previous committed
  envelope. The only startup exception is an absent or unsupported Pi tool
  enumeration surface during initial launch, which uses a startup-tolerant empty
  baseline rather than failing before the first prompt. Startup active-tool update
  failure leaves no active startup persona and exposes startup unavailable with
  `LARVA_TOOL_ENUMERATION_FAILED`.

Matching is exact string matching in the first design target. Wildcards,
path-level rules, command-level bash rules, and project-level overrides are out
of scope.

### Validation boundary

The launcher does not parse the tool-policy file. It only passes the selected
policy file path to the bundled Pi extension through `LARVA_PI_TOOL_POLICY_FILE`
when an override is needed. The Pi extension owns path resolution, parsing, and
validation for initial startup, in-session persona switches, and child startup.

| Validation item | Launcher preflight | Extension commit |
| --- | --- | --- |
| file exists | no; missing file is valid | no; missing file means no adapter-local restrictions |
| file readable if present | no | yes |
| valid JSON if present | no | yes |
| top-level object with only `personas` if present | no | yes |
| `personas` is object if present | no | yes |
| target persona entry shape | no | yes, for active target when entry exists |
| `allow`/`deny` are arrays of strings | no | yes, for active target |
| unknown keys | no | yes, for active target |
| duplicate tool names | no | normalize |
| unknown Pi tool names | no | no; unmatched names are ignored |

For initial `--persona`, extension policy shape failure is fatal startup failure
with `LARVA_POLICY_INVALID`. For an in-session switch, it returns `ok: false` and
preserves the previous active state. For child startup, it returns a failed
`LarvaSubagentResult`.

### Semantics

Tool filtering baseline:

- On every successful strict persona commit, the extension enumerates Pi's current
  model-facing tools and treats that set as the unfiltered baseline for this
  commit. During initial startup only, if the Pi runtime lacks a supported tool
  enumeration surface, the extension may use a startup-tolerant empty baseline.
- The target persona policy is applied to that baseline only. Prior Larva
  restrictions from an earlier persona commit do not carry over.
- Missing configured tool-policy file: no extra Larva-Pi tool restriction; the
  committed active tools are the current baseline.
- Missing active target persona entry: no extra Larva-Pi tool restriction for that
  persona; the committed active tools are the current baseline.
- Pi-required non-model UI/runtime tools are outside this Larva policy surface.

Policy validation and filtering:

- Invalid JSON, unreadable file, wrong top-level shape, invalid active target
  entry shape, non-array `allow`/`deny`, non-string entries, or unknown keys in
  the active target entry: fail the attempted launch/switch and keep the previous
  active policy. If no previous policy exists, no persona is committed.
- Invalid non-target persona entries are ignored until that persona becomes the
  active target.
- Policy tool names that are not registered in the current Pi runtime are ignored.
  They do not make launch or switching fail.
- `deny` wins over `allow` for tools that exist in the current Pi runtime.
- If `allow` is absent, the baseline is allowed minus denied tools.
- If `allow` is present, only listed existing tools are allowed, minus denied
  tools.
- Empty `allow: []` means no model-facing tools are allowed.
- Empty `deny: []` denies nothing.
- A policy denying `larva_subagent` blocks the subagent tool even when
  `can_spawn` would otherwise allow it. The observable result is the generic
  `ToolPolicyDecision` denial with `LARVA_TOOL_DENIED`; the `larva_subagent`
  handler is not invoked and no `LarvaSubagentResult` is produced.

There is no `ask` action.

## Subagent spawning

### Public tool

The extension registers the primary child-session custom tool:

```text
larva_subagent(persona_id, task, task_id?)
```

Input contract:

- `persona_id`: required non-empty string; target Larva persona id.
- `task`: required non-empty string; instruction to send to the child session for
  this invocation.
- `task_id`: optional non-empty string; absolute child Pi session `.jsonl` file
  path under the Larva child session root. Omitted or explicit `null` means new
  child session; empty, blank, non-string non-null, relative, or out-of-root
  values remain invalid.

Bad input returns `status: "failed"` with `LARVA_BAD_INPUT`; it does not create or
resume a child process. For these pre-session failures, public `task_id` is
`null`. `persona_id` in the result is the requested target id only after it passed
basic non-empty string validation; otherwise it is an empty string.

### Recent sessions helper

For medium-frequency subagent reuse, the extension may expose one small read-only
helper:

```text
larva_subagent_sessions(limit?)
```

Input contract:

- `limit`: optional positive integer; default `10`; maximum `25`.
- Invalid `limit` values return `status: "failed"` with `LARVA_BAD_INPUT` and do
  not inspect the filesystem.

Pi-facing ToolResult contract:

- Success returns exactly the adapter-local ToolResult wrapper below. The recent
  sessions array lives under `details.sessions`; there is no top-level
  `sessions` field.

```json
{
  "content": [{"type": "text", "text": "Recent Larva subagent sessions: ..."}],
  "details": {
    "status": "success",
    "sessions": [
      {
        "task_id": "/absolute/path/to/child-session.jsonl",
        "persona_id": "turing",
        "last_status": "cancelled",
        "sequence": 12
      }
    ],
    "error": null
  },
  "isError": false
}
```

- Invalid `limit` returns the same wrapper shape with `details.status` set to
  `"failed"`, `details.sessions` set to `[]`, `details.error` set to
  `{"code": "LARVA_BAD_INPUT", "message": "limit must be an integer from 1 to 25."}`,
  `content[0].text` set to
  `LARVA_BAD_INPUT: limit must be an integer from 1 to 25.`, and `isError:
  true`.

The helper returns recent child sessions observed by the current parent Pi
extension process, newest first by process-local sequence number. Each item
contains only UX/recovery metadata:

```json
{
  "task_id": "/absolute/path/to/child-session.jsonl",
  "persona_id": "turing",
  "last_status": "cancelled",
  "sequence": 12
}
```

This helper is not a second resume mechanism. It does not scan the filesystem,
write sidecar files, infer provenance, expose a `last` alias, or weaken
`larva_subagent(task_id=...)` validation. It is a process-local memory index of
sessions already seen by this parent extension. If the helper returns multiple
plausible sessions, the caller must ask the user which exact `task_id` to resume.


### Runtime visibility

`larva_subagent` uses Pi custom-tool rendering and partial updates so users can
see which child persona is running and what it is doing without waiting for the
final result.

P0 call display:

- Implement `renderCall` for the tool row.
- Collapsed call display shows `larva_subagent -> <persona_id> [new|resume]` and
  a bounded task preview of at most 120 visible characters; longer previews end
  with `...`.
- Resume calls additionally show an abbreviated `task_id` path of at most 80
  visible characters; longer paths keep the filename suffix and start with
  `...`.
- Visible preview limits count Unicode NFC-normalized code points after stripping
  ANSI escape sequences and replacing newlines/control characters with a single
  space. If text is truncated, the ellipsis is included inside the stated bound.
  They do not count display columns or grapheme clusters.
- The actual tool name remains `larva_subagent`; display text is not a protocol
  name and must not be parsed as one.

P1 running updates:

- `execute` emits partial ToolResult updates through Pi's `onUpdate` callback.
- Partial updates carry adapter-local render details: target `persona_id`,
  new/resume mode, task preview, current phase, and `task_id` once known.
- Partial update text is bounded to at most 200 visible characters per update.
- Coarse phases are enough: `starting`, `session_ready`, `prompt_sent`,
  `waiting_for_child`, `collecting_final_text`, then terminal `success`,
  `failed`, or `cancelled`.
- Partial update content is small status text for UI/model safety. The parent
  extension must not stream full child logs or full child transcript into the
  parent context.

P2 result rendering:

- Implement `renderResult` for final and partial results.
- Collapsed final result shows persona and terminal state, for example
  `turing completed`, `turing cancelled`, or `turing failed`.
- Expanded final result shows persona id, new/resume mode, full task, `task_id`
  when known, final status, error if any, final output, and the visible resume
  footer.
- The parent `larva: <persona-id>` footer status remains the parent persona
  status. Subagent visibility belongs to the tool row and the authorized
  `/larva-log` view-only overlay, not to a separate global status
  override.
- Do not add a widget dashboard, Larva-private terminal overlay, filesystem-backed
  monitor, or model-visible log stream. The only authorized overlay for this
  target is `/larva-log`, and it is user-visible, view-only, and
  adapter-local.


### Presentation log view-only overlay

`/larva-log [task_id?]` is an authorized Pi-adapter slash command for
viewing the parent extension's subagent presentation log and optional
adapter-local persistent cache. It is not a model-facing tool, not a shared
Larva/opifex schema, and not a tool-policy input.
It exists only so the human user can inspect recent subagent row/progress/result
presentation without streaming full child logs into the parent model context.

Overlay selection contract:

- The command is registered as `larva-log`; the protocol tool name
  remains `larva_subagent`.
- The optional argument is interpreted as one exact `task_id` after trimming. With
  no argument, the newest retained presentation-log entry is selected in detail
  mode. There is no `last` alias, fuzzy matching, filesystem scan, raw JSONL
  parsing, or sidecar read/write.
- Pressing `s` while the overlay is open enters an in-overlay subagent selector.
  `/larva-log --select` may open directly into that selector. The
  selector does not replace the command's default newest-detail behavior.
- Selector rows are single-line, width-safe summaries containing local started
  time (`HH:MM:SS`), status token, persona id, short task label, phase/status,
  and bounded task preview. Absolute local time is used instead of relative age
  because the overlay is event-driven rather than timer-polled, so relative age
  would become stale while idle. Full task paths, full task prompts, full outputs,
  internal call/frame IDs, and raw child event payloads must stay out of selector
  rows.
- Selector ordering is deterministic: running entries first, then newest
  `updated_at` first, then highest `sequence` first as a tie-breaker. This keeps
  active subagents easiest to inspect while preserving log-like recency for
  completed entries.
- In selector mode, `↑`/`↓` moves the cursor and `Enter` selects the highlighted
  entry, returning to detail mode without closing the overlay. `Esc`/`q` closes
  the overlay. Mouse click remains unsupported/no-op.
- The overlay content is derived only from the parent extension's presentation
  log for child sessions already observed by this parent process plus the
  adapter-local persistent cache described below. Loaded cache entries are
  inspectable historical UI state, not live event sources.

Persistent cache target:

- The Pi adapter persists the newest renderer-safe presentation entries to
  `~/.pi/larva/subagent-presentation-log.json`.
- Default enabled state is `enabled: true`.
- Default retention is newest 100 entries and entries updated within the last 7
  days. Retention cleanup runs on load, write, and explicit clear.
- Optional config file: `~/.pi/larva/subagent-log.json`.
- Optional absolute file override for tests/users: `LARVA_PI_SUBAGENT_LOG_FILE`.
- Config shape is adapter-local and intentionally small:
  `enabled`, `max_entries`, `max_age_days`, `include_prompt`, and
  `include_output`.
- Valid ranges: `max_entries` is an integer from 1 to 1000; `max_age_days` is an
  integer from 1 to 365. Boolean fields must be booleans.
- Malformed config fails closed for persistence: do not write the cache for that
  process, and report a user-visible `LARVA_SUBAGENT_LOG_CONFIG_INVALID` error.
- Persistence is fed only by presentation-log mutations (`running`, progress,
  final result, cancel, failure, reset). It must not scan child session JSONL,
  parse raw Pi transcripts, write sidecars beside child sessions, or infer entries
  from filesystem history.
- Live streaming fields are process-local only for this target. Assistant live
  text previews, normalized timeline events, exact-session assistant excerpt ids,
  normalized tool snapshots, active tool state, and raw child RPC event payloads
  must not be persisted in the adapter cache. The cache sanitizer must drop those fields if they are present
  in memory. In the same parent Pi extension process, terminal presentation
  entries may retain bounded normalized `timeline_events` and `tool_snapshots`
  copied from the running entry so the `Timeline` pane remains useful after
  success, failure, or cancellation; terminal entries must clear
  `active_tool_state` and reload/cache roundtrips must still drop those fields.
- The persisted cache is a UI inspection cache only. It is not resume authority,
  not a child-session source of truth, not model-visible context, not a tool-policy
  input, and not a shared Larva/opifex schema.
- `/larva-log --clear` is the cleanup surface. It clears the
  adapter-local presentation cache and in-memory overlay entries, then closes any
  open overlay. It must not delete child Pi session files, mutate persona/model
  state, alter tool policy, or remove public child `task_id` values.

Live streaming target:

- While a selected subagent is running, the overlay may show live assistant output
  and tool-call activity from the child Pi RPC event stream. Authorized child
  event inputs are `message_update`, `tool_execution_start`,
  `tool_execution_update`, `tool_execution_end`, and terminal agent events such as
  `agent_end`. The implementation must not scan or parse raw child session JSONL
  to reconstruct streaming state.
- Child RPC events are normalized into adapter-local presentation events before
  they reach the overlay. Raw RPC frames must not be rendered, persisted, exposed
  as shared schema, or injected into model-visible context.
- `message_update` text deltas may update a process-local live assistant output
  preview and append or merge into a bounded assistant excerpt in the process-local
  `Timeline`. If real Pi RPC omits assistant `message_update` frames, the adapter
  may read only the exact active child session file to extract bounded assistant
  text excerpts for the same process-local Timeline. `thinking_*` deltas must not
  display thinking content; the overlay may show only a bounded neutral state such
  as `thinking hidden` if useful.
- The final `Output` content remains the final `get_last_assistant_text` result
  after child completion. Live assistant text is a realtime preview only and is
  replaced or reconciled by the final result; preserving terminal
  `timeline_events` for same-process `Timeline` inspection must not make live
  assistant preview text a final-output authority.
- Tool execution events are grouped by `toolCallId` into one changing tool row or
  snapshot per tool call. `tool_execution_start`, `tool_execution_update`, and
  `tool_execution_end` must not create an unbounded three-event firehose. Updates
  replace the current status/output preview for that tool while preserving the
  tool row's first-seen position in the chronological Timeline.
- Tool output belongs in the `Timeline` pane as a bounded preview, not in the
  assistant `Output` pane. The `Output` pane is for assistant live/final text;
  the `Timeline` pane is chronological and action-first: it shows assistant
  message excerpts, hidden-thinking markers, terminal status, tool name,
  human-readable bounded argument summary, bounded output/error preview, and final
  success/failure state. Internal `toolCallId`, frame ids, UUIDs, and provider
  correlation ids are hidden by default and may appear only in bounded
  debug/metadata affordances.
- Overlong selector rows, assistant text, tool args, and tool output must be
  renderer-safe and bounded. Selector rows are single-line truncated summaries.
  Scrollable panes may wrap, but live buffers must still have a hard in-memory
  bound and visible truncation marker so a noisy child cannot turn the overlay
  into an unbounded log stream.

Overlay UI contract:

- The overlay is a Pi TUI-backed custom component. Its visible chrome title is
  the concise `Larva subagent log`; `presentation log` remains the
  internal/design term for adapter-local in-memory UI state. It must use Pi TUI
  `visibleWidth`, `truncateToWidth`, and `wrapTextWithAnsi` for bordered rows,
  pane content, wrapping, and truncation.
- The component must preserve Pi TUI's `render(width)` invariant for every line,
  including CJK text, emoji, Markdown syntax, ANSI-stripped input, long child
  session paths, selector rows, live assistant previews, and tool-output previews.
- The overlay uses the same terminal-modal chrome helpers and frame budget as
  the persona selector: `90%` width, `90%` max height, accent-colored border,
  solid ANSI background, stable frame height across tab/scroll/selector states,
  and a terminal-compatible right/bottom drop shadow that is not clipped by Pi's
  overlay frame.
- The overlay is an event-driven live view while open: presentation-log and
  normalized stream mutations notify the open component, which re-reads the
  selected adapter-local entry and requests a render. For the currently active
  child only, the adapter may also read the exact allocated `task_id`/session file
  already returned by Pi to extract bounded assistant text excerpts for Timeline
  when RPC does not emit `message_update`. This is not timer polling, does not
  scan directories, does not parse arbitrary history, and does not make child
  JSONL resume/provenance authority.
- Event-driven refresh preserves the active tab, selector/detail mode, selected
  entry, selector cursor, and scroll offset where possible. If the selected entry
  disappears during reset/cleanup, the overlay closes or clears through normal
  cleanup.
- The overlay exposes keyboard tabs in input-before-output order with the
  chronological stream after assistant output: `Summary`, `Prompt`, `Output`,
  `Timeline`, and `Metadata`.
- `Summary` shows readable grouped/aligned fields for selected-entry status,
  persona, progress, task id, prompt availability, output availability, live event
  availability, result/error summary, and view-only provenance; it must not inline
  the full prompt, raw Markdown output, raw tool output, or raw RPC payloads.
- `Prompt` shows the full initial subagent prompt/task text with width-safe
  Markdown rendering and readable numbered-step formatting for compact task
  prompts.
- `Output` renders live assistant text while running and final output after
  completion with Pi TUI `Markdown` when output exists; empty output uses a
  renderer-safe fallback.
- `Timeline` shows a process-local bounded chronological presentation stream.
  It may include assistant message excerpts, hidden-thinking markers, terminal
  status, grouped tool-call snapshots, and other normalized stream events. Each
  tool call is displayed as one evolving human-readable action row keyed
  internally by `toolCallId`, with bounded argument summaries, bounded
  output/error previews, and final success/failure status. Assistant excerpts use
  timeline-shaped plain preview rows such as `• assistant <excerpt>` and must not
  full-Markdown-render partial stream fragments; the Output pane remains the
  Markdown-reading surface for assistant text. Tool rows are dimmed, indented rows
  such as `↳ read(path="file") — success`; heavy arguments such as
  full content, patches, diffs, or base64 data are omitted/summarized rather than
  rendered. Default Timeline
  content must not start with or visually privilege internal ids such as `call_*`,
  `toolCallId`, frame ids, UUIDs, or provider correlation ids. Pressing `d` in
  Timeline may reveal bounded debug IDs for diagnosis without polluting the
  default view.
- `Metadata` shows adapter-local fields such as mode, sequence, phase,
  task_preview, prompt pointer, call id, selected task id, overlay generation,
  live-stream availability, error object, bounded debug tool IDs, and view-only
  provenance.
- Keyboard controls in detail mode: `Esc`/`q` close, `s` enters selector mode,
  `↑`/`↓` scroll, `PageUp`/`PageDown` page scroll, `Home`/`End` jump, and
  `1`/`2`/`3`/`4`/`5` or `←`/`→` switch tabs. `Enter` does not close the detail
  overlay.
- Keyboard controls in selector mode: `↑`/`↓` move the selector cursor,
  `PageUp`/`PageDown` page through entries, `Home`/`End` jump, `Enter` selects
  the highlighted entry and returns to detail mode, `s` returns to detail mode,
  and `Esc`/`q` close the overlay.
- Mouse wheel may scroll the active pane or selector list while the overlay is
  open. The component owns mouse-reporting enable/disable cleanup. Mouse click
  support is explicitly out of scope for this target.

Result and safety contract:

- The result shape is adapter-local and view-only: it carries `view_only: true`,
  renderer-safe `content`, and overlay `details`; it does not mirror
  `LarvaSubagentResult` top-level `task_id` or `result_text` fields.
- Opening the overlay may replace the previous overlay generation. Missing
  observed entries return `LARVA_SUBAGENT_LOG_NOT_OBSERVED` and close the current
  overlay; unavailable UI notification returns `LARVA_SUBAGENT_LOG_UI_UNAVAILABLE`.
- The overlay must not mutate persona state, model state, tool policy, active
  task markers, child session files, recent-session index contents, or resume
  authority. Reset/cleanup may close the overlay and clear presentation state.
- Overlay text and live stream previews are user-visible only. They must not be
  injected into the parent system prompt, model-visible tool list, model-facing
  tool result stream, tool allow/deny policy, shared PersonaSpec,
  CapabilityToken, JobSpec, or any opifex shared surface.

Rationale: the tool row remains the primary compact realtime surface, but a
small view-only overlay is useful when the user needs to inspect recent or
currently running subagents after row rendering has scrolled or collapsed. Keeping
selection, streaming, and cache behavior adapter-local, bounded, event-driven,
and model-invisible preserves the opifex shared-surface boundaries and avoids
turning UI inspection into resume authority or a filesystem-backed monitor. Pi
TUI owns terminal width, Markdown rendering, and keyboard primitives so Larva does
not reimplement fragile terminal behavior.

### Spawn authority

The active parent persona's `can_spawn` field controls whether spawning is
allowed:

- omitted or `false`: no subagent spawning;
- `true`: may spawn any registered Larva persona;
- string array: may spawn only listed persona ids.

If no parent Larva persona is active, `larva_subagent` returns `failed` with
`LARVA_NO_ACTIVE_PERSONA`.

`can_spawn` controls spawn authority. The resolved adapter-local tool-policy file
controls Pi tools inside the parent or child session. A policy denying
`larva_subagent` also blocks the tool if the parent persona has an active
allow/deny policy entry for that tool.

### Child startup

When a new child is spawned, the tool starts one child Pi process for that
`larva_subagent` invocation. The process is not retained after the result is
returned. This keeps lifecycle management simple: every new call or resume call
owns exactly one child process.

Child session root:

- Default root: `~/.pi/larva/child-sessions`.
- Test override: `LARVA_PI_CHILD_SESSION_DIR` may point to another absolute path.
- Empty, relative, unreadable, or uncreatable override paths make
  `larva_subagent` return `failed` with `LARVA_CHILD_START_FAILED`.
- The directory is created if missing with owner-only permissions where the host
  platform supports them.
- Public `task_id` values are valid only when their canonical real path is inside
  this root. Paths outside the root are `LARVA_BAD_INPUT`.
- Child sessions are retained until the user deletes them; the first design target
  performs no automatic cleanup.

Child process invocation:

```text
<LARVA_PI_REAL_BIN> <LARVA_PI_EXTENSION_FLAG> <LARVA_PI_EXTENSION_ENTRY> --mode rpc --session-dir <larva-child-session-dir>
```

The child must use the `LARVA_PI_REAL_BIN`, `LARVA_PI_EXTENSION_FLAG`, and
`LARVA_PI_EXTENSION_ENTRY` values provided by the launcher. It must not invoke bare
`pi`, rediscover Pi through `PATH`, or derive the extension entry from module
metadata or argv inspection.

Environment:

- `LARVA_PI_INITIAL_PERSONA_ID=<child persona id>`
- `LARVA_PI_MODEL_MAP_FILE=<absolute model-map override path>` only when an override is set
- `LARVA_PI_TOOL_POLICY_FILE=<absolute policy override path>` only when an override is set
- `LARVA_PI_PARENT_PERSONA_ID=<parent persona id>`
- `LARVA_PI_REAL_BIN=<resolved real Pi executable>`
- `LARVA_PI_EXTENSION_FLAG=<-e or --extension>`
- `LARVA_PI_EXTENSION_ENTRY=<absolute bundled extension entry>`
- `LARVA_CLI_ARGV_JSON=<same Larva CLI argv prefix>`
- `LARVA_PI_INTERACTIVE_TUI=0`

Child extension initialization resolves the child persona, selects its model using
the shared model resolver, loads policy, enumerates available Pi tools, and commits the child persona envelope
before replying to the first `get_state` request. Policy names for tools not
present in the child Pi runtime are ignored. If initialization fails before RPC
readiness, the child writes one stderr line using this shape and exits non-zero:

```text
larva pi: <ERROR_CODE>: <human-readable message>
```

The parent maps only these child stderr codes through to `LarvaSubagentResult`:
`LARVA_PERSONA_NOT_FOUND`, `LARVA_MODEL_UNAVAILABLE`, `LARVA_POLICY_INVALID`, and
`LARVA_TOOL_ENUMERATION_FAILED`. Any other pre-RPC child exit maps to
`LARVA_CHILD_START_FAILED`. The parent must not parse other child stderr text.

Startup sequence:

1. start the child process using the invocation above;
2. read JSONL stdout using Pi RPC framing;
3. send `{"id":"state-1","type":"get_state"}`;
4. require a successful response within ten seconds with a non-empty
   `data.sessionFile` whose canonical real path is a `.jsonl` file under the
   child session root;
5. use that session file path as the public `task_id`;
6. send `{"id":"prompt-1","type":"prompt","message":<task>}`;
7. require a successful `prompt` response within ten seconds, then consume events
   until `agent_end`;
8. send `{"id":"last-1","type":"get_last_assistant_text"}` and require a
   successful response within ten seconds with `data.text` as a string; use that
   string as `result_text`.

Completion is defined by the first `agent_end` event after the accepted `prompt`
command. Waiting for `agent_end` is intentionally unbounded by the adapter and
continues until Pi completes or the parent aborts. A "missing `agent_end`" failure
means the child process exits or closes stdout before emitting `agent_end`. A
still-running child without `agent_end` is not classified as missing. JSON parse
failure, unsupported response shape, command-response timeout, EOF before
`agent_end`, failed `get_last_assistant_text` response, or missing/null/non-string
`data.text` maps to `LARVA_CHILD_PROTOCOL_FAILED`. A failed process start or
extension load maps to `LARVA_CHILD_START_FAILED` unless a whitelisted child fatal
startup code is parsed as described above.

No Larva sidecar file is written. The resume contract is deliberately only:

- the public `task_id` path;
- canonical path containment inside the child session root;
- readable `.jsonl` session file;
- explicit `persona_id` supplied on each `larva_subagent` call.

This avoids multi-file state for metadata that is not a security boundary. It
also allows a resumed child session to use current-registry persona hot fixes.

A running child uses the persona/model/tool-policy envelope captured at that
child process startup. A later resume starts a new child process and re-resolves
the requested child persona id from the current registry before appending the new
task.

### Result contract

`LarvaSubagentResult` is the semantic/domain payload for child-session outcomes:

```json
{
  "task_id": "/absolute/path/to/child-session.jsonl",
  "persona_id": "doc-reviewer",
  "status": "success",
  "result_text": "...",
  "error": null
}
```

Pi custom-tool `handler` and `execute` calls return a Pi-facing ToolResult wrapper
around that payload so Pi can render the tool output safely:

```json
{
  "content": [{"type": "text", "text": "..."}],
  "task_id": "/absolute/path/to/child-session.jsonl",
  "persona_id": "doc-reviewer",
  "status": "success",
  "result_text": "...",
  "error": null,
  "details": {
    "task_id": "/absolute/path/to/child-session.jsonl",
    "persona_id": "doc-reviewer",
    "status": "success",
    "result_text": "...",
    "error": null
  },
  "isError": false
}
```

The wrapper is adapter-local and does not define a new shared Larva/opifex schema.
For `larva_subagent`, the machine-readable child-session fields `task_id`,
`persona_id`, `status`, `result_text`, and `error` are required both in `details`
and as top-level metadata with exactly matching values. `details` remains the
canonical semantic payload location; the top-level mirrors are for Pi/runtime
consumers only and must not be added to the `larva_subagent_sessions` helper as a
top-level `sessions` field. `status` is the semantic domain status; Pi `isError`
is a renderer/tool-call flag derived from `status !== "success"` and must not be
treated as a replacement status enum.

`task_id` is canonically the child Pi session file path. It is the only public
resume handle.

For failures before any child session path exists, the wrapper mirrors and
`details` both use `task_id: null`:

```json
{
  "content": [{"type": "text", "text": "LARVA_BAD_INPUT: task must be a non-empty string."}],
  "task_id": null,
  "persona_id": "",
  "status": "failed",
  "result_text": "",
  "error": {"code": "LARVA_BAD_INPUT", "message": "task must be a non-empty string."},
  "details": {
    "task_id": null,
    "persona_id": "",
    "status": "failed",
    "result_text": "",
    "error": {"code": "LARVA_BAD_INPUT", "message": "task must be a non-empty string."}
  },
  "isError": true
}
```

`persona_id` in the result is the requested target id after it passes basic
non-empty string validation. If `persona_id` is missing, empty, or not a string,
the result uses `""`.

Status values:

- `success`: child session reached agent completion and produced a string final
  assistant text value.
- `failed`: child process startup, extension loading, persona resolution, model
  selection, protocol handling, policy validation, session validation, or session
  resume failed.
- `cancelled`: the parent tool call was aborted and the child was aborted or
  killed as cleanup.

`result_text` is the final assistant message produced by the child for this tool
invocation. On resume, it is the final assistant message produced after the new
`task` is appended. It is never raw JSONL. It may contain partial child output for
`failed` or `cancelled` only when the child produced text before failure.

`get_last_assistant_text.data.text` must be a string before it can become
`result_text`. Missing `data.text`, `null`, or any non-string value maps to
`LARVA_CHILD_PROTOCOL_FAILED`. Empty string is still a valid string and is not
coerced.

If Pi returns assistant text with truncation or runtime limits, the integration
returns that text exactly and does not judge whether it is semantically usable.
`LARVA_CHILD_PROTOCOL_FAILED` is used only when the RPC response is malformed,
reports command failure, or lacks a string final assistant text field.

`error` is `null` on `success`. On `failed` or `cancelled`, it is an object:

```json
{
  "code": "LARVA_SESSION_INVALID",
  "message": "Child session path is invalid."
}
```

The Pi-facing wrapper still includes `content` on `failed` and `cancelled`
results. Failure content is stable human-readable error text derived from the
semantic `error.code` and `error.message`; cancellation content states that the
Larva subagent was cancelled. This covers failures before session allocation such
as bad input or no active parent persona as well as failures after a child session
path is known.

Initial stable error codes:

- `LARVA_BAD_INPUT`
- `LARVA_PI_BAD_ARGS`
- `LARVA_PI_NOT_FOUND`
- `LARVA_PI_EXTENSION_NOT_FOUND`
- `LARVA_PI_EXTENSION_LOAD_UNSUPPORTED`
- `LARVA_NO_ACTIVE_PERSONA`
- `LARVA_SPAWN_NOT_ALLOWED`
- `LARVA_PERSONA_NOT_FOUND`
- `LARVA_MODEL_MAP_INVALID`
- `LARVA_MODEL_UNAVAILABLE`
- `LARVA_POLICY_INVALID`
- `LARVA_TOOL_ENUMERATION_FAILED`
- `LARVA_TOOL_DENIED`
- `LARVA_SESSION_NOT_FOUND`
- `LARVA_SESSION_INVALID`
- `LARVA_SESSION_BUSY`
- `LARVA_CHILD_START_FAILED`
- `LARVA_CHILD_PROTOCOL_FAILED`
- `LARVA_CHILD_CANCELLED`

#### Visible resume footer

Whenever `LarvaSubagentResult.task_id` is non-null, the Pi-facing ToolResult
`content[0].text` includes a short resume footer after the human-readable result
or error text:

```text
---
Larva subagent session:
persona_id: <persona_id>
task_id: <absolute child session .jsonl path>
reuse: pass this exact task_id to larva_subagent
```

The footer is presentation-only. It does not alter `result_text`, does not add a
new semantic field, and does not replace the machine-readable `details.task_id`.
If `task_id` is `null`, the wrapper must not show a resume footer or imply the
run can be resumed.


#### Adapter-local progress details

Final `details` preserve the semantic `LarvaSubagentResult` fields. Partial
updates may use an adapter-local progress details shape for rendering while the
child is running:

```json
{
  "persona_id": "turing",
  "mode": "new",
  "task_preview": "explain why self-attention matters...",
  "phase": "waiting_for_child",
  "task_id": "/absolute/path/to/child-session.jsonl"
}
```

This progress shape is UI-only. It is not a new shared Larva/opifex schema and it
must not relax the final result contract. Once execution finalizes, the ToolResult
`details` again preserve the semantic `task_id`, `persona_id`, `status`,
`result_text`, and `error` fields.


### Error mapping

Use these mappings before falling back to `LARVA_CHILD_PROTOCOL_FAILED` for
unknown child/RPC failures.

Policy denial for the `larva_subagent` tool is not a `LarvaSubagentResult`: if
`tool_call` denies `larva_subagent`, Pi observes the generic `ToolPolicyDecision`
denial with `LARVA_TOOL_DENIED` and the subagent handler is not invoked.

Subagent handler mappings:

- Empty or non-string `persona_id`, `task`, or `task_id`: `LARVA_BAD_INPUT`.
- Relative `task_id`, canonicalization failure, symlink escape, or path outside
  child session root: `LARVA_BAD_INPUT`.
- Parent has no active persona: `LARVA_NO_ACTIVE_PERSONA`.
- Parent `can_spawn` disallows target: `LARVA_SPAWN_NOT_ALLOWED`.
- Child fatal startup stderr with whitelisted `LARVA_PERSONA_NOT_FOUND`:
  `LARVA_PERSONA_NOT_FOUND`.
- Child fatal startup stderr with whitelisted `LARVA_MODEL_UNAVAILABLE`:
  `LARVA_MODEL_UNAVAILABLE`.
- Child fatal startup stderr with whitelisted `LARVA_POLICY_INVALID`:
  `LARVA_POLICY_INVALID`.
- Child fatal startup stderr with whitelisted `LARVA_TOOL_ENUMERATION_FAILED`:
  `LARVA_TOOL_ENUMERATION_FAILED`.
- Canonical under-root path that does not end in `.jsonl`: `LARVA_SESSION_INVALID`.
- Canonical under-root `.jsonl` session file is missing: `LARVA_SESSION_NOT_FOUND`.
- Existing under-root path is a directory, not a regular file, or unreadable:
  `LARVA_SESSION_INVALID`.
- Same `task_id` is already being resumed by another active call in this parent
  extension process: `LARVA_SESSION_BUSY`.
- Child Pi process cannot be started, extension cannot be loaded, or pre-RPC child
  exit has no whitelisted Larva error code: `LARVA_CHILD_START_FAILED`.
- Child RPC starts but returns malformed, unsupported, or unknown protocol output:
  `LARVA_CHILD_PROTOCOL_FAILED`.
- Parent abort cancels or kills the child: `LARVA_CHILD_CANCELLED`.

### Resume

When `task_id` is provided, the parent validates only input, path, parent spawn
authority, and same-process busy state before starting the child. Child persona
resolution, child model selection, child policy parsing, and child runtime tool
enumeration are performed by the child extension during child startup. Parent tool
policy is enforced before `larva_subagent` execution through the generic
`tool_call` policy path; if that policy denies the tool, the handler is not
invoked.

Deterministic `task_id` taxonomy:

- missing, empty, non-string, or relative `task_id`: `LARVA_BAD_INPUT`;
- canonicalization failure, symlink escape, or path outside child session root:
  `LARVA_BAD_INPUT`;
- canonical path under the child session root that does not end in `.jsonl`:
  `LARVA_SESSION_INVALID`;
- canonical `.jsonl` path under the child session root that does not exist:
  `LARVA_SESSION_NOT_FOUND`;
- existing path under the child session root that is a directory, not a regular
  file, or not readable: `LARVA_SESSION_INVALID`.

The parent persona must still be allowed to spawn the requested target persona id.
If the file is missing, invalid, or busy, the tool returns `failed` and does not
create a new session.

"Previously returned" is not proven by extra metadata. For this first design
target, resume eligibility is path-based: an existing readable `.jsonl` session
file under the Larva child session root is a valid resume handle. This keeps the
contract simple and avoids fake provenance guarantees.

Resume uses current-registry persona semantics. The existing child session file is
reused, but the new child process resolves `persona_id` from the current Larva
registry before appending `task`. This intentionally allows persona prompt/model
hot fixes to affect resumed child work.

Resume child process invocation is the same as new child startup:

```text
<LARVA_PI_REAL_BIN> <LARVA_PI_EXTENSION_FLAG> <LARVA_PI_EXTENSION_ENTRY> --mode rpc --session-dir <larva-child-session-dir>
```

Resume sequence:

1. validate `task_id`, child session root, and parent spawn authority for
   `larva_subagent`;
2. mark the canonical `task_id` busy in the parent extension's in-memory
   active-task set; if it is already busy, return `failed` with
   `LARVA_SESSION_BUSY` before starting any child process;
3. start the child RPC process using `LARVA_PI_REAL_BIN`,
   `LARVA_PI_EXTENSION_FLAG`, and `LARVA_PI_EXTENSION_ENTRY`;
4. let the child extension perform child persona/model/policy/tool initialization;
5. send `{"id":"switch-1","type":"switch_session","sessionPath":<task_id>}`;
6. require `success: true` and `data.cancelled !== true` within ten seconds;
7. send `{"id":"prompt-1","type":"prompt","message":<task>}`;
8. require a successful `prompt` response within ten seconds;
9. wait for `agent_end` after that accepted prompt;
10. send `get_last_assistant_text` and require a successful response within ten
    seconds; use that response for `result_text`;
11. remove `task_id` from the active-task set after success, failure, or
    cancellation.

If child initialization emits a whitelisted fatal startup code, map it as defined
in Child startup. If a response timeout or protocol failure occurs after the busy
marker is set, the extension clears the marker and aborts or kills the child
process as cleanup.

Resume appends the provided `task` as a new user instruction to the existing child
session through Pi RPC `prompt`. It does not ignore or replace `task`, and it does
not merely return prior output.

Completed, failed, and cancelled child sessions may be resumed if their session
file remains valid and readable.

Using the session file path as `task_id` makes child-session reuse naturally
survive parent Pi restarts.

### Abort

If the parent tool call receives Pi's abort signal, the extension forwards one RPC
abort request to the child. If the child process is still alive after a five-second
grace period, the extension may kill the child process.

Abort result rules:

- If abort or kill stops the child, return `cancelled` with
  `error.code: "LARVA_CHILD_CANCELLED"`.
- If the child exits successfully during the grace period, return the child's
  normal `success` result.
- If abort RPC fails but kill succeeds, still return `cancelled` with
  `LARVA_CHILD_CANCELLED`.
- If both abort and kill fail or child state becomes unknowable, return `failed`
  with `LARVA_CHILD_PROTOCOL_FAILED`.

There is no separate cancel command in the first design target.

### Concurrency

The integration does not provide a batch tool. Pi's documented default parallel
tool mode may run sibling `larva_subagent` calls concurrently after sequential
preflight.

The integration does not add a scheduler in the first design target. It has only
one same-process safety rule: two active calls in the same parent Pi extension
process must not resume the same `task_id` at the same time.

Same-`task_id` resume exclusion:

- The parent extension keeps an in-memory set of active canonical `task_id` paths.
- Scope: one active parent Pi extension process.
- Acquisition: after `task_id` validation and before child process start, check
  the set; if the canonical path is already present, return `failed` with
  `LARVA_SESSION_BUSY`.
- Release: remove the canonical path from the set after resume finishes, fails, or
  is cancelled.
- Restart behavior: parent Pi restart clears the set. There is no stale-lock file
  to clean up.

This deliberately does not protect against two independent parent Pi processes
resuming the same child session concurrently. That cross-process case is outside
the first design target. If it becomes a real requirement, the design should be
reopened explicitly instead of adding hidden filesystem locking now.

Child completion duration is not capped by the adapter; it remains a Pi/runtime
limit and may run until Pi completes or the parent aborts. Required child RPC
command responses are different: `get_state`, `switch_session`, `prompt`, and
`get_last_assistant_text` must each respond within ten seconds. Timeout maps to
`LARVA_CHILD_PROTOCOL_FAILED`; resume timeout must also clear the busy marker and
clean up the child process.

No adapter-specific maximum is imposed on total child sessions, `task` length, or
`result_text` length in the first design target. If Pi rejects a request before
child work starts, return `failed` with the closest stable code (`LARVA_BAD_INPUT`,
`LARVA_CHILD_START_FAILED`, or `LARVA_CHILD_PROTOCOL_FAILED`). If Pi truncates or
limits output but still returns assistant text through RPC, preserve that text in
`result_text`; do not classify truncation by semantic judgment. Parent abort must
still propagate as defined in Abort.

#### Recent session index

In addition to the active-task set, the parent extension may keep a bounded
process-local recent-session index for `larva_subagent_sessions(limit?)`. The
index records only child sessions the parent extension has already observed
through `larva_subagent` results: canonical `task_id`, requested `persona_id`,
latest status, and monotonic process-local sequence number. It retains at most 25
entries; when a new entry exceeds that bound, the oldest retained entry is
evicted.

The recent-session index is not durable state. Parent Pi restart clears it. It
must not be backed by sidecar files, lock files, or a filesystem scan. Normal
resume validation remains path-based and is performed only by
`larva_subagent(task_id=...)`.


## Launcher contract

The launcher consumes only Larva-owned flags before forwarding remaining
arguments to Pi.

Initial target:

```text
larva pi [--persona <id>] [--] <pi args...>
```

Parsed launcher fields:

- `persona`: optional string from `--persona <id>`.
- `pi_args`: ordered list of all remaining arguments, preserving values after
  optional `--` separator normalization.

Interactive-mode detection for `LARVA_PI_INTERACTIVE_TUI`:

- The launcher does not validate Pi arguments generally. It only scans `pi_args`
  to decide whether the Larva selector is safe to expose.
- Recognized non-interactive markers are exact `-p`, exact `--print`, exact
  `--json`, and `--mode` values `rpc`, `print`, `json`, or `sdk`.
- `--mode` may appear as `--mode <value>` or `--mode=<value>`.
- `--mode interactive` and `--mode=interactive` are interactive only when no
  non-interactive, unknown, or malformed mode marker is also present.
- Missing `--mode` value, empty mode value, or any unrecognized `--mode` value is
  treated as non-interactive for Larva selector purposes.
- If multiple mode or print markers conflict, non-interactive wins and
  `LARVA_PI_INTERACTIVE_TUI=0`.
- Unknown Pi arguments that are not `--mode` forms are ignored by this detector and
  still forwarded unchanged.
- Default when no recognized non-interactive marker is present is
  `LARVA_PI_INTERACTIVE_TUI=1`.

Internal launcher-to-extension environment:

- `LARVA_PI_INITIAL_PERSONA_ID`: set only when `--persona` is supplied.
- `LARVA_PI_MODEL_MAP_FILE`: optional absolute path override for
  `~/.pi/larva/model-map.json`; when set, the extension reads only that path.
- `LARVA_PI_TOOL_POLICY_FILE`: optional absolute path override for tool-policy
  resolution; when set, the extension reads only that path.
- `LARVA_PI_CHILD_SESSION_DIR`: optional absolute child session root override for
  tests.
- `LARVA_PI_REAL_BIN`: absolute path to the resolved real Pi executable.
- `LARVA_PI_EXTENSION_FLAG`: selected extension flag, either `-e` or `--extension`.
- `LARVA_PI_EXTENSION_ENTRY`: absolute path to the bundled Larva Pi extension
  entry file used in the parent Pi invocation and reused by child/RPC launches.
- `LARVA_CLI_ARGV_JSON`: JSON array argv prefix for invoking the same Larva CLI
  context as the launcher. The extension appends `resolve <id> --json` or
  `list --json`.
- `LARVA_PI_INTERACTIVE_TUI`: `1` only when the detector above classifies the
  forwarded Pi args as interactive TUI; `0` for RPC, print, JSON, SDK, malformed
  mode, unknown mode, or conflicting mode/print markers.
- `LARVA_PI_LAUNCHED`: literal `1`, used only to prevent accidental recursive
  launcher execution. The extension consumes this sentinel before using
  launcher-provided child process fields; without it, child/RPC spawning fails
  closed with `LARVA_CHILD_START_FAILED` rather than executing a possibly
  recursive launcher path.

Real Pi executable discovery:

- Test override: if `LARVA_PI_BIN` is set, it must point to an executable file and
  is used as the real Pi binary.
- Default: search `PATH` for the first executable named `pi` whose resolved path is
  not the current `larva` executable and not inside Larva's own shim path.
- If no such executable exists, exit `127` with `LARVA_PI_NOT_FOUND`.
- If multiple valid `pi` executables exist, use the first one in `PATH` order.

Extension flag selection:

- Run `<real-pi-bin> --help` during preflight.
- Prefer `-e` when listed.
- Otherwise use `--extension` when listed.
- If neither is listed, exit before Pi starts with
  `LARVA_PI_EXTENSION_LOAD_UNSUPPORTED`.

Real Pi invocation shape:

```text
<LARVA_PI_REAL_BIN> <LARVA_PI_EXTENSION_FLAG> <LARVA_PI_EXTENSION_ENTRY> <pi_args...>
```

Launcher responsibilities:

- locate the bundled Pi extension entry file and resolve it to an absolute path;
- locate the real Pi executable using the discovery rule above;
- select the supported extension flag using the rule above;
- classify interactive TUI mode using only the detector above;
- build `LARVA_CLI_ARGV_JSON` for the same Larva CLI context and preserve the
  launcher environment for registry access;
- set the internal environment variables above;
- forward user Pi arguments unchanged after optional separator normalization,
  with only the prepended extension flag and bundled extension path added by Larva;
- report launcher-detected stderr errors using
  `larva pi: <ERROR_CODE>: <message>`;
- preserve stderr from the Pi process, including extension-detected fatal startup
  errors that use the same `larva pi: <ERROR_CODE>: <message>` shape.

Exit behavior:

- `0`: the Pi process exits successfully and no Larva fatal startup error occurred.
- `2`: Larva launcher preflight, argument failure, or bundled extension fatal
  startup error when the extension can choose the code.
- `127`: real `pi` executable not found.
- otherwise: propagate the real Pi process exit code. Extension-detected fatal
  startup errors must still be non-zero even when Pi chooses the code.

## API contracts

These are adapter-internal contracts. Pi's real hook names are documented for the
selected surfaces (`-e`, `--extension`, `pi.registerCommand`, `pi.registerTool`,
`tool_call`, `before_agent_start`, `pi.setModel`, `ctx.ui.setStatus`,
`pi.getAllTools`, `pi.setActiveTools`, and RPC JSONL commands). The implementation
maps those Pi APIs to these Larva-facing shapes without changing the behavior
below.

```ts
type LarvaErrorCode =
  | "LARVA_BAD_INPUT"
  | "LARVA_PI_BAD_ARGS"
  | "LARVA_PI_NOT_FOUND"
  | "LARVA_PI_EXTENSION_NOT_FOUND"
  | "LARVA_PI_EXTENSION_LOAD_UNSUPPORTED"
  | "LARVA_NO_ACTIVE_PERSONA"
  | "LARVA_PERSONA_NOT_FOUND"
  | "LARVA_MODEL_MAP_INVALID"
  | "LARVA_MODEL_UNAVAILABLE"
  | "LARVA_POLICY_INVALID"
  | "LARVA_TOOL_ENUMERATION_FAILED"
  | "LARVA_TOOL_DENIED"
  | "LARVA_SPAWN_NOT_ALLOWED"
  | "LARVA_SESSION_NOT_FOUND"
  | "LARVA_SESSION_INVALID"
  | "LARVA_SESSION_BUSY"
  | "LARVA_CHILD_START_FAILED"
  | "LARVA_CHILD_PROTOCOL_FAILED"
  | "LARVA_CHILD_CANCELLED";

type LarvaError = {
  code: LarvaErrorCode;
  message: string;
};

type PersonaEnvelope = {
  persona_id: string;
  spec_digest: string;
  model: string;
  prompt: string;
  tool_policy: PiToolPolicy;
};

type PiToolPolicy = {
  allow?: string[];
  deny?: string[];
};

type PersonaSwitchResult =
  | { ok: true; envelope: PersonaEnvelope }
  | { ok: false; error: LarvaError };

type ToolPolicyDecision =
  | { action: "allow" }
  | { action: "deny"; error: LarvaError };

type LarvaSubagentInput = {
  persona_id: string;
  task: string;
  task_id?: string | null;
};

type LarvaSubagentResult = {
  task_id: string | null;
  persona_id: string;
  status: "success" | "failed" | "cancelled";
  result_text: string;
  error: LarvaError | null;
};

type LarvaAutocompleteRequest = {
  text: string;
  query: string;
  cursor: number | null;
  trigger: "tab" | "force" | "unknown";
  baseProvider: LarvaAutocompleteBaseProvider | null;
};

type LarvaAutocompleteCandidate = {
  value: string;
  label: string;
  description?: string;
};

type PersonaCandidate = {
  id: string;
  description: string;
  model: string;
  spec_digest: string;
  capabilities: Record<string, "none" | "read_only" | "read_write" | "destructive">;
};

type PersonaCandidateCacheFile = {
  version: 1;
  source: "larva list --json";
  source_key: string;
  fetched_at_ms: number;
  candidates: PersonaCandidate[];
};

type PersonaCandidateRefreshResult =
  | { ok: true; refreshed: true; source: "larva list --json"; candidates: number; stale_before: number; cache_path: string }
  | { ok: false; refreshed: true; source: "larva list --json"; error: LarvaError; stale_available: boolean; stale_count: number; cache_path: string };

type LarvaAutocompleteBaseProvider = (
  request: LarvaAutocompleteRequest,
) => Promise<LarvaAutocompleteCandidate[] | null> | LarvaAutocompleteCandidate[] | null;

type LarvaAutocompleteProvider = (
  request: LarvaAutocompleteRequest,
) => Promise<LarvaAutocompleteCandidate[] | null> | LarvaAutocompleteCandidate[] | null;
```

Command and hook contracts:

- `/larva-persona <id>` returns `PersonaSwitchResult` and commits state only on
  `ok: true`.
- `/larva-persona --refresh-cache` returns a user-visible refresh result and never
  commits persona/model/tool/session state. It refreshes only the adapter-local
  persona candidate cache by running public `larva list --json`. It is not a new
  slash command or model-facing LLM tool.
- `/larva-persona` with no argument opens a selector only when
  `LARVA_PI_INTERACTIVE_TUI=1`. RPC `ctx.hasUI`, print mode, and JSON mode return
  `LARVA_BAD_INPUT` without changing state.
- Pi editor autocomplete uses the optional `ctx.ui.addAutocompleteProvider` hook
  when the runtime UI context exposes it. The adapter-local provider contract is
  `LarvaAutocompleteProvider`. Request fields are current editor `text`, current
  completion `query`, nullable `cursor` when Pi does not supply one, `trigger`,
  and nullable `baseProvider`. Larva consumes only `text`, `query`, `cursor`,
  `trigger`, `baseProvider`, and persona candidates from the adapter-local cache;
  it must not depend on private Pi fields or private Larva registry files.
- Autocomplete candidates use `LarvaAutocompleteCandidate`: insertion `value`,
  visible `label`, and optional `description`. `/larva-persona` candidates insert
  the persona id; mention candidate `value` is exactly `@persona:<id>`. Any
  trailing space or suffix after insertion is Pi UI behavior outside the Larva
  candidate value.
- Autocomplete nullable return behavior is part of the contract. Returning `null`
  means “no Larva candidates/no handled completion” and must not be treated as an
  error. If `baseProvider` is present, unrelated input returns the base provider's
  result unchanged; if it is absent, unrelated input returns `null`.
- Autocomplete delegate/merge behavior is part of the contract. Non-`/larva-persona`
  slash-command input and unrelated `@...` input delegate to Pi's base provider.
  For persona mentions, the provider asks the base provider first when present;
  Pi file-reference candidates stay first in their original order; persona
  candidates are appended after them. A duplicate is an exact same insertion
  `value` across the merged Pi+Larva list; duplicates are removed by keeping the
  first candidate.
- Persona candidate cache refresh uses `LARVA_CLI_ARGV_JSON` plus
  `list --json`, or the existing fallback command discovery only when
  `LARVA_CLI_ARGV_JSON` is absent. The default disk cache path is
  `~/.pi/larva/persona-candidates-cache.json`; tests may set the absolute-path
  override `LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE`. The refresh path validates
  list output, projects each persona to `PersonaCandidate`, strips `prompt`,
  rejects malformed cache entries fail-closed for writes, and preserves the
  previous cache on refresh failure.
- Runtime verification must prove the tested supported Pi build exposes
  `ctx.ui.addAutocompleteProvider` before claiming editor-autocomplete support.
- If `ctx.ui.addAutocompleteProvider` is unavailable, the extension keeps the
  command-level `/larva-persona` completer and omits Larva editor autocomplete
  for both `/larva-persona` editor input and persona mentions.
  If no persona candidate cache is available, the autocomplete provider returns
  the base provider result when one was requested for that input, else `null`; it
  must not synchronously wait for `larva list --json` or throw through the Pi TUI.
  Base provider failures remain Pi-owned and must not be converted into Larva
  errors.
- Initial `--persona` commit runs during extension initialization before first
  prompt, selector, or `larva: none` status.
- Prompt injection uses Pi `before_agent_start` and returns a composed
  `systemPrompt`; it never replaces Pi's project/user context wholesale.
- Prompt injection is idempotent: existing Larva-managed blocks bounded by
  `larva:identity-policy` and `larva:active-persona` markers are removed before
  current blocks are added, and no unbounded Pi identity text is matched or
  rewritten.
- Model switching resolves PersonaSpec `model` through the adapter-local model map
  first: exact `models[spec.model]`, then longest literal `prefix_rules` match.
  Same-length matching prefix conflict, invalid JSON, invalid schema, or invalid
  rules in an existing config maps to `LARVA_MODEL_MAP_INVALID`. Missing config or
  key miss with no prefix hit preserves split-on-first-slash fallback. Mapped or
  fallback provider/model id then uses `ctx.modelRegistry.find(provider, model_id)`
  followed by `pi.setModel(model)`. Missing slash, empty provider, empty model id,
  Pi registry miss, or `false` from `pi.setModel` maps to
  `LARVA_MODEL_UNAVAILABLE`.
- Policy enforcement is two-stage. At every strict commit, the extension enumerates
  the current Pi model-facing tools as that commit's baseline, applies the target
  persona allow/deny policy to that baseline, and calls
  `pi.setActiveTools(filteredTools)` so disallowed tools are not offered to the
  model. Missing policy means `filteredTools` equals the current baseline. Prior
  Larva restrictions from an earlier persona commit do not carry over. At
  tool-call time, `tool_call` interception denies any disallowed tool that still
  appears. If enumeration or active-tool update fails, commit fails with
  `LARVA_TOOL_ENUMERATION_FAILED` and preserves prior state. During initial
  startup only, absence of a supported Pi enumeration surface is treated as a
  startup-tolerant empty baseline. If the startup active-tool update fails, the
  startup degrades to no committed active persona with startup unavailable status;
  genuine `getAllTools` failures and active-tool update failures remain
  fail-closed for strict in-session switching.
- If `tool_call` denies `larva_subagent`, Pi observes `ToolPolicyDecision` with
  `action: "deny"` and `LARVA_TOOL_DENIED`; the custom tool handler is not
  invoked and no `LarvaSubagentResult` is produced.
- Policy names not present in the current Pi runtime are ignored.
- `larva_subagent` accepts `LarvaSubagentInput` and produces a semantic
  `LarvaSubagentResult` only when the custom tool handler is actually invoked;
  the registered Pi `handler`/`execute` return the Pi-facing ToolResult wrapper
  with text `content`, required matching top-level/details semantic fields, and
  `isError` derived from status.
- `LarvaSubagentInput.task_id`, when present, is an absolute child Pi `.jsonl`
  session path under the child session root. Resume validation is path-based and
  does not require sidecar or provenance metadata.
- Extension initialization reads only `LARVA_PI_INITIAL_PERSONA_ID`,
  `LARVA_PI_MODEL_MAP_FILE`, `LARVA_PI_TOOL_POLICY_FILE`, `LARVA_PI_CHILD_SESSION_DIR`,
  `LARVA_PI_PARENT_PERSONA_ID`, `LARVA_PI_REAL_BIN`, `LARVA_PI_EXTENSION_FLAG`,
  `LARVA_PI_EXTENSION_ENTRY`, `LARVA_CLI_ARGV_JSON`,
  `LARVA_PI_INTERACTIVE_TUI`, and `LARVA_PI_LAUNCHED` from the launcher
  environment. `LARVA_PI_LAUNCHED` is consumed as the recursion-prevention
  sentinel for child Pi launches before the extension trusts `LARVA_PI_REAL_BIN`,
  `LARVA_PI_EXTENSION_FLAG`, or `LARVA_PI_EXTENSION_ENTRY`.
- Child sessions expose `larva_subagent` only when the child persona's own
  `can_spawn` and child tool policy allow it. Nested spawning is not special-cased.

### Larva CLI bridge contract

The Pi TypeScript extension resolves and lists personas through the Larva CLI. It
does not read registry files directly.

Primary invocation source:

```text
LARVA_CLI_ARGV_JSON
```

`LARVA_CLI_ARGV_JSON` is a JSON array argv prefix supplied by the launcher for the
same Larva CLI context that started `larva pi`. The extension appends the command
arguments below to that prefix and inherits the launcher-provided environment.

Resolution command suffix:

```text
resolve <persona-id> --json
```

List command suffix for completion and selector UI:

```text
list --json
```

Fallback commands are allowed only when `LARVA_CLI_ARGV_JSON` is absent, for tests
or manually loaded extension sessions:

```text
larva resolve <persona-id> --json
larva list --json
uvx larva resolve <persona-id> --json
uvx larva list --json
```

Successful resolve stdout shape:

```json
{"data": {"id": "software-architect", "prompt": "...", "model": "...", "capabilities": {}, "spec_version": "0.1.0", "spec_digest": "sha256:..."}}
```

Successful list stdout shape:

```json
{"data": [{"id": "software-architect", "description": "...", "spec_digest": "sha256:...", "model": "provider/model"}]}
```

For completion and selector population, the extension requires only `data[].id` as
a non-empty string. It may display `description` or `model` when present, but it
must not require them for selection.

Failure stdout shape:

```json
{"error": {"code": "INVALID_PERSONA_ID", "numeric_code": 104, "message": "...", "details": {}}}
```

Bridge rules:

- The command must exit within ten seconds.
- Malformed `LARVA_CLI_ARGV_JSON`, resolve timeout, non-zero exit, invalid JSON,
  missing `data`, or missing required PersonaSpec fields maps to
  `LARVA_PERSONA_NOT_FOUND`.
- List timeout, non-zero exit, invalid JSON, missing `data`, non-array `data`, or
  an item without a non-empty string `id` makes completion return no suggestions.
  For interactive no-argument `/larva-persona`, the command returns `ok: false`
  with `LARVA_PERSONA_NOT_FOUND` and leaves active state unchanged.
- Stderr is diagnostic only. The extension must not parse semantics from stderr.
- The returned resolve `data` object must satisfy the canonical PersonaSpec
  contract before building a `PersonaEnvelope`.

### Child RPC contract

The parent extension communicates with child Pi using Pi RPC JSONL only after the
child is ready enough to speak RPC. Before RPC readiness, the parent may read
child stderr only for the whitelisted fatal startup line described in Child
startup.

Supported child RPC commands:

- `get_state`: obtain `data.sessionFile` for public `task_id` allocation.
- `prompt`: submit the child task.
- `switch_session`: resume a previous child session file.
- `get_last_assistant_text`: obtain final assistant text for `result_text`.
- `abort`: request child cancellation.

RPC command response rules:

- `get_state`, `switch_session`, `prompt`, and `get_last_assistant_text` must each
  return a command response within ten seconds.
- Waiting for `agent_end` after an accepted `prompt` has no adapter timeout; it
  ends when Pi completes, aborts, or the process fails.
- A command response with `success: false`, invalid JSON, unexpected id/type,
  missing required data field, or timeout maps to `LARVA_CHILD_PROTOCOL_FAILED`,
  except `switch_session` with a missing session may map to
  `LARVA_SESSION_NOT_FOUND` if Pi exposes that distinction clearly.
- `get_last_assistant_text.data.text` must be a string. Missing, `null`, or
  non-string `text` maps to `LARVA_CHILD_PROTOCOL_FAILED`.
- Child stdout is protocol-only. Child stderr is diagnostics-only after RPC
  readiness.

## Architecture basis

```yaml
architecture_basis:
  system_layers:
    - core: "No changes. PersonaSpec validation and normalization remain canonical."
    - app: "No required changes unless a narrow facade helper is needed for export/resolve reuse."
    - shell: "New Pi launcher and bundled Pi extension boundary."
    - external_runtime: "Pi CLI/RPC process and user-provided MCP bridge."

  source_of_truth_matrix:
    PersonaSpec schema: "opifex canonical contract"
    persona registry contents: "Larva persona registry; accessed by Pi extension through the launcher-supplied LARVA_CLI_ARGV_JSON CLI argv prefix"
    persona candidate cache: "Pi extension adapter-local memory and disk projection generated only from public larva list --json; weakly consistent UI cache, not registry authority"
    active Pi persona: "Pi extension session-local committed envelope"
    Pi executable: "LARVA_PI_REAL_BIN discovered by launcher"
    Pi extension flag: "LARVA_PI_EXTENSION_FLAG selected by launcher from Pi help"
    Pi extension entry: "LARVA_PI_EXTENSION_ENTRY absolute bundled extension path resolved by launcher"
    Pi interactive classification: "Launcher scan of forwarded pi_args for exact print/json/mode markers"
    Pi model map: "~/.pi/larva/model-map.json or absolute LARVA_PI_MODEL_MAP_FILE override, adapter-local, parsed only by Pi extension"
    Pi tool rules: "~/.pi/larva/tool-policy.json or explicit absolute LARVA_PI_TOOL_POLICY_FILE override only; no implicit legacy ~/.pi/tool-policy.json fallback; adapter-local, parsed only by Pi extension"
    Pi runtime tool baseline: "Current Pi model-facing tools enumerated by the extension at each strict persona commit; initial startup may use an empty baseline when Pi lacks a supported enumeration surface"
    child session root: "~/.pi/larva/child-sessions or absolute LARVA_PI_CHILD_SESSION_DIR test override"
    child session identity: "Pi child session file path returned as task_id"
    child session validation: "Canonical readable .jsonl path under child session root"
    child resume busy state: "Parent extension in-memory active-task set"
    subagent presentation log overlay: "Parent extension presentation log plus adapter-local persistent cache and current overlay generation; user-visible only and never model/tool-policy visible"
    Pi MCP bridge: "User-installed Pi extension/package, out of this integration scope"

  service_catalog:
    larva_pi_launcher:
      owner: "larva.shell"
      responsibility: "Discover real Pi and Larva CLI context, then start Pi with the bundled Larva extension and optional initial persona."
    larva_pi_extension:
      owner: "contrib/pi-extension"
      responsibility: "Project resolved Larva personas into Pi prompt/model/tool state."
    persona_candidate_cache:
      owner: "contrib/pi-extension"
      responsibility: "Keep selector/autocomplete hot paths fast with a prompt-free memory/disk stale cache refreshed from public larva list --json."
    larva_subagent_tool:
      owner: "contrib/pi-extension"
      responsibility: "Spawn or resume one child Pi RPC process per invocation as a target persona."

  runtime_contract:
    launch: "larva pi [--persona <id>] [--] <pi args...> -> <real-pi-bin> <extension-flag> <extension-entry> <pi args...>"
    interactive_mode: "LARVA_PI_INTERACTIVE_TUI from exact -p/--print/--json/--mode detector; non-interactive wins conflicts"
    switch: "/larva-persona <id>, next model invocation, atomic commit"
    persona_cache_refresh: "/larva-persona --refresh-cache -> refresh prompt-free adapter-local PersonaCandidate cache from public larva list --json; does not commit persona/model/tool state"
    projection: "before_agent_start prompt composition + pi.setModel(model), committed at launch/switch/child startup"
    policy: "allow/deny filtering over current Pi model-facing tool baseline; missing policy equals baseline; initial startup tolerates absent/unsupported enumeration surfaces with an empty baseline; prior Larva restrictions do not carry; unknown policy tool names ignored; setActiveTools plus tool_call enforcement"
    persona_bridge: "LARVA_CLI_ARGV_JSON + resolve/list suffix, fallback larva/uvx only when env is absent; list results are projected into prompt-free PersonaCandidate cache before UI use"
    subagent: "larva_subagent(persona_id, task, task_id?) -> LarvaSubagentResult only when the tool handler is invoked; explicit null task_id is treated as omitted/new session; Pi ToolResult wrapper mirrors semantic fields at top level and details; visible footer includes persona_id and exact task_id when task_id is non-null"
    subagent_sessions_helper: "optional larva_subagent_sessions(limit?: positive int = 10, max 25) -> newest-first process-local recent sessions from an index capped at 25 entries; invalid limit returns LARVA_BAD_INPUT; no filesystem scan, sidecar, alias, or provenance proof"
    subagent_tool_rendering: "renderCall shows persona, new/resume mode, bounded task preview, and abbreviated task_id for resumes; visible bounds count Unicode NFC-normalized code points with ellipsis inside the bound; onUpdate emits bounded row-local phases; renderResult supports collapsed and expanded final views without overriding parent larva footer"
    subagent_presentation_overlay: "/larva-log [task_id?] shows a view-only user-visible overlay from parent-extension presentation entries plus adapter-local persistent cache; optional argument is one exact task_id; no filesystem scan, raw JSONL parse, child-session sidecar, alias, persona/model/tool-policy mutation, model-facing injection, or shared opifex surface"
    persona_mentions: "interactive editor autocomplete requires ctx.ui.addAutocompleteProvider and inserts canonical @persona:<id>; mention-only with no persona switch, no automatic larva_subagent call, and no prompt/spec injection; raw @, @p, and @persona may show candidates from the adapter-local persona cache while preserving Pi file-reference suggestions"
    child_rpc: "<real-pi-bin> <extension-flag> <extension-entry> --mode rpc --session-dir <child root>, child fatal stderr before RPC readiness, then prompt/switch_session/get_state/get_last_assistant_text with string final text"
    resume: "task_id is a readable .jsonl child session path under child root; task is appended through RPC prompt; child persona id is re-resolved from current registry"

  state_strata:
    canonical_state: "PersonaSpec and registry entries managed by Larva"
    adapter_config_state: "~/.pi/larva/model-map.json and ~/.pi/larva/tool-policy.json, plus explicit env overrides; no implicit legacy tool-policy fallback"
    adapter_cache_state: "~/.pi/larva/persona-candidates-cache.json, or absolute LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE override for tests, and process memory hold a prompt-free weakly consistent PersonaCandidate projection for UI hot paths"
    session_state: "Committed persona id/spec digest/model/tool policy inside one Pi extension process"
    child_session_state: "Pi session JSONL file used as public task_id"
    child_busy_state: "In-memory active-task set inside one parent Pi extension process"
    recent_session_index: "In-memory newest-first process-local index of up to 25 child sessions observed by one parent Pi extension process; advisory only"
    presentation_overlay_state: "In-memory presentation log, adapter-local persistent cache, and current overlay generation; user-visible view state only, not model context or resume authority"

  transport_boundary_rules:
    - "Larva CLI/facade/MCP surfaces remain the persona source; Pi extension does not read registry files directly."
    - "Launcher passes LARVA_CLI_ARGV_JSON so the extension uses the same Larva CLI context."
    - "Parent and child Pi are launched through LARVA_PI_REAL_BIN with LARVA_PI_EXTENSION_FLAG and LARVA_PI_EXTENSION_ENTRY; no bare pi lookup or extension-entry derivation in the extension."
    - "No Pi settings writes."
    - "Pi RPC is used only for child Pi session control."
    - "Before child RPC readiness, parent parses only whitelisted `larva pi: <LARVA_*_CODE>:` stderr lines."
    - "MCP bridge is external to this integration."
    - "No sidecar metadata is written for child sessions; path containment plus explicit persona_id is the whole resume contract."
    - "No filesystem lock files are part of the first target; cross-process same-task resume coordination is out of scope."

  cross_cutting_governance:
    registries:
      - "Larva persona registry remains owned by Larva."
      - "Pi extension keeps an adapter-local prompt-free persona candidate cache generated only from public larva list --json."
      - "Pi extension keeps only session-local committed envelope state."
      - "Parent Pi extension keeps a process-local active-task set for same-task resume exclusion."
      - "Parent Pi extension keeps a process-local recent-session index capped at 25 entries only for optional resume UX."
      - "Parent Pi extension keeps a process-local presentation log/current overlay generation and adapter-local persistent cache only for view-only user inspection."
    lifecycle_ordering:
      - "Launcher preflights Larva-owned arguments, extension path, real Pi executable, extension flag, Larva CLI argv prefix, interactive classification, and initial persona id only."
      - "Extension loads disk persona candidate cache at session start when available and starts background refresh without blocking selector/autocomplete hot paths."
      - "Extension parses active-target policy shape, selects model, enumerates the current Pi model-facing tool baseline for strict commits, applies target policy, ignores missing policy tool names, sets active tools, and commits persona envelope only after checks pass; initial startup may substitute an empty baseline only when the Pi enumeration surface is absent or unsupported."
      - "Child extension performs child persona/model/policy initialization before replying to get_state."
      - "Subagent child process discovers sessionFile via RPC get_state and validates it before exposing task_id."
      - "Resume marks task_id active before starting the child process and clears it after completion, failure, or cancellation."
      - "Subagent row progress is updated only through the current tool row lifecycle: renderCall before execution, onUpdate during execution, and renderResult for final/expanded display."
      - "The /larva-log command reads only in-memory presentation entries, opens or replaces a user-visible overlay, and never changes persona/model/tool-policy/session authority."
    coordination_mechanisms:
      - "Selected Pi extension flag for parent and child extension loading."
      - "Launcher-provided Pi extension entry path for parent and child extension loading."
      - "Pi before_agent_start and pi.setModel for persona projection."
      - "Pi extension command for persona switch and persona candidate cache refresh under /larva-persona."
      - "Pi setActiveTools plus tool_call hook for allow/deny enforcement."
      - "Pi custom tool for subagent spawn/resume."
      - "Pi RPC JSONL for child sessions."
      - "Child stderr fatal-startup line before RPC readiness."
      - "In-memory active-task set for same-parent same-task resume exclusion."
      - "In-memory recent-session index capped at 25 entries for optional larva_subagent_sessions(limit?) helper."
      - "Pi custom-tool row renderer for bounded subagent call, progress, and result visibility."
      - "Pi slash command /larva-log for view-only user-visible presentation-log overlay."
      - "Adapter-local memory/disk persona candidate cache with background stale-while-revalidate refresh from public larva list --json."
      - "Pi editor autocomplete provider for canonical @persona:<id> mentions while preserving Pi file-reference suggestions; unavailable when ctx.ui.addAutocompleteProvider is absent."
    wiring_strategy: "Explicit launcher environment plus selected Pi extension flag registration; row-local rendering, view-only presentation overlay, persona candidate caching, and editor autocomplete stay inside the Pi extension."
    governance_owner: "Larva shell owns launcher; Pi extension owns runtime projection, persona candidate cache, tool-policy parsing, active-task state, recent-session index, subagent row rendering, view-only presentation overlay, and persona mention autocomplete."

  shared_abstractions:
    shared_types:
      - name: "PersonaSpec"
        owner_module: "opifex contract"
        consumers: ["Pi extension", "Larva CLI/MCP"]
        rationale: "Canonical persona identity, prompt, model, capabilities, and can_spawn; Larva consumes, validates, and projects it but does not co-own canonical meaning."
      - name: "PersonaEnvelope"
        owner_module: "contrib/pi-extension"
        consumers: ["persona switch", "prompt/model projection", "child startup"]
        rationale: "One committed process-local envelope prevents per-turn drift and half-applied state."
      - name: "PersonaCandidate"
        owner_module: "contrib/pi-extension"
        consumers: ["/larva-persona completion", "persona selector", "@persona autocomplete", "manual cache refresh"]
        rationale: "Prompt-free UI projection from public larva list --json keeps hot paths fast without exposing full PersonaSpec or reading private registry files."
      - name: "PiToolPolicy"
        owner_module: "contrib/pi-extension"
        consumers: ["persona switch", "tool_call hook", "subagent child startup"]
        rationale: "One adapter-local policy shape prevents duplicated allow/deny parsing."
      - name: "LarvaError"
        owner_module: "contrib/pi-extension"
        consumers: ["persona switch", "tool policy", "larva_subagent result"]
        rationale: "Stable machine-readable failure shape for tests and RPC clients."
      - name: "LarvaSubagentResult"
        owner_module: "contrib/pi-extension"
        consumers: ["larva_subagent semantic result", "Pi ToolResult wrapper details", "Pi ToolResult top-level mirrors"]
        rationale: "Minimal semantic result shape: task_id, persona_id, status, result_text, error. Pi handler/execute wrap it with renderer-safe content, matching top-level/details fields, and isError; no semantic result is produced when tool_call blocks the tool before handler invocation."
      - name: "LarvaSubagentSessionSummary"
        owner_module: "contrib/pi-extension"
        consumers: ["optional larva_subagent_sessions helper", "resume UX"]
        rationale: "Small process-local UX/recovery shape capped at 25 retained entries: task_id, persona_id, last_status, sequence. It is not resume authority."
      - name: "LarvaSubagentOverlayResult"
        owner_module: "contrib/pi-extension"
        consumers: ["/larva-log command", "view-only presentation overlay"]
        rationale: "Adapter-local command result for user-visible overlay inspection: content, view_only, and overlay details only. It is not LarvaSubagentResult, does not expose top-level task_id/result_text mirrors, and is never a shared opifex schema."
    shared_protocols: []
    shared_utilities: "N/A: no utility should be shared until implementation proves duplication."
    decision: "Only types that cross command/tool/session boundaries are shared; internals stay local."

  module_split_recommendations:
    - module: "src/larva/shell/pi.py"
      owner: "larva shell"
      reason_to_split: "Process/env launcher concerns are separate from OpenCode launcher and from core persona semantics."
    - module: "contrib/pi-extension/larva.ts"
      owner: "Pi adapter"
      reason_to_split: "Pi extension hooks are runtime-specific and should not enter Python core/app layers."
    - module: "contrib/pi-extension/README.md"
      owner: "Pi adapter docs"
      reason_to_split: "Operator-facing install, policy, and runtime semantics belong next to the extension."

  ux_surfaces:
    - surface: "CLI command"
      scope: "larva pi --persona <id> argument forwarding, extension loading, exit behavior, stderr errors"
    - surface: "Pi slash command"
      scope: "/larva-persona completion, selector, --refresh-cache, status/error messages"
    - surface: "Pi custom tool"
      scope: "larva_subagent tool description, optional larva_subagent_sessions helper, visible resume footer, renderCall/onUpdate/renderResult row display, and result shape"
    - surface: "Pi slash command overlay"
      scope: "/larva-log [task_id?] view-only user-visible presentation log from parent-extension entries plus adapter-local persistent cache; not model/tool-policy visible"
    - surface: "Pi interactive editor autocomplete"
      scope: "canonical @persona:<id> mention candidates, raw @ and partial namespace suggestions, no automatic side effects, and preservation of Pi file-reference suggestions"

  runtime_surfaces:
    - surface: "CLI"
      launch_or_entrypoint: "larva pi --persona <id>"
      minimum_liveness_proof: "A Pi session starts via the selected extension flag with the Larva extension loaded and status shows active persona."
    - surface: "Pi RPC child process"
      launch_or_entrypoint: "<real-pi-bin> <extension-flag> <extension-entry> --mode rpc --session-dir <child root>"
      minimum_liveness_proof: "larva_subagent returns success/failed/cancelled with public task_id when allocated."

  open_questions: []

  readiness: "READY"
```


### Architecture basis change notes

Pi TUI formal dependency and enhanced UI delta:

- `contrib/pi-extension` is a Node/TypeScript runtime surface with a formal
  dependency on exact `@earendil-works/pi-tui@0.78.0`; local development and CI
  must install it with `npm --prefix contrib/pi-extension ci` before Pi-extension
  UI work.
- Pi TUI owns display width, wrapping, truncation, keyboard matching, Markdown
  rendering, selector/input primitives, and basic layout containers.
- Larva owns only adapter-specific UI state: subagent log overlay selection,
  scroll offset, keyboard tab state, view-only overlay result shape, and
  mouse-reporting lifecycle cleanup.
- Expanded subagent results render as Markdown UI when expanded, while collapsed
  rows remain compact renderer-safe text.
- `/larva-log` is a keyboard-tabbed Pi TUI overlay with Summary, Prompt,
  Output, and Metadata panes; Prompt contains the full initial prompt, Summary
  uses readable grouped/aligned fields, and Output uses Pi TUI Markdown rendering.
  The overlay uses the same modal chrome helpers, `90%` width, `90%` max-height
  budget, accent border, solid ANSI surface, stable frame, and terminal-compatible
  drop shadow conventions as the persona selector.
- `/larva-persona` no-argument interactive selection uses a Pi TUI selector with
  `Input`, `SelectList`, and a detail panel when custom UI is available, while
  preserving non-interactive and fallback selector behavior.
- Mouse wheel remains supported for scrollable overlays. Mouse click is a
  non-goal for this target.


Subagent reuse visibility delta:

- `larva_subagent_sessions(limit?)` is a Pi-adapter-owned read-only helper surface
  backed only by parent-extension process memory and capped at 25 retained
  entries.
- The recent-session index belongs to the same state stratum as the existing
  parent-extension active-task set, but it is advisory UX state, not resume
  authority.
- The visible resume footer and top-level ToolResult mirrors are Pi ToolResult
  presentation/runtime metadata. They must not change the semantic
  `LarvaSubagentResult`, `details.task_id`, or path-based resume validation.
- The no-sidecar and no-filesystem-scan transport boundary remains unchanged.


Subagent runtime visibility delta:

- `renderCall`, `onUpdate`, and `renderResult` are Pi-adapter presentation
  concerns owned by `contrib/pi-extension`.
- Runtime progress state is adapter-local and row-local: target persona, new vs
  resume mode, task preview, current phase, and allocated `task_id` when known.
- Bounded previews count Unicode NFC-normalized code points after ANSI/control
  cleanup, with ellipsis counted inside the visible-character bound.
- Final semantic results stay `LarvaSubagentResult`; partial progress details may
  use an adapter-local rendering shape but must not become a shared Larva/opifex
  contract.
- The parent `larva: <persona-id>` status remains parent persona state; subagent
  status is rendered in the `larva_subagent` tool row.
- No custom widget dashboard, filesystem-backed monitor, or full child log stream
  is part of the first target.


Subagent presentation overlay delta:

- `/larva-log [task_id?]` is authorized as a Pi-adapter-owned,
  user-visible, view-only overlay over the parent extension's in-memory
  presentation log.
- Older tool-row-only wording is narrowed: it forbids dashboards, Larva-private
  terminal overlays, filesystem-backed monitors, raw JSONL overlays, and
  model-visible log streams; it does not forbid this fixed view-only overlay.
- The overlay is not a model-facing tool, not tool-policy input/output, not
  resume authority, and not a shared Larva/opifex schema or surface.
- Persistent-cache support uses an adapter-local cache file at
  `~/.pi/larva/subagent-presentation-log.json` with default 7-day/100-entry
  retention. That cache remains UI inspection state only and is written only from
  presentation-log mutations, never from raw child JSONL scanning.
- Cleanup uses `/larva-log --clear` to clear overlay cache/state without
  deleting child sessions or changing resume authority.
- Overlay verification must prove command registration, exact-task/newest
  selection, view-only result shape, stable not-observed/UI-unavailable errors,
  cleanup/close behavior, and no persona/model/tool-policy/session mutation.


Persona mention UX delta:

- `@persona:<id>` is a Pi-adapter-owned interactive editor mention surface backed
  by the same adapter-local persona candidate cache as `/larva-persona` completion
  and available only when the runtime UI exposes `ctx.ui.addAutocompleteProvider`.
- The mention is semantic context only. It does not switch active persona, force
  `larva_subagent`, or inject the mentioned persona prompt/spec.
- Runtime authority remains unchanged: only explicit `/larva-persona` switches the
  parent persona, and only explicit model tool use invokes `larva_subagent`.
- The autocomplete provider may surface persona candidates for raw `@`, partial
  canonical namespace tokens, and `@persona:<query>` input, but it must delegate
  unrelated `@...` input to Pi's base provider and preserve Pi-owned file
  reference suggestions.
- The raw short form `@<id>` is reserved for future evaluation and is not part of
  this implementation target. Id-like raw short-form prefixes such as `@doc`,
  `@python`, and `@python-senior` must not trigger Larva persona matching and
  must delegate to Pi file-reference completion until short form is explicitly
  implemented.


Prompt identity overlay delta:

- Persona identity projection is Larva-adapter-owned prompt composition in
  `before_agent_start`, not a Pi prompt-builder replacement.
- The Pi chained system prompt remains the source of truth for tools, guidelines,
  Pi documentation notes, project context, skills, date, and working directory.
- Larva owns only marker-bounded identity blocks:
  `larva:identity-policy` and `larva:active-persona`.
- Idempotence is achieved by removing previous Larva-managed blocks only; the
  adapter must not match or rewrite Pi's generic identity sentence.
- Provider-specific payload rewrite is out of scope for persona identity; the
  effective Pi session prompt should remain inspectable through Pi's system prompt
  surfaces.


#### Subagent selector and live streaming overlay delta

- `/larva-log` remains the only authorized user-visible overlay for this
  target. The default command opens newest-detail mode; selector mode is entered
  with `s` or directly via `/larva-log --select`.
- Selector state is adapter-local overlay state. It selects among parent-observed
  presentation entries and loaded adapter-cache entries only; it does not scan
  child session files, parse raw JSONL, or create resume authority.
- Selector ordering is running entries first, then newest `updated_at`, then
  highest `sequence`. Selector rows are width-safe one-line summaries with local
  started time and must not include full prompts, full outputs, raw tool output,
  raw child RPC payloads, full task paths, or internal call/frame IDs. Event-driven
  refresh must allow newly launched subagents to appear without stealing cursor
  focus from the currently selected entry when that entry still exists.
- Live assistant output and tool-call activity are process-local presentation
  state fed by child Pi RPC events. Authorized inputs are normalized
  `message_update`, `tool_execution_start`, `tool_execution_update`,
  `tool_execution_end`, and terminal child events such as `agent_end`.
- Streaming state is not persisted in this target. Cache writes must omit live
  assistant previews, timeline events, exact-session assistant excerpt ids,
  grouped tool-call snapshots, active tool state, and raw child RPC event
  payloads.
- Timeline display is chronological and bounded: assistant message excerpts and
  first-seen tool calls share one ordered stream, while start/update/end frames
  update one changing tool row or snapshot per tool call instead of appending an
  unbounded event log. Tool output is shown only as a bounded preview in the
  `Timeline` pane.
- The `Output` pane is for assistant live/final text. The final output authority
  remains the child `get_last_assistant_text` result after completion.
- Overlong streaming text, tool args, and tool output must be renderer-safe,
  bounded in memory, and visibly marked when truncated. `thinking_*` deltas must
  not reveal thinking content.

## Runtime capability and provenance matrix

This matrix records the implementation/proof status for the bundled Pi extension.
It is part of this design authority; operator docs may summarize it but should
link here rather than redefining the contracts.

| capability | implemented behavior | provenance rule | proof command or test |
| --- | --- | --- | --- |
| Fatal initial persona startup | `larva pi --persona <id>` failures in model selection or policy parsing write `larva pi: <ERROR_CODE>:` and exit non-zero before any prompt/model turn. Manual extension loads without `LARVA_PI_LAUNCHED=1` may degrade instead of exiting. | PASS requires non-zero process exit plus Larva startup stderr before the first prompt. | `node scripts/pi-extension-runtime-smoke.mjs --scenario startup-fatal`; `uv run pytest tests/shell/test_pi_extension_real_runtime.py -k startup_fatal -v` |
| Launcher sentinel | `LARVA_PI_LAUNCHED=1` is required before the extension trusts `LARVA_PI_REAL_BIN`, `LARVA_PI_EXTENSION_FLAG`, and `LARVA_PI_EXTENSION_ENTRY` for child/RPC spawning. Missing or false sentinel fails closed with `LARVA_CHILD_START_FAILED`. | Source/harness proof is sufficient for the recursion guard because it proves no child process is spawned without the sentinel. | `uv run pytest tests/shell/test_pi_extension_contract.py -k launched_sentinel -v` |
| Persona mentions | Mention autocomplete inserts id-only canonical values exactly shaped as `@persona:<id>`; the mention has no automatic switch, subagent call, prompt injection, or PersonaSpec injection side effect. Raw short forms such as `@python-senior` remain delegated. | Candidate behavior can be proven by the extension harness; claiming live editor support additionally requires live TUI `ctx.ui.addAutocompleteProvider` provenance. | `node contrib/pi-extension/test-autocomplete-runtime.mjs`; `uv run pytest tests/shell/test_pi_extension_real_runtime.py -k autocomplete -v` |
| `ctx.ui.addAutocompleteProvider` editor support | The extension installs a narrow provider only when Pi exposes the hook. If the hook is missing, completion degrades to command-level `/larva-persona` completion and base-provider delegation/`null` for editor autocomplete. | Mock/local harness hook evidence is never sufficient for `supported: true`; support requires non-mock Pi interactive TUI runtime/build provenance. Current local smoke reports `runtimeHarness.mock` as degraded/unsupported provenance. | `node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates`; `uv run pytest tests/shell/test_pi_extension_real_runtime.py -k capability_gate -v` |
| `/larva-log` overlay | The authorized slash command is view-only, user-visible, adapter-local, and backed by the parent extension's presentation log plus adapter-local persistent cache. It must not expose top-level `task_id`/`result_text` mirrors or mutate persona/model/tool-policy/session state. | Runtime/harness proof must show command registration, view-only shape, newest/exact selection, persistent cache load/clear, reset/not-observed behavior, and no mutation of resume authority. | `node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates`; `uv run pytest tests/shell/test_pi_extension_subagent_ux.py -k presentation_log_overlay -v` |
| Pi TUI enhanced UI | The adapter imports directly from exact `@earendil-works/pi-tui@0.78.0`; custom components satisfy visible-width rendering; `/larva-log` has the concise `Larva subagent log` chrome title, Summary/Prompt/Output/Metadata tabs, event-driven in-memory refresh, and Markdown output; expanded `larva_subagent` results render Markdown Summary/Task/Output/Error/Resume sections; `/larva-persona` uses `Input`/`SelectList` plus detail when custom UI is available; mouse clicks are unsupported no-ops. | Package/install and harness proof establish implemented component behavior. Live Pi support claims remain bounded by `capability-gates`; mock-only or unavailable runtime evidence must be reported as unsupported or blocked. | `npm --prefix contrib/pi-extension ls @earendil-works/pi-tui --depth=0`; `node contrib/pi-extension/test-persona-selector-ui.mjs`; `uv run pytest tests/shell/test_pi_extension_subagent_ux.py -k 'pi_tui_direct_imports_bordered_scroll_width_and_mouse_click_noop or presentation_log_overlay or vt46' -v`; `node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates` |
| Child RPC live proof | `larva_subagent` starts child Pi through the registered execute path using launcher-provided real Pi binary, extension flag, and extension entry, then performs fresh `get_state`/`prompt`/`agent_end`/`get_last_assistant_text`, resume `switch_session`/`prompt`, abort, and cleanup. | PASS requires controlled live Pi evidence for B1 fresh startup, B2 resume, B3 abort propagation, and B4 orphan-free cleanup. If Pi or extension loading is unavailable, the proof is blocked, not silently passed. | `node scripts/pi-extension-runtime-smoke.mjs --scenario live-child-rpc-proof`; inspect `runtime.controlledLive` |
| Subagent row/progress rendering | `larva_subagent` exposes `renderCall`, `execute` progress updates, and `renderResult` with bounded visible text; this is row-local and does not replace the parent `larva:` footer. | Harness proof is sufficient for renderer contract shape and deterministic bounds; live Pi rendering remains a UI runtime concern. | `uv run pytest tests/shell/test_pi_extension_subagent_ux.py -k 'render_hooks or vt46' -v` |
| Runtime hard gates | Extension loading, Pi RPC command inventory, autocomplete hook provenance, subagent row progress, and subagent log overlay command are reported together. | The matrix is data/provenance, not a fallback authority for behavior. Unsupported or mock-only items must be shown as unsupported/unknown rather than claimed. | `node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates` |

## Verification targets

Implementation gates must prove these observable behaviors:

1. `larva pi --persona known -- --version` invokes real Pi as
   `<real-pi-bin> <selected-extension-flag> <bundled extension> --version`, sets
   `LARVA_PI_INITIAL_PERSONA_ID=known`, `LARVA_PI_REAL_BIN`,
   `LARVA_PI_EXTENSION_FLAG`, `LARVA_PI_EXTENSION_ENTRY`, and
   `LARVA_CLI_ARGV_JSON` for the extension process.
2. `larva pi --persona missing` does not start Pi, exits non-zero, and writes
   `larva pi: LARVA_PERSONA_NOT_FOUND:` to stderr.
3. Missing real `pi` executable exits `127` and writes
   `larva pi: LARVA_PI_NOT_FOUND:` to stderr.
4. `LARVA_PI_BIN` test override is honored when it points to an executable; PATH
   discovery skips Larva's own shim path and uses the first valid real `pi`.
5. Extension loading preflight prefers `-e` when supported, otherwise uses
   `--extension` when supported. If neither flag is supported, it exits before Pi
   starts with `LARVA_PI_EXTENSION_LOAD_UNSUPPORTED` and does not write Pi settings.
6. Initial `--persona` commit runs during extension initialization before first
   user prompt, selector, or `larva: none` status. Malformed/unavailable model or
   invalid policy shape writes `larva pi: <ERROR_CODE>:` to stderr and makes Pi
   exit non-zero. An absent or unsupported Pi tool enumeration surface at startup
   uses the startup-tolerant empty baseline instead of failing. Startup
   `setActiveTools` failure degrades to no committed startup persona with startup
   unavailable status. Genuine `getAllTools` or active-tool update failures remain
   `LARVA_TOOL_ENUMERATION_FAILED` for strict in-session switching.
7. `/larva-persona <valid>` commits one `PersonaEnvelope`, calls
   `ctx.modelRegistry.find(...)` plus `pi.setModel(...)`, and status shows the
   committed persona id.
8. With no active persona, interactive status is set to `larva: none`.
9. `before_agent_start` composes Pi's existing system prompt with the committed
   Larva identity-policy and active-persona blocks; it does not replace
   project/user context wholesale and it removes only previous Larva-managed
   marker-bounded blocks instead of duplicating them.
10. Launcher mode detection sets `LARVA_PI_INTERACTIVE_TUI=0` for exact `-p`,
    exact `--print`, exact `--json`, `--mode rpc|print|json|sdk`, missing/empty or
    unknown `--mode`, and conflicting mode/print markers; it sets `1` when no
    recognized non-interactive marker is present. `/larva-persona` with no
    argument opens a selector only when `LARVA_PI_INTERACTIVE_TUI=1`; selecting a
    persona commits it and cancelling leaves state unchanged with
    `LARVA_BAD_INPUT`. RPC `ctx.hasUI`, print mode, JSON mode, SDK mode, or
    `LARVA_PI_INTERACTIVE_TUI=0` do not open a selector.
11. `/larva-persona` with no argument in non-interactive mode returns `ok: false`
    with `LARVA_BAD_INPUT` and leaves state unchanged.
12. `/larva-persona <invalid>` returns `ok: false` with
    `LARVA_PERSONA_NOT_FOUND` and leaves the previous envelope unchanged.
13. Model strings parse at the first slash: `openrouter/google/gemini` becomes
    provider `openrouter` and model id `google/gemini`; missing slash, empty
    provider, empty model id, unavailable model, invalid target policy shape, or
    failed strict tool enumeration returns `ok: false` with the documented error
    and leaves the previous envelope unchanged.
14. Missing policy file and missing active target persona policy entry do not add
    extra tool restrictions: the commit uses the current Pi model-facing tool
    baseline, and prior Larva restrictions from an earlier persona do not carry
    over.
15. Extension policy validation rejects unreadable JSON, wrong top-level shape,
    invalid active target entry shape, non-string `allow`/`deny` entries in the
    active target, and unknown keys in the active target. The launcher does not
    parse the policy file. Invalid non-target entries are ignored until targeted.
16. Policy names for tools not currently registered in Pi are ignored, not
    rejected. `deny` wins over `allow`; present `allow` acts as an allowlist over
    existing model-facing tools; empty `allow: []` blocks all model-facing tools.
17. Policy commit enumerates the current Pi model-facing tool baseline, calls
    `pi.setActiveTools(filteredTools)`, does not carry over prior Larva
    restrictions, and also enforces the same decision through `tool_call`
    interception. A denied tool call returns `ToolPolicyDecision` with
    `action: "deny"` and `LARVA_TOOL_DENIED`; the underlying Pi tool is not
    invoked. When the denied tool is `larva_subagent`, no `LarvaSubagentResult` is
    produced.
18. `can_spawn: false` or omitted makes `larva_subagent` return `failed` with
    `LARVA_SPAWN_NOT_ALLOWED`.
19. `can_spawn: ["target"]` allows only listed targets and rejects unlisted
    targets with `LARVA_SPAWN_NOT_ALLOWED`.
20. No active parent persona makes `larva_subagent` return `failed` with
    `LARVA_NO_ACTIVE_PERSONA`.
21. Bad `larva_subagent` input returns `failed` with `LARVA_BAD_INPUT`, null
    public `task_id`, and `persona_id: ""` unless the target id passed basic
    non-empty string validation.
22. Child session root defaults to `~/.pi/larva/child-sessions`, supports absolute
    `LARVA_PI_CHILD_SESSION_DIR` test override, is created if missing, and rejects
    empty, relative, unreadable, or uncreatable overrides with
    `LARVA_CHILD_START_FAILED`.
23. Public `task_id` paths outside the canonical child session root are rejected
    with `LARVA_BAD_INPUT`.
24. Successful `larva_subagent` returns a Pi-facing ToolResult wrapper with text
    `content`, top-level metadata and `details` preserving matching semantic
    `status: "success"`, public `task_id`, string final assistant `result_text`,
    `persona_id`, `error: null`, and `isError: false`.
25. Failed `larva_subagent` after session allocation returns renderer-safe text
    `content`, matching top-level metadata and `details` with public `task_id`
    when known, a non-null `{code, message}` error object, and `isError: true`;
    pre-session failures such as no active parent persona also include text
    `content` and matching top-level/details fields.
26. Child startup uses `LARVA_PI_REAL_BIN`, `LARVA_PI_EXTENSION_FLAG`, and
    `LARVA_PI_EXTENSION_ENTRY`, not bare `pi` or derived extension-entry paths;
    uses Pi RPC `get_state`, validates `data.sessionFile` as a readable `.jsonl`
    path under the child session root, uses that path as `task_id`, sends
    `prompt`, waits for `agent_end`, then requires
    `get_last_assistant_text.data.text` to be a string for `result_text`.
27. No child-session sidecar file is written or required; resume validation relies
    on child-root path containment, readable `.jsonl` file shape, and explicit
    `persona_id` resolution.
28. `task_id` resume uses Pi RPC `switch_session`, then appends the new `task` via
    `prompt` and returns output from that resumed invocation, not prior raw JSONL.
29. Resume path taxonomy is deterministic: non-string/empty/relative task id,
    canonicalization failure, symlink escape, or outside-root path returns
    `LARVA_BAD_INPUT`; under-root non-`.jsonl`, directory, non-regular file, or
    unreadable file returns `LARVA_SESSION_INVALID`; missing under-root `.jsonl`
    returns `LARVA_SESSION_NOT_FOUND`.
30. Resume fails with `LARVA_SESSION_BUSY` when the same canonical `task_id` is
    already active in this parent extension process.
31. Before starting a resume child process, the parent validates only input/path,
    parent spawn authority, and busy state. Child persona/model/policy/tool
    initialization happens inside the child extension.
32. Two concurrent resumes of the same `task_id` in one parent Pi extension
    process use the in-memory active-task set; one proceeds and the other returns
    `failed` with `LARVA_SESSION_BUSY` before starting a child process.
33. Parent Pi restart clears busy state; there is no stale lock file to remove.
34. A running child uses the persona/model/tool-policy envelope captured at that
    child process startup. A later resume reuses the child session file but
    re-resolves the requested child persona id from the current registry before
    appending the new task.
35. Parent abort sends Pi RPC `abort`, returns `status: "cancelled"` with
    `LARVA_CHILD_CANCELLED` when abort or kill stops the child, returns `success`
    if the child completed during grace, and returns `failed` with
    `LARVA_CHILD_PROTOCOL_FAILED` if child state becomes unknowable.
36. Child sessions expose nested `larva_subagent` only when the child persona's
    own `can_spawn` and child tool policy allow it.
37. Persona resolution bridge uses `LARVA_CLI_ARGV_JSON` plus `resolve <id> --json`
    and inherits launcher registry environment. Fallback to `larva`/`uvx larva` is
    allowed only when `LARVA_CLI_ARGV_JSON` is absent. Timeout/nonzero/malformed
    output maps to `LARVA_PERSONA_NOT_FOUND`.
38. Persona list bridge uses `LARVA_CLI_ARGV_JSON` plus `list --json` and never
    reads private `~/.larva/registry` files. List output is projected into
    adapter-local `PersonaCandidate` entries containing only `id`, `description`,
    `model`, `spec_digest`, and `capabilities`; `prompt` and full PersonaSpec
    content are excluded from memory cache, disk cache, completion items, selector
    rows, and mention autocomplete. UI hot paths use memory or disk cache without
    synchronously waiting for `larva list --json`; refresh failure preserves stale
    cache.
39. Before child RPC readiness, parent parses only child stderr lines shaped as
    `larva pi: <ERROR_CODE>:` and propagates only `LARVA_PERSONA_NOT_FOUND`,
    `LARVA_MODEL_UNAVAILABLE`, `LARVA_POLICY_INVALID`, and
    `LARVA_TOOL_ENUMERATION_FAILED`; other pre-RPC child exits map to
    `LARVA_CHILD_START_FAILED`.
40. Child RPC command responses for `get_state`, `switch_session`, `prompt`, and
    `get_last_assistant_text` time out after ten seconds with
    `LARVA_CHILD_PROTOCOL_FAILED`; waiting for `agent_end` after an accepted prompt
    is unbounded until Pi completes or the parent aborts.
41. If Pi truncates or limits returned assistant text but still returns a string
    final text field, `larva_subagent` returns that text without semantic
    usability judgment. `LARVA_CHILD_PROTOCOL_FAILED` is reserved for malformed,
    failed, text-missing, null-text, or non-string-text RPC responses.

42. Any `larva_subagent` ToolResult with non-null `task_id` includes a visible
    resume footer in `content[0].text` containing `persona_id`, exact `task_id`,
    and an instruction to pass that `task_id` back to `larva_subagent`. Results
    with `task_id: null` do not show a resume footer.
43. `larva_subagent_sessions(limit?)`, if exposed, accepts only an optional
    positive integer `limit` with default `10` and maximum `25`; invalid values
    return a Pi-facing ToolResult with `isError: true`, `details.status` set to
    `"failed"`, `details.sessions` set to `[]`, and `details.error.code` set to
    `"LARVA_BAD_INPUT"`; its `content[0].text` is
    `LARVA_BAD_INPUT: limit must be an integer from 1 to 25.`. On success it
    returns `isError: false` with `details.status` set to `"success"`,
    `details.sessions` containing newest-first process-local recent-session
    entries already observed by this parent extension, and `details.error: null`;
    the process-local index retains at most 25 entries and evicts the oldest
    retained entry when a new entry exceeds that bound; the response has no top-level
    `sessions` field. It does not scan the filesystem, write sidecar metadata,
    create a `last` alias, or relax normal `task_id` resume validation.

44. `larva_subagent` custom rendering uses `renderCall` to show target
    `persona_id`, new/resume mode, and a task preview bounded to 120 visible
    characters in the tool row; resume calls also show an abbreviated `task_id`
    path bounded to 80 visible characters. The protocol tool name
    remains `larva_subagent`. Tests must prove deterministic visible-character
    counting for these bounds, including ANSI stripping, newline/control
    replacement, Unicode NFC-normalized code-point counting, and ellipsis
    placement counted inside the 120- and 80-character limits.
45. During execution, `larva_subagent` emits partial updates through Pi `onUpdate`
    with bounded progress details: persona id, new/resume mode, phase, task
    preview, and `task_id` once allocated. Partial update text is bounded to 200
    visible characters per update and does not stream full child logs or full
    child transcripts into parent context. Tests must prove deterministic
    visible-character counting for the 200-character bound, including ANSI
    stripping, newline/control replacement, Unicode NFC-normalized code-point
    counting, and ellipsis placement counted inside the limit.
46. `renderResult` supports collapsed and expanded final views. Collapsed view
    shows persona and terminal state; expanded view shows persona id, mode, full
    task, `task_id` when known, final status, error if any, final output, and the
    resume footer. Subagent rendering does not overwrite the parent `larva:`
    footer status or add a widget dashboard.
47. `/larva-log [task_id?]`, if exposed, is registered as a Pi slash
    command and opens only a user-visible, view-only overlay from the parent
    extension's presentation log plus adapter-local persistent cache. Tests must
    prove newest and exact
    `task_id` selection, `view_only: true`, no top-level `task_id` or
    `result_text` mirrors, stable `LARVA_SUBAGENT_LOG_NOT_OBSERVED` and
    `LARVA_SUBAGENT_LOG_UI_UNAVAILABLE` errors, reset/not-observed cleanup, and
    no mutation of persona state, model state, tool policy, active task markers,
    child session files, recent-session index contents, or resume authority.
    Runtime/spec verification must also prove overlay text is not injected into
    the parent prompt, model-visible tool list, model-facing tool result stream,
    tool allow/deny policy, shared PersonaSpec, CapabilityToken, JobSpec, or any
    opifex shared surface.

48. Interactive TUI autocomplete requires a runtime UI context exposing
    `ctx.ui.addAutocompleteProvider`; runtime proof must show the tested Pi build
    exposes that hook before claiming editor-autocomplete support. With that hook,
    persona mentions may surface candidates on raw `@`, partial canonical
    namespace tokens, and `@persona:<query>` input.
    It returns canonical `@persona:<id>` candidates from the same adapter-local
    persona candidate cache as `/larva-persona`, preserves the documented matching
    order, keeps Pi file-reference candidates in their original order before
    appended persona candidates, removes exact duplicate insertion `value`s across
    the merged list by keeping the first candidate, delegates unrelated `@...`
    input to Pi's base provider, and preserves Pi-owned file-reference suggestions
    when raw `@` suggestions are shown. It does not offer raw short-form `@<id>`
    persona candidates. A submitted `@persona:<id>` mention has no automatic side
    effect: it does not switch personas, force `larva_subagent`, or inject the
    mentioned persona prompt/spec.

49. `/larva-persona --refresh-cache` forces a persona candidate cache refresh
    through public `larva list --json`, updates memory and disk cache on success,
    preserves the old cache on failure, and does not commit persona/model/tool or
    session state. It is an option on the existing `/larva-persona` command, not
    a new slash command or model-facing LLM tool. Registry mutations need not be
    reflected instantly, but after manual refresh the selector and autocomplete
    reflect the refreshed candidate set.

50. Prompt projection uses Larva-managed overlay blocks rather than Pi default
    prompt string matching. The effective prompt preserves the incoming Pi
    chained system prompt unchanged between `larva:identity-policy` and
    `larva:active-persona` blocks, removes only previous Larva-managed marker
    blocks for idempotence, includes the active `larva-spec` watermark and
    committed PersonaSpec prompt, and does not rebuild Pi's prompt from
    `systemPromptOptions` or modify provider-specific request payloads for
    persona identity.


### Pi TUI enhanced UI verification addendum

Additional gates for the formal Pi TUI dependency and enhanced UI target:

1. `npm --prefix contrib/pi-extension ci` succeeds and installs exact
   `@earendil-works/pi-tui@0.78.0` from the `contrib/pi-extension` package and
   lock files.
2. The Pi extension can import Pi TUI primitives from the formal dependency path
   without relying on host-global module resolution.
3. All `/larva-log` custom-component render lines satisfy visible width
   `<= width` using Pi TUI `visibleWidth`, including CJK text, emoji, Markdown
   syntax, ANSI-stripped input, long `task_id` paths, selector rows, live
   assistant previews, and tool-output previews.
4. `/larva-log` uses the persona selector's modal surface conventions:
   the same modal chrome helpers, `90%` width, `90%` max-height budget,
   accent-colored border, solid ANSI background, stable frame height across
   tab/scroll/selector states, and terminal-compatible right/bottom drop shadow.
5. `/larva-log` captures the initial subagent prompt/task text in the
   presentation log and exposes it in the user-visible overlay without making it a
   model-facing or shared opifex surface.
6. `/larva-log` exposes keyboard tabs for Summary, Prompt, Output,
   Timeline, and Metadata; `1`/`2`/`3`/`4`/`5` and `←`/`→` switch tabs without
   mutating presentation state.
7. Summary uses readable grouped/aligned fields and does not inline full prompt,
   raw Markdown output, raw tool output, or raw RPC payloads; the Prompt pane
   exposes the full initial prompt.
8. The Prompt pane renders the full initial prompt/task text through Pi TUI
   Markdown with readable numbered-step formatting for compact task prompts. The
   Output pane renders live assistant text while running and final subagent output
   through Pi TUI Markdown when output exists, and uses a renderer-safe fallback
   when output is empty. Final output remains based on `get_last_assistant_text`.
9. The Timeline pane shows a process-local bounded chronological stream that may
   include assistant message excerpts, hidden-thinking markers, terminal status,
   and tool-call snapshots. It groups `tool_execution_start`,
   `tool_execution_update`, and `tool_execution_end` by `toolCallId` into one
   evolving row/snapshot per tool call at its first-seen position. Its default
   view is human-action-first: it shows assistant excerpts as timeline-shaped
   plain preview rows such as `• assistant <excerpt>` without full Markdown
   rendering partial stream fragments, dimmed/indented tool rows such as
   `↳ read(path="file") — success`, bounded argument summaries, bounded
   output/error previews, and success/failure status without appending an
   unbounded event firehose or exposing internal call/frame ids. Heavy arguments
   such as full content, patches, diffs, and base64 data are omitted/summarized.
   Internal ids are available only through bounded debug/metadata views.
10. `message_update` streaming proof covers assistant text preview updates and
    verifies that `thinking_*` content is not rendered. Overlong message/tool
    content must be bounded in memory, renderer-safe, and visibly marked as
    truncated.
11. Selector proof covers default newest-detail open, `s` to enter selector,
    deterministic ordering (running first, then newest `updated_at`, then highest
    `sequence`), single-line bounded rows with local started time and no full path
    or internal IDs, event-driven refresh without cursor theft, keyboard
    navigation, `Enter` selecting without closing, and `Esc`/`q` close behavior.
12. Streaming state is process-local only for this target. Cache roundtrip proof
    must show live assistant previews, timeline events, exact-session assistant
    excerpt ids, grouped tool snapshots, active tool state, and raw child RPC
    event payloads are not persisted.
13. The overlay uses substantially more available height on tall terminals through
    terminal-row-aware viewport sizing while preserving stable frame height.
14. `Esc`/`q`, `↑`/`↓`, `PageUp`/`PageDown`, `Home`/`End`, `s`, `Enter`, and mouse
    wheel continue to work according to the active mode; Enter does not close the
    detail overlay and mouse click remains unsupported/no-op.
15. Mouse reporting is enabled only while the overlay is open and disabled on
    dispose/reset/close. Mouse click is not supported and has no required
    behavior.
16. Expanded `larva_subagent` final views render as Markdown UI with Summary,
    Task, Output, Error, and Resume sections while preserving the semantic
    `LarvaSubagentResult` and Pi ToolResult top-level/details mirrors.
17. Collapsed `larva_subagent` final views remain compact renderer-safe text and
    do not add a widget dashboard.
18. `/larva-persona` interactive no-argument mode, when UI is available, renders a
    Pi TUI selector with filter input, persona list, model/description/capability
    summary, digest detail, Enter confirm, and Esc cancel. Selector proof must
    cover an accent-colored border, solid ANSI background, adaptive list
    viewport/full-height utilization, terminal-compatible drop shadow, stable
    frame height during filter/navigation, visible width `<= width`, and mouse
    click no-op behavior. It must also prove `ctrl+alt+p` extension shortcut
    registration, same-path selector commit behavior, and non-idle no-state-change
    warning behavior. Non-interactive mode, missing UI, and fallback selector
    behavior remain as specified earlier in this section.
19. Persona candidate cache proof covers memory hit, disk stale hit, background
    refresh success, background refresh failure preserving stale data, cold-cache
    non-blocking behavior, prompt exclusion, and `/larva-persona --refresh-cache`
    manual refresh success/failure behavior.

## Implementation handoff
Suggested order for the persona candidate cache work:

1. Add adapter-local `PersonaCandidate` projection helpers inside
   `contrib/pi-extension/larva.ts`.
   - Input: public `larva list --json` result.
   - Output: `id`, `description`, `model`, `spec_digest`, `capabilities` only.
   - Reject malformed candidate rows for cache writes.
   - Never retain `prompt` in memory cache, disk cache, selector details,
     completion items, or mention autocomplete.

2. Replace the existing completion TTL-only cache with a two-tier cache.
   - Memory cache: current process fast path.
   - Disk cache: adapter-local default path
     `~/.pi/larva/persona-candidates-cache.json`, with absolute test override
     support via `LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE`.
   - Tests must be able to reset memory state and point disk state at a temp file.

3. Add stale-while-revalidate refresh orchestration.
   - At `session_start` / extension initialization with real runtime context, load
     disk cache when present.
   - Start background refresh from public `larva list --json` without blocking Pi
     startup, selector opening, or autocomplete.
   - Share an in-flight refresh between callers.
   - On refresh success, update memory first, then disk.
   - On refresh failure, preserve stale cache and record bounded diagnostics.

4. Rewire `/larva-persona` completion, selector population, and
   `@persona:<id>` autocomplete to use the shared candidate cache.
   - Hot paths return memory cache when present.
   - If memory is empty but disk cache is valid, return disk cache immediately and
     trigger refresh.
   - If both caches are empty, return a bounded empty/loading-compatible result and
     trigger refresh; do not synchronously wait for `larva list --json`.

5. Add `/larva-persona --refresh-cache`.
   - It is a mode of the existing command, not a new slash command or LLM tool.
   - It forces a foreground refresh through public `larva list --json`.
   - Success updates memory and disk cache and notifies the user.
   - Failure preserves old cache and reports a bounded failure reason.
   - It must not commit persona/model/tool policy or session state.

6. Add tests before implementation where practical, then make them green.
   Minimum tests:
   - projection excludes `prompt`;
   - disk stale cache is returned without waiting when `larva list --json` is slow
     or fails;
   - background refresh success updates memory and disk;
   - background refresh failure preserves stale cache;
   - cold cache does not read private `~/.larva/registry` and does not block UI;
   - `/larva-persona --refresh-cache` success/failure behavior;
   - simulated registry mutation becomes visible after manual refresh;
   - selector, command completion, and mention autocomplete all use the same
     candidate source.

7. Run gates.
   - Focused Pi extension contract tests.
   - Pi extension subagent UX tests if shared helpers are touched.
   - Runtime smoke for command registration and selector/autocomplete surfaces.
   - `invar guard`.

Watch for:

- Do not add `PersonaCandidateIndex`, `larva personas index --json`, a Pi bridge
  daemon, or registry revision invalidation in this pass.
- Do not add a new slash command or alias; use `/larva-persona --refresh-cache`.
- Do not add a model-facing refresh tool unless a later workflow proves it is
  necessary.
- Do not import Pi-specific cache concepts into PersonaSpec validation or opifex
  contracts.
- Do not directly read `~/.larva/registry` as the primary data source.
- Do not silently continue with a half-switched persona/model/policy state.
- Do not dump persona registries or cached candidates into the system prompt.
- Do not match or rewrite Pi's default identity sentence; remove only
  Larva-managed marker blocks for prompt idempotence.
- Do not rebuild Pi's prompt builder from `systemPromptOptions`; preserve Pi's
  chained system prompt as the operational context.
- Do not use provider-specific request payload rewriting for persona identity.
- Do not treat `@persona:<id>` as an automatic command, persona switch, forced
  subagent invocation, or prompt/spec injection.
- Do not intercept Pi-owned `@` file references; raw `@`, `@p`, and `@persona`
  may show persona candidates, but unrelated `@...` editor input must delegate to
  Pi's base provider and raw `@` suggestions must preserve Pi file-reference
  suggestions.
- Do not build worktree isolation or a job scheduler in this feature.
- Do not mutate Pi JSONL session files for Larva provenance.
- Do not write Pi settings files as a hidden fallback for extension loading.
- Do not add sidecar metadata or filesystem lock files unless cross-process resume
  safety becomes an explicit requirement.
