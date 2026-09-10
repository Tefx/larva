# Larva Pi thinking-level isolation

## Status

The accepted [native extension target](pi-native-extension.md) now owns startup
and settings isolation. Its implementation is pending. Main Pi uses normal
settings persistence and session-local persona setters; only children retain
private settings capsules.

Thinking policy, route verification, profile switching and console behavior in
this reference remain applicable unless explicitly superseded there. The older
implementation-phase and handoff topology below is historical and does not
require a new Vectl phase or authorize execution.

## Problem

Parent and child sessions need independently selected model/thinking routes
without persona automation changing unrelated sessions' defaults. The earlier
launcher isolated the entire main settings file, which also discarded normal
preference changes such as theme selection.

On the inspected Pi 0.85.1 host, extension model/thinking setters update runtime
state and session history without saving global defaults. Other settings, such as
theme, do persist. Therefore a native main can retain ordinary Pi preferences
while persona changes stay session-local. Children still require private settings
capsules and explicit verified routes.

The native design records both the real-runtime evidence and its limits. It uses
Pi's public extension, CLI, environment, session and RPC surfaces without changing
Pi itself.

## Decision

The native target retains adapter-local thinking policy and treats model and
thinking as one runtime route, reusing the existing model-map profile switch
control path and generation.

Main persona automation uses session-local Pi APIs. Main ordinary settings use
Pi's normal persistence, with no parent capsule or exit-time settings rollback.
Each new or resumed child process retains a private Pi agent-directory capsule;
its route is independently resolved and verified before the task prompt.

## Non-goals

- No Pi source or installed-package modification.
- No PersonaSpec, Opifex, or Larva registry schema change.
- No model-specific thinking entries in the policy.
- No `larva_subagent` thinking parameter.
- No new thinking-policy slash command, daemon, file watcher, policy profile, or
  hot reload mechanism.
- No second route generation or second active-run registry.
- No automatic merge of child capsule settings into base Pi settings.
- No contract for how another repository creates or deploys the policy file.
- No main whole-settings isolation or retained `larva pi` compatibility layer.

## Thinking policy

### Location

Default:

```text
$HOME/.pi/larva/thinking-policy.json
```

An absolute `LARVA_PI_THINKING_POLICY_FILE` may override the default path.

### Shape

```json
{
  "schema_version": 1,
  "default": "medium",
  "personas": {
    "vectl-orchestrator": "high",
    "software-architect": "high",
    "python-executor": "low"
  }
}
```

Allowed levels are exactly:

```text
off, minimal, low, medium, high, xhigh, max
```

The only precedence rule is:

```text
personas[persona_id] -> default
```

The file supports exact persona ids only. Unknown keys, malformed values, an
unknown schema version, or a non-object shape are invalid. A missing file uses
the built-in default `medium`. An existing invalid file fails the affected
persona activation or child invocation before its next prompt.

Thinking policy is owned by the Larva Pi adapter. It is not PersonaSpec content
and is not written into the Larva registry. Pi remains authoritative for model
capability clamping; Larva records both requested and effective values when they
differ.

## Pi agent-directory capsules

### Boundary

Main Pi uses its normal base agent directory. The native extension establishes
that base identity and carries it into child startup; it does not require a
Python launcher to supply `LARVA_PI_BASE_AGENT_DIR`.

Each child receives a private directory under the existing Larva runtime root:

```text
$HOME/.pi/larva/runtime/<run-id>/agent
```

The capsule contains a private copy of the base `settings.json`. Other required
Pi resources retain their existing references to the base agent directory.
Session storage remains in the existing explicit parent or child session
directory rather than moving under a capsule.

Child processes must never write the base settings file through the capsule.
Project settings, linked resources and arbitrary tool I/O retain their existing
ownership; the capsule supplies no wider filesystem isolation.

### Safety and lifetime

- Child capsule directory mode: `0700`.
- Private settings mode: `0600`.
- Cleanup may remove only the capsule root and links within it; it must not
  follow links into the base Pi directory.
- Child capsules join existing completion, cancellation, startup-failure and
  other terminal cleanup paths; verify parent shutdown with a live child too.
- Bounded stale-child cleanup may retain its existing lifetime rules.
- Capsule settings are never merged back into base settings.
- Native main has no capsule to clean up and never restores a global settings
  snapshot on exit.

Reuse the existing child helpers unless an actual consumer or failure mode
requires a separate module. The retired Python parent-capsule helpers do not
need a TypeScript replacement.

## Runtime route

The existing resolved model route is extended conceptually with one field:

```text
provider
model_id
requested_thinking
```

This is one value used by parent persona activation, child startup/resume, and
model-map profile switching. It does not introduce a new registry or control
plane.

### Parent behavior

- A fresh explicit persona activation applies that persona's requested thinking.
- An explicit persona switch applies the target persona's requested thinking.
- With no active persona, Larva leaves Pi's session thinking unchanged.
- Persona automation uses session-local model/thinking setters. Session history
  may record those choices; unrelated new sessions' global defaults remain
  unchanged.
- Manual current-session changes and explicit user saves follow native Pi's
  respective semantics. Ordinary settings such as theme persist normally.
- Resuming a parent session preserves its recorded thinking until another
  explicit persona or model-map profile switch applies a policy value.
- A turn-scoped persona borrow captures and restores actual origin model and
  thinking, including manual pre-borrow choices.

### Child startup and resume

For each new or resumed child invocation:

```text
resolve persona
-> resolve active model-map route
-> resolve persona thinking policy
-> create child capsule
-> spawn Pi with explicit --model and --thinking
-> switch_session when resuming
-> apply route fence
-> get_state
-> verify model and effective thinking
-> send prompt
```

