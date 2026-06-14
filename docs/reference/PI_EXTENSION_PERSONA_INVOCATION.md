# Pi Extension Persona Invocation (Larva-Side)

Target: `docs/reference/PI_EXTENSION_PERSONA_INVOCATION.md`

## Positioning
This document defines the extension-facing persona invocation contract. Trusted
same-runtime Pi extensions can request Larva to run a specified persona once in a
fresh internal child Pi invocation and receive the final assistant text or a
stable structured error.

This is a reference contract, not evidence that any replacement-runtime or final
runtime gate has passed. Implementation handoffs must cite fresh runtime/final
gate evidence separately before claiming the replacement persona invocation
feature is complete.

- **NOT `larva_subagent` mode:** This is an internal extension-level primitive, not the model-facing `larva_subagent` tool.
- **NOT model-facing:** Agents do not call this directly.
- **NOT Aileron-specific:** Aileron is an example consumer, but not a product dependency.
- **NOT a scheduler/queue/task system.**
- **NOT a security boundary.**

## Internal Reuse
The invocation mechanism internally reuses existing Larva Pi mechanisms:
- Persona registry resolution
- Model mapping
- Persona tool policy
- Child Pi RPC startup
- Fresh child invocation/session behavior
- Timeout/abort/kill cleanup
- Lifecycle stale suppression
- Protocol/internal error handling

## Event Bus Surface
The interface is entirely over the event bus:
- `larva:persona-invocation:request`
- `larva:persona-invocation:cancel`
- `larva:persona-invocation:result`

## Machine-Check Anchors

The following literal anchors are intentional verification anchors for the vectl plan and summarize the normative contract without adding scope:

- prompt max 65536 UTF-8 bytes (`prompt_max_65536_utf8_bytes`)
- final_text max 16384 UTF-8 bytes (`final_text_max_16384_utf8_bytes`)
- metadata JSON.stringify UTF-8 max 2048 bytes (`metadata_json_stringify_max_2048_utf8_bytes`)
- timeout_ms 1..120000 (`timeout_ms_invalid_below_1`, `timeout_ms_invalid_above_120000`, `timeout_runtime_timeout_returns_TIMEOUT`)
- result error object shape: {code,message} (`result_error_object_exact_code_message_shape`)
- failed and cancelled results always have empty final_text (`failed_result_empty_final_text`, `cancelled_result_empty_final_text`)
- overlimit successful child output fails without artifact or truncation (`overlimit_output_PROTOCOL_FAILED_empty_final_text_no_artifact_no_truncation`)
- terminal-state matrix
- first terminal state wins (`terminal_race_first_terminal_state_wins`)
- at most one result (`terminal_race_at_most_one_result`)
- late timeout-cancel-stale ignored (`terminal_race_late_timeout_cancel_stale_ignored`)
- no capability discovery
- no fallback/version negotiation
- no variant
- no caller-selected cwd
- no tool override/tool_mode
- no schema enforcement
- no output artifact
- no queue
- no resume
- no public task id
- no status/events/wait/select
- no console integration
- no model-facing tool
- no Aileron-specific options

## Request Payload
`larva:persona-invocation:request`
```json
{
  "request_id": "canonical-lowercase-uuid-v4",
  "persona_id": "non-empty-string",
  "prompt": "non-empty-string",
  "timeout_ms": 120000,
  "metadata": {} // optional
}
```

