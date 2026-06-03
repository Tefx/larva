# Larva Pi extension

This directory contains the bundled Pi Coding Agent extension used by
`larva pi`. The integration projects Larva persona identity, prompt, model, and
adapter-local tool rules into Pi at runtime. The canonical PersonaSpec schema and
field meanings remain owned by opifex; this extension does not add Pi policy,
active-persona, sidecar, or runtime-permission fields to PersonaSpec JSON.

## Launching Pi through Larva

Use the Larva launcher instead of loading this extension manually:

```bash
larva pi --persona python-senior -- <pi args...>
```

`--persona` is optional. When omitted, Pi starts with no active Larva persona
until one is selected in the session. Arguments after `larva pi` are forwarded to
the real Pi executable.

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
```

Switching resolves the target persona through the Larva CLI context supplied by
the launcher, validates the target model and active policy entry, computes tool
rules, and commits the persona atomically. If any step fails, the previous
persona, model, and tool rules remain active.

With no argument, `/larva-persona` opens a selector only in interactive TUI mode.
In RPC, print, JSON, SDK, malformed mode, unknown mode, or other non-interactive
launcher classifications, the command returns an input error and leaves active
state unchanged. The Pi status line shows:

```text
larva: <id>
```

or, when no persona is active:

```text
larva: none
```

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
  from `larva list --json` when the runtime exposes the editor provider hook.
- Matching is case-insensitive substring matching over persona ids, not only
  prefix matching. For example, `senior` should match `python-senior`.
- Prefix matches rank before non-prefix substring matches. Otherwise preserve the
  registry order returned by `larva list --json`.
- Forced Tab and regular completion use the same matching path.
- All non-`/larva-persona` editor input is delegated to Pi's base provider so
  global and file completion remain Pi-owned.

Completion candidates have Pi's command item shape:

```json
{"value": "persona-id", "label": "persona-id", "description": "optional description or model"}
```

Performance target:

- The provider should cache the parsed `larva list --json` result in memory for
  an implementation-defined bounded TTL and share an in-flight list request
  between concurrent completion calls. The chosen TTL must be deterministic in
  tests by using an injectable clock or equivalent test hook; tests must prove
  cache hit, expiry, and in-flight sharing behavior without waiting on wall-clock
  time.
- The cache is a process-local parsed-list cache only. Do not write completion
  cache files, prefetch the persona list before a completion or selector needs it,
  or inject the persona catalogue into prompts.
- Tests must be able to reset the process-local completion cache and shared
  in-flight request state without touching disk.
- If `larva list --json` fails or returns malformed JSON, the provider returns
  `null` and does not throw through the Pi TUI.

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

Autocomplete uses the same persona list bridge and matching rules as
`/larva-persona` completion. Candidate `value` and dedupe identity are exactly
`@persona:<id>`. Any trailing space or suffix after insertion is Pi UI behavior
outside the Larva candidate value. Candidates may include the persona description
or model in the completion description. When persona candidates and Pi
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
behavior remains in `design/pi-coding-agent-integration.md` under "Runtime
capability and provenance matrix" and "Verification targets".

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

## `larva_subagent` custom tool

When the active parent persona and Pi tool policy allow it, the extension exposes
the primary child-session tool:

```text
larva_subagent(persona_id, task, task_id?)
```

Input:

- `persona_id`: required non-empty target Larva persona id.
- `task`: required non-empty instruction for the child Pi session.
- `task_id`: optional absolute child Pi `.jsonl` session path under the child
  session root. Resume validation is path-based only; no sidecar or provenance
  metadata is required.

Semantic/domain result payload (`LarvaSubagentResult`):

```json
{
  "task_id": "/absolute/path/to/child-session.jsonl",
  "persona_id": "doc-reviewer",
  "status": "success",
  "result_text": "...",
  "error": null
}
```

The Pi custom-tool `handler`/`execute` return a renderer-safe ToolResult wrapper
around that semantic payload, not a new Larva public schema. The wrapper includes
`content: [{"type":"text","text":"..."}]` for Pi rendering and preserves the
machine-readable `task_id`, `persona_id`, `status`, `result_text`, and `error`
fields in `details`. For `larva_subagent`, those same five fields are also
required as top-level metadata with values exactly matching `details`; this
adapter-local duplication is for Pi/runtime consumers only. `status` is the Larva
domain status (`success`, `failed`, or `cancelled`); Pi `isError` is derived
separately from whether that status is not `success`.

When `task_id` is non-null, the visible `content` text includes a short resume
footer with the target `persona_id`, exact `task_id`, and instruction to pass that
same `task_id` back to `larva_subagent` to continue the child session. The footer
is presentation-only: it does not change `result_text`, `details`, or resume
validation. If no child session path exists yet, `task_id` stays `null` and no
resume footer is shown.

The tool row also has custom Pi rendering so the parent UI does not show only the
raw tool name. The collapsed call display shows the target persona, whether the
call is new or a resume, and a task preview bounded to 120 visible characters:

```text
larva_subagent -> turing [new]
  explain why self-attention matters...
