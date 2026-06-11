# Larva Pi Extension Compaction Focus

Status: implemented in the bundled Larva Pi extension. This document is the
runtime contract and operator reference for the implemented behavior.

This document defines the Larva Pi extension behavior for adding
Larva/persona-specific focus to Pi context compaction without replacing Pi's
base compaction prompts.

## Implementation status and verification

The bundled extension handles Pi's `session_before_compact` hook by calling Pi's
exported `compact(...)` helper with bounded Larva focus supplied through
`customInstructions`. It preserves Pi's native compaction prompts and result
schema; Larva does not replace `SUMMARIZATION_PROMPT`,
`UPDATE_SUMMARIZATION_PROMPT`, split-turn prompt handling, or the provider
payload.

Verification pointers:

- `uv run pytest tests/shell/test_pi_extension_contract.py -k compaction_focus -q`
- `test_compaction_focus_expected_red_gap_exposed`: focused hook calls Pi
  `compact(...)` with the original `event.preparation`, runtime model/auth,
  abort signal, optional thinking level/stream function, and composed
  `customInstructions`.
- `test_compaction_focus_config_case_table` and
  `test_compaction_focus_hook_case_table`: config defaults/disable switches,
  native fallback, cancellation, and bounded diagnostics.
- `test_compaction_focus_non_overreach_guards_defined`: no base-prompt
  replacement, provider-payload rewrite, automatic continuation message, or
  config-file writes.

## Goal

Improve task continuity after Pi compaction by preserving unfinished work,
next actions, files, commands, failing tests, blockers, and persona-specific
summary needs.

The extension must keep Pi's default compaction summary format and only append
bounded focus text through Pi's `customInstructions` path.

## Non-goals

- Do not modify installed Pi packages under `/opt/homebrew/...`.
- Do not replace Pi's default `SUMMARIZATION_PROMPT`,
  `UPDATE_SUMMARIZATION_PROMPT`, or split-turn prompt.
- Do not change PersonaSpec or opifex shared contracts.
- Do not make threshold or manual compaction automatically continue execution.
- Do not use provider-payload rewriting as the primary integration path.
- Do not write, migrate, merge, or create user configuration files
  automatically.

## Pi API constraint

Pi 0.79.1 exposes `session_before_compact`, but its result shape supports only:

```ts
{ cancel?: boolean; compaction?: CompactionResult }
```

It does not support returning only additional focus text, such as:

```ts
{ customInstructions: "..." }
```

Therefore Larva cannot mutate `event.customInstructions` and then hand control
back to Pi's built-in compaction path. To affect automatic compaction, Larva
must either return no value and allow native Pi compaction, or generate a full
`CompactionResult` and return it through the hook.

## Integration approach
When enabled, Larva handles `session_before_compact` by:

1. Reading adapter-local compaction configuration.
2. Building bounded focus text from manual compact instructions, the active
   persona's `compaction_prompt`, and the configured carry-forward rule.
3. Calling Pi's exported `compact(...)` helper with the original
   `event.preparation` and the built focus as `customInstructions`.
4. Returning `{ compaction: result }` to Pi.

This keeps Pi's base prompt, previous-summary update logic, split-turn logic,
file-operation tracking, and session-context rebuild behavior intact. Larva's
only intended semantic change is the appended `Additional focus:` text that Pi's
own compactor already supports.

The implementation contract should be expressible with these TypeScript shapes
(imported from `@earendil-works/pi-coding-agent` where available):

```ts
type LarvaCompactionHookResult =
  | undefined
  | { cancel: true }
  | { compaction: CompactionResult };

type LarvaCompactAdapter = (
  preparation: CompactionPreparation,
  model: Model<any>,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  customInstructions: string,
  signal: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
) => Promise<CompactionResult>;

async function handleLarvaSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  compactAdapter: LarvaCompactAdapter,
): Promise<LarvaCompactionHookResult>;
```

