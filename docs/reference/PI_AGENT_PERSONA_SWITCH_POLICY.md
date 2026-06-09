# Pi Agent Persona Switch Policy

Status: current normative authority for Pi agent persona switch mode semantics  
Scope: Larva-owned Pi launcher and bundled Pi extension runtime policy  
Contract boundary: no PersonaSpec schema change, no opifex shared-contract change

This document defines the current normative policy for agent/runtime-initiated
persona switches in Pi. It is deliberately generic: the rules do not depend on
vectl, a specific agent, or a specific persona.

## Decision

Larva mode has four canonical levels:

```text
manual < confirm < auto < free
```

The default mode is `confirm`.

Mode names are exact: no `off`/`ask` aliases. The target policy does not define compatibility aliases such as `off` or `ask`; unknown persisted values fail safe to `confirm` with a warning rather than being interpreted as aliases.

## What the mode controls

The mode controls only agent/runtime-initiated persona switches.

It does not restrict explicit user actions. A user may still switch persona
manually through the user-facing persona switch surface. User manual switches
always have highest priority.

The mode is Pi adapter-local session policy. It is not a PersonaSpec field, not
a registry field, and not controlled by persona prompt text.

## Mode semantics

### `manual`

The agent/runtime may not initiate persona switches.

- The model-facing autonomous switch surface is unavailable or rejected.
- A stale or forged switch request fails closed.
- Manual user persona switching remains available.
- No persona lease is created.

### `confirm`

The agent/runtime may request a temporary persona borrow, but the user must
confirm before it is committed.

`confirm` means "ask before temporary borrow". It does not mean "ask before a
persistent switch".

Default confirmation action:

```text
Borrow once
```

Required confirmation choices:

```text
[Borrow once] [Deny] [Auto-borrow for this session] [Switch persistently]
```

A target implementation that exposes `confirm` UI must provide these four
outcomes with the following semantics:

- `Borrow once`: create a turn-scoped persona lease and restore the origin
  persona and the Pi model that was active immediately before the borrow when the
  current assistant turn ends. Restore must not reapply the origin persona's
  default `PersonaSpec.model` if the user had manually selected a different Pi
  model before the borrow.
- `Deny`: do not change persona, model, or tool state.
- `Auto-borrow for this session`: set a session-local mode override to `auto`,
  then create the same turn-scoped lease for the current request, including the
  same origin Pi model snapshot. The override is not persisted as a global/user
  preference.
- `Switch persistently`: treat the action as an explicit user manual switch;
  set the active persona to the target and clear any active lease.

If no confirmation UI is available, `confirm` fails safely without changing the
active persona.

### `auto`

The agent/runtime may automatically borrow another persona without confirmation.

`auto` means temporary borrow. It does not mean persistent switch.

- A persona lease is created before the switch is committed.
- The lease records the persona and Pi model that were active immediately before
  the automatic switch.
- The origin persona and origin Pi model are restored when the current assistant
  turn ends.
- Restore is runtime-enforced and must not rely on the model remembering to
  switch back.

### `free`

The agent/runtime may automatically switch persona persistently.

- No persona lease is created.
- No automatic restore is required.
- The new active persona remains active after the current turn.

`free` is the only mode where agent/runtime-initiated persistent switching is
allowed without explicit user confirmation.

## Persona lease model

`confirm` and `auto` use the same lease model.

A persona lease represents a temporary borrow:

```text
PersonaLease:
  originPersonaId
  borrowedPersonaId
  originPiModelSnapshot
  scope
  initiatedBy
```

Field meaning:

- `originPersonaId`: the active persona immediately before the automatic or
  confirmed borrow. This may be the process-start persona, a restored session
  persona, or a persona selected manually by the user.
- `originPiModelSnapshot`: the actual Pi model active immediately before the
  borrow, if observable. This is a runtime model snapshot, not the origin
  persona's default `PersonaSpec.model`.
- `borrowedPersonaId`: the persona temporarily borrowed for the current scope.
- `scope`: `turn` by default. `agent_session` is allowed only for a real agent
  execution context.
- `initiatedBy`: `agent` or `runtime`.

One active lease is enough for the first policy version. Do not introduce a stack
unless a real nested-agent requirement appears.

## Restore boundary

The default restore boundary is the end of the current assistant turn.

The runtime can reliably detect a turn boundary when the active assistant turn
has reached a terminal state: no pending model continuation, no pending tool
call, and the final assistant output for that turn has been submitted.

Do not infer multi-turn task completion from natural language. Multi-turn work is
ambiguous, so each turn borrows and restores independently:

```text
turn 1: A -> B -> restore A
turn 2: A -> B -> restore A
turn 3: A -> C -> restore A
```

If a runtime creates a real agent execution context, such as a child agent
session or background agent session that calls a model and may produce assistant
output, the lease may be scoped to that `agent_session` instead. Ordinary
background tasks do not carry persona and must not create persona leases.

## Tasks and persona

Generic tasks do not need persona.

No persona lease is needed for deterministic work such as:

- reading or writing files;
- running tests or compilers;
- waiting for events;
- querying status;
- moving data between runtime components;
- deterministic tool execution.

