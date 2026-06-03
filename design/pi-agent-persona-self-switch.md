# Larva Pi Agent Persona Self-Switch Design

Status: implemented first target; future child inherit/ask/auto policy remains unimplemented
Scope: `larva pi` launcher and bundled Pi extension only
Canonical contract authority: opifex-owned PersonaSpec schema remains unchanged

## Decision

Add a session-level agent persona switch policy for Larva's Pi integration.

The feature has three user-facing surfaces:

```text
larva pi --agent-persona-switch off|ask|auto ...
/larva-agent-persona-switch [off|ask|auto]
larva_persona_switch(persona_id, reason, handoff?, continue_task?)
```

Optional but recommended read-only discovery tool:

```text
larva_personas(query?, limit?)
```

The model-facing tool is the only autonomous switch entrypoint. It reuses the
existing internal persona commit path that is already used by `/larva-persona`.
The tool must not expose the internal commit primitive directly.

## Rationale

The existing Pi extension can already switch active Larva persona in-place through
`/larva-persona <id>`. That path resolves the target persona, validates the model,
loads adapter-local runtime configuration, updates Pi model/tool state, and commits
one session-local active persona envelope atomically.

Agent self-switch should reuse that commit path instead of creating a parallel
runtime state path. The new behavior is consent and orchestration around the
commit primitive, not a new PersonaSpec capability.

The switch policy is session-level because it represents user consent for this Pi
session. It must not be a PersonaSpec field and must not be controlled by a
persona prompt.

## Non-goals

- No PersonaSpec schema change.
- No opifex shared-contract change.
- No persona-level `auto|ask|off` policy.
- No persona catalogue injected into the system prompt.
- No direct LLM access to `commitPersona(...)`.
- No child-to-parent persona mutation.
- No automatic child self-switch in the first target.

## User-facing policy modes

### `off`

Default mode.

Behavior:

- The agent cannot self-switch persona.
- `larva_persona_switch` is not active or visible to the model.
- A defensive `tool_call` gate still rejects stale or forged calls.
- Manual user switch remains available through `/larva-persona <id>`.

### `ask`

Behavior:

- The agent may request a persona switch by calling `larva_persona_switch`.
- The extension asks the user for confirmation before committing.
- If the user confirms, the extension commits the target persona.
- If the user rejects, cancels, times out, or no UI is available, no switch occurs.

### `auto`

Behavior:

- The agent may switch to a better-suited persona without user confirmation.
- The tool must require a clear `reason` and should include a concise `handoff`.
- Successful switch terminates the old persona turn.
- If `continue_task` is true, the extension queues a Larva-generated continuation
  so the new persona can continue the same task on the next turn.

## Runtime flow

```text
LLM current persona
  -> calls larva_persona_switch(persona_id, reason, handoff?, continue_task?)
      -> extension checks session switch mode
      -> off: reject without commit
      -> ask: request user confirmation; reject without commit if not approved
      -> auto: continue without confirmation
      -> extension calls internal commitPersona(persona_id)
          -> resolve persona
          -> validate/select model
          -> compute active tool set
          -> commit active persona envelope atomically
      -> append session audit entry
      -> if committed: return terminate=true
      -> if committed and continue_task=true: queue Larva-generated continuation
```

The model calls `larva_persona_switch`. It never calls `commitPersona(...)`.

`commitPersona(...)` stays an internal primitive shared by:

- `/larva-persona <id>` user slash command;
- `larva_persona_switch(...)` model-facing tool;
- startup initial persona commit.

## Termination semantics

A successful self-switch must return a terminating tool result.

Reason:

- The current provider call started with the old persona prompt.
- The Larva active-persona prompt is injected by `before_agent_start`.
- A tool call happens after that hook has already run for the current turn.
- Committing a new persona mid-turn changes extension state, but it does not
  restart the current provider call with the new persona prompt.

Therefore a successful switch must stop the old persona turn before it continues
producing output.