A child never inherits the parent's current thinking level. Every resume resolves
the current persona policy again. A model mismatch, missing/invalid
`thinkingLevel`, or an unverified route fails before the prompt. A supported Pi
clamp such as `xhigh -> high` is valid and is recorded rather than treated as a
mismatch.

## Model-map profile switching

Thinking policy does not change the `model-map*.json` schema. It integrates with
the current process-local profile switch implementation after that feature's
active remediation and verification phase closes.

The existing switch serialization, route generation, starting-child fence,
bounded child fan-out, partial outcome, and rollback behavior remain the single
control path. For each parent or ready child, the route transition is:

```text
capture previous model and thinking
-> set target model
-> set requested thinking
-> read effective state
-> verify model and thinking
-> mark the existing route generation applied
```

If model or thinking application fails, the target is not fully switched. Larva
attempts to restore both previous values and uses the existing partial/failed
classification if restoration cannot be confirmed. An in-flight model request
keeps its old route; the next prompt uses the newly verified route.

A starting child and profile switching share one serialized route lock. Child
admission captures one snapshot containing the profile path, resolved model,
requested thinking, and route generation before releasing that lock. The child
process receives that profile path through its cloned
spawn environment, so initial-persona validation and `--model` use the same map.
If a switch starts after the snapshot, the existing post-RPC fence applies the
newer model and thinking before the first prompt. No second generation counter is
permitted.

## Subagent Console

The presentation entry gains three bounded fields:

```text
startup_model
requested_thinking
startup_thinking
```

`startup_model` and `startup_thinking` come from the final successful child RPC
`get_state` immediately before the first prompt for that invocation. They are
immutable presentation facts after capture and remain view-only cache metadata.

The selector displays a compact effective value, for example:

```text
software-architect  think=high
python-executor     think=low
```

When Pi clamps the request, it displays the transition:

```text
software-architect  think=xhigh->high
```

The Metadata pane displays:

```text
Startup model:      openrouter/openai/gpt-5.6-sol
Requested thinking: xhigh
Startup thinking:   high
```

The existing `thinking hidden` marker continues to mean hidden reasoning content;
it is separate from thinking level. Presentation cache data must never become
status, wait, event, cancellation, or route authority.

## Failure model

| Failure | Required result |
|---|---|
| Policy file missing | Use built-in `medium` |
| Existing policy invalid | Fail affected activation/invocation before prompt |
| Capsule creation or permission failure | Fail startup; do not run against base settings |
| Child model verification mismatch | Fail before prompt |
| Child thinking state missing or invalid | Fail before prompt |
| Pi clamps a valid requested level | Continue and record requested/effective values |
| Profile switch updates model but not thinking | Roll back both or return existing partial/failed outcome |
| Capsule cleanup failure | Report bounded diagnostic; never delete base targets |

## Implementation phases

> Historical rollout notes for the original thinking-isolation work. These phases and the following original code-scope list do not prescribe native-cutover ownership or Plan topology. The [native design](pi-native-extension.md#implementation-and-cutover-sequence) owns the replacement delivery sequence.


### 1. Current model-map phase prerequisite

Complete the active `pi_model_map_profile_switch_20260725` remediation,
independent runtime verification, and conformance review before implementation of
this feature begins. This avoids concurrent edits to the same route-switch and
child-startup paths.

### 2. Contract and expected-red proof

Add focused tests proving the current gaps:

- concurrent Larva parent/child processes can touch shared Pi settings;
- children lack persona-specific explicit thinking startup;
- model-map switching does not treat model and thinking as one verified route;
- Subagent Console lacks effective startup thinking metadata.

### 3. Capsule isolation

Add parent and child capsule creation, environment wiring, session-directory
preservation, cleanup, permission checks, and stale cleanup. Prove the base Pi
settings hash is unchanged across concurrent parent and child changes.

### 4. Policy and route integration

Add strict policy loading and connect requested thinking to explicit parent
persona activation, persona switching, turn-lease restoration, child new/resume,
and the existing profile-switch generation. Verify effective state before child
prompts.

### 5. Presentation and documentation

Add startup model/thinking fields to the overlay and view-only presentation cache.
Update Larva's operator and async-subagent documentation in the same change.

### 6. Verification and review

Required runtime evidence:

1. Two concurrent parents use different thinking levels without changing base Pi
   settings.
2. One parent and concurrent high/low persona children remain isolated.
3. Child resume reapplies the current persona policy.
4. A provider profile switch verifies both model and thinking.
5. Injected thinking-switch failure proves rollback or partial classification.
6. Pi capability clamping is shown as requested versus effective.
7. Overlay values match RPC `get_state`.
8. Normal, cancelled, failed, and stale capsule cleanup stay within the capsule
   root.
9. Full repository tests and `invar guard` pass, followed by independent runtime
   and conformance review.

## Expected code and documentation scope

- `src/larva/shell/pi.py`
- `contrib/pi-extension/larva.ts`
- existing Pi launcher, runtime, subagent, model-map, and overlay tests
- `README.md`
- `contrib/pi-extension/README.md`
- `docs/reference/PI_EXTENSION_ASYNC_SUBAGENTS.md`

No additional source module is planned. A separate helper module is allowed only
if implementation and tests no longer fit comfortably together in the existing
owner file.

## Implementation handoff

Use the [native cutover sequence and acceptance matrix](pi-native-extension.md#implementation-and-cutover-sequence).
The earlier phase sequence above records the thinking-isolation implementation's
history; it is not a request to append phases, preserve the launcher, or repeat
completed work. Current execution authority and any matching managed step must be
resolved when implementation is actually requested.