Persona belongs to an agent execution context: a context that calls a model,
continues reasoning, or produces assistant-visible text. Only those contexts may
own a persona lease beyond the current turn.

## User manual switch precedence

A user manual switch always wins over an active lease.

When the user manually switches persona:

```text
clear any active lease
set active persona to the user-selected persona
do not later restore to the old lease origin
```

This prevents the runtime from undoing an explicit user decision.

## Multiple automatic borrows in one turn

If the agent/runtime borrows more than one persona in the same turn, the first
origin remains the restore target.

Example:

```text
turn starts as A
borrow B
borrow C
turn ends: restore A
```

In `confirm`, switching from one borrowed persona to another requires another
confirmation, with copy that states the restore target remains the original
persona.

## UX copy

Required `confirm` prompt content:

```text
Borrow persona?

The assistant wants to borrow {targetPersona} for this response.
Current persona {originPersona} and current Pi model will be restored afterward.

Reason:
{shortReason}

[Borrow once] [Deny] [Auto-borrow for this session] [Switch persistently]
```

Status/event-log notices, not chat-body messages:

```text
Borrowing persona: {targetPersona}; restore target: {originPersona}
Restored persona: {originPersona}
Persona mode changed for this session: confirm -> auto
```

Restore notices must stay in status UI, event logs, or audit entries. They must
not be injected into the assistant's chat response. If the user explicitly asks
for runtime status, the assistant may summarize status/event/audit information;
that summary is not an automatic restore notice.

## Unknown mode handling

The target policy does not support compatibility aliases.

If a persisted or environment-provided mode is not one of the canonical values:

```text
manual | confirm | auto | free
```

then the runtime must:

1. fall back to `confirm` for safety;
2. emit a warning through status/event log;
3. avoid silently mapping legacy names to canonical names.

This is a fail-safe path, not backward compatibility.

## Restore failure handling

Restore must be attempted on success, failure, cancellation, and timeout paths
for any active lease.

If restore fails, the runtime must not silently treat the borrowed persona as the
new normal. It must:

1. report restore failure through status/event log;
2. keep enough audit detail for diagnosis;
3. preserve the current runtime state;
4. require explicit user persona choice before any further persona-changing
   action.

This policy intentionally defines no automatic safe-default persona fallback.

## Mode matrix

| Mode | Agent/runtime may initiate | User confirmation | Automatic restore | Restore target |
| --- | --- | --- | --- | --- |
| `manual` | No | N/A | N/A | N/A |
| `confirm` | Request only | Yes | Yes | Persona and Pi model active before borrow |
| `auto` | Yes | No | Yes | Persona and Pi model active before borrow |
| `free` | Yes | No | No | N/A |

## Runtime invariants

- Default mode is `confirm`.
- Mode names are exactly `manual`, `confirm`, `auto`, and `free`.
- Mode governs agent/runtime-initiated switching only.
- User manual switching is always allowed and clears any active lease.
- `confirm` is confirmation before temporary borrow.
- `auto` is automatic temporary borrow.
- `free` is automatic persistent switch.
- `manual` forbids agent/runtime-initiated switches.
- Turn-scoped leases restore the origin persona and captured origin Pi model at
  current assistant turn end.
- Agent-session-scoped leases are allowed only for model-calling agent execution
  contexts.
- Generic tasks do not own persona.
- Restore is runtime-enforced and does not depend on model self-discipline.
- Restore notices use status/event/audit surfaces, not chat-body text.
- Restore failure is visible; it is never silently ignored.

## Suggested verification cases

- New session with no explicit mode starts in `confirm`.
- `manual` rejects agent/runtime switch requests while preserving manual user
  switching.
- `confirm` with no confirmation UI fails safely without changing
  persona/model/tools.
- `confirm` + `Deny` leaves persona/model/tools unchanged.
- `confirm` + `Borrow once` creates a turn-scoped lease and restores the origin
  persona plus the actual pre-borrow Pi model at turn end.
- `confirm` while already borrowing requires a new confirmation before borrowing
  another persona, and the restore target remains the first origin.
- `confirm` + `Auto-borrow for this session` changes only session-local mode to
  `auto`; a new session still starts from configured default.
- `confirm` + `Switch persistently` is treated as a user manual switch and does
  not create a lease.
- `auto` creates a turn-scoped lease and restores the origin persona plus the
  actual pre-borrow Pi model at turn end.
- `free` switches without creating a lease and does not restore.
- User manual switching during a lease clears the lease and prevents later
  restore to the old origin.
- Multiple borrows in one turn restore to the first origin.
- Ordinary deterministic tasks never create a persona lease.
- Agent execution contexts may own `agent_session` leases.
- Success, failure, cancellation, and timeout all attempt restore.
- Restore notices are emitted through status/event/audit surfaces and are not
  injected into assistant chat-body text.
- Restore failure reports through status/event log, preserves current runtime
  state, records audit detail, and requires explicit user persona choice before
  any further persona-changing action.
- Unknown mode falls back to `confirm` with a warning and no alias mapping.