The switch tool should be documented and prompted as a single-tool action:

```text
Call larva_persona_switch alone. Do not call other tools in the same assistant
message when switching persona.
```

The extension should also defend against mixed tool batches where possible.

## Auto-continuation

Committing a persona changes runtime state but does not by itself start another
model turn.

When `continue_task=true`, the extension should queue a transparent continuation
message after a successful commit:

```text
[Larva-generated continuation after persona switch]
Switched from <old-persona> to <new-persona>.
Reason: <reason>
Handoff: <handoff>
Continue the user's original task under the new persona.
Do not switch again unless newly justified.
```

The continuation must be explicit and auditable. It must not pretend to be a new
human-authored request.

Recommended first implementation path:

```text
pi.sendUserMessage(<Larva-generated continuation>, { deliverAs: "followUp" })
```

This should be runtime-tested against Pi's queue and termination behavior.

## Session state

CLI startup sets the default mode through environment:

```text
LARVA_PI_AGENT_PERSONA_SWITCH=off|ask|auto
```

The slash command updates the current session mode:

```text
/larva-agent-persona-switch auto
```

The extension persists session override state with a custom session entry:

```json
{
  "customType": "larva-agent-persona-switch-mode",
  "details": {
    "mode": "auto",
    "source": "slash-command"
  }
}
```

On session start, mode resolution order is:

1. latest valid session override entry;
2. launcher environment default;
3. hard default `off`.

## Tool exposure and prompt guidance

The active tool set must reflect session mode.

```text
off  -> no larva_persona_switch, no larva_personas
ask  -> enable larva_persona_switch and larva_personas
auto -> enable larva_persona_switch and larva_personas
```

`before_agent_start` should inject only short mode-specific guidance.

For `auto`:

```text
If the current active Larva persona is materially unsuitable and a clearly better
registered Larva persona exists, call larva_persona_switch alone with a concise
reason and handoff. Do not switch for minor style mismatch. At most one
self-switch may happen for one user request chain unless the user explicitly asks
otherwise.
```

For `ask`:

```text
You may request a persona switch with larva_persona_switch when another registered
Larva persona is clearly better suited. The user must approve before the switch is
committed.
```

For `off`, do not inject self-switch guidance.

## Child subagent policy

A child subagent is a separate Pi process and session. It should use the same
implementation machinery, but it needs an explicit policy boundary.

First target rule:

```text
child self-switch mode = off
```

Reason:

`larva_subagent(persona_id="python-engineer", task="...")` should mean the child
session runs as `python-engineer`. If the child silently switches itself to another
persona, the parent receives a result whose persona provenance is ambiguous.

Future optional extension:

```text
LARVA_PI_CHILD_AGENT_PERSONA_SWITCH=off|inherit|ask|auto
```

Do not add this until parent-session self-switch is proven stable.

## Audit entries

Every attempted switch should create a non-model-context custom entry.

Suggested details shape:

```json
{
  "source": "tool|slash-command|startup",
  "mode": "off|ask|auto",
  "from_persona_id": "software-architect",
  "to_persona_id": "python-engineer",
  "reason": "implementation required",
  "handoff": "implement the agreed module boundary",
  "approved": true,
  "committed": true,
  "error_code": null,
  "continue_task": true
}
```

These entries are for user inspection, tests, and session recovery. They are not
shared opifex contracts.

## Loop and abuse guards

Minimum guards:

- Default mode is `off`.
- At most one successful self-switch per user request chain by default.
- Same-persona switch is a no-op and should not terminate.
- `reason` is required and must be non-empty.
- `handoff` should be bounded in length.
- `off` mode rejects even if a stale tool call is somehow present.
- `ask` mode requires live UI confirmation.
- Child sessions default to `off`.

## Architecture basis