`CompactionResult` is the Pi result shape with `summary`, `firstKeptEntryId`,
`tokensBefore`, and optional `details`. Larva must not define a second summary
schema.

## Runtime state requirement

`PersonaSpec` already permits:

```ts
compaction_prompt?: string
```

The Pi extension's active runtime envelope must preserve that field so the
compaction hook can read it without re-resolving the persona:

```ts
type PersonaEnvelope = {
  persona_id: string;
  spec_digest: string;
  model: string;
  prompt: string;
  tool_policy: PiToolPolicy;
  can_spawn?: boolean | string[];
  compaction_prompt?: string;
};
```

Only `compaction_prompt` is used as persona-specific compaction focus. The
extension must not inject the full persona prompt into compaction focus.

## Adapter-local configuration
The configuration file is:

```text
~/.pi/larva/compaction.json
```

Tests and local experiments may override the path with:

```text
LARVA_PI_COMPACTION_CONFIG_FILE=/absolute/path/to/compaction.json
```

The override must be absolute and non-empty. A relative or empty override is an
invalid config condition. Missing config means defaults. Malformed config must
not cancel compaction; Larva must fall back to native Pi compaction and emit the
configured diagnostic channel when available.

### Schema
```json
{
  "enabled": true,
  "carry_forward_rule": {
    "enabled": true,
    "text": "If the task is unfinished, keep it in Progress/In Progress and Next Steps.\nDo not mark work as complete unless completion evidence exists.\nPreserve next concrete action, files changed, commands run, failing tests, and blockers."
  }
}
```

Parsing rules:

- The root value must be a JSON object. `null`, arrays, scalars, and invalid JSON
  are invalid.
- Unknown root keys and unknown `carry_forward_rule` keys are invalid. The file
  is adapter-local, so strict validation is preferred over accepting misspelled
  policy.
- `enabled` is optional boolean, default `true`.
- When root `enabled` is `false`, the parser still validates all present keys and
  types. A present `carry_forward_rule.text` must still be a string if supplied,
  but empty or over-limit text is ignored because the whole feature is disabled.
- `carry_forward_rule` is optional object. Missing object defaults to the full
  default carry-forward rule configuration.
- `carry_forward_rule.enabled` is optional boolean, default `true`.
- When `carry_forward_rule.enabled` is `false` and root `enabled` is `true`, a
  present `carry_forward_rule.text` must be a string if supplied, but empty or
  over-limit text is ignored because that section is disabled.
- When both root `enabled` and `carry_forward_rule.enabled` are `true`,
  `carry_forward_rule.text` must be a non-empty string after trimming.
- Enabled `carry_forward_rule.text` is bounded to 4000 Unicode code points after
  trimming. Over-limit configured text is invalid rather than silently truncated.

Examples:

```json
{"enabled": false, "carry_forward_rule": {"text": ""}}
```

Valid: the feature is disabled, and present text has the correct type.

```json
{"enabled": true, "carry_forward_rule": {"enabled": false, "text": ""}}
```

Valid: only the carry-forward section is disabled.

```json
{"enabled": true, "carry_forward_rule": {"enabled": true, "text": ""}}
```

Invalid: enabled text is empty after trimming.

If the file is absent, the effective default is enabled with the built-in
carry-forward rule above.

Invalid config outcome:

- emit `LARVA_COMPACTION_CONFIG_INVALID` when a notification/status channel is
  available;
- return `undefined` from the hook so Pi performs native compaction;
- do not rewrite, delete, migrate, or create any config file.

## Focus composition
The focus text is assembled in this order, omitting empty sections:

```text
Manual compact focus:
<event.customInstructions>

Active Larva persona compaction focus:
<state.envelope.compaction_prompt>

Larva carry-forward rule:
<configured or built-in carry-forward rule>
```

Manual `/compact ...` instructions always remain first and must never be
overwritten by persona or adapter defaults.

Bounds and trimming:

- Trim leading/trailing whitespace for each source before deciding whether it is
  empty.
