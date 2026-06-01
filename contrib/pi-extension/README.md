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
fall back to writing `.pi/settings.json` or any other Pi settings file. At a
user-appropriate level, the launcher-owned environment records the resolved real
Pi executable, selected extension flag, absolute bundled extension entry, Larva
CLI argv prefix, optional initial persona id, policy-file path, and whether the
forwarded Pi arguments look interactive. Child Pi RPC sessions reuse those
launcher-provided values rather than rediscovering Pi or deriving extension
paths.

## Adapter-local model map

PersonaSpec `model` remains canonical Larva data. Pi-provider aliases are
adapter-local Larva-Pi configuration and must not be added to PersonaSpec or
opifex shared contracts.

The canonical model-map path is:

```text
~/.pi/larva/model-map.json
```

Set `LARVA_PI_MODEL_MAP_FILE` to override the path for tests or local adapter
experiments. When it is set, the extension reads only that path for the model
map.

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

Runtime-map completion policy:

- Build `~/.pi/larva/model-map.json` from observed Larva registry models,
  `/Users/tefx/dotfiles/agent/models.yaml`, and `pi --list-models --offline`.
- Add exact mappings only when the target provider/model id is present in Pi's
  offline registry. If no verified target exists, leave the model unmapped so the
  failure is explicit.
- For `openai/gpt-*`, prefer `openai-codex/<same-id>` when Pi lists it; only fall
  back to `openrouter/openai/<same-id>` when the Codex target is unavailable and
  the OpenRouter target is listed.
- `openrouter/*` models are covered by the literal `openrouter/` prefix rule and
  do not need one exact entry per model.
- Known adapter-local aliases may be mapped only after exact Pi registry proof:
  `ollama-cloud/glm-*` to `openrouter/z-ai/*`, `ollama-cloud/kimi-*` to
  `openrouter/moonshotai/*`, and `ollama-cloud/minimax-*` to
  `openrouter/minimax/*`.

Current verified example for the active local registry/dotfiles inventory:

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
`openrouter/google/gemini-3.5-flash` are covered by the literal `openrouter/`
prefix rule. The old `ollama-cloud/kimi-k2.6:cloud` spelling is not mapped unless
an exact entry is added and verified against Pi's registry.

Contract verification cases for the implementation step:

- Exact aliases in the example resolve through `models` before any prefix rule is
  considered.
- `openrouter/*` model ids preserve embedded slashes after the `openrouter/`
  prefix is stripped.
- Two matching prefix rules with the same `from_prefix` length fail closed with
  `LARVA_MODEL_MAP_INVALID`.
- Startup persona application and `/larva-persona` switching use the same model
  resolver and the same unavailable-model error projection.

## Adapter-local tool policy

Persona-specific Pi tool filtering is configured at the canonical path:

```text
~/.pi/larva/tool-policy.json
```

Set `LARVA_PI_TOOL_POLICY_FILE` to override the path. Resolution order is:

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
  adapter experiment, set `LARVA_PI_TOOL_POLICY_FILE=~/.pi/tool-policy.json` so
  the non-canonical path is explicit. Do not rely on the extension to discover it
  as a fallback.
- If both `~/.pi/larva/tool-policy.json` and `~/.pi/tool-policy.json` exist during
  migration, treat that as an operator conflict: stop, report the two paths, and
  choose one policy file manually. Do not merge, overwrite, or infer precedence
  between the two files.

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
- Matching is exact Pi tool-name matching only. Wildcards, path-level rules,
  command-level bash rules, and project-level overrides are out of scope.
- Tool names unknown to the current Pi runtime are ignored rather than rejected.
- `deny` wins over `allow`; if `allow` is present, only listed existing tools are
  allowed minus denied tools; if `allow` is absent, the current Pi tool baseline
  is allowed minus denied tools.
- There is no `ask` action.

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

### `/larva-persona` Tab completion

The command keeps Pi's command-level argument completer and, when the runtime UI
context exposes `ctx.ui.addAutocompleteProvider`, installs a narrow TUI
autocomplete provider for editor Tab completion. The provider intercepts only a
slash-command line shaped as:

```text
/larva-persona <query>
```

Target behavior for the next implementation step:

- Typing `/larva-persona <query>` and pressing Tab shows matching persona ids
  from `larva list --json`.
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

- The provider should cache the parsed `larva list --json` result in memory for a
  short bounded TTL and share an in-flight list request between concurrent
  completion calls.
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

The supplemental gate uses `--offline` runtime scenarios and the deterministic
fake Larva CLI bridge under `tests/fixtures/pi/fake-larva-cli.mjs`; it does not
require live network access or session credentials. If the real Pi binary is not
available or cannot report an extension flag, real-Pi scenarios skip with the
captured availability evidence. If Pi is present but its RPC runtime does not
expose extension UI/custom-command observability, those scenarios xfail with RPC
evidence. Plugin load, slash-command liveness, and other product/runtime failures
must fail the gate rather than being hidden behind unconditional skips.

## `larva_subagent` custom tool

When the active parent persona and Pi tool policy allow it, the extension exposes
one custom tool:

```text
larva_subagent(persona_id, task, task_id?)
```

Input:

- `persona_id`: required non-empty target Larva persona id.
- `task`: required non-empty instruction for the child Pi session.
- `task_id`: optional public resume handle returned by an earlier call.

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
fields in `details` and mirrored top-level metadata. `status` is the Larva domain
status (`success`, `failed`, or `cancelled`); Pi `isError` is derived separately
from whether that status is not `success`.

Failure and cancellation paths also return renderer-safe `content`: failures use
the stable error code/message text, and cancelled runs use cancellation text. On
failures before a child session path exists, `task_id` is `null`; after a child
session path is known, the metadata may include that public path with a non-null
`{code, message}` error.

The child session root defaults to:

```text
~/.pi/larva/child-sessions
```

The public `task_id` is the child Pi `.jsonl` session file path under that root.
It is the only public resume handle. A resume call validates that the supplied
path is a readable `.jsonl` file under the child session root, starts a new child
Pi RPC process, switches to that session, appends the new `task`, and returns the
final assistant text from the resumed invocation. The child persona id is
resolved from the current Larva registry on each new or resumed child startup.

The parent extension tracks same-`task_id` resumes in memory within one parent Pi
process. If another active call in that same process is already resuming the same
canonical path, the tool returns `failed` with `LARVA_SESSION_BUSY` before
starting another child process. This is not a cross-process filesystem lock.

If the parent tool call is aborted, the extension forwards a Pi RPC abort request
to the child and may kill the child after a grace period. If the child is stopped
by abort or kill, the result is `cancelled` with `LARVA_CHILD_CANCELLED`; if the
child completes during the grace period, the normal success result is returned.

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
- No worktree isolation, file locking, merge management, sandboxing, or credential
  isolation.
- No project-level policy hierarchy.
- No batch subagent tool or job scheduler.
- No subagent catalogue dumped into the system prompt.
- No Larva sidecar metadata or provenance file for child sessions.
- No MCP transport implementation inside this integration; users may install a Pi
  MCP bridge separately.
