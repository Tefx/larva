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

## Adapter-local tool policy

Persona-specific Pi tool filtering is configured in:

```text
~/.pi/tool-policy.json
```

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
/larva-persona <prefix>
```

It passes exactly `<prefix>` (for example, `vectl` in `/larva-persona vectl`) to
the same persona-id completer used by command-level completion. Forced Tab and
regular completion use the same path. In `larva pi`, typing
`/larva-persona <prefix>` and pressing Tab should show matching persona ids from
the current `larva list --json` output. All other editor input is delegated to
Pi's base provider so global and file completion remain Pi-owned.

Completion candidates have Pi's command item shape:

```json
{"value": "persona-id", "label": "persona-id", "description": "optional description or model"}
```

If `larva list --json` fails or returns malformed JSON, the provider returns
`null` and does not throw through the Pi TUI. The extension does not inject a
persona catalogue into prompts, cache completion results, or perform fuzzy
matching; matching is exact `startsWith(<prefix>)` over current persona ids.

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

Result shape:

```json
{
  "task_id": "/absolute/path/to/child-session.jsonl",
  "persona_id": "doc-reviewer",
  "status": "success",
  "result_text": "...",
  "error": null
}
```

`status` is `success`, `failed`, or `cancelled`. On failures before a child
session path exists, `task_id` is `null`; after a child session path is known,
the result may include that public path with a non-null `{code, message}` error.

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

- No PersonaSpec schema changes and no Pi-specific policy fields in PersonaSpec.
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