```

For resume calls, the collapsed call display also shows an abbreviated resume
handle bounded to 80 visible characters:

```text
larva_subagent -> turing [resume]
  task_id: ~/.pi/larva/child-sessions/...
  continue the previous task...
```

During execution, the tool streams coarse progress updates through Pi's custom
tool update channel. The updates are intentionally small and user-facing: current
phase, target `persona_id`, new/resume mode, task preview, and `task_id` once
known. Each update text is bounded to 200 visible characters. They do not stream
full child logs into the parent context. Typical phases are: `starting`,
`session_ready`, `prompt_sent`, `waiting_for_child`,
`collecting_final_text`, and terminal `success`, `failed`, or `cancelled`.

Visible preview limits count Unicode NFC-normalized code points after stripping
ANSI escape sequences and replacing newlines/control characters with a single
space. If text is truncated, the ellipsis is included inside the stated bound.
They do not count display columns or grapheme clusters.

The final rendered result supports collapsed and expanded views. Collapsed view
shows a compact status such as `turing completed`, `turing cancelled`, or
`turing failed`. Expanded view shows persona id, mode, full task, `task_id` when
known, final status, error if any, final output, and the same resume footer. This
uses Pi custom rendering only; it does not overwrite the parent `larva: <id>`
footer status or create a separate widget dashboard.

Failure and cancellation paths also return renderer-safe `content`: failures use
the stable error code/message text, and cancelled runs use cancellation text. On
failures before a child session path exists, `task_id` is `null`; after a child
session path is known, the metadata and visible footer include that public path
with a non-null `{code, message}` error.

The child session root defaults to:

```text
~/.pi/larva/child-sessions
```

The public `task_id` is the child Pi `.jsonl` session file path under that root.
It is the only durable public resume handle. A resume call validates that the
supplied path is a readable `.jsonl` file under the child session root, starts a
new child Pi RPC process, switches to that session, appends the new `task`, and
returns the final assistant text from the resumed invocation. The child persona id
is resolved from the current Larva registry on each new or resumed child startup.

For convenience, the extension may also expose a small read-only helper:

```text
larva_subagent_sessions(limit?)
```

Input:

- `limit`: optional positive integer; default `10`; maximum `25`. Non-integer,
  zero, negative, or above-maximum values return `LARVA_BAD_INPUT` and do not
  inspect session files.

It returns the recent child sessions seen by the current parent Pi extension
process, newest first by process-local sequence number, including `task_id`,
`persona_id`, latest status, and the process-local sequence number. The
process-local index retains at most 25 entries; when a new entry exceeds that
bound, the oldest retained entry is evicted. This helper is an in-memory UX aid
only. It does not scan
`~/.pi`, write sidecar metadata, prove provenance, create aliases such as
`task_id: "last"`, or replace normal `larva_subagent(task_id=...)` validation.
If multiple recent sessions could match a user request, the agent must ask the
user which `task_id` to resume instead of guessing.

The helper returns a Pi ToolResult wrapper, not bare JSON. On success,
machine-readable sessions live only under `details.sessions`:

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

Invalid `limit` returns the same wrapper shape with `isError: true`,
`details.status` set to `"failed"`, `details.sessions` set to `[]`,
`details.error.code` set to `"LARVA_BAD_INPUT"`, `details.error.message` set to
`"limit must be an integer from 1 to 25."`, and `content[0].text` set to
`LARVA_BAD_INPUT: limit must be an integer from 1 to 25.`.

The parent extension tracks same-`task_id` resumes in memory within one parent Pi
process. If another active call in that same process is already resuming the same
canonical path, the tool returns `failed` with `LARVA_SESSION_BUSY` before
starting another child process. This is not a cross-process filesystem lock.

If the parent tool call is aborted, the extension forwards a Pi RPC abort request
to the child and may kill the child after a grace period. If the child is stopped
by abort or kill, the result is `cancelled` with `LARVA_CHILD_CANCELLED`; if the
child completes during the grace period, the normal success result is returned.

### `/larva-subagent-log` view-only overlay

The extension also registers the authorized slash command:

```text
/larva-subagent-log [task_id?]
```

This is a user-visible, view-only overlay over the parent extension's in-memory
subagent presentation log. It is not a model-facing tool, not a tool-policy input,
not a resume authority, and not a shared Larva/opifex schema. With no argument it
selects the newest observed presentation-log entry; with an argument it selects
one exact `task_id`. It does not scan the filesystem, parse raw Pi JSONL, read or
write sidecars, or support aliases such as `last`.

The overlay result carries `view_only: true`, renderer-safe text `content`, and
adapter-local overlay `details`. It deliberately does not mirror
`LarvaSubagentResult` top-level `task_id` or `result_text` fields. Missing
observed entries return `LARVA_SUBAGENT_LOG_NOT_OBSERVED`; unavailable UI
notification returns `LARVA_SUBAGENT_LOG_UI_UNAVAILABLE`. Opening or resetting the
overlay must not mutate persona state, model state, tool policy, active task
markers, child session files, recent-session index contents, or resume authority.

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
- No MCP transport implementation inside this integration; users may install a Pi
  MCP bridge separately.