```yaml
architecture_basis:
  system_layers:
    core: "No change. PersonaSpec validation and normalization remain canonical."
    shell_cli: "Add larva pi --agent-persona-switch to pass a session default into the Pi extension."
    pi_extension: "Own session switch mode, model-facing switch tools, slash command, prompt guidance, audit, termination, and continuation."
    external_runtime: "Pi CLI/TUI/RPC remains the host runtime."

  source_of_truth_matrix:
    PersonaSpec schema: "opifex canonical contract"
    persona registry contents: "Larva registry through the existing CLI bridge"
    active Pi persona: "Pi extension session-local committed envelope"
    agent switch mode: "Pi session-level state; latest session override, else launcher env, else off"
    user manual switch: "/larva-persona <id>"
    agent self-switch: "larva_persona_switch tool gated by session switch mode"
    continuation request: "Larva-generated queued message, explicit and auditable"

  service_catalog:
    larva_pi_launcher:
      owner: "larva.shell"
      responsibility: "Parse Larva-owned switch-mode flag and pass default mode through environment."
    larva_pi_extension:
      owner: "contrib/pi-extension"
      responsibility: "Manage session switch mode and project persona state into Pi."
    agent_switch_tool:
      owner: "contrib/pi-extension"
      responsibility: "Expose the only model-facing persona switch request surface."
    persona_discovery_tool:
      owner: "contrib/pi-extension"
      responsibility: "Expose bounded read-only persona discovery when ask/auto mode allows switching."

  runtime_contract:
    launch: "larva pi --agent-persona-switch off|ask|auto [--persona <id>] [--] <pi args...>"
    slash_mode: "/larva-agent-persona-switch [off|ask|auto]"
    tool_switch: "larva_persona_switch(persona_id, reason, handoff?, continue_task?)"
    success: "commit target persona atomically, append audit, terminate old turn, optionally queue continuation"
    failure: "do not commit; preserve previous persona/model/tools"
    default_mode: "off"
    child_default_mode: "off"

  state_strata:
    canonical_state: "PersonaSpec and registry entries"
    session_policy_state: "agent switch mode and audit custom entries in the Pi session"
    runtime_envelope_state: "active persona/model/tool envelope inside one Pi extension process"
    continuation_state: "queued Larva-generated message for the next turn only"

  transport_boundary_rules:
    - "Do not change PersonaSpec or opifex shared contracts."
    - "Do not expose commitPersona directly to the model."
    - "Do not inject a persona catalogue into the system prompt."
    - "Do not allow child self-switch to mutate parent persona state."
    - "Do not treat persona prompt text as authority to change session switch mode."

  cross_cutting_governance:
    registries:
      - "Larva registry remains persona source of truth."
      - "Pi extension owns only session-local switch mode and committed envelope."
    lifecycle_ordering:
      - "Resolve switch mode on session_start."
      - "Register slash command and model-facing tools during extension initialization."
      - "Update active tool exposure when mode changes or persona commits."
      - "Inject mode guidance only during before_agent_start."
      - "On successful model-facing switch, terminate the old turn before continuation."
    coordination_mechanisms:
      - "CLI env default for launch-time switch mode."
      - "Session custom entries for runtime switch-mode override and audit."
      - "Pi registerTool for model-facing switch and discovery tools."
      - "Pi registerCommand for slash mode changes."
      - "Pi setActiveTools plus tool_call gate for enforcement."
      - "Pi sendUserMessage follow-up for auto-continuation, pending runtime proof."
    wiring_strategy: "Explicit env default plus session-local state; no global files for this policy in first target."
    governance_owner: "contrib/pi-extension owns runtime behavior; larva.shell owns CLI flag forwarding."

  shared_abstractions:
    shared_types:
      - name: "AgentPersonaSwitchMode"
        owner_module: "contrib/pi-extension"
        consumers: ["CLI env parser", "slash command", "switch tool", "before_agent_start guidance", "tool exposure"]
        rationale: "One enum prevents drift between user-facing modes."
      - name: "PersonaSwitchRequest"
        owner_module: "contrib/pi-extension"
        consumers: ["larva_persona_switch tool", "ask confirmation UI", "audit entry"]
        rationale: "One request shape keeps reason/handoff/continue semantics consistent."
      - name: "PersonaSwitchAuditEntry"
        owner_module: "contrib/pi-extension"
        consumers: ["session persistence", "tests", "operator inspection"]
        rationale: "Switch attempts need auditable, non-model-context state."
    shared_protocols: []
    shared_utilities: "N/A: keep local until duplication is proven."
    decision: "Only cross-surface request/mode/audit shapes are shared; implementation internals stay local."

  ux_surfaces:
    - surface: "CLI flag"
      scope: "--agent-persona-switch off|ask|auto"
    - surface: "Pi slash command"
      scope: "/larva-agent-persona-switch [off|ask|auto]"
    - surface: "Pi model-facing tool"
      scope: "larva_persona_switch and optional larva_personas"
    - surface: "Confirmation UI"
      scope: "ask-mode approval before commit"
    - surface: "Continuation message"
      scope: "explicit Larva-generated continuation after auto switch"

  runtime_surfaces:
    - surface: "Interactive Pi session"
      launch_or_entrypoint: "larva pi --agent-persona-switch ask|auto --persona <id>"
      minimum_liveness_proof: "Agent can request switch; mode and persona status update visibly; old turn terminates on commit."
    - surface: "Non-interactive Pi/RPC"
      launch_or_entrypoint: "larva pi --agent-persona-switch off|auto -- --mode rpc"
      minimum_liveness_proof: "off rejects switch; auto commits without UI; ask rejects without UI."

  resolved_implementation_decisions:
    continuation_transport: "Use explicit Larva-generated pi.sendUserMessage(..., { deliverAs: 'followUp' }) for first target auto-continuation. The message must be visibly marked as Larva-generated and auditable; do not block implementation on custom-message triggerTurn exploration."
    mixed_tool_batch_enforcement: "Require larva_persona_switch to be called alone in tool description and prompt guidance. Runtime enforcement should defensively reject or neutralize sibling tool calls when Pi event ordering exposes enough context; if full sibling visibility is unavailable, the documented single-tool contract plus terminating result is the supported behavior."
    request_chain_identity: "Use a simple in-memory guard for the first target: at most one successful self-switch within the original user turn plus its Larva-generated continuation chain. Persist audit entries for inspection only; do not introduce durable global counters."
    child_policy: "Child Pi processes start with agent self-switch mode off. Do not add inherit/ask/auto child policy in the first target. Revisit only after parent self-switch has runtime proof."

  open_questions: []

  readiness: "READY_FOR_PLANNING"
```

## Implementation handoff

Suggested order:

1. Add CLI flag parsing and env forwarding.
2. Add extension mode enum, mode resolution, and session persistence.
3. Add `/larva-agent-persona-switch` slash command.
4. Add optional `larva_personas` read-only discovery tool.
5. Add `larva_persona_switch` tool as facade over internal commit.
6. Add active-tool exposure and defensive `tool_call` gating.
7. Add prompt guidance per mode.
8. Add audit entries.
9. Add terminate behavior and auto-continuation.
10. Force child process default mode to `off`.

## Verification targets

- CLI forwards `LARVA_PI_AGENT_PERSONA_SWITCH` correctly.
- Invalid CLI mode fails before Pi launch.
- Session slash command updates mode and persists it.
- Reload/resume restores latest session mode override.
- `off` mode hides/rejects model-facing switch tool.
- `ask` mode commits only after UI approval.
- `ask` mode without UI rejects without commit.
- `auto` mode commits without UI.
- Successful model-facing switch returns terminating tool result.
- Auto-continuation starts a new turn under the new persona prompt.
- Child subagent starts with self-switch mode `off` unless a future explicit child policy is added.