- `request_id`: Required canonical lowercase UUID v4, exactly 36 chars, regex `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. No trim/normalize. An active duplicate `request_id` in one runtime fails with `LARVA_PERSONA_INVOCATION_BAD_INPUT`.
- `persona_id`: Required non-empty string. Resolved via Larva registry. If not found, maps to `LARVA_PERSONA_INVOCATION_PERSONA_NOT_FOUND`.
- `prompt`: Required string. Must be non-empty after trim check, but the original prompt string is sent unchanged. Max 65536 UTF-8 bytes. Invalid/overlimit results in `LARVA_PERSONA_INVOCATION_BAD_INPUT`.
- `timeout_ms`: Required integer 1..120000. Invalid results in `LARVA_PERSONA_INVOCATION_BAD_INPUT`. Runtime timeout maps to `LARVA_PERSONA_INVOCATION_TIMEOUT`.
- `metadata`: Optional JSON object. Diagnostics only. Max serialized output (using `JSON.stringify(metadata)`) is bounded to 2048 UTF-8 bytes after requiring a plain JSON object. Not prompt, not behavior/authority, not required to echo. Invalid/overlimit results in `LARVA_PERSONA_INVOCATION_BAD_INPUT`.

## Cancel Payload
`larva:persona-invocation:cancel`
```json
{
  "request_id": "canonical-lowercase-uuid-v4",
  "reason": "renderer-safe text"
}
```

- `request_id`: Required canonical lowercase UUID v4 (same rule as request `request_id`).
- `reason`: Required string. Larva applies the same renderer-safe normalization used by existing Pi cancellation text: Unicode NFC, remove ANSI escape sequences, replace Unicode control/format characters with spaces, collapse repeated spaces, and trim. The normalized result must be non-empty and at most 500 Unicode code points.
- Target: Private `request_id` only (no public task id).
- Active request behavior: Aborts child process. An active cancel emits exactly one terminal result event with status "cancelled", `final_text` `""`, and error `{ "code": "LARVA_PERSONA_INVOCATION_CANCELLED", "message": "..." }`. Late child success/failure after cancel is ignored.
- Terminal/unknown request behavior: Unknown or already-terminal cancel must not create a new result (does nothing, no duplicate result).
- Malformed cancel: Invalid cancel payload does not create a result for an unknown request. For an active malformed cancel `request_id`, there is no correlation target, so no result event is emitted.

## Invalid Event Handling (Malformed Requests/Cancels)

The `request_id` is the strict correlation invariant. `at-most-one-result` applies to any `request_id`.

| Event Type | Condition | Behavior / Emitted Result |
| --- | --- | --- |
| `request` | Absent, non-string, or non-canonical `request_id` | Rejected as `LARVA_PERSONA_INVOCATION_BAD_INPUT` (diagnostic/log only). **No result event emitted** (no valid correlation id). |
| `request` | Active `request_id` duplicate | Rejected as `LARVA_PERSONA_INVOCATION_BAD_INPUT` (diagnostic/log only). **No result event emitted** (original invocation keeps sole right to emit terminal result). |
| `request` | Valid inactive `request_id`, but other fields are BAD_INPUT (e.g. prompt, timeout, metadata) | Emits normal `failed` result event with that `request_id` and error code `LARVA_PERSONA_INVOCATION_BAD_INPUT`. |
| `cancel` | Absent, non-string, or non-canonical `request_id` | Rejected as diagnostic only. **No result event emitted.** |
| `cancel` | Valid `request_id`, but unknown or already-terminal | Ignored. **No result event emitted.** |
| `cancel` | Valid active `request_id`, but `reason` is missing/empty/non-string/overlong | Rejected as diagnostic only. **No result event emitted.** Active invocation continues unchanged. |
| `cancel` | Valid active `request_id` and valid `reason` | Active invocation is aborted. Emits a `cancelled` result event. |

## Result Payload
`larva:persona-invocation:result`
```json
{
  "request_id": "canonical-lowercase-uuid-v4",
  "status": "success|failed|cancelled",
  "persona_id": "resolved-persona-id",
  "final_text": "...",
  "error": null
}
```

- `request_id`: Always a canonical `request_id` from an accepted invocation or a valid `request_id` from a rejected pre-start request with non-correlation-field `BAD_INPUT`. Larva never synthesizes a `request_id` and never echoes an invalid/non-canonical `request_id`.
- `status`: One of `"success"`, `"failed"`, or `"cancelled"`.
- `persona_id`: Resolved id on success. On bad input or persona-not-found, uses the request `persona_id` when syntactically present, otherwise an empty string `""`.
- `final_text`: Max 16384 UTF-8 bytes. Non-empty string allowed only on success. Must be empty (`""`) for failed or cancelled statuses. If success output exceeds byte bounds: it becomes a failed result, `final_text` is empty, no artifact is created, no truncation occurs, and error is `LARVA_PERSONA_INVOCATION_PROTOCOL_FAILED` with a clear message.
- `error`: `null` on success. On failure or cancellation, an object: `{ "code": "LARVA_PERSONA_INVOCATION_...", "message": "..." }`.

## Terminal State Matrix

First terminal state wins. Only one result is emitted per request.

| Scenario | `status` | `final_text` | `error.code` |
| --- | --- | --- | --- |
| Normal completion | `"success"` | `"..."` | `null` |
| Valid `request_id` with malformed non-correlation request fields | `"failed"` | `""` | `LARVA_PERSONA_INVOCATION_BAD_INPUT` |
| Persona not in registry | `"failed"` | `""` | `LARVA_PERSONA_INVOCATION_PERSONA_NOT_FOUND` |
| Pi tool policy startup failure | `"failed"` | `""` | `LARVA_PERSONA_INVOCATION_POLICY_FAILED` |
| Mapped model not found/offline | `"failed"` | `""` | `LARVA_PERSONA_INVOCATION_MODEL_UNAVAILABLE` |
| Execution time exceeds `timeout_ms` | `"failed"` | `""` | `LARVA_PERSONA_INVOCATION_TIMEOUT` |
| Canceled via valid cancel payload | `"cancelled"` | `""` | `LARVA_PERSONA_INVOCATION_CANCELLED` |
| Child RPC crashes/over-limit output | `"failed"` | `""` | `LARVA_PERSONA_INVOCATION_PROTOCOL_FAILED` |
| Invoker internal runtime crash | `"failed"` | `""` | `LARVA_PERSONA_INVOCATION_INTERNAL_ERROR` |

## Examples

### Example: Success
```json
{
  "request_id": "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
  "status": "success",
  "persona_id": "python-senior",
  "final_text": "Here is the refactored code...",
  "error": null
}
```

### Example: Bad Input Failure
```json
{
  "request_id": "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
  "status": "failed",
  "persona_id": "",
  "final_text": "",
  "error": {
    "code": "LARVA_PERSONA_INVOCATION_BAD_INPUT",
    "message": "Prompt cannot be empty."
  }
}
```

### Example: Timeout Failure
```json
{
  "request_id": "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
  "status": "failed",
  "persona_id": "python-senior",
  "final_text": "",
  "error": {
    "code": "LARVA_PERSONA_INVOCATION_TIMEOUT",
    "message": "Invocation exceeded timeout of 120000 ms."
  }
}
```

### Example: Active Cancel
```json
{
  "request_id": "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
  "status": "cancelled",
  "persona_id": "python-senior",
  "final_text": "",
  "error": {
    "code": "LARVA_PERSONA_INVOCATION_CANCELLED",
    "message": "User initiated abort."
  }
}
```

## Lifecycle and Race Conditions
- First terminal state wins.
- At most one result event per `request_id`.
- Timeout, cancel, or stale state suppresses late success or failure.
- Lifecycle actions (shutdown, reload, new, resume, fork) cancel or render stale any active invocations and never send callbacks to the old context or parent LLM context. Lifecycle stale -> no result event; diagnostic code `LARVA_PERSONA_INVOCATION_STALE`.

Machine-check anchor ids for lifecycle stale suppression:

- `lifecycle_shutdown_stale_context_suppresses_result`
- `lifecycle_reload_stale_context_suppresses_result`
- `lifecycle_new_stale_context_suppresses_result`
- `lifecycle_resume_stale_context_suppresses_result`
- `lifecycle_fork_stale_context_suppresses_result`

## Error Codes
(See Terminal State Matrix above for how these are delivered inside the `error` object.)

Machine-check anchor ids for terminal error codes:

- `terminal_error_code_BAD_INPUT` -> `LARVA_PERSONA_INVOCATION_BAD_INPUT`
- `terminal_error_code_PERSONA_NOT_FOUND` -> `LARVA_PERSONA_INVOCATION_PERSONA_NOT_FOUND`
- `terminal_error_code_MODEL_UNAVAILABLE` -> `LARVA_PERSONA_INVOCATION_MODEL_UNAVAILABLE`
- `terminal_error_code_POLICY_FAILED` -> `LARVA_PERSONA_INVOCATION_POLICY_FAILED`
- `terminal_error_code_TIMEOUT` -> `LARVA_PERSONA_INVOCATION_TIMEOUT`
- `terminal_error_code_CANCELLED` -> `LARVA_PERSONA_INVOCATION_CANCELLED`
- `terminal_error_code_PROTOCOL_FAILED` -> `LARVA_PERSONA_INVOCATION_PROTOCOL_FAILED`
- `terminal_error_code_INTERNAL_ERROR` -> `LARVA_PERSONA_INVOCATION_INTERNAL_ERROR`

## Explicit Non-Goals
- Capability discovery
- Fallback/version negotiation
- Variant support
- Caller-selected cwd
- Tool override/tool_mode
- Schema enforcement
- Output artifacts (for oversized results)
- Queueing/scheduler handles
- Resume functionality
- Public task id allocation
- Status/events/wait/select orchestration (unlike async subagents)
- Console integration
- Model-facing tool wrapper (this means literally no model-facing tool is registered for this surface)
- Aileron-specific options/errors