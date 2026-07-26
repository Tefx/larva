# Larva Pi thinking-level isolation

## Status

Proposed. This document defines the Larva-owned design and implementation
boundary. It does not authorize implementation by itself.

## Problem

Pi persists model and thinking-level changes through the active
`PI_CODING_AGENT_DIR/settings.json`. Multiple Larva parent sessions and child Pi
processes can therefore change one shared settings file. A parent orchestration
session may need a high thinking level while implementation personas need a lower
level, yet child startup currently has no persona-specific thinking policy and
the Subagent Console does not show the effective startup level.

Larva cannot require changes to Pi. The solution must use Pi's existing CLI,
environment, session, and RPC surfaces.

## Decision

Larva will add two mechanisms:

1. A small adapter-local persona thinking policy.
2. A private Pi agent-directory capsule for every Larva-launched parent and child
   Pi process.

Model and thinking will be resolved and applied as one runtime route while
reusing the existing model-map profile switch control path and generation.

## Non-goals

- No Pi source or installed-package modification.
- No PersonaSpec, Opifex, or Larva registry schema change.
- No model-specific thinking entries in the policy.
- No `larva_subagent` thinking parameter.
- No new slash command, daemon, file watcher, policy profile, or hot reload.
- No second route generation or second active-run registry.
- No automatic merge of capsule settings into the user's base Pi settings.
- No contract for how another repository creates or deploys the policy file.
- No parent-isolation guarantee when Larva's extension is loaded by bypassing the
  supported `larva pi` launcher.

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

Before `larva pi` replaces `PI_CODING_AGENT_DIR`, it records the effective base
Pi agent directory in `LARVA_PI_BASE_AGENT_DIR`. Each Larva-launched Pi process
receives a private directory under:

```text
$HOME/.pi/larva/runtime/<run-id>/agent
```

The capsule contains a private copy of `settings.json`. Other required Pi files
and directories refer to the base Pi agent directory. Session storage remains in
its existing explicit parent or child session directory rather than moving under
the capsule.

This makes Pi's existing settings writes process-local without changing Pi.
Parent and child processes must never write the base settings file through the
capsule.

### Safety and lifetime

- Capsule directory mode: `0700`.
- Private settings mode: `0600`.
- Cleanup may remove only the capsule root and links within it; it must not
  follow links into the base Pi directory.
- Parent capsules are removed by the `larva pi` launcher on normal return and
  startup failure.
- Child capsules join the existing child cleanup paths for completion,
  cancellation, and startup failure.
- A later Larva launch may remove bounded stale capsule directories left by a
  process crash.
- Capsule settings are never merged back into base settings.

The implementation should remain small helper functions in the existing Python
launcher and TypeScript extension unless tests prove that a separate module is
necessary.

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
- With no active persona, Larva leaves the Pi session thinking level unchanged.
- Shift-Tab remains a manual current-session change and writes only the parent
  capsule.
- Resuming a parent session preserves the thinking level recorded in that Pi
  session until another explicit persona or model-map profile switch applies a
  policy value.
- A turn-scoped persona borrow captures and restores both origin model and origin
  thinking.

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

A starting child resolves or fences both model and thinking before its first
prompt. No second generation counter is permitted.

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

Implementation must occur on a feature branch, never directly on `main`. The
planner should append a new phase after the current model-map phase, preserve the
prerequisite explicitly, require expected-red proof before mutation, and retain
real installed-Pi concurrency and overlay verification as independent gate work.
