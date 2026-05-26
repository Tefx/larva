"""Expected-red contract tests for the bundled Pi extension.

These tests intentionally pin the TypeScript extension contract before the
``contrib/pi-extension`` implementation exists.  They are source/harness-level
tests only: no production Pi extension code is implemented in this step.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"
PYPROJECT: Final = ROOT / "pyproject.toml"


REQUIREMENT_TRACEABILITY: Final[dict[int, tuple[str, ...]]] = {
    6: ("test_initial_persona_commit_is_before_user_visible_none_state",),
    7: ("test_persona_switch_commits_envelope_model_and_status",),
    8: ("test_no_active_persona_sets_none_status",),
    9: ("test_prompt_watermark_composes_replaces_and_never_dumps_catalogue",),
    10: ("test_no_argument_selector_is_interactive_only_and_mode_gated",),
    11: ("test_no_argument_non_interactive_returns_bad_input_without_state_change",),
    12: ("test_invalid_persona_switch_preserves_previous_envelope",),
    13: ("test_model_parse_first_slash_and_atomic_failure_preservation",),
    14: ("test_policy_baseline_resets_on_each_commit",),
    15: ("test_policy_validation_boundary_and_active_target_shape",),
    16: ("test_policy_filtering_ignores_unknown_tools_and_deny_wins",),
    17: ("test_set_active_tools_and_tool_call_denial_contract",),
    18: ("test_subagent_spawn_authority_false_or_omitted",),
    19: ("test_subagent_spawn_authority_allowlist",),
    20: ("test_subagent_without_active_parent_fails",),
    21: ("test_subagent_bad_input_public_result_contract",),
    22: ("test_child_session_root_default_override_and_invalid_override",),
    23: ("test_task_id_outside_child_root_is_bad_input",),
    24: ("test_subagent_success_result_contract",),
    25: ("test_subagent_failed_after_allocation_keeps_task_id",),
    26: ("test_child_process_uses_launcher_env_and_rpc_sequence",),
    27: ("test_no_sidecar_resume_contract",),
    28: ("test_resume_switches_session_appends_task_and_uses_new_output",),
    29: ("test_resume_path_taxonomy",),
    30: ("test_resume_busy_same_task_returns_session_busy",),
    31: ("test_resume_parent_preflight_defers_child_persona_initialization",),
    32: ("test_concurrent_same_task_resume_uses_in_memory_busy_set",),
    33: ("test_busy_state_is_process_local_without_lock_files",),
    34: ("test_resume_re_resolves_persona_in_new_child_process",),
    35: ("test_abort_contract",),
    36: ("test_nested_subagent_exposure_uses_child_authority_and_policy",),
    37: ("test_persona_resolve_bridge_uses_larva_cli_argv_json_and_fallback_rules",),
    38: ("test_persona_list_bridge_uses_larva_cli_argv_json_for_completion_and_selector",),
    39: ("test_child_stderr_startup_error_whitelist",),
    40: ("test_child_rpc_timeout_and_agent_end_wait_contract",),
    41: ("test_child_final_text_preserves_any_string_and_rejects_malformed_text",),
}


def _source() -> str:
    assert EXTENSION.exists(), (
        "expected-red: bundled Pi extension contract target is missing at "
        f"{EXTENSION.relative_to(ROOT)}"
    )
    return EXTENSION.read_text(encoding="utf-8")


def _assert_tokens(source: str, *tokens: str) -> None:
    missing = [token for token in tokens if token not in source]
    assert not missing, "missing Pi extension contract tokens: " + ", ".join(missing)


def _assert_regex(source: str, pattern: str, message: str) -> None:
    assert re.search(pattern, source, re.DOTALL), message


def test_requirement_traceability_covers_verification_targets_6_through_41() -> None:
    """The expected-red harness maps every owned design target to a test."""
    assert sorted(REQUIREMENT_TRACEABILITY) == list(range(6, 42))


def test_pi_extension_packaged_path_force_includes_source_extension() -> None:
    """Wheel packaging must include the bundled Pi extension runtime path."""
    pyproject = PYPROJECT.read_text(encoding="utf-8")

    assert (
        '"contrib/pi-extension/larva.ts" = "larva/shell/pi_extension/larva.ts"'
        in pyproject
    )


def test_initial_persona_commit_is_before_user_visible_none_state() -> None:
    source = _source()
    _assert_tokens(
        source,
        "LARVA_PI_INITIAL_PERSONA_ID",
        "initializeExtension",
        "commitPersona",
        "LARVA_POLICY_INVALID",
        "LARVA_TOOL_ENUMERATION_FAILED",
        "LARVA_MODEL_UNAVAILABLE",
    )
    _assert_regex(
        source,
        r"LARVA_PI_INITIAL_PERSONA_ID[\s\S]+commitPersona[\s\S]+setStatus",
        "initial persona must be committed before any user-visible status/selector path",
    )


def test_persona_switch_commits_envelope_model_and_status() -> None:
    source = _source()
    _assert_tokens(
        source,
        "PersonaEnvelope",
        "persona_id",
        "spec_digest",
        "modelRegistry.find",
        "setModel",
        "ctx.ui.setStatus",
        "larva:",
    )


def test_no_active_persona_sets_none_status() -> None:
    _assert_tokens(_source(), "larva: none", "ctx.ui.setStatus")


def test_prompt_watermark_composes_replaces_and_never_dumps_catalogue() -> None:
    source = _source()
    _assert_tokens(
        source,
        "before_agent_start",
        "systemPrompt",
        "<!-- larva-spec:",
        "Use Larva MCP or the larva CLI",
    )
    _assert_regex(
        source,
        r"replaceLarvaWatermark|LARVA_WATERMARK_RE|previous Larva watermark",
        "prompt watermark must be replaced, not duplicated",
    )
    assert "subagent catalogue" not in source.lower()
    assert "list --json" not in re.search(
        r"before_agent_start[\s\S]{0,2000}", source
    ).group(0), "prompt hook must not dump the persona catalogue"


def test_no_argument_selector_is_interactive_only_and_mode_gated() -> None:
    source = _source()
    _assert_tokens(
        source,
        "LARVA_PI_INTERACTIVE_TUI",
        "openPersonaSelector",
        "completePersonaIds",
        "LARVA_BAD_INPUT",
    )


def test_no_argument_non_interactive_returns_bad_input_without_state_change() -> None:
    source = _source()
    _assert_tokens(source, "LARVA_PI_INTERACTIVE_TUI", "ok: false", "LARVA_BAD_INPUT")
    _assert_regex(
        source,
        r"LARVA_PI_INTERACTIVE_TUI[\s\S]+preserve|previousEnvelope|rollback",
        "non-interactive no-argument command must leave active state unchanged",
    )


def test_invalid_persona_switch_preserves_previous_envelope() -> None:
    source = _source()
    _assert_tokens(source, "LARVA_PERSONA_NOT_FOUND", "previousEnvelope", "ok: false")


def test_model_parse_first_slash_and_atomic_failure_preservation() -> None:
    source = _source()
    _assert_tokens(source, "parseModel", "indexOf(\"/\")", "modelRegistry.find", "setModel")
    _assert_regex(
        source,
        r"openrouter/google/gemini|provider[\s\S]+modelId",
        "model parser must split only at the first slash",
    )
    _assert_tokens(source, "LARVA_MODEL_UNAVAILABLE", "previousEnvelope")


def test_policy_baseline_resets_on_each_commit() -> None:
    source = _source()
    _assert_tokens(source, "getAllTools", "baseline", "setActiveTools")
    assert "carry over" in source or "previousActiveTools" not in source


def test_policy_validation_boundary_and_active_target_shape() -> None:
    source = _source()
    _assert_tokens(source, "LARVA_PI_TOOL_POLICY_FILE", "personas", "LARVA_POLICY_INVALID")
    _assert_tokens(source, "allow", "deny")
    assert "ask" not in source


def test_policy_filtering_ignores_unknown_tools_and_deny_wins() -> None:
    source = _source()
    _assert_tokens(source, "filterPolicyTools", "deny", "allow", "getAllTools")
    _assert_regex(source, r"deny[\s\S]+wins|denyWins|denied\.has", "deny must win over allow")


def test_set_active_tools_and_tool_call_denial_contract() -> None:
    source = _source()
    _assert_tokens(source, "setActiveTools", "tool_call", "ToolPolicyDecision", "LARVA_TOOL_DENIED")
    _assert_regex(
        source,
        r"larva_subagent[\s\S]+LARVA_TOOL_DENIED[\s\S]+handler|handler[\s\S]+larva_subagent[\s\S]+LARVA_TOOL_DENIED",
        "denied larva_subagent must be stopped by generic tool policy before handler result",
    )


def test_subagent_spawn_authority_false_or_omitted() -> None:
    _assert_tokens(_source(), "can_spawn", "LARVA_SPAWN_NOT_ALLOWED")


def test_subagent_spawn_authority_allowlist() -> None:
    source = _source()
    _assert_tokens(source, "can_spawn", "includes", "LARVA_SPAWN_NOT_ALLOWED")


def test_subagent_without_active_parent_fails() -> None:
    _assert_tokens(_source(), "LARVA_NO_ACTIVE_PERSONA", "activeParent")


def test_subagent_bad_input_public_result_contract() -> None:
    source = _source()
    _assert_tokens(source, "LarvaSubagentResult", "LARVA_BAD_INPUT", "task_id: null")
    _assert_tokens(source, "persona_id", "result_text", "status: \"failed\"")


def test_child_session_root_default_override_and_invalid_override() -> None:
    _assert_tokens(
        _source(),
        "LARVA_PI_CHILD_SESSION_DIR",
        ".pi/larva/child-sessions",
        "LARVA_CHILD_START_FAILED",
    )


def test_task_id_outside_child_root_is_bad_input() -> None:
    _assert_tokens(_source(), "realpath", "LARVA_BAD_INPUT", "childSessionRoot")


def test_subagent_success_result_contract() -> None:
    _assert_tokens(
        _source(), "status: \"success\"", "result_text", "error: null", "task_id"
    )


def test_subagent_failed_after_allocation_keeps_task_id() -> None:
    _assert_tokens(_source(), "status: \"failed\"", "error", "task_id")


def test_child_process_uses_launcher_env_and_rpc_sequence() -> None:
    source = _source()
    _assert_tokens(
        source,
        "LARVA_PI_REAL_BIN",
        "LARVA_PI_EXTENSION_FLAG",
        "LARVA_PI_EXTENSION_ENTRY",
        "--mode",
        "rpc",
        "get_state",
        "prompt",
        "agent_end",
        "get_last_assistant_text",
    )
    assert "bare pi" not in source.lower()


def test_no_sidecar_resume_contract() -> None:
    source = _source()
    assert "sidecar" not in source.lower()
    _assert_tokens(source, "task_id", ".jsonl", "persona_id")


def test_resume_switches_session_appends_task_and_uses_new_output() -> None:
    source = _source()
    _assert_tokens(source, "switch_session", "prompt", "get_last_assistant_text")
    _assert_regex(
        source,
        r"switch_session[\s\S]+prompt[\s\S]+get_last_assistant_text",
        "resume must switch session, append new task, then read new final text",
    )


def test_resume_path_taxonomy() -> None:
    source = _source()
    _assert_tokens(
        source,
        "LARVA_BAD_INPUT",
        "LARVA_SESSION_INVALID",
        "LARVA_SESSION_NOT_FOUND",
        ".jsonl",
        "realpath",
    )


def test_resume_busy_same_task_returns_session_busy() -> None:
    _assert_tokens(_source(), "activeTaskIds", "LARVA_SESSION_BUSY")


def test_resume_parent_preflight_defers_child_persona_initialization() -> None:
    source = _source()
    _assert_tokens(source, "switch_session", "LARVA_PI_INITIAL_PERSONA_ID")
    _assert_regex(
        source,
        r"validateTaskId[\s\S]+canSpawn[\s\S]+activeTaskIds",
        "parent resume preflight should validate path, spawn authority, and busy state only",
    )


def test_concurrent_same_task_resume_uses_in_memory_busy_set() -> None:
    _assert_tokens(_source(), "Set<string>", "activeTaskIds", "finally")


def test_busy_state_is_process_local_without_lock_files() -> None:
    source = _source()
    _assert_tokens(source, "activeTaskIds")
    assert "lockfile" not in source.lower()
    assert ".lock" not in source


def test_resume_re_resolves_persona_in_new_child_process() -> None:
    source = _source()
    _assert_tokens(source, "resolvePersona", "LARVA_PI_INITIAL_PERSONA_ID", "switch_session")
    _assert_regex(
        source,
        r"resolvePersona[\s\S]+switch_session|switch_session[\s\S]+resolvePersona",
        "resume must re-resolve the supplied persona in a new child process",
    )


def test_abort_contract() -> None:
    _assert_tokens(_source(), "abort", "LARVA_CHILD_CANCELLED", "kill", "cancelled")


def test_nested_subagent_exposure_uses_child_authority_and_policy() -> None:
    source = _source()
    _assert_tokens(source, "larva_subagent", "can_spawn", "LARVA_PI_PARENT_PERSONA_ID")


def test_persona_resolve_bridge_uses_larva_cli_argv_json_and_fallback_rules() -> None:
    source = _source()
    _assert_tokens(
        source,
        "LARVA_CLI_ARGV_JSON",
        "resolve",
        "--json",
        "LARVA_PERSONA_NOT_FOUND",
        "uvx",
        "larva",
    )
    _assert_regex(
        source,
        r"LARVA_CLI_ARGV_JSON[\s\S]+resolve[\s\S]+--json",
        "resolve bridge must append suffix to launcher-provided argv prefix",
    )
    _assert_regex(source, r"timeout|AbortSignal|setTimeout", "bridge must time out")
    _assert_regex(source, r"JSON\.parse[\s\S]+LARVA_PERSONA_NOT_FOUND", "malformed output maps to persona-not-found")


def test_persona_list_bridge_uses_larva_cli_argv_json_for_completion_and_selector() -> None:
    source = _source()
    _assert_tokens(source, "LARVA_CLI_ARGV_JSON", "list", "--json", "completePersonaIds")
    _assert_regex(
        source,
        r"data\[\]\.id|item\.id|persona\.id",
        "list bridge must require only data[].id for suggestions",
    )


def test_child_stderr_startup_error_whitelist() -> None:
    source = _source()
    for code in (
        "LARVA_PERSONA_NOT_FOUND",
        "LARVA_MODEL_UNAVAILABLE",
        "LARVA_POLICY_INVALID",
        "LARVA_TOOL_ENUMERATION_FAILED",
        "LARVA_CHILD_START_FAILED",
    ):
        _assert_tokens(source, code)
    _assert_regex(source, r"larva pi: <ERROR_CODE>|larva pi:", "stderr parser shape is required")


def test_child_rpc_timeout_and_agent_end_wait_contract() -> None:
    source = _source()
    _assert_tokens(source, "get_state", "switch_session", "prompt", "get_last_assistant_text")
    _assert_regex(source, r"10_000|10000|ten seconds", "RPC commands must time out after ten seconds")
    _assert_regex(source, r"agent_end[\s\S]+unbounded|waitForAgentEnd", "agent_end wait must not use adapter timeout")


def test_child_final_text_preserves_any_string_and_rejects_malformed_text() -> None:
    source = _source()
    _assert_tokens(source, "get_last_assistant_text", "data.text", "LARVA_CHILD_PROTOCOL_FAILED")
    _assert_regex(source, r"typeof\s+[^\n]+text\s*===\s*[\"']string", "final text must be accepted when it is any string")


def test_fake_contract_scenarios_are_documented_for_future_runtime_harness() -> None:
    """Keep fake Pi/RPC scenario names visible until the TS harness lands."""
    scenarios = {
        "bridge_env": ["LARVA_CLI_ARGV_JSON", "resolve <id> --json", "list --json"],
        "policy_denial": ["tool_call", "ToolPolicyDecision", "no LarvaSubagentResult"],
        "resume": ["switch_session", "prompt", "re-resolve persona"],
        "abort": ["abort", "LARVA_CHILD_CANCELLED"],
    }

    assert json.loads(json.dumps(scenarios)) == scenarios