- Manual focus section: maximum 2000 Unicode code points after trimming,
  including any truncation marker.
- Persona compaction focus section: maximum 2000 Unicode code points after
  trimming, including any truncation marker.
- Carry-forward rule section: maximum 4000 Unicode code points, enforced by
  config parsing.
- Total composed focus: maximum 6000 Unicode code points, including any total
  truncation marker.

Truncation algorithm:

1. Count Unicode code points with `Array.from(text).length`.
2. For runtime manual/persona text over its section bound, compute
   `omitted = originalCodePoints - keptCodePoints`, where `keptCodePoints` is
   chosen so `keptText + marker` is exactly within the section bound.
3. Marker format is exact: `...[truncated ${omitted} code points]`.
4. Section truncation is tail truncation: keep the prefix and append the marker.
5. Compose non-empty labeled sections with a blank line between sections.
6. If composed focus exceeds 6000 code points, tail-truncate the composed string
   using the same marker format and bound-inclusive counting.

Fixture examples:

- With the real section bound of 2000 and input `"a".repeat(2005)`, output is
  `"a".repeat(1971) + "...[truncated 34 code points]"`.
- If a future smaller bound makes the marker itself longer than the bound, output
  the first `bound` code points of the marker. Current 2000/6000 bounds are large
  enough for the marker to fit.
- If manual focus, persona focus, and carry-forward are all present and total
  truncation is required, the retained prefix must begin with `Manual compact
  focus:`. Later sections are sacrificed first.

If all sections are empty after trimming, the hook returns `undefined` and Pi
uses native compaction.

## Required runtime inputs
Calling Pi's `compact(...)` requires the same mandatory runtime inputs Pi uses
in its native path:

- active model from the Pi extension context (`ctx.model`): required. Missing
  model maps to `LARVA_COMPACTION_FOCUS_UNAVAILABLE` and native fallback.
- auth resolution from `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)`:
  required to return `{ ok: true }`. The returned `apiKey` may be `undefined`
  only if Pi's model registry returns it that way; Larva passes `apiKey` and
  `headers` through exactly and must not synthesize credentials. `{ ok: false }`
  maps to `LARVA_COMPACTION_FOCUS_UNAVAILABLE` and native fallback.
- abort signal from `event.signal`: required. Missing signal means the event
  shape is unsupported and maps to native fallback.
- `event.preparation`: required. It is supported only when it is an object with
  non-empty string `firstKeptEntryId`, arrays `messagesToSummarize` and
  `turnPrefixMessages`, boolean `isSplitTurn`, finite number `tokensBefore`,
  object `fileOps`, object `settings`, and optional string `previousSummary`.
  `fileOps` must include set-like fields `read`, `written`, and `edited` if Larva
  validates the concrete Pi `FileOperations` shape directly; otherwise Larva
  must pass through Pi's `event.preparation.fileOps` only after confirming it is
  an object.
  Anything else is malformed and maps to native fallback.

Fidelity-preserving optional inputs:

- thinking level from `pi.getThinkingLevel?.()` when available. Missing thinking
  level does not force fallback; call `compact(...)` with `undefined` so Pi's
  helper omits reasoning options.
- stream function if Pi exposes one to the extension runtime. Missing stream
  function does not force fallback; Pi's exported `compact(...)` can fall back to
  its non-streaming completion helper.

Larva must not derive a model from `state.envelope.model`, must not construct
provider requests directly, and must not guess credentials. Missing mandatory
inputs return `undefined` so Pi performs native compaction.

## Fallback behavior
Larva must fall back to native Pi compaction by returning `undefined` when:

- compaction focus is disabled;
- the composed focus is empty;
- config parsing or validation fails;
- mandatory model/auth/runtime prerequisites are unavailable;
- the event shape is not the expected compaction event;
- `compact(...)` is unavailable before invocation;
- `compact(...)` throws for a non-abort reason.

Abort handling is distinct from ordinary fallback:

- If `event.signal.aborted` is already true before Larva invokes `compact(...)`,
  return `{ cancel: true }` so the user's cancellation remains cancellation and
  native compaction is not restarted.
- If `event.signal` aborts during Larva's `compact(...)` call and the thrown
  value satisfies the cancellation predicate below, return `{ cancel: true }`.
- If `compact(...)` throws for any other reason, emit diagnostics when possible
  and return `undefined` so Pi may run native compaction once.

Cancellation predicate:

```ts
function isCompactionAbort(caught: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!(caught instanceof Error)) return false;
  return caught.name === "AbortError" || caught.message === "Compaction cancelled";
}
```

Fallback must not return a partial or malformed summary. It must also avoid
starting duplicate compaction after user cancellation.

## Diagnostics
Diagnostics are adapter-local and bounded. They are not PersonaSpec fields, not
subagent terminal errors, and not compaction authority.

Stable codes:

- `LARVA_COMPACTION_CONFIG_INVALID`: config path, JSON parse, schema, unknown key,
  or bounds failure.
- `LARVA_COMPACTION_FOCUS_UNAVAILABLE`: mandatory runtime prerequisite is missing,
  auth is unavailable, or the compact adapter is unavailable.
- `LARVA_COMPACTION_FOCUS_FAILED`: Larva attempted focused compaction and the
  compact adapter threw a non-abort error.

Message template:

```text
<CODE>: <bounded reason>; using native Pi compaction
```

For `{ cancel: true }` abort handling, no warning diagnostic is required because
user cancellation is the expected outcome.

Emission channel:

1. Prefer `ctx.ui.notify(message, "warning")` when available.
2. Otherwise use `setLarvaStatus(ctx, "compaction focus: <CODE>")` when status is
   available.
3. In non-UI modes where no status channel exists, diagnostics may be omitted but
   fallback behavior must remain deterministic.

Diagnostic text is capped at 500 Unicode code points after sanitization. It must
not include raw conversation, summary, API keys, headers, full prompts, or
`customInstructions`; reasons must be generic such as `invalid config`,
`missing model`, `auth unavailable`, or `focused compact failed`.

## Verification requirements
Implementation must provide tests for:

1. active `PersonaEnvelope` preserves `compaction_prompt`;
2. config parsing, defaults, disable switches, disabled-but-present text
   validation, custom text, strict unknown-key rejection, bounds, missing nested
   object defaults, invalid non-object/null roots, and invalid override paths;
3. focus composition for manual instructions, persona focus, carry-forward rule,
   disabled sections, per-section truncation, marker-inclusive length,
   `omitted` count calculation, total truncation, and empty-focus fallback;
4. successful hook path calls Pi `compact(...)` with the composed focus as
   `customInstructions` and returns `{ compaction: result }`;
5. mandatory runtime input fallback for missing model, auth `{ ok: false }`,
   missing signal, malformed preparation fields including malformed `fileOps`,
   unavailable adapter, and non-abort adapter failure;
6. abort behavior returns `{ cancel: true }` without starting native duplicate
   compaction, including already-aborted signal and thrown `AbortError`/
   `Compaction cancelled` cases;
7. diagnostics: code mapping, notify-before-status channel precedence,
   500-code-point cap, and redaction of raw conversation, prompts,
   `customInstructions`, API keys, and headers;
8. output summaries retain Pi's standard sections, including `## Goal`,
   `## Progress`, `## Next Steps`, and `## Critical Context`;
9. non-overreach constraints: no installed Pi package edits, no PersonaSpec or
   opifex schema changes, no Pi base prompt replacement, no provider-payload
   rewrite, no automatic continuation message, and no automatic config file
   writes.

## Operator-facing summary

Larva compaction focus is implemented to make summaries less likely to imply
task completion when work is still open. It is not an automatic continuation
feature. After threshold or manual compaction, Pi may still wait for the next
user turn; the improved summary simply gives the next agent turn better
carry-forward state.
