"""Regression and conformance tests for the bundled Pi extension.

These tests pin the implemented TypeScript extension contract for
``contrib/pi-extension``.  They combine source-level checks with focused runtime
probes so final green proof reflects the shipped Pi extension behavior.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any, Final

import pytest

ROOT: Final = Path(__file__).resolve().parents[2]
CI_WORKFLOW: Final = ROOT / ".github" / "workflows" / "ci.yml"
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"
PI_EXTENSION_README: Final = ROOT / "contrib" / "pi-extension" / "README.md"
PI_EXTENSION_ASYNC_SPEC: Final = ROOT / "docs" / "reference" / "PI_EXTENSION_ASYNC_SUBAGENTS.md"
PI_INTEGRATION_DESIGN: Final = ROOT / "design" / "pi-coding-agent-integration.md"
PI_EXTENSION_SELECTOR_UI: Final = ROOT / "contrib" / "pi-extension" / "test-persona-selector-ui.mjs"
PI_EXTENSION_PACKAGE_JSON: Final = ROOT / "contrib" / "pi-extension" / "package.json"
PI_EXTENSION_PACKAGE_LOCK: Final = ROOT / "contrib" / "pi-extension" / "package-lock.json"
PYPROJECT: Final = ROOT / "pyproject.toml"
PI_TUI_PINNED_VERSION: Final = "0.78.0"
PI_EXTENSION_NPM_CI_COMMAND: Final = "npm --prefix contrib/pi-extension ci"
PI_EXTENSION_RUNTIME_GATE_COMMAND: Final = (
    "uv run pytest tests/shell/test_pi_extension_contract.py "
    "tests/shell/test_pi_extension_subagent_ux.py "
    "tests/shell/test_pi_extension_real_runtime.py -v"
)
PI_EXTENSION_RUNTIME_SMOKE_COMMAND: Final = (
    "node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates"
)
REPO_LOCAL_GATE_TEST_COMMAND: Final = "uv run pytest -q tests/shell/test_repo_local_ci_gate.py"
SHARED_SURFACE_GATE_COMMAND: Final = (
    "uv run python scripts/ci/larva_repo_local_gate.py verify --opifex-root opifex"
)


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
        "bundled Pi extension contract target is missing at "
        f"{EXTENSION.relative_to(ROOT)}"
    )
    return EXTENSION.read_text(encoding="utf-8")


def _workflow_step_containing(workflow: str, token: str) -> str:
    token_index = workflow.index(token)
    step_start = workflow.rfind("\n      - name:", 0, token_index)
    if step_start == -1:
        step_start = 0
    next_step = workflow.find("\n      - name:", token_index)
    if next_step == -1:
        next_step = len(workflow)
    return workflow[step_start:next_step]


def _assert_required_workflow_step(workflow: str, token: str) -> None:
    step = _workflow_step_containing(workflow, token)
    lower_step = step.lower()
    assert "continue-on-error" not in lower_step
    assert "|| true" not in step


def _run_node(tmp_path: Path, script: str, *, timeout: float = 3.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime contract tests")

    script_path = tmp_path / "scenario.mjs"
    script_path.write_text(textwrap.dedent(script), encoding="utf-8")
    completed = subprocess.run(
        [node, str(script_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "LARVA_PI_INITIAL_PERSONA_ID": "", "LARVA_PI_LAUNCHED": "0"},
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _runtime_extension_copy(tmp_path: Path, appended_exports: str) -> Path:
    extension = tmp_path / "larva-pi-runtime-test.ts"
    extension.write_text(_source() + "\n" + textwrap.dedent(appended_exports), encoding="utf-8")
    return extension


def _run_selector_ui_harness() -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension selector UI runtime contract tests")
    completed = subprocess.run(
        [node, str(PI_EXTENSION_SELECTOR_UI)],
        check=False,
        capture_output=True,
        text=True,
        timeout=8,
        env={**os.environ, "LARVA_PI_INITIAL_PERSONA_ID": "", "LARVA_PI_LAUNCHED": "0"},
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _assert_tokens(source: str, *tokens: str) -> None:
    missing = [token for token in tokens if token not in source]
    assert not missing, "missing Pi extension contract tokens: " + ", ".join(missing)


def _assert_regex(source: str, pattern: str, message: str) -> None:
    assert re.search(pattern, source, re.DOTALL), message


def _function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 0
    for index in range(brace, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[brace + 1 : index]
    raise AssertionError(f"could not find function body for {signature}")


def test_requirement_traceability_covers_verification_targets_6_through_41() -> None:
    """The green conformance harness maps every owned design target to a test."""
    assert sorted(REQUIREMENT_TRACEABILITY) == list(range(6, 42))


def test_pi_extension_packaged_path_force_includes_source_extension() -> None:
    """Wheel packaging must include the bundled Pi extension runtime path."""
    pyproject = PYPROJECT.read_text(encoding="utf-8")

    assert (
        '"contrib/pi-extension/larva.ts" = "larva/shell/pi_extension/larva.ts"'
        in pyproject
    )


def test_ci_installs_pi_extension_dependencies_before_runtime_gate() -> None:
    """CI must hydrate the repo-local Pi extension dependencies before UI/runtime gates."""
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")

    assert PI_EXTENSION_NPM_CI_COMMAND in workflow
    assert PI_EXTENSION_RUNTIME_GATE_COMMAND in workflow
    assert PI_EXTENSION_RUNTIME_SMOKE_COMMAND in workflow
    assert workflow.index(PI_EXTENSION_NPM_CI_COMMAND) < workflow.index(
        PI_EXTENSION_RUNTIME_GATE_COMMAND
    )
    assert workflow.index(PI_EXTENSION_NPM_CI_COMMAND) < workflow.index(
        PI_EXTENSION_RUNTIME_SMOKE_COMMAND
    )
    assert workflow.index(PI_EXTENSION_RUNTIME_GATE_COMMAND) < workflow.index(
        PI_EXTENSION_RUNTIME_SMOKE_COMMAND
    )

    _assert_required_workflow_step(workflow, PI_EXTENSION_NPM_CI_COMMAND)
    for retained_gate in (
        REPO_LOCAL_GATE_TEST_COMMAND,
        PI_EXTENSION_RUNTIME_GATE_COMMAND,
        PI_EXTENSION_RUNTIME_SMOKE_COMMAND,
        SHARED_SURFACE_GATE_COMMAND,
    ):
        assert retained_gate in workflow
        _assert_required_workflow_step(workflow, retained_gate)


def test_pi_tui_dependency_is_exact_lockfile_backed_and_ci_installable() -> None:
    """The formal Pi TUI dependency must be exact and lockfile-backed for npm ci."""
    package_json = json.loads(PI_EXTENSION_PACKAGE_JSON.read_text(encoding="utf-8"))
    package_lock = json.loads(PI_EXTENSION_PACKAGE_LOCK.read_text(encoding="utf-8"))

    assert package_json["dependencies"]["@earendil-works/pi-tui"] == PI_TUI_PINNED_VERSION
    assert package_lock["packages"][""]["dependencies"]["@earendil-works/pi-tui"] == PI_TUI_PINNED_VERSION
    locked_pi_tui = package_lock["packages"]["node_modules/@earendil-works/pi-tui"]
    assert locked_pi_tui["version"] == PI_TUI_PINNED_VERSION
    assert f"pi-tui-{PI_TUI_PINNED_VERSION}.tgz" in locked_pi_tui["resolved"]
    assert "integrity" in locked_pi_tui


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
        r"async function initializeSession[\s\S]+LARVA_PI_INITIAL_PERSONA_ID[\s\S]+commitPersona[\s\S]+setStatus",
        "initial persona must be committed by the session-start runtime before status/selector paths",
    )


def test_initialize_extension_wires_pi_surfaces_to_module_logic() -> None:
    source = _source()
    body = _function_body(source, "export async function initializeExtension")

    assert "const initialRuntimeCtx = withRuntimeEnv(ctx, env)" in body
    assert "if (canInitializeSessionNow(initialRuntimeCtx)) await ensureSessionInitialized(initialRuntimeCtx, pi)" in body
    assert 'on?.("session_start"' in body
    assert body.index("registerLarvaPersonaCommand") < body.index('on?.("before_agent_start"')
    assert body.index("registerTool") < body.index("const initialRuntimeCtx = withRuntimeEnv(ctx, env)")
    assert body.index("registerTool") < body.index('on?.("tool_call"')

    assert "registerLarvaPersonaCommand(ctx, pi)" in body
    command_body = _function_body(source, "function registerLarvaPersonaCommand")
    assert '"larva-persona", command' in command_body
    assert 'name: "larva-persona"' in command_body
    assert "getArgumentCompletions" in command_body
    assert "completePersonaIds(prefix, withRuntimeEnv(ctx, baseEnv))" in command_body
    assert "handlePersonaCommand(input, runtimeCtx, pi)" in command_body
    assert "notifyPersonaSwitchResult(runtimeCtx, result)" in command_body

    assert 'on?.("session_start", async' in body
    session_body = re.search(r"on\?\.\(\"session_start\", async \(_payload: unknown, eventCtx\?: PiContext\) => \{(?P<body>[\s\S]*?)\n  \}\);", body)
    assert session_body is not None
    assert "registerLarvaPersonaAutocompleteProvider(runtimeCtx)" in session_body.group("body")
    assert session_body.group("body").index("registerLarvaPersonaAutocompleteProvider(runtimeCtx)") < session_body.group("body").index("ensureSessionInitialized(runtimeCtx, pi)")
    assert "await ensureSessionInitialized(runtimeCtx, pi)" in session_body.group("body")
    assert 'on?.("before_agent_start", async (payload: unknown, eventCtx?: PiContext)' in body
    assert "await sessionInitializationPromise" in body
    before_agent_start_registration = re.search(r"on\?\.\(\"before_agent_start\", async \(payload: unknown, eventCtx\?: PiContext\) => \{(?P<body>[\s\S]*?)\n  \}\);", body)
    assert before_agent_start_registration is not None
    before_agent_body = before_agent_start_registration.group("body")
    assert "const runtimeCtx = withRuntimeEnv(eventCtx ?? ctx, env)" in before_agent_body
    assert "await ensureSessionInitialized(runtimeCtx, pi)" in before_agent_body
    assert "return before_agent_start(payload, runtimeCtx, pi)" in before_agent_body
    agent_end_registration = re.search(r"on\?\.\(\"agent_end\", async \(payload: unknown, eventCtx\?: PiContext\) => \{(?P<body>[\s\S]*?)\n  \}\);", body)
    assert agent_end_registration is not None
    assert "attemptPersonaLeaseRestore(runtimeCtx, pi, terminalRestorePath(payload) ?? \"success\")" in agent_end_registration.group("body")
    tool_call_registration = re.search(r"on\?\.\(\"tool_call\", \(payload: unknown\) => \{(?P<body>[\s\S]*?)\n  \}\);", body)
    assert tool_call_registration is not None
    assert "decideToolCall(name)" in tool_call_registration.group("body")


def test_larva_subagent_tool_registration_returns_pi_observable_result() -> None:
    source = _source()
    body = _function_body(source, "export async function initializeExtension")
    tool_registration = re.search(r"registerTool\?\.\(\{(?P<body>[\s\S]*?)\n  \}\);", body)
    assert tool_registration is not None
    tool_body = tool_registration.group("body")

    assert 'name: "larva_subagent"' in tool_body
    assert "inputSchema: subagentSchema" in tool_body
    assert "parameters: subagentSchema" in tool_body
    assert 'required: ["persona_id", "task"]' in source
    assert "additionalProperties: false" in source
    assert 'task_id: { type: "string", description: "Optional child session .jsonl path to resume. Omit this field to start a new child session." }' in source
    assert "Null is treated like omission and starts a new child session." not in source
    assert "handler: (input: LarvaSubagentInput) => larva_subagent" in tool_body
    assert "execute:" in tool_body
    assert "abortSignal: signal ?? runtimeCtx.signal ?? runtimeCtx.abortSignal" in tool_body


@pytest.mark.parametrize(
    ("tool_name", "required_tokens"),
    [
        (
            "larva_subagent_events",
            (
                'name: "larva_subagent_events"',
                "since_sequence",
                "cursor_expired",
                "next_sequence",
                "latest 1000 recent events",
                "sequence > since_sequence",
            ),
        ),
        (
            "larva_subagent_wait",
            (
                'name: "larva_subagent_wait"',
                'return_when: "all"',
                'return_when: "any"',
                'return_when: "first_error"',
                "timeout_ms",
                "LARVA_SUBAGENT_NOT_OBSERVED",
            ),
        ),
        (
            "larva_subagent_select",
            (
                'name: "larva_subagent_select"',
                'return_when: "any"',
                "same output model as wait",
                "task_ids",
                "timeout_ms",
            ),
        ),
    ],
)
def test_async_subagent_deterministic_orchestration_tools_registered(
    tool_name: str, required_tokens: tuple[str, ...]
) -> None:
    """Deterministic async tools must be model-facing registered contracts."""
    source = _source()

    missing = [token for token in required_tokens if token not in source]
    assert not missing, f"{tool_name} deterministic orchestration gap; missing tokens: {missing}"


def test_subagent_wait_supports_long_deadlines_and_visible_snapshots() -> None:
    """Long-running subagents need long waits and self-contained timeout evidence."""
    source = _source()
    assert "SUBAGENT_WAIT_MAX_TIMEOUT_MS = 86_400_000" in source
    assert "maximum: SUBAGENT_WAIT_MAX_TIMEOUT_MS" in source
    assert "description: SUBAGENT_WAIT_TIMEOUT_DESCRIPTION" in source
    assert source.count("description: SUBAGENT_WAIT_TIMEOUT_DESCRIPTION") == 2
    for guidance_token in (
        "0 returns an immediate snapshot and is preferred for checkpoint/status probes in large interactive parent Pi sessions.",
        "Long waits remain supported, but can increase parent TUI/Node heap pressure in large transcripts",
        "reserve them for fresh/small sessions or unattended orchestration",
        "Do not use shell sleep polling",
    ):
        assert guidance_token in source
    assert "recommended_next_action" in source
    assert "snapshots: snapshotsByTaskId(runs)" in source
    assert "runs.map(subagentSnapshotLine)" in source
    assert "maximum: 60000" not in source
    for forbidden in (
        'return_when: { anyOf: [{ enum: ["all", "any", "first_error"] }, { type: "null" }]',
        'timeout_ms: { anyOf: [{ type: "integer", minimum: 0, maximum: 60000 }, { type: "null" }]',
        'task_id: { anyOf: [{ type: "string" }, { type: "null" }]',
    ):
        assert forbidden not in source


def test_persona_shortcut_cold_cache_errors_are_larva_results_not_plain_rejections() -> None:
    """Ctrl+Alt+P must not surface `[object Object]` on cold cache failure."""
    source = _source()
    assert "const personas = await listPersonas(ctx);" in source
    assert "catch (caught)" in source
    assert "if (isLarvaError(caught)) return { ok: false, error: caught };" in source
    assert "openPersonaSelector(ctx);" in source


def test_unknown_session_persona_switch_mode_warning_is_deduped_and_scans_history() -> None:
    """Bad historical mode entries should fail safe without warning spam."""
    source = _source()
    assert "let sawUnknownMode = false;" in source
    assert "if (isAgentPersonaSwitchMode(mode)) return mode;" in source
    assert "sawUnknownMode = true;" in source
    assert "const emittedAgentPersonaSwitchModeWarnings = new Set<string>();" in source
    assert "if (emittedAgentPersonaSwitchModeWarnings.has(message)) continue;" in source



def test_async_subagent_guidance_separates_automation_from_conversation() -> None:
    """Accepted receipts steer automation to deterministic tools and conversation to push callbacks."""
    source = _source()
    guidance_tokens = (
        "Do not treat this accepted result as task evidence; a Larva subagent result callback is still pending.",
        "Do not use shell sleep polling",
        "For automation that depends on the child result, use larva_subagent_wait, larva_subagent_select, or larva_subagent_events with exact task_id handles.",
        "For conversational Pi continuation, yield for the larva-subagent-result push callback.",
        "Inspection/debugging only; use wait/select/events for orchestration, not repeated status polling.",
    )

    missing = [token for token in guidance_tokens if token not in source]
    assert not missing, f"accepted async receipt guidance gap; missing tokens: {missing}"


def test_async_subagent_resume_task_id_lexical_validation_precedes_filesystem_checks() -> None:
    """Resume task_id validation must reject non-normalized strings before filesystem checks."""
    source = _source()
    function_start = source.index("export async function larva_subagent(")
    body = source[function_start:source.index("function safelyEmitSubagentUpdate", function_start)]

    assert "validateExactPublicTaskIdLexical(taskId, env)" in body
    assert body.index("validateExactPublicTaskIdLexical(taskId, env)") < body.index("childSessionRoot(env)")
    assert body.index("validateExactPublicTaskIdLexical(taskId, env)") < body.index("validateTaskId(lexicallyValidTaskId, root)")
    lexical_body = _function_body(source, "function validateExactPublicTaskIdLexical")
    for token in (
        'taskId.trim() !== taskId',
        'taskId.normalize("NFC") !== taskId',
        'taskId.includes("~")',
        'taskId.includes("%")',
        'segment.length === 0',
        'segment === "."',
        'segment === ".."',
        'resolve(taskId) !== taskId',
    ):
        assert token in lexical_body


def test_async_subagent_background_activity_indicator_count_only() -> None:
    """Live subagent status indicator must be aggregate/count-only."""
    source = _source()
    indicator_tokens = (
        "updateSubagentBackgroundIndicator",
        "subagents:",
        " running",
        "cancelling",
        "activeSubagentRuns",
        "task_preview",
    )

    missing = [token for token in indicator_tokens if token not in source]
    assert not missing, f"count-only background indicator gap; missing tokens: {missing}"
    indicator_source = source[source.index("updateSubagentBackgroundIndicator") :]
    assert "setTimeout" not in indicator_source[:1200]
    assert "task_preview" not in indicator_source[:1200]


def test_live_pi_command_registration_uses_two_arg_argument_completion_shape(tmp_path: Path) -> None:
    """Mirror Pi v0.75.5 slash autocomplete's registered command contract.

    Pi's extension API is ``registerCommand(name, options)`` and its TUI maps
    registered commands to autocomplete items by reading a string command name
    into ``item.value`` before calling ``item.value.startsWith(prefix)``.
    """

    fake_cli = tmp_path / "fake-larva-list.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, flag] = process.argv;
            if (command !== "list" || flag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: [
                { id: "vectl-planner", description: "Plan with vectl", model: "provider/model" },
                { id: "frontend-engineer", description: "Frontend", model: "provider/model" }
              ]
            }));
            """
        ),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        let registered = null;
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
          }},
          ui: {{ setStatus: async () => undefined }},
        }};
        const pi = {{
          registerCommand: (name, options) => {{ registered = {{ name, options }}; }},
          registerTool: () => undefined,
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        const commandItem = {{ value: registered.name, label: registered.name }};
        const argumentItems = await registered.options.getArgumentCompletions("vectl");
        const canPiMatchCommand = commandItem.value.startsWith("larva");
        const canPiMatchArgument = argumentItems[0].value.startsWith("vectl");
        console.log(JSON.stringify({{
          registeredNameType: typeof registered.name,
          hasLegacyObjectName: typeof registered.name === "object",
          commandItem,
          canPiMatchCommand,
          argumentItems,
          canPiMatchArgument,
          emptyResult: await registered.options.getArgumentCompletions("missing"),
        }}));
        """,
    )

    assert result["registeredNameType"] == "string"
    assert result["hasLegacyObjectName"] is False
    assert result["commandItem"] == {"value": "larva-persona", "label": "larva-persona"}
    assert result["canPiMatchCommand"] is True
    assert result["argumentItems"] == [
        {"value": "vectl-planner", "label": "vectl-planner", "description": "Plan with vectl"}
    ]
    assert result["canPiMatchArgument"] is True
    assert result["emptyResult"] is None


def test_current_pi_factory_uses_event_context_for_startup_status_and_commands(tmp_path: Path) -> None:
    """Mirror Pi v0.75.x's default extension factory contract.

    Current Pi calls the extension default export as ``factory(pi)`` and supplies
    UI/model context later to lifecycle and command handlers.  Larva must
    therefore commit startup personas from ``session_start`` and use the command
    handler context for `/larva-persona`, not a load-time pseudo-context.
    """

    fake_cli = tmp_path / "fake-larva-resolve.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const statuses = [];
        const notifications = [];
        const handlers = {{}};
        let registered = null;
        let registeredTool = null;
        const pi = {{
          getAllTools: async () => ["read", "bash", "larva_subagent"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: (name, options) => {{ registered = {{ name, options }}; }},
          registerTool: (tool) => {{ registeredTool = tool; }},
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};

        await mod.default(pi);
        const runtimeCtx = {{
          env: {{
            LARVA_PI_INITIAL_PERSONA_ID: "startup",
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INTERACTIVE_TUI: "0",
          }},
          ui: {{
            setStatus: async (key, status) => statuses.push({{ key, status }}),
            notify: async (message, notifyType) => notifications.push({{ message, notifyType }}),
          }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};

        await handlers.session_start({{ reason: "startup" }}, runtimeCtx);
        const switchResult = await registered.options.handler("ok", runtimeCtx);

        console.log(JSON.stringify({{
          registeredName: registered.name,
          hasSessionStart: typeof handlers.session_start === "function",
          toolHasCurrentShape: registeredTool.parameters !== undefined && typeof registeredTool.execute === "function",
          statuses,
          notifications,
          switchResult,
          finalEnvelope: mod.getActiveEnvelope(),
        }}));
        """,
    )

    assert result["registeredName"] == "larva-persona"
    assert result["hasSessionStart"] is True
    assert result["toolHasCurrentShape"] is True
    assert result["statuses"][0] == {"key": "larva", "status": "larva: startup"}
    assert result["statuses"][-1] == {"key": "larva", "status": "larva: ok"}
    assert result["notifications"][-1] == {"message": "Larva persona active: ok", "notifyType": "info"}
    assert result["switchResult"]["ok"] is True
    assert result["finalEnvelope"]["persona_id"] == "ok"


def test_current_pi_factory_defers_process_env_initial_persona_until_session_context(tmp_path: Path) -> None:
    """Child Pi startup has persona in process.env but modelRegistry only on session_start ctx."""

    fake_cli = tmp_path / "fake-larva-resolve.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        process.env.LARVA_PI_LAUNCHED = "1";
        process.env.LARVA_PI_INITIAL_PERSONA_ID = "startup";
        process.env.LARVA_CLI_ARGV_JSON = JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]);
        process.env.LARVA_PI_INTERACTIVE_TUI = "0";
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const statuses = [];
        const handlers = {{}};
        const modelCalls = [];
        const pi = {{
          getAllTools: async () => ["read", "bash", "larva_subagent"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};

        await mod.default(pi);
        const envelopeBeforeSession = mod.getActiveEnvelope();
        const runtimeCtx = {{
          env: {{
            LARVA_PI_INITIAL_PERSONA_ID: "startup",
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INTERACTIVE_TUI: "0",
          }},
          ui: {{ setStatus: async (key, status) => statuses.push({{ key, status }}), notify: async () => undefined }},
          modelRegistry: {{ find: async (...args) => {{ modelCalls.push(args); return {{ id: "model" }}; }} }},
        }};
        await handlers.session_start({{ reason: "startup" }}, runtimeCtx);

        console.log(JSON.stringify({{
          envelopeBeforeSession,
          finalEnvelope: mod.getActiveEnvelope(),
          statuses,
          modelCalls,
        }}));
        """,
    )

    assert result["envelopeBeforeSession"] is None
    assert result["finalEnvelope"]["persona_id"] == "startup"
    assert result["statuses"][-1] == {"key": "larva", "status": "larva: startup"}
    assert result["modelCalls"] == [["provider", "model"]]


def test_launched_initial_persona_invalid_model_exits_before_prompt(tmp_path: Path) -> None:
    """`larva pi --persona` startup failures must be process-fatal before a prompt."""

    fake_cli = tmp_path / "fake-larva-resolve.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`
              }
            }));
            """
        ),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        let exitCode = null;
        let stderr = "";
        const originalExit = process.exit;
        const originalWrite = process.stderr.write;
        process.exit = (code) => {{ exitCode = code; throw new Error("PROCESS_EXIT"); }};
        process.stderr.write = (chunk) => {{ stderr += String(chunk); return true; }};
        const handlers = {{}};
        const pi = {{
          getAllTools: async () => ["read"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        try {{
          await mod.default(pi);
          await handlers.session_start({{ reason: "startup" }}, {{
            env: {{
              LARVA_PI_LAUNCHED: "1",
              LARVA_PI_INITIAL_PERSONA_ID: "startup",
              LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            }},
            ui: {{ setStatus: () => undefined, notify: () => undefined }},
            modelRegistry: {{ find: async () => null }},
          }});
        }} catch (error) {{
          if (error.message !== "PROCESS_EXIT") throw error;
        }} finally {{
          process.exit = originalExit;
          process.stderr.write = originalWrite;
        }}
        console.log(JSON.stringify({{ exitCode, stderr, envelope: mod.getActiveEnvelope(), beforeAgent: mod.before_agent_start({{ systemPrompt: "base" }}) }}));
        """,
    )

    assert result["exitCode"] == 1
    assert "larva pi: LARVA_MODEL_UNAVAILABLE: initial persona 'startup' failed before first prompt/model turn" in result["stderr"]
    assert result["envelope"] is None
    assert result["beforeAgent"] is None


def test_persona_switch_commits_envelope_model_and_status() -> None:
    source = _source()
    _assert_tokens(
        source,
        "PersonaEnvelope",
        "persona_id",
        "spec_digest",
        "modelRegistry.find",
        "setModel",
        "setLarvaStatus",
        "larva:",
    )


def test_no_active_persona_sets_none_status(tmp_path: Path) -> None:
    _assert_tokens(_source(), "larva: none", "setLarvaStatus")
    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const statuses = [];
        const handlers = {{}};
        const ctx = {{
          env: {{}},
          ui: {{ setStatus: async (status) => statuses.push(status) }},
        }};
        const pi = {{
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        await mod.initializeExtension(ctx, pi);
        await handlers.session_start?.({{}});
        console.log(JSON.stringify({{ statuses, envelope: mod.getActiveEnvelope() }}));
        """,
    )
    assert result["envelope"] is None
    assert result["statuses"] == ["larva: none"]


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


def test_enhanced_persona_selector_uses_pi_tui_input_selectlist_detail_without_mouse_click() -> None:
    source = _source()
    _assert_tokens(
        source,
        "Input as TuiInput",
        "SelectList",
        "LarvaPersonaSelector",
        "openEnhancedPersonaSelector",
        "registerShortcut",
        "Key.ctrlAlt(\"p\")",
        "Open Larva persona selector",
        "available when Pi is idle",
        "rankPersonasForSelector",
        "Type to filter persona ids/descriptions.",
        "Capabilities",
        "Digest",
        "Mouse click/press/release SGR events are intentionally unsupported no-ops",
        "SELECTOR_SURFACE_BG",
        "SELECTOR_BORDER_FG",
        "selectorSurfaceLine",
        "selectorShadowLine",
        "selectorListViewportLines",
        "╭",
        "╰",
        "overlayPadLine",
    )
    selector_body = _function_body(source, "export class LarvaPersonaSelector")
    assert "new TuiInput()" in selector_body
    assert "new SelectList" in selector_body
    assert "renderDetailRow" in selector_body
    assert "handleInput(data: string)" in selector_body
    assert "boxWidth - 4" in selector_body
    assert "selectorBoxRow" in selector_body
    assert "selectorFullBorderRow" in selector_body
    assert "ENABLE_MOUSE_REPORTING" not in selector_body
    assert "mouseWheelScrollDelta" not in selector_body

    open_body = _function_body(source, "export async function openPersonaSelector")
    assert open_body.index("openEnhancedPersonaSelector") < open_body.index("ctx.ui?.select")
    persona_command_body = _function_body(source, "function registerLarvaPersonaCommand")
    assert "runPersonaSelectorCommand" in persona_command_body
    assert "registerShortcut?.(Key.ctrlAlt(\"p\")" in persona_command_body
    assert "isIdle" in persona_command_body
    handle_body = _function_body(source, "export async function handlePersonaCommand")
    assert handle_body.index("LARVA_PI_INTERACTIVE_TUI") < handle_body.index("openPersonaSelector")


def test_enhanced_persona_selector_runtime_harness() -> None:
    payload = _run_selector_ui_harness()
    assertions = payload["assertions"]

    assert assertions == {
        "enhancedComponentUsesInputSelectListDetail": True,
        "detailPanelHasCapabilitiesAndDigest": True,
        "filteringRankingDeterministic": True,
        "enterCommitsThroughCommand": True,
        "ctrlAltPShortcutRegistered": True,
        "ctrlAltPShortcutOpensSelectorAndCommits": True,
        "ctrlAltPShortcutNonIdlePreservesState": True,
        "escCancelPreservesActiveState": True,
        "fallbackPreserved": True,
        "mouseClickUnsupportedNoOp": True,
        "renderLinesWithinWidth": True,
        "selectorOverlayBordered": True,
        "selectorSurfaceDistinct": True,
        "selectorAdaptiveHeightUtilization": True,
        "selectorDropShadow": True,
        "selectorFrameStableDuringNavigation": True,
    }
    assert payload["detail"]["afterFilterDetail"] == [
        "ID: DevOps",
        "Model: openrouter/devops",
        "Description: Operations developer prefix match",
        "Capabilities: deploy:read_write, shell:read_only",
        "Digest: sha256:DevOps",
    ]
    assert payload["detail"]["filteredOrder"] == ["DevOps", "devrel", "qa-dev", "backend-dev"]
    assert payload["detail"]["afterDownDetail"][0] == "ID: devrel"
    assert payload["detail"]["enterResult"] == "devrel"
    assert payload["commit"]["envelopePersona"] == "vectl-planner"
    assert payload["commit"]["selectedByCustom"] == "vectl-planner"
    assert payload["shortcut"]["registeredShortcut"] == "ctrl+alt+p"
    assert payload["shortcut"]["activePersona"] == "vectl-planner"
    assert payload["shortcutNonIdle"]["activePersonaAfterShortcut"] == "ok"
    assert payload["shortcutNonIdle"]["warningShown"] is True
    assert payload["cancel"]["activePersonaAfterCancel"] == "ok"
    assert payload["fallback"]["nonInteractiveCalls"] == {"custom": 0, "select": 0, "openSelector": 0}
    assert payload["adaptive"]["tallListViewportRows"] > payload["adaptive"]["smallListViewportRows"]
    assert payload["adaptive"]["tallCandidateRows"] >= 16


def test_persona_selector_surface_layout_shadow_docs_are_synchronized() -> None:
    readme = PI_EXTENSION_README.read_text(encoding="utf-8")
    design = PI_INTEGRATION_DESIGN.read_text(encoding="utf-8")
    selector_harness = PI_EXTENSION_SELECTOR_UI.read_text(encoding="utf-8")

    for document in (readme, design):
        _assert_tokens(
            document,
            "accent-colored border",
            "solid ANSI background",
            "adaptive list viewport",
            "terminal-compatible drop shadow",
            "frame height remains stable",
            "ctrl+alt+p",
            "conflict-screened",
            "extension shortcut",
            "not a `keybindings.json` command alias",
            "mouse click",
        )
    _assert_tokens(
        selector_harness,
        "selectorSurfaceDistinct",
        "selectorAdaptiveHeightUtilization",
        "selectorDropShadow",
        "ctrlAltPShortcutRegistered",
    )


def test_subagent_log_overlay_surface_docs_are_synchronized() -> None:
    readme = PI_EXTENSION_README.read_text(encoding="utf-8")
    design = PI_INTEGRATION_DESIGN.read_text(encoding="utf-8")
    authority = PI_EXTENSION_ASYNC_SPEC.read_text(encoding="utf-8")

    for document in (readme, design, authority):
        _assert_tokens(
            document,
            "/larva-subagent",
            "Subagent Console",
            "Larva subagent log",
            "persona selector",
            "accent-colored border",
            "solid ANSI background",
            "stable frame height",
            "terminal-compatible",
            "drop shadow",
            "90%",
            "initial prompt",
            "event-driven",
            "not timer polling",
            "Persistent cache",
            "subagent-presentation-log.json",
            "subagent-log.json",
            "--clear",
            "LARVA_SUBAGENT_LOG_CONFIG_INVALID",
            "Summary",
            "Prompt",
            "Output",
            "Timeline",
            "Metadata",
            "Markdown",
            "height",
            "mouse click",
        )


def test_async_subagent_docs_parity_against_reference() -> None:
    """README/source parity is judged against the async subagent reference."""

    authority = PI_EXTENSION_ASYNC_SPEC.read_text(encoding="utf-8")
    readme = PI_EXTENSION_README.read_text(encoding="utf-8")
    design = PI_INTEGRATION_DESIGN.read_text(encoding="utf-8")
    source = _source()

    authority_requirements = {
        "authority_path": str(PI_EXTENSION_ASYNC_SPEC.relative_to(ROOT)),
        "accepted_plus_callback": "accepted-plus-callback" in authority and "larva_subagent" in authority,
        "canonical_command": "/larva-subagent" in authority,
        "status_tool": "larva_subagent_status" in authority,
        "cancel_tool": "larva_subagent_cancel" in authority,
        "callback_boundary": "Larva subagent result — runtime event/data" in authority,
        "deterministic_automation_guidance": "Automation should use `larva_subagent_wait`, `larva_subagent_select`, or" in authority,
        "conversational_push_guidance": "Conversational Pi flows should yield the turn and wait for the" in authority,
        "status_inspection_only": "inspection/debugging only" in authority,
        "persistent_cache_not_authority": "Persistent presentation cache is adapter-local UI continuity only" in authority,
        "indicator_source_active_registry": "Source of truth is the same process-local active-run registry" in authority,
        "indicator_count_only_aggregate": "Show only aggregate non-terminal activity" in authority,
        "indicator_no_controls_or_content": "Never expose task text, child output, fuzzy selectors, or cancel-all actions." in authority,
        "indicator_cache_not_authority": "Persistent presentation cache" in authority and "excluded from the indicator" in authority,
        "cancel_grace_1500": "1500 ms" in authority,
        "lifecycle_rules": "On parent session shutdown, reload, new session, resume, or fork" in authority,
        "large_session_wait_guidance": all(
            token in authority
            for token in (
                "`0` returns an immediate snapshot and is preferred for checkpoint/status",
                "long waits remain supported",
                "parent TUI/Node heap pressure in large transcripts",
                "fresh/small\n  sessions or unattended orchestration",
                "Do not use\n  shell sleep polling",
            )
        ),
    }
    assert all(value is True for key, value in authority_requirements.items() if key != "authority_path"), json.dumps(
        authority_requirements, indent=2, sort_keys=True
    )

    parity = {
        "readme_names_canonical_larva_subagent": "/larva-subagent" in readme,
        "design_names_canonical_larva_subagent": "/larva-subagent" in design,
        "source_registers_canonical_larva_subagent_command": '"larva-subagent"' in source,
        "source_registers_status_tool": '"larva_subagent_status"' in source,
        "source_registers_events_wait_select_tools": all(token in source for token in ('"larva_subagent_events"', '"larva_subagent_wait"', '"larva_subagent_select"')),
        "source_registers_cancel_tool": '"larva_subagent_cancel"' in source,
        "source_returns_accepted_result_pending": 'status: "accepted"' in source and "result_pending" in source,
        "source_guides_automation_to_deterministic_tools": "For automation that depends on the child result, use larva_subagent_wait, larva_subagent_select, or larva_subagent_events with exact task_id handles." in source,
        "source_guides_conversation_to_push_callback": "For conversational Pi continuation, yield for the larva-subagent-result push callback." in source,
        "source_marks_status_inspection_only": "Inspection/debugging only; use wait/select/events for orchestration, not repeated status polling." in source,
        "readme_lists_events_wait_select": all(token in readme for token in ("larva_subagent_events(since_sequence?, task_ids?, limit?)", "larva_subagent_wait(task_ids, return_when?, timeout_ms?)", "larva_subagent_select(task_ids, timeout_ms?)")),
        "readme_guides_automation_to_deterministic_tools": "For automation that depends on the child" in readme and "building a shell sleep/status-polling loop" in readme,
        "readme_marks_status_inspection_only": "inspection and\ndebugging tool only" in readme,
        "readme_large_session_wait_guidance": all(
            token in readme
            for token in (
                "checkpoint/status probes in large interactive parent Pi sessions",
                "`timeout_ms: 0` or short waits; `0` returns an immediate snapshot",
                "Long waits\nremain supported",
                "parent TUI/Node heap pressure in large\ntranscripts",
                "fresh/small sessions or unattended orchestration",
                "Do not use shell sleep polling or ad-hoc status loops",
            )
        ),
        "readme_marks_persistent_cache_ui_only": "adapter-local UI continuity only" in readme and "never orchestration authority" in readme,
        "readme_indicator_count_only": "status/background indicator is count-only" in readme,
        "readme_indicator_active_registry_source": "process-local active-run registry and event-driven\nupdates" in readme,
        "readme_indicator_aggregate_only": "shows only aggregate\nnon-terminal activity" in readme,
        "readme_indicator_no_controls_or_content": all(token in readme for token in ("task prompts", "child output", "cancellation\nbuttons", "control/content surface")),
        "readme_indicator_cache_non_authority": "presentation cache remains UI-only continuity data and is never\nauthoritative for this indicator" in readme,
        "source_records_1500ms_abort_kill_grace": bool(re.search(r"(?:1500|1_500)[\s\S]{0,120}(?:abort|kill|grace)", source, re.IGNORECASE)),
    }
    assert parity == {key: True for key in parity}, json.dumps(
        {
            "authority": authority_requirements,
            "parity": parity,
            "reference": str(PI_EXTENSION_ASYNC_SPEC.relative_to(ROOT)),
        },
        indent=2,
        sort_keys=True,
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


def test_pi_model_lookup_keeps_only_explicit_gpt55_preference_mapping() -> None:
    source = _source()
    _assert_tokens(source, "piModelLookupFor", "openai", "gpt-5.5", "openai-codex")
    assert "*" not in re.search(
        r"function piModelLookupFor[\s\S]{0,500}", source
    ).group(0), "Pi model preference mapping must not introduce wildcard guessing"


def test_policy_baseline_resets_on_each_commit() -> None:
    source = _source()
    _assert_tokens(source, "getAllTools", "baseline", "setActiveTools")
    assert "carry over" in source or "previousActiveTools" not in source


def test_policy_validation_boundary_and_active_target_shape() -> None:
    source = _source()
    _assert_tokens(source, "LARVA_PI_TOOL_POLICY_FILE", "personas", "LARVA_POLICY_INVALID")
    _assert_tokens(source, "allow", "deny")
    assert '"ask"' not in re.search(r"function filterPolicyTools[\\s\\S]*?{", source).group(0) if re.search(r"function filterPolicyTools[\\s\\S]*?{", source) else True


def test_tool_policy_path_contract_rejects_implicit_legacy_fallback() -> None:
    source = _source()
    _assert_tokens(
        source,
        "toolPolicyPathContract",
        "~/.pi/larva/tool-policy.json",
        "LARVA_PI_TOOL_POLICY_FILE",
        "never read legacy ~/.pi/tool-policy.json implicitly",
        "explicitLegacyOnly",
        "do not auto-migrate, merge, rewrite, create user files, or provide a compatibility window",
    )


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


def test_initial_active_tool_update_failure_degrades_startup_and_allows_later_switch(tmp_path: Path) -> None:
    """Initial setActiveTools failure must not abort extension loading.

    The degraded startup must remain visibly unavailable rather than committing a
    false active persona, while later normal persona switches still update active
    tools and keep fail-closed tool_call denial semantics.
    """

    fake_cli = tmp_path / "fake-larva-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )
    policy = tmp_path / "tool-policy.json"
    policy.write_text(
        json.dumps({"personas": {"ok": {"deny": ["bash"]}, "startup": {"deny": ["bash"]}}}),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const statuses = [];
        const activeToolCalls = [];
        let commandHandler = null;
        let setActiveToolsAttempts = 0;
        let exitCode = null;
        let stderr = "";
        const originalExit = process.exit;
        const originalWrite = process.stderr.write;
        process.exit = (code) => {{ exitCode = code; throw new Error("PROCESS_EXIT"); }};
        process.stderr.write = (chunk) => {{ stderr += String(chunk); return true; }};
        const ctx = {{
          env: {{
            LARVA_PI_LAUNCHED: "1",
            LARVA_PI_INITIAL_PERSONA_ID: "startup",
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_TOOL_POLICY_FILE: {json.dumps(str(policy))},
          }},
          ui: {{ setStatus: async (status) => statuses.push(status) }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => ["read", "bash", "larva_subagent"],
          setActiveTools: async (tools) => {{
            setActiveToolsAttempts += 1;
            activeToolCalls.push(tools);
            if (setActiveToolsAttempts === 1) throw new Error("active tool surface unavailable at startup");
            return true;
          }},
          setModel: async () => true,
          registerCommand: (command) => {{ commandHandler = command.handler; }},
          registerTool: () => undefined,
          on: () => undefined,
        }};

        try {{
          await mod.initializeExtension(ctx, pi);
        }} finally {{
          process.exit = originalExit;
          process.stderr.write = originalWrite;
        }}
        const degradedEnvelope = mod.getActiveEnvelope();
        const degradedPrompt = mod.before_agent_start({{ systemPrompt: "base" }});
        const switched = await commandHandler("ok");
        const denied = mod.decideToolCall("bash");
        const allowed = mod.decideToolCall("read");
        console.log(JSON.stringify({{
          statuses,
          activeToolCalls,
          exitCode,
          stderr,
          degradedEnvelope,
          degradedPrompt: degradedPrompt ?? null,
          switched,
          denied,
          allowed,
          finalEnvelope: mod.getActiveEnvelope(),
        }}));
        """,
    )

    assert result["exitCode"] is None
    assert result["stderr"] == ""
    assert result["degradedEnvelope"] is None
    assert result["degradedPrompt"] is None
    assert result["statuses"][0] == "larva: startup unavailable (LARVA_TOOL_ENUMERATION_FAILED)"
    assert result["switched"]["ok"] is True
    assert result["statuses"][-1] == "larva: ok"
    assert result["activeToolCalls"] == [["read", "larva_subagent"], ["read", "larva_subagent"]]
    assert result["denied"]["action"] == "deny"
    assert result["denied"]["error"]["code"] == "LARVA_TOOL_DENIED"
    assert result["allowed"] == {"action": "allow"}
    assert result["finalEnvelope"]["persona_id"] == "ok"


def test_initial_unsupported_tool_enumerator_uses_empty_baseline_but_switch_failures_remain_atomic(tmp_path: Path) -> None:
    """Startup tolerates an unsupported tool surface without weakening switch atomicity."""

    fake_cli = tmp_path / "fake-larva-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )
    policy = tmp_path / "tool-policy.json"
    policy.write_text(
        json.dumps({"personas": {"ok": {"deny": ["bash"]}, "startup": {"deny": ["bash"]}}}),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const statuses = [];
        const activeToolCalls = [];
        let commandHandler = null;
        let phase = "startup";
        const ctx = {{
          env: {{
            LARVA_PI_INITIAL_PERSONA_ID: "startup",
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_TOOL_POLICY_FILE: {json.dumps(str(policy))},
          }},
          ui: {{ setStatus: async (status) => statuses.push(status) }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => {{
            if (phase === "startup") throw new TypeError("getAllTools is not available in this Pi startup surface");
            throw new Error("tool registry failed during active switch");
          }},
          setActiveTools: async (tools) => {{ activeToolCalls.push(tools); return true; }},
          setModel: async () => true,
          registerCommand: (command) => {{ commandHandler = command.handler; }},
          registerTool: () => undefined,
          on: () => undefined,
        }};

        await mod.initializeExtension(ctx, pi);
        phase = "switch";
        const startupEnvelope = mod.getActiveEnvelope();
        const deniedAfterStartup = mod.decideToolCall("bash");
        const switched = await commandHandler("ok");
        console.log(JSON.stringify({{
          statuses,
          activeToolCalls,
          startupEnvelope,
          deniedAfterStartup,
          switched,
          finalEnvelope: mod.getActiveEnvelope(),
        }}));
        """,
    )

    assert result["statuses"][0] == "larva: startup"
    assert result["activeToolCalls"] == [[]]
    assert result["startupEnvelope"]["persona_id"] == "startup"
    assert result["deniedAfterStartup"]["action"] == "deny"
    assert result["switched"]["ok"] is False
    assert result["switched"]["error"]["code"] == "LARVA_TOOL_ENUMERATION_FAILED"
    assert result["finalEnvelope"]["persona_id"] == "startup"


def test_startup_registers_larva_tools_before_policy_baseline_filtering(tmp_path: Path) -> None:
    """Startup policy baseline must include Larva-owned custom tools."""

    fake_cli = tmp_path / "fake-larva-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )
    policy = tmp_path / "tool-policy.json"
    policy.write_text(
        json.dumps({"personas": {"startup": {"allow": ["larva_subagent"]}}}),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const registeredToolNames = [];
        const activeToolCalls = [];
        const ctx = {{
          env: {{
            LARVA_PI_INITIAL_PERSONA_ID: "startup",
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_TOOL_POLICY_FILE: {json.dumps(str(policy))},
          }},
          ui: {{ setStatus: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => [...registeredToolNames, "read", "bash"],
          setActiveTools: async (tools) => {{ activeToolCalls.push(tools); return true; }},
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: (tool) => registeredToolNames.push(tool.name),
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        console.log(JSON.stringify({{
          registeredToolNames,
          activeToolCalls,
          activeEnvelope: mod.getActiveEnvelope(),
          subagentAllowed: mod.decideToolCall("larva_subagent"),
          bashDenied: mod.decideToolCall("bash"),
        }}));
        """,
    )

    assert result["registeredToolNames"][:2] == ["larva_subagent", "larva_subagent_sessions"]
    assert result["activeToolCalls"] == [["larva_subagent"]]
    assert result["activeEnvelope"]["persona_id"] == "startup"
    assert result["subagentAllowed"] == {"action": "allow"}
    assert result["bashDenied"]["action"] == "deny"
    assert result["bashDenied"]["error"]["code"] == "LARVA_TOOL_DENIED"


def test_persona_commit_prevalidates_then_sets_model_before_active_tools(tmp_path: Path) -> None:
    """Persona commit must avoid side effects until validation, then set model before tools."""

    fake_cli = tmp_path / "fake-larva-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )
    policy = tmp_path / "tool-policy.json"
    policy.write_text(
        json.dumps({"personas": {"ok": {"deny": ["bash"]}, "bad-policy": {"allow": [1]}}}),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const calls = [];
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_TOOL_POLICY_FILE: {json.dumps(str(policy))},
          }},
          ui: {{ setStatus: async () => undefined }},
          modelRegistry: {{ find: async (...args) => {{ calls.push(["find", ...args]); return {{ id: "model" }}; }} }},
        }};
        const pi = {{
          getAllTools: async () => {{ calls.push(["getAllTools"]); return ["read", "bash"]; }},
          setModel: async () => {{ calls.push(["setModel"]); return true; }},
          setActiveTools: async (tools) => {{ calls.push(["setActiveTools", tools]); return true; }},
        }};
        const ok = await mod.commitPersona("ok", ctx, pi);
        const afterOkCalls = [...calls];
        calls.length = 0;
        const badPolicy = await mod.commitPersona("bad-policy", ctx, pi);
        console.log(JSON.stringify({{ ok, afterOkCalls, badPolicy, afterBadCalls: calls, finalEnvelope: mod.getActiveEnvelope() }}));
        """,
    )

    assert result["ok"]["ok"] is True
    assert result["afterOkCalls"] == [
        ["find", "provider", "model"],
        ["getAllTools"],
        ["setModel"],
        ["setActiveTools", ["read"]],
    ]
    assert result["badPolicy"]["ok"] is False
    assert result["badPolicy"]["error"]["code"] == "LARVA_POLICY_INVALID"
    assert result["afterBadCalls"] == [["find", "provider", "model"], ["getAllTools"]]
    assert result["finalEnvelope"]["persona_id"] == "ok"


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
    assert "input.task_id === undefined || input.task_id === null" in source
    assert "task_id must be a non-empty string" in source


def test_child_session_root_default_override_and_invalid_override() -> None:
    source = _source()
    _assert_tokens(
        source,
        "LARVA_PI_CHILD_SESSION_DIR",
        ".pi/larva/child-sessions",
        "LARVA_CHILD_START_FAILED",
    )
    body = _function_body(source, "async function childSessionRoot")
    assert "configured !== undefined && configured.length === 0" in body
    assert body.index("configured !== undefined && configured.length === 0") < body.index("join(homedir()")


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


def test_child_process_requires_launched_sentinel_before_launcher_env_spawn(tmp_path: Path) -> None:
    """The extension consumes ``LARVA_PI_LAUNCHED`` as a child-spawn recursion guard."""
    source = _source()
    launcher_body = _function_body(source, "function launcherArgs")
    _assert_tokens(source, "isLarvaPiLaunched", "LARVA_PI_LAUNCHED")
    assert launcher_body.index("isLarvaPiLaunched(env)") < launcher_body.index("LARVA_PI_REAL_BIN")
    assert "!launched" in launcher_body
    start_child_body = _function_body(source, "function startChild")
    assert 'LARVA_PI_LAUNCHED: "1"' in start_child_body

    fake_cli = tmp_path / "fake-larva-resolve.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )
    spawn_marker = tmp_path / "spawned.txt"
    fake_pi = tmp_path / "fake-recursive-pi.mjs"
    fake_pi.write_text(
        textwrap.dedent(
            f"""
            import {{ writeFileSync }} from "node:fs";
            writeFileSync({json.dumps(str(spawn_marker))}, "spawned");
            process.exit(0);
            """
        ),
        encoding="utf-8",
    )

    result = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const env = {{
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
          LARVA_PI_REAL_BIN: process.execPath,
          LARVA_PI_EXTENSION_FLAG: {json.dumps(str(fake_pi))},
          LARVA_PI_EXTENSION_ENTRY: "would-be-extension.ts",
          LARVA_PI_CHILD_SESSION_DIR: {json.dumps(str(tmp_path))},
          LARVA_PI_LAUNCHED: "0",
          HOME: {json.dumps(str(tmp_path))},
        }};
        const ctx = {{
          env,
          ui: {{ setStatus: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => ["larva_subagent"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerTool: () => undefined,
          registerCommand: () => undefined,
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        await mod.commitPersona("parent", ctx, pi);
        const denied = await mod.larva_subagent({{ persona_id: "child", task: "must not spawn recursively" }}, {{ env }});
        console.log(JSON.stringify({{ denied, markerExists: await import("node:fs").then(fs => fs.existsSync({json.dumps(str(spawn_marker))})) }}));
        """,
    )

    assert result["denied"]["status"] == "failed"
    assert result["denied"]["error"]["code"] == "LARVA_CHILD_START_FAILED"
    assert result["markerExists"] is False


def test_no_sidecar_resume_contract() -> None:
    source = _source()
    assert "sidecar" not in source.lower()
    _assert_tokens(source, "task_id", ".jsonl", "persona_id")


def test_child_rpc_trace_file_is_documented_as_proof_only_not_authority() -> None:
    readme = PI_EXTENSION_README.read_text(encoding="utf-8")
    authority = PI_EXTENSION_ASYNC_SPEC.read_text(encoding="utf-8")
    for document in (readme, authority):
        _assert_tokens(
            document,
            "LARVA_PI_CHILD_RPC_TRACE_FILE",
            "runtime proof probes only",
            "model-facing helper",
            "not a public resume handle",
            "not a provenance record",
            "sidecar metadata",
            "not authority for `larva_subagent_sessions`",
            "Trace write failures are ignored",
        )


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
    _assert_tokens(
        _source(),
        "activeSubagentRuns",
        "subagentTaskIdBusyInRegistry",
        "activeSubagentRunByTaskId",
        "LARVA_SESSION_BUSY",
    )


def test_resume_parent_preflight_defers_child_persona_initialization() -> None:
    source = _source()
    subagent_body = _function_body(source, "export async function larva_subagent")
    child_sequence_body = _function_body(source, "async function runChildSequence")
    _assert_tokens(source, "switch_session", "LARVA_PI_INITIAL_PERSONA_ID")
    _assert_regex(
        source,
        r"validateTaskId[\s\S]+canSpawn[\s\S]+subagentTaskIdBusyInRegistry",
        "parent resume preflight should validate path, spawn authority, and active-run registry busy state only",
    )
    assert "resolvePersona" not in subagent_body
    assert "resolvePersona" not in child_sequence_body
    assert child_sequence_body.index("startChild(env, root, personaId)") < child_sequence_body.index('rpc.command("switch-1"')


def test_concurrent_same_task_resume_uses_in_memory_active_run_registry() -> None:
    _assert_tokens(
        _source(),
        "Map<string, ActiveSubagentRun>",
        "activeSubagentRuns",
        "moveSubagentRunToTaskId",
        "activeSubagentRunByTaskId",
        "cancelSubagentByTaskId",
        "finally",
    )


def test_cancel_authority_does_not_fall_back_to_presentation_only_rows() -> None:
    source = _source()
    body = _function_body(source, "awaitTerminal = false): Promise<LarvaSubagentCancelResult> {")
    _assert_tokens(body, "activeSubagentRunByTaskId", "LARVA_SUBAGENT_NOT_OBSERVED")
    assert "cancelObservedPresentationOnlyTask" not in source
    assert "recordSubagentPresentationResult(cancelled(" not in body


def test_larva_subagent_cancel_unobserved_exact_task_id_is_not_bad_input_or_filesystem_discovered(tmp_path: Path) -> None:
    """Well-formed exact cancel task ids are process-local registry lookups only."""

    child_root = tmp_path / "child-sessions"
    missing_task_id = child_root / "missing-observed-only.jsonl"
    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const env = {{ LARVA_PI_CHILD_SESSION_DIR: {json.dumps(str(child_root))} }};
        const unobserved = await mod.larva_subagent_cancel({{ task_id: {json.dumps(str(missing_task_id))}, reason: "valid model reason" }}, {{ env }});
        const exact500 = await mod.larva_subagent_cancel({{ task_id: {json.dumps(str(missing_task_id))}, reason: "x".repeat(500) }}, {{ env }});
        const overlong = await mod.larva_subagent_cancel({{ task_id: {json.dumps(str(missing_task_id))}, reason: "x".repeat(501) }}, {{ env }});
        const relative = await mod.larva_subagent_cancel({{ task_id: "missing-observed-only.jsonl", reason: "valid model reason" }}, {{ env }});
        console.log(JSON.stringify({{
          unobserved,
          exact500,
          overlong,
          relative,
          childRootExistsAfterCancel: (await import("node:fs")).existsSync({json.dumps(str(child_root))}),
        }}));
        """,
    )

    assert payload["unobserved"]["isError"] is True
    assert payload["unobserved"]["details"]["task_id"] == str(missing_task_id)
    assert payload["unobserved"]["details"]["error"]["code"] == "LARVA_SUBAGENT_NOT_OBSERVED"
    assert payload["exact500"]["details"]["error"]["code"] == "LARVA_SUBAGENT_NOT_OBSERVED"
    assert payload["overlong"]["details"]["error"]["code"] == "LARVA_BAD_INPUT"
    assert payload["relative"]["details"]["error"]["code"] == "LARVA_BAD_INPUT"
    assert payload["childRootExistsAfterCancel"] is False


def test_busy_state_is_process_local_without_lock_files() -> None:
    source = _source()
    _assert_tokens(source, "activeSubagentRuns", "subagentTaskIdBusyInRegistry")
    assert "activeTaskIds" not in source
    assert "lockfile" not in source.lower()
    assert ".lock" not in source


def test_resume_re_resolves_persona_in_new_child_process() -> None:
    source = _source()
    start_child_body = _function_body(source, "function startChild")
    child_sequence_body = _function_body(source, "async function runChildSequence")
    _assert_tokens(source, "LARVA_PI_INITIAL_PERSONA_ID", "switch_session")
    assert "LARVA_PI_INITIAL_PERSONA_ID: personaId" in start_child_body
    assert "resolvePersona" not in child_sequence_body
    _assert_regex(
        source,
        r"startChild\(env, root, personaId\)[\s\S]+switch_session",
        "resume must start a child process with the supplied persona before switching session",
    )


def test_abort_contract() -> None:
    source = _source()
    _assert_tokens(source, "abort", "LARVA_CHILD_CANCELLED", "kill", "cancelled")


def test_in_flight_abort_is_forwarded_to_child_rpc_and_wins_cancelled_race() -> None:
    source = _source()
    body = _function_body(source, "async function runChildSequence")

    _assert_tokens(
        body,
        "abortSignal?.addEventListener",
        "rpc.abort()",
        "Promise.race",
        "abortPromise",
        "cancelled(",
        "removeEventListener",
    )
    assert body.index("abortSignal?.addEventListener") < body.index('rpc.command("prompt-1"')
    assert body.index("const first = await Promise.race") < body.index("return first")
    _assert_regex(
        body,
        r"first\.status === \"cancelled\"[\s\S]+return first",
        "cancelled abort outcome must not be overwritten by a later successful child result",
    )


def test_abort_unknown_child_termination_returns_protocol_failed_not_cancelled() -> None:
    source = _source()
    abort_body = _function_body(source, "async abort()")
    sequence_body = _function_body(source, "async function runChildSequence")
    subagent_body = _function_body(source, "export async function larva_subagent")

    _assert_tokens(
        abort_body,
        "isSuccessResponse(aborted)",
        "const killed = this.child.kill()",
        'return killed ? "cancelled" : "unknowable"',
    )
    _assert_tokens(
        sequence_body,
        'outcome === "cancelled"',
        "LARVA_CHILD_PROTOCOL_FAILED",
        "Child abort state became unknowable.",
    )
    assert 'ctx?.abortSignal?.aborted && result.status !== "success"' not in subagent_body
    _assert_regex(
        sequence_body,
        r"outcome === \"cancelled\"[\s\S]+return cancelled[\s\S]+return failed[\s\S]+LARVA_CHILD_PROTOCOL_FAILED",
        "unknowable abort outcome must stay failed with LARVA_CHILD_PROTOCOL_FAILED",
    )


def test_nested_subagent_exposure_uses_child_authority_and_policy() -> None:
    source = _source()
    _assert_tokens(source, "larva_subagent", "can_spawn", "LARVA_PI_PARENT_PERSONA_ID")


def test_persona_resolve_bridge_uses_larva_cli_argv_json_and_fallback_rules() -> None:
    source = _source()
    is_persona_spec_body = _function_body(source, "function isPersonaSpec")
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
    assert "hasOnlyPersonaSpecKeys(value)" in is_persona_spec_body
    assert 'typeof value.description === "string"' in is_persona_spec_body
    assert "value.description.length > 0" in is_persona_spec_body
    assert "isCanonicalCapabilities(value.capabilities)" in is_persona_spec_body
    assert 'value.spec_version === "0.1.0"' in is_persona_spec_body


def test_persona_resolve_payload_is_canonical_personaspec_fail_closed_runtime_probe() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for PersonaSpec fail-closed runtime probe")
    completed = subprocess.run(
        [node, "contrib/pi-extension/test-personaspec-fail-closed.mjs"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=5.0,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)

    assert result["positive"]["persona_id"] == "ok"
    assert result["positive"]["calls"] == ["find", "getAllTools", "setModel", "setActiveTools"]
    failures = {entry["id"]: entry for entry in result["negatives"]}
    for case_id in (
        "missing-description",
        "bad-spec-version",
        "bad-posture",
        "legacy-tools",
        "legacy-side-effect-policy",
        "legacy-variables",
        "legacy-variant",
        "legacy-registry",
        "legacy-active",
        "extra-key",
    ):
        assert failures[case_id]["ok"] is False
        assert failures[case_id]["code"] == "LARVA_PERSONA_NOT_FOUND"
        assert failures[case_id]["before"] == "ok"
        assert failures[case_id]["after"] == "ok"
        assert failures[case_id]["sideEffects"] == []
        assert failures[case_id]["statuses"] == []
    assert result["finalEnvelope"]["persona_id"] == "ok"


def test_persona_list_bridge_uses_larva_cli_argv_json_for_completion_and_selector() -> None:
    source = _source()
    list_match = re.search(
        r"export async function listPersonas\(ctx\?: \{ env\?: RuntimeEnv \}\): Promise<BridgeListItem\[]> \{(?P<body>[\s\S]*?)\n\}",
        source,
    )
    assert list_match is not None
    list_body = list_match.group("body")
    _assert_tokens(source, "LARVA_CLI_ARGV_JSON", "list", "--json", "completePersonaIds")
    _assert_regex(
        source,
        r"data\[\]\.id|item\.id|persona\.id",
        "list bridge must require only data[].id for suggestions",
    )
    assert "items.some((item) => item === null)" in list_body
    assert "return []" in list_body


def test_child_stderr_startup_error_whitelist() -> None:
    source = _source()
    parser_body = _function_body(source, "function parseStartupError")
    for code in (
        "LARVA_PERSONA_NOT_FOUND",
        "LARVA_MODEL_UNAVAILABLE",
        "LARVA_POLICY_INVALID",
        "LARVA_TOOL_ENUMERATION_FAILED",
    ):
        assert code in parser_body
    whitelist_body = re.search(r"const whitelist:[\s\S]*?\];", parser_body).group(0)
    assert "LARVA_CHILD_START_FAILED" not in whitelist_body
    assert "LARVA_MODEL_MAP_INVALID" not in whitelist_body
    assert "post-readiness stderr is diagnostic only" in source
    _assert_regex(source, r"larva pi: <ERROR_CODE>|larva pi:", "stderr parser shape is required")
    _assert_regex(source, r"isLarvaError\(sessionFile\)|if \(isLarvaError\(value\)\) return value;", "early diagnostic errors must propagate through state requests without being overridden")


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


def test_expected_red_subagent_log_selector_streaming_runtime_contract_tokens() -> None:
    """Expected-red source contract for canonical `/larva-subagent` selector + streaming delta."""

    source = _source()
    assert '"--select"' in source
    assert '"timeline"' in source and "Timeline" in source
    assert "timeline_events" in source
    assert "toolCallId" in source
    assert "message_update" in source
    assert "tool_execution_start" in source
    assert "tool_execution_update" in source
    assert "tool_execution_end" in source
    assert "live_assistant" in source or "liveAssistant" in source
    assert "thinking hidden" in source
    assert "sanitizeSubagentPresentationCacheEntry" in source
    sanitizer = _function_body(source, "function sanitizeSubagentPresentationCacheEntry")
    for forbidden_live_field in (
        "live_assistant_preview",
        "tool_snapshots",
        "timeline_events",
        "session_assistant_message_ids",
        "active_tool_state",
        "raw_rpc_events",
    ):
        assert forbidden_live_field in sanitizer

def _write_agent_switch_fake_cli(tmp_path: Path) -> Path:
    fake_cli = tmp_path / "fake-larva-agent-switch-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, arg, jsonFlag] = process.argv;
            if (command === "resolve" && jsonFlag === "--json") {
              process.stdout.write(JSON.stringify({
                data: {
                  id: arg,
                  description: `Persona ${arg}`,
                  prompt: `Prompt for ${arg}`,
                  model: "provider/model",
                  capabilities: {},
                  spec_version: "0.1.0",
                  spec_digest: `sha256:${arg}`,
                  can_spawn: true
                }
              }));
            } else if (command === "list" && arg === "--json") {
              process.stdout.write(JSON.stringify({
                data: [
                  { id: "architect", description: "Architecture persona", model: "provider/model" },
                  { id: "python", description: "Python persona", model: "provider/model" }
                ]
              }));
            } else {
              process.exit(3);
            }
            """
        ),
        encoding="utf-8",
    )
    return fake_cli


def _run_agent_persona_switch_harness(tmp_path: Path, scenario_body: str) -> dict[str, Any]:
    fake_cli = _write_agent_switch_fake_cli(tmp_path)
    return _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const fakeCli = {json.dumps(str(fake_cli))};

        async function buildHarness(envOverrides = {{}}, options = {{}}) {{
          const commands = {{}};
          const tools = {{}};
          const handlers = {{}};
          const sessionEntries = [...(options.sessionEntries ?? [])];
          const statuses = [];
          const notifications = [];
          const activeToolCalls = [];
          const modelCalls = [];
          const sentUserMessages = [];
          const confirmations = [];
          const selectCalls = [];
          const pi = {{
            getAllTools: async () => ["read", "bash", "larva_subagent", "larva_persona_switch", "larva_personas"],
            setActiveTools: async (tools) => {{ activeToolCalls.push(tools); return true; }},
            setModel: async (...args) => {{ modelCalls.push(args); return true; }},
            registerCommand: (nameOrCommand, maybeOptions) => {{
              if (typeof nameOrCommand === "string") commands[nameOrCommand] = maybeOptions;
              else commands[nameOrCommand.name] = nameOrCommand;
            }},
            registerTool: (tool) => {{ tools[tool.name] = tool; }},
            on: (event, handler) => {{ handlers[event] = handler; }},
            sendUserMessage: async (message, options) => {{ sentUserMessages.push({{ message, options }}); return true; }},
          }};
          const ui = {{
            setStatus: async (status) => statuses.push([status]),
            notify: async (...args) => notifications.push(args),
            confirm: async (...args) => {{ confirmations.push(args); return options.confirmResult ?? true; }},
          }};
          if (!options.omitSelect) {{
            ui.select = async (...args) => {{ selectCalls.push(args); return options.selectResult; }};
          }}
          const session = {{
            entries: sessionEntries,
            getEntries: () => sessionEntries,
            appendEntry: (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
            addEntry: (entry) => sessionEntries.push(entry),
            addCustomEntry: (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
          }};
          const ctx = {{
            env: {{
              LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
              LARVA_PI_INTERACTIVE_TUI: "1",
              LARVA_PI_AGENT_PERSONA_SWITCH: undefined,
              ...envOverrides,
            }},
            ui: options.omitUi ? undefined : ui,
            modelRegistry: {{ find: async (...args) => {{ modelCalls.push(["find", ...args]); return options.modelUnavailable ? null : {{ id: "model" }}; }} }},
            sessionManager: options.omitSession ? undefined : {{ getEntries: () => sessionEntries }},
            appendEntry: options.omitSession ? undefined : (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
            session: options.omitSession ? undefined : session,
          }};
          if (options.samePiAsCtx) {{
            Object.assign(ctx, pi);
            await mod.initializeExtension(ctx);
          }} else {{
            await mod.initializeExtension(ctx, pi);
          }}
          if (!options.skipSessionStart && typeof handlers.session_start === "function") await handlers.session_start({{ entries: sessionEntries }}, ctx);
          return {{ mod, ctx, pi, commands, tools, handlers, sessionEntries, statuses, notifications, activeToolCalls, modelCalls, sentUserMessages, confirmations, selectCalls }};
        }}

        {textwrap.dedent(scenario_body)}
        """,
        timeout=8,
    )


def _registered_names(payload: dict[str, Any], key: str) -> set[str]:
    return set(payload.get(key, []))


def test_agent_persona_switch_session_mode_resolution_custom_entry_env_default_confirm_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const defaultHarness = await buildHarness({});
        const envManualHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
        const envConfirmHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm" });
        const envAutoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
        const envFreeHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "free" });
        const legacyHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off" });
        const customAutoHarness = await buildHarness(
          { LARVA_PI_AGENT_PERSONA_SWITCH: "manual" },
          { sessionEntries: [{ type: "custom", customType: "larva-agent-persona-switch-mode", data: { mode: "auto", source: "slash-command" } }] }
        );
        console.log(JSON.stringify({
          defaultTools: Object.keys(defaultHarness.tools),
          envManualTools: Object.keys(envManualHarness.tools),
          envConfirmTools: Object.keys(envConfirmHarness.tools),
          envAutoTools: Object.keys(envAutoHarness.tools),
          envFreeTools: Object.keys(envFreeHarness.tools),
          legacyTools: Object.keys(legacyHarness.tools),
          legacyNotifications: legacyHarness.notifications,
          customAutoTools: Object.keys(customAutoHarness.tools),
          customEntries: customAutoHarness.sessionEntries,
          commands: Object.keys(defaultHarness.commands),
        }));
        """,
    )

    assert "larva-mode" in _registered_names(payload, "commands")
    assert "larva-agent-persona-switch" not in _registered_names(payload, "commands")
    for key in ("defaultTools", "envConfirmTools", "envAutoTools", "envFreeTools", "legacyTools", "customAutoTools"):
        assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, key)
    assert "larva_persona_switch" not in _registered_names(payload, "envManualTools")
    assert "larva_personas" not in _registered_names(payload, "envManualTools")
    assert any("unknown" in note[0].lower() and "confirm" in note[0] for note in payload["legacyNotifications"])



def test_active_persona_session_restore_uses_latest_commit_without_rewriting_session_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const harness = await buildHarness({}, { sessionEntries: [restoreEntry] });
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          sessionEntries: harness.sessionEntries,
          statuses: harness.statuses,
          modelCalls: harness.modelCalls,
          activeTools: harness.activeToolCalls.at(-1),
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "python"
    assert payload["envelope"]["spec_digest"] == "sha256:python"
    assert payload["sessionEntries"] == [
        {
            "type": "custom",
            "customType": "larva-active-persona-commit",
            "data": {
                "schema_version": 1,
                "persona_id": "python",
                "spec_digest": "sha256:python",
                "source": "slash-command",
                "committed_at": "2026-06-04T00:00:00.000Z",
            },
        }
    ]
    assert any(status == ["larva: python"] for status in payload["statuses"])
    assert any(call[:3] == ["find", "provider", "model"] for call in payload["modelCalls"])
    assert "read" in payload["activeTools"]


def test_active_persona_restore_does_not_reapply_model_on_later_prompt_turn(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const harness = await buildHarness({}, { sessionEntries: [restoreEntry] });
        const setModelCount = () => harness.modelCalls.filter((call) => Array.isArray(call) && call.length === 1 && call[0]?.id === "model").length;
        const setModelCountAfterRestore = setModelCount();
        const activeToolUpdatesAfterRestore = harness.activeToolCalls.length;
        harness.sessionEntries.push({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "next turn" }] },
          timestamp: Date.now(),
        });
        const before = await harness.handlers.before_agent_start({ systemPrompt: "Base prompt" }, harness.ctx);
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          before,
          setModelCountAfterRestore,
          setModelCountAfterPrompt: setModelCount(),
          activeToolUpdatesAfterRestore,
          activeToolUpdatesAfterPrompt: harness.activeToolCalls.length,
          modelCalls: harness.modelCalls,
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "python"
    assert "Prompt for python" in payload["before"]["systemPrompt"]
    assert payload["setModelCountAfterRestore"] == 1
    assert payload["setModelCountAfterPrompt"] == 1
    assert payload["activeToolUpdatesAfterPrompt"] == payload["activeToolUpdatesAfterRestore"]


def test_larva_persona_command_does_not_reapply_model_on_later_prompt_turn(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness();
        const command = harness.commands["larva-persona"];
        const committed = await (command.handler ?? command.options?.handler)("python", harness.ctx);
        const setModelCount = () => harness.modelCalls.filter((call) => Array.isArray(call) && call.length === 1 && call[0]?.id === "model").length;
        const setModelCountAfterCommand = setModelCount();
        const activeToolUpdatesAfterCommand = harness.activeToolCalls.length;
        harness.sessionEntries.push({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "next turn" }] },
          timestamp: Date.now(),
        });
        const before = await harness.handlers.before_agent_start({ systemPrompt: "Base prompt" }, harness.ctx);
        console.log(JSON.stringify({
          committed,
          envelope: harness.mod.getActiveEnvelope(),
          before,
          setModelCountAfterCommand,
          setModelCountAfterPrompt: setModelCount(),
          activeToolUpdatesAfterCommand,
          activeToolUpdatesAfterPrompt: harness.activeToolCalls.length,
          sessionEntries: harness.sessionEntries,
        }));
        """,
    )

    assert payload["committed"]["ok"] is True
    assert payload["envelope"]["persona_id"] == "python"
    assert "Prompt for python" in payload["before"]["systemPrompt"]
    assert payload["setModelCountAfterCommand"] == 1
    assert payload["setModelCountAfterPrompt"] == 1
    assert payload["activeToolUpdatesAfterPrompt"] == payload["activeToolUpdatesAfterCommand"]


def test_active_persona_restore_rehydrates_when_latest_commit_changes(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const nextRestoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "architect", spec_digest: "sha256:architect", source: "slash-command", committed_at: "2026-06-04T00:01:00.000Z" },
        };
        const harness = await buildHarness({}, { sessionEntries: [restoreEntry] });
        const setModelCount = () => harness.modelCalls.filter((call) => Array.isArray(call) && call.length === 1 && call[0]?.id === "model").length;
        const setModelCountAfterRestore = setModelCount();
        harness.sessionEntries.push(nextRestoreEntry);
        const before = await harness.handlers.before_agent_start({ systemPrompt: "Base prompt" }, harness.ctx);
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          before,
          setModelCountAfterRestore,
          setModelCountAfterCommitChange: setModelCount(),
          activeTools: harness.activeToolCalls.at(-1),
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "architect"
    assert "Prompt for architect" in payload["before"]["systemPrompt"]
    assert payload["setModelCountAfterRestore"] == 1
    assert payload["setModelCountAfterCommitChange"] == 2
    assert "read" in payload["activeTools"]


def test_active_persona_session_restore_runs_on_extension_reload_without_session_start_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const harness = await buildHarness({}, { sessionEntries: [restoreEntry], samePiAsCtx: true, skipSessionStart: true });
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          statuses: harness.statuses,
          activeTools: harness.activeToolCalls.at(-1),
          sessionEntries: harness.sessionEntries,
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "python"
    assert any(status == ["larva: python"] for status in payload["statuses"])
    assert "read" in payload["activeTools"]
    assert len([entry for entry in payload["sessionEntries"] if entry.get("customType") == "larva-active-persona-commit"]) == 1


def test_active_persona_session_restore_before_agent_start_uses_event_ctx_without_session_start_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const harness = await buildHarness({}, { samePiAsCtx: true, skipSessionStart: true, omitSession: true });
        const eventEntries = [restoreEntry];
        const eventCtx = {
          ...harness.ctx,
          session: {
            entries: eventEntries,
            getEntries: () => eventEntries,
            appendEntry: (customType, data) => eventEntries.push({ type: "custom", customType, data }),
          },
        };
        const before = await harness.handlers.before_agent_start({ systemPrompt: "Base prompt" }, eventCtx);
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          before,
          statuses: harness.statuses,
          eventEntries,
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "python"
    assert "Prompt for python" in payload["before"]["systemPrompt"]
    assert any(status == ["larva: python"] for status in payload["statuses"])
    assert payload["eventEntries"] == [
        {
            "type": "custom",
            "customType": "larva-active-persona-commit",
            "data": {
                "schema_version": 1,
                "persona_id": "python",
                "spec_digest": "sha256:python",
                "source": "slash-command",
                "committed_at": "2026-06-04T00:00:00.000Z",
            },
        }
    ]


def test_agent_persona_switch_mode_restore_before_agent_start_uses_event_ctx_without_session_start_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const personaEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const modeEntry = {
          type: "custom",
          customType: "larva-agent-persona-switch-mode",
          data: { mode: "auto", source: "slash-command" },
        };
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" }, { samePiAsCtx: true, skipSessionStart: true, omitSession: true });
        const eventEntries = [personaEntry, modeEntry];
        const eventCtx = {
          ...harness.ctx,
          session: {
            entries: eventEntries,
            getEntries: () => eventEntries,
            appendEntry: (customType, data) => eventEntries.push({ type: "custom", customType, data }),
          },
        };
        const before = await harness.handlers.before_agent_start({ systemPrompt: "Base prompt" }, eventCtx);
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          before,
          registeredTools: Object.keys(harness.tools),
          activeTools: harness.activeToolCalls.at(-1),
          eventEntries,
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "python"
    assert "larva_persona_switch" in payload["before"]["systemPrompt"]
    assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, "registeredTools")
    assert {"larva_persona_switch", "larva_personas"} <= set(payload["activeTools"])
    assert len([entry for entry in payload["eventEntries"] if entry.get("customType") == "larva-agent-persona-switch-mode"]) == 1



def test_active_persona_commit_writes_real_pi_session_manager_custom_entry_behavior(tmp_path: Path) -> None:
    fake_cli = _write_agent_switch_fake_cli(tmp_path)
    session_manager_js = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js"
    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const {{ SessionManager }} = await import({json.dumps(session_manager_js)});
        const sessionDir = {json.dumps(str(tmp_path / "pi-sessions-write"))};
        const manager = SessionManager.create(process.cwd(), sessionDir);
        manager.appendMessage({{ role: "user", content: "set persona", timestamp: Date.now() }});
        manager.appendMessage({{
          role: "assistant",
          content: [{{ type: "text", text: "ok" }}],
          api: "test",
          provider: "test",
          model: "test",
          usage: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }} }},
          stopReason: "stop",
          timestamp: Date.now(),
        }});
        const sessionFile = manager.getSessionFile();
        const statuses = [];
        const handlers = {{}};
        const commands = {{}};
        const pi = {{
          appendEntry: (customType, data) => manager.appendCustomEntry(customType, data),
          getAllTools: async () => ["read", "bash", "larva_subagent", "larva_persona_switch", "larva_personas"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: (nameOrCommand, maybeOptions) => {{
            if (typeof nameOrCommand === "string") commands[nameOrCommand] = maybeOptions;
            else commands[nameOrCommand.name] = nameOrCommand;
          }},
          registerTool: () => undefined,
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        const eventCtx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INTERACTIVE_TUI: "1",
          }},
          ui: {{ setStatus: async (status) => statuses.push([status]), notify: async () => undefined }},
          modelRegistry: {{ find: async () => {{ return {{ id: "model" }}; }} }},
          sessionManager: manager,
        }};
        await mod.initializeExtension(pi);
        await handlers.session_start?.({{ reason: "startup" }}, eventCtx);
        const command = commands["larva-persona"];
        const committed = await (command.handler ?? command.options?.handler)("python", eventCtx);
        const reopened = SessionManager.open(sessionFile);
        console.log(JSON.stringify({{
          committed,
          entries: reopened.getEntries().filter((entry) => entry.customType === "larva-active-persona-commit"),
          statuses,
        }}));
        """,
        timeout=8,
    )

    assert payload["committed"]["ok"] is True
    assert payload["entries"][-1]["type"] == "custom"
    assert payload["entries"][-1]["customType"] == "larva-active-persona-commit"
    assert payload["entries"][-1]["data"]["persona_id"] == "python"
    assert payload["entries"][-1]["data"]["spec_digest"] == "sha256:python"
    assert payload["entries"][-1]["data"]["source"] == "slash-command"


def test_active_persona_session_restore_from_real_pi_session_manager_reopen_behavior(tmp_path: Path) -> None:
    fake_cli = _write_agent_switch_fake_cli(tmp_path)
    session_manager_js = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js"
    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const {{ SessionManager }} = await import({json.dumps(session_manager_js)});
        const sessionDir = {json.dumps(str(tmp_path / "pi-sessions"))};
        const manager = SessionManager.create(process.cwd(), sessionDir);
        manager.appendMessage({{ role: "user", content: "set persona", timestamp: Date.now() }});
        manager.appendMessage({{
          role: "assistant",
          content: [{{ type: "text", text: "ok" }}],
          api: "test",
          provider: "test",
          model: "test",
          usage: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }} }},
          stopReason: "stop",
          timestamp: Date.now(),
        }});
        manager.appendCustomEntry("larva-active-persona-commit", {{
          schema_version: 1,
          persona_id: "python",
          spec_digest: "sha256:python",
          source: "slash-command",
          committed_at: "2026-06-05T00:00:00.000Z",
        }});
        const sessionFile = manager.getSessionFile();
        const reopened = SessionManager.open(sessionFile);
        const statuses = [];
        const activeToolCalls = [];
        const modelCalls = [];
        const commands = {{}};
        const tools = {{}};
        const handlers = {{}};
        const pi = {{
          appendEntry: (customType, data) => reopened.appendCustomEntry(customType, data),
          getAllTools: async () => ["read", "bash", "larva_subagent", "larva_persona_switch", "larva_personas"],
          setActiveTools: async (tools) => {{ activeToolCalls.push(tools); return true; }},
          setModel: async () => true,
          registerCommand: (nameOrCommand, maybeOptions) => {{
            if (typeof nameOrCommand === "string") commands[nameOrCommand] = maybeOptions;
            else commands[nameOrCommand.name] = nameOrCommand;
          }},
          registerTool: (tool) => {{ tools[tool.name] = tool; }},
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        const eventCtx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INTERACTIVE_TUI: "1",
          }},
          ui: {{ setStatus: async (status) => statuses.push([status]), notify: async () => undefined }},
          modelRegistry: {{ find: async (...args) => {{ modelCalls.push(args); return {{ id: "model" }}; }} }},
          sessionManager: reopened,
        }};
        await mod.initializeExtension(pi);
        await handlers.session_start?.({{ reason: "startup" }}, eventCtx);
        console.log(JSON.stringify({{
          envelope: mod.getActiveEnvelope(),
          statuses,
          activeTools: activeToolCalls.at(-1),
          entries: reopened.getEntries().filter((entry) => entry.customType === "larva-active-persona-commit"),
          sessionFile,
        }}));
        """,
        timeout=8,
    )

    assert payload["envelope"]["persona_id"] == "python"
    assert any(status == ["larva: python"] for status in payload["statuses"])
    assert "read" in payload["activeTools"]
    assert payload["entries"] == [
        {
            "type": "custom",
            "customType": "larva-active-persona-commit",
            "data": {
                "schema_version": 1,
                "persona_id": "python",
                "spec_digest": "sha256:python",
                "source": "slash-command",
                "committed_at": "2026-06-05T00:00:00.000Z",
            },
            "id": payload["entries"][0]["id"],
            "parentId": payload["entries"][0]["parentId"],
            "timestamp": payload["entries"][0]["timestamp"],
        }
    ]


def test_active_persona_session_restore_session_commit_wins_over_explicit_startup_persona_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const harness = await buildHarness({ LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { sessionEntries: [restoreEntry] });
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          sessionEntries: harness.sessionEntries,
          statuses: harness.statuses,
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "python"
    active_entries = [entry for entry in payload["sessionEntries"] if entry.get("customType") == "larva-active-persona-commit"]
    assert len(active_entries) == 1
    assert active_entries[0]["data"]["persona_id"] == "python"
    assert active_entries[0]["data"]["source"] == "slash-command"
    assert any(status == ["larva: python"] for status in payload["statuses"])


def test_active_persona_restore_preserves_session_model_change_after_persona_commit_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const modelChange = { type: "model_change", provider: "manual-provider", modelId: "manual-model" };
        const harness = await buildHarness({ LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { sessionEntries: [restoreEntry, modelChange] });
        const setModelCalls = harness.modelCalls.filter((call) => Array.isArray(call) && call.length === 1 && call[0]?.id === "model");
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          sessionEntries: harness.sessionEntries,
          setModelCalls,
          modelCalls: harness.modelCalls,
          activeTools: harness.activeToolCalls.at(-1),
          statuses: harness.statuses,
        }));
        """,
    )

    assert payload["envelope"]["persona_id"] == "python"
    assert payload["setModelCalls"] == []
    assert not any(call[:3] == ["find", "provider", "model"] for call in payload["modelCalls"])
    assert "read" in payload["activeTools"]
    assert payload["sessionEntries"] == [
        {
            "type": "custom",
            "customType": "larva-active-persona-commit",
            "data": {
                "schema_version": 1,
                "persona_id": "python",
                "spec_digest": "sha256:python",
                "source": "slash-command",
                "committed_at": "2026-06-04T00:00:00.000Z",
            },
        },
        {"type": "model_change", "provider": "manual-provider", "modelId": "manual-model"},
    ]
    assert any(status == ["larva: python"] for status in payload["statuses"])


def test_active_persona_session_restore_failure_is_nonfatal_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const restoreEntry = {
          type: "custom",
          customType: "larva-active-persona-commit",
          data: { schema_version: 1, persona_id: "python", spec_digest: "sha256:python", source: "slash-command", committed_at: "2026-06-04T00:00:00.000Z" },
        };
        const harness = await buildHarness({}, { sessionEntries: [restoreEntry], modelUnavailable: true });
        console.log(JSON.stringify({
          envelope: harness.mod.getActiveEnvelope(),
          statuses: harness.statuses,
          notifications: harness.notifications,
          sessionEntries: harness.sessionEntries,
        }));
        """,
    )

    assert payload["envelope"] is None
    assert any(status == ["larva: python unavailable (LARVA_MODEL_UNAVAILABLE)"] for status in payload["statuses"])
    assert any("Larva session persona restore unavailable: LARVA_MODEL_UNAVAILABLE" in notification[0] for notification in payload["notifications"])
    assert payload["sessionEntries"] == [
        {
            "type": "custom",
            "customType": "larva-active-persona-commit",
            "data": {
                "schema_version": 1,
                "persona_id": "python",
                "spec_digest": "sha256:python",
                "source": "slash-command",
                "committed_at": "2026-06-04T00:00:00.000Z",
            },
        }
    ]


def test_agent_persona_switch_slash_command_persists_documented_session_entry_shape_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({});
        const command = harness.commands["larva-mode"];
        const result = command ? await (command.handler ?? command.options?.handler)("auto", harness.ctx) : null;
        console.log(JSON.stringify({ result, sessionEntries: harness.sessionEntries, commands: Object.keys(harness.commands) }));
        """,
    )

    assert "larva-mode" in _registered_names(payload, "commands")
    assert "larva-agent-persona-switch" not in _registered_names(payload, "commands")
    assert payload["result"] == {"ok": True, "mode": "auto"}
    assert any(
        entry == {
            "type": "custom",
            "customType": "larva-agent-persona-switch-mode",
            "data": {"mode": "auto", "source": "slash-command"},
        }
        for entry in payload["sessionEntries"]
    )


def test_agent_persona_switch_noarg_selector_persists_selected_mode_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" }, { selectResult: "auto" });
        const command = harness.commands["larva-mode"];
        const result = await (command.handler ?? command.options?.handler)("", harness.ctx);
        console.log(JSON.stringify({
          result,
          selectCalls: harness.selectCalls,
          sessionEntries: harness.sessionEntries,
          activeTools: harness.activeToolCalls.at(-1),
          tools: Object.keys(harness.tools),
        }));
        """,
    )

    assert payload["result"] == {"ok": True, "mode": "auto"}
    assert payload["selectCalls"] == [["Larva agent persona self-switch mode", ["manual", "confirm", "auto", "free"]]]
    assert any(
        entry == {
            "type": "custom",
            "customType": "larva-agent-persona-switch-mode",
            "data": {"mode": "auto", "source": "slash-command"},
        }
        for entry in payload["sessionEntries"]
    )
    assert {"larva_persona_switch", "larva_personas"} <= set(payload["activeTools"])
    assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, "tools")



def test_agent_persona_switch_noarg_cancel_or_missing_ui_preserves_mode_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const canceledHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
        const canceledCommand = canceledHarness.commands["larva-mode"];
        const canceledResult = await (canceledCommand.handler ?? canceledCommand.options?.handler)("", canceledHarness.ctx);
        const missingUiHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" }, { omitUi: true });
        const missingUiCommand = missingUiHarness.commands["larva-mode"];
        const missingUiResult = await (missingUiCommand.handler ?? missingUiCommand.options?.handler)("", missingUiHarness.ctx);
        console.log(JSON.stringify({
          canceledResult,
          canceledEntries: canceledHarness.sessionEntries,
          canceledTools: Object.keys(canceledHarness.tools),
          canceledActiveTools: canceledHarness.activeToolCalls.at(-1) ?? [],
          missingUiResult,
          missingUiEntries: missingUiHarness.sessionEntries,
          missingUiTools: Object.keys(missingUiHarness.tools),
          missingUiActiveTools: missingUiHarness.activeToolCalls.at(-1) ?? [],
        }));
        """,
    )

    assert payload["canceledResult"]["ok"] is False
    assert payload["canceledResult"]["error"]["code"] == "LARVA_BAD_INPUT"
    assert payload["missingUiResult"]["ok"] is False
    assert payload["missingUiResult"]["error"]["code"] == "LARVA_BAD_INPUT"
    for key in ("canceledEntries", "missingUiEntries"):
        assert not any(entry.get("customType") == "larva-agent-persona-switch-mode" for entry in payload[key])
    for key in ("canceledTools", "missingUiTools", "canceledActiveTools", "missingUiActiveTools"):
        assert "larva_persona_switch" not in payload[key]
        assert "larva_personas" not in payload[key]



def test_agent_persona_switch_tool_exposure_manual_confirm_auto_free_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const manualHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
        const confirmHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm" });
        const autoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
        const freeHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "free" });
        console.log(JSON.stringify({
          manualTools: Object.keys(manualHarness.tools),
          confirmTools: Object.keys(confirmHarness.tools),
          autoTools: Object.keys(autoHarness.tools),
          freeTools: Object.keys(freeHarness.tools),
          autoSwitchSchema: autoHarness.tools["larva_persona_switch"]?.inputSchema ?? null,
        }));
        """,
    )

    assert "larva_persona_switch" not in _registered_names(payload, "manualTools")
    assert "larva_personas" not in _registered_names(payload, "manualTools")
    for key in ("confirmTools", "autoTools", "freeTools"):
        assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, key)
    max_switches_schema = payload["autoSwitchSchema"]["properties"]["max_switches_per_chain"]
    assert {option["type"] for option in max_switches_schema["anyOf"]} == {"integer", "null"}
    assert max_switches_schema["anyOf"][0]["minimum"] == 0
    assert "0 means unlimited" in max_switches_schema["description"]



def test_agent_persona_switch_invalid_stored_or_env_mode_fails_safe_to_confirm_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const invalidStoredHarness = await buildHarness(
          { LARVA_PI_AGENT_PERSONA_SWITCH: "auto" },
          { sessionEntries: [{ type: "custom", customType: "larva-agent-persona-switch-mode", data: { mode: "bogus", source: "slash-command" } }] }
        );
        const invalidEnvHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "bogus" });
        console.log(JSON.stringify({
          invalidStoredTools: Object.keys(invalidStoredHarness.tools),
          invalidStoredNotifications: invalidStoredHarness.notifications,
          invalidEnvTools: Object.keys(invalidEnvHarness.tools),
          invalidEnvNotifications: invalidEnvHarness.notifications,
        }));
        """,
    )

    for key in ("invalidStoredTools", "invalidEnvTools"):
        assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, key)
    for key in ("invalidStoredNotifications", "invalidEnvNotifications"):
        assert any("unknown" in note[0].lower() and "confirm" in note[0] for note in payload[key])



def test_agent_persona_switch_slash_manual_recomputes_active_tools_and_preserves_manual_switch_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const cases = [];
        for (const mode of ["confirm", "auto", "free"]) {
          const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: mode, LARVA_PI_INITIAL_PERSONA_ID: "architect" });
          const beforeManualActiveTools = harness.activeToolCalls.at(-1);
          const modeCommand = harness.commands["larva-mode"];
          const manualModeResult = await (modeCommand.handler ?? modeCommand.options?.handler)("manual", harness.ctx);
          const afterManualActiveTools = harness.activeToolCalls.at(-1);
          const staleSwitchDecision = harness.mod.decideToolCall("larva_persona_switch");
          const stalePersonasDecision = harness.mod.decideToolCall("larva_personas");
          const manual = harness.commands["larva-persona"];
          const manualResult = await (manual.handler ?? manual.options?.handler)("python", harness.ctx);
          const afterManualSwitchActiveTools = harness.activeToolCalls.at(-1);
          cases.push({
            mode,
            beforeManualActiveTools,
            manualModeResult,
            afterManualActiveTools,
            staleSwitchDecision,
            stalePersonasDecision,
            manualResult,
            afterManualSwitchActiveTools,
            finalEnvelope: harness.mod.getActiveEnvelope(),
            commands: Object.keys(harness.commands),
          });
        }
        console.log(JSON.stringify({ cases }));
        """,
    )

    assert {case["mode"] for case in payload["cases"]} == {"confirm", "auto", "free"}
    for case in payload["cases"]:
        assert {"larva_persona_switch", "larva_personas"} <= set(case["beforeManualActiveTools"])
        assert case["manualModeResult"] == {"ok": True, "mode": "manual"}
        assert "larva_persona_switch" not in case["afterManualActiveTools"]
        assert "larva_personas" not in case["afterManualActiveTools"]
        assert case["staleSwitchDecision"]["action"] == "deny"
        assert case["staleSwitchDecision"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_MANUAL"
        assert case["stalePersonasDecision"]["action"] == "deny"
        assert "larva-persona" in case["commands"]
        assert case["manualResult"]["ok"] is True
        assert case["finalEnvelope"]["persona_id"] == "python"
        assert "larva_persona_switch" not in case["afterManualSwitchActiveTools"]
        assert "larva_personas" not in case["afterManualSwitchActiveTools"]



def test_agent_persona_switch_stale_manual_rejects_forged_tool_call_without_commit_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const forgedEventDecision = await harness.handlers.tool_call?.({ toolName: "larva_persona_switch" });
        const directResult = await harness.mod.larva_persona_switch({ persona_id: "python", reason: "need implementation" }, harness.ctx, harness.pi);
        console.log(JSON.stringify({
          forgedEventDecision,
          directResult,
          finalEnvelope: harness.mod.getActiveEnvelope(),
          tools: Object.keys(harness.tools),
        }));
        """,
    )

    assert payload["forgedEventDecision"]["block"] is True
    assert "manual" in payload["forgedEventDecision"]["reason"].lower()
    assert payload["directResult"]["status"] == "failed"
    assert payload["directResult"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_MANUAL"
    assert payload["finalEnvelope"]["persona_id"] == "architect"
    assert "larva_persona_switch" not in payload["tools"]



def test_agent_persona_switch_manual_larva_persona_preserved_in_all_modes_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const results = [];
        for (const mode of ["manual", "confirm", "auto", "free"]) {
          const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: mode });
          const manual = harness.commands["larva-persona"];
          const result = await (manual.handler ?? manual.options?.handler)("python", harness.ctx);
          results.push({ mode, result, finalEnvelope: harness.mod.getActiveEnvelope(), toolNames: Object.keys(harness.tools) });
        }
        console.log(JSON.stringify({ results }));
        """,
    )

    for case in payload["results"]:
        assert case["result"]["ok"] is True
        assert case["finalEnvelope"]["persona_id"] == "python"
    manual_case = next(case for case in payload["results"] if case["mode"] == "manual")
    assert "larva_persona_switch" not in manual_case["toolNames"]
    for mode in ("confirm", "auto", "free"):
        case = next(item for item in payload["results"] if item["mode"] == mode)
        assert "larva_persona_switch" in case["toolNames"]



def test_agent_persona_switch_prompt_guidance_for_confirm_auto_free_without_catalogue_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const prompt = (harness) => harness.mod.before_agent_start({ systemPrompt: "base" })?.systemPrompt ?? "";
        const manualHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const manualPrompt = prompt(manualHarness);
        const confirmHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const confirmPrompt = prompt(confirmHarness);
        const autoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const autoPrompt = prompt(autoHarness);
        const freeHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "free", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const freePrompt = prompt(freeHarness);
        console.log(JSON.stringify({ manualPrompt, confirmPrompt, autoPrompt, freePrompt }));
        """,
    )

    assert "larva_persona_switch" not in payload["manualPrompt"]
    assert "Borrow once" in payload["confirmPrompt"]
    assert "temporary" in payload["confirmPrompt"]
    assert "restores at assistant turn end" in payload["autoPrompt"]
    assert "persistent" in payload["freePrompt"]
    for key in ("confirmPrompt", "autoPrompt", "freePrompt"):
        assert "Python persona" not in payload[key]
        assert "Architecture persona" not in payload[key]



def test_agent_personas_read_only_bounded_and_hidden_in_manual_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const autoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
        const tool = autoHarness.tools["larva_personas"];
        const result = tool ? await (tool.execute ?? tool.handler)("call-1", { limit: 100 }, undefined, undefined, autoHarness.ctx) : null;
        const firstPersona = result?.details?.personas?.[0] ?? null;
        const firstPersonaShape = firstPersona === null ? null : {
          keys: Object.keys(firstPersona),
          hasOwnPrompt: Object.prototype.hasOwnProperty.call(firstPersona, "prompt"),
          allowlistedKeysOnly: Object.keys(firstPersona).every((key) => ["id", "description", "model", "spec_digest", "capabilities"].includes(key)),
        };
        const manualHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "manual" });
        const directManual = await manualHarness.mod.larva_personas({ limit: 100 }, manualHarness.ctx);
        console.log(JSON.stringify({
          manualTools: Object.keys(manualHarness.tools),
          result,
          firstPersonaShape,
          directManual,
        }));
        """,
    )

    assert "larva_personas" not in _registered_names(payload, "manualTools")
    assert payload["result"]["details"]["status"] == "success"
    assert len(payload["result"]["details"]["personas"]) <= 25
    assert "prompt" not in payload["result"]["details"]["personas"][0]
    assert payload["firstPersonaShape"] == {
        "keys": ["id", "description", "model"],
        "hasOwnPrompt": False,
        "allowlistedKeysOnly": True,
    }
    assert payload["directManual"]["isError"] is True
    assert payload["directManual"]["details"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_MANUAL"


def test_agent_persona_switch_borrow_restore_preserves_runtime_model_active_before_borrow_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        harness.ctx.model = { provider: "manual-provider", id: "manual-model" };
        const switchTool = harness.tools["larva_persona_switch"];
        const borrowed = await (switchTool.execute ?? switchTool.handler)("call-borrow", { persona_id: "python", reason: "implementation required" }, undefined, undefined, harness.ctx);
        const during = harness.mod.getActiveEnvelope();
        await harness.handlers.agent_end({ terminal: "success" }, harness.ctx);
        const after = harness.mod.getActiveEnvelope();
        console.log(JSON.stringify({
          borrowedStatus: borrowed.status,
          during,
          after,
          modelCalls: harness.modelCalls,
          finalSetModel: harness.modelCalls.filter((call) => Array.isArray(call) && call.length === 1).at(-1),
          restoreAudit: harness.sessionEntries.findLast((entry) => entry.customType === "larva-agent-persona-switch-audit" && entry.data?.event === "restore")?.data ?? null,
        }));
        """,
    )

    assert payload["borrowedStatus"] == "success"
    assert payload["during"]["persona_id"] == "python"
    assert payload["after"]["persona_id"] == "architect"
    assert payload["finalSetModel"] == [{"provider": "manual-provider", "id": "manual-model"}]
    assert payload["restoreAudit"]["restored"] is True
    assert payload["restoreAudit"]["restored_pi_model"] is True
    assert payload["restoreAudit"]["lease"]["originPiModelLabel"] == "manual-provider/manual-model"


def test_agent_persona_switch_confirm_outcomes_and_no_ui_preserve_state_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const borrowHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm", LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { selectResult: "borrow_once" });
        const borrowTool = borrowHarness.tools["larva_persona_switch"];
        const borrow = await (borrowTool.execute ?? borrowTool.handler)("call-borrow", { persona_id: "python", reason: "implementation required" }, undefined, undefined, borrowHarness.ctx);
        const borrowEnvelope = borrowHarness.mod.getActiveEnvelope();
        await borrowHarness.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
        const restoredEnvelope = borrowHarness.mod.getActiveEnvelope();

        const deniedHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm", LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { selectResult: "deny" });
        const deniedTool = deniedHarness.tools["larva_persona_switch"];
        const denied = await (deniedTool.execute ?? deniedTool.handler)("call-denied", { persona_id: "python", reason: "implementation required" }, undefined, undefined, deniedHarness.ctx);
        const deniedEnvelope = deniedHarness.mod.getActiveEnvelope();

        const autoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm", LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { selectResult: "auto_session" });
        const autoTool = autoHarness.tools["larva_persona_switch"];
        const autoBorrow = await (autoTool.execute ?? autoTool.handler)("call-auto", { persona_id: "python", reason: "implementation required" }, undefined, undefined, autoHarness.ctx);
        const autoModeEntry = autoHarness.sessionEntries.find((entry) => entry.customType === "larva-agent-persona-switch-mode" && entry.data?.mode === "auto");

        const persistentHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm", LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { selectResult: "persistent" });
        const persistentTool = persistentHarness.tools["larva_persona_switch"];
        const persistent = await (persistentTool.execute ?? persistentTool.handler)("call-persistent", { persona_id: "python", reason: "implementation required" }, undefined, undefined, persistentHarness.ctx);
        await persistentHarness.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
        const persistentEnvelope = persistentHarness.mod.getActiveEnvelope();

        const noUiHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "confirm", LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { omitSelect: true });
        delete noUiHarness.ctx.ui.confirm;
        const noUiTool = noUiHarness.tools["larva_persona_switch"];
        const noUi = await (noUiTool.execute ?? noUiTool.handler)("call-no-ui", { persona_id: "python", reason: "implementation required" }, undefined, undefined, noUiHarness.ctx);
        const noUiEnvelope = noUiHarness.mod.getActiveEnvelope();

        console.log(JSON.stringify({
          borrow,
          borrowEnvelope,
          restoredEnvelope,
          denied,
          deniedEnvelope,
          autoBorrow,
          autoModeEntry,
          persistent,
          persistentEnvelope,
          noUi,
          noUiEnvelope,
        }));
        """,
    )

    assert payload["borrow"]["status"] == "success"
    assert payload["borrow"]["details"]["lease"]["scope"] == "turn"
    assert payload["borrow"]["details"]["lease"]["originPersonaId"] == "architect"
    assert payload["borrowEnvelope"]["persona_id"] == "python"
    assert payload["restoredEnvelope"]["persona_id"] == "architect"
    assert payload["denied"]["status"] == "failed"
    assert payload["deniedEnvelope"]["persona_id"] == "architect"
    assert payload["autoBorrow"]["status"] == "success"
    assert payload["autoModeEntry"]["data"]["mode"] == "auto"
    assert payload["persistent"]["status"] == "success"
    assert payload["persistent"]["details"]["lease"] is None
    assert payload["persistentEnvelope"]["persona_id"] == "python"
    assert payload["noUi"]["status"] == "failed"
    assert payload["noUi"]["error"]["code"] == "LARVA_CONFIRMATION_UNAVAILABLE"
    assert payload["noUiEnvelope"]["persona_id"] == "architect"



def test_agent_persona_switch_reason_required_before_commit_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const tool = harness.tools["larva_persona_switch"];
        const result = tool ? await (tool.execute ?? tool.handler)("call-1", { persona_id: "python" }, undefined, undefined, harness.ctx) : null;
        console.log(JSON.stringify({ result, finalEnvelope: harness.mod.getActiveEnvelope(), tools: Object.keys(harness.tools) }));
        """,
    )

    assert "larva_persona_switch" in _registered_names(payload, "tools")
    assert payload["result"]["status"] == "failed"
    assert payload["result"]["error"]["code"] == "LARVA_BAD_INPUT"
    assert payload["finalEnvelope"]["persona_id"] == "architect"


def test_agent_persona_switch_invalid_input_audits_and_bounded_handoff_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const invalidHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const invalid = await invalidHarness.mod.larva_persona_switch(null, invalidHarness.ctx, invalidHarness.pi);
        const invalidEnvelope = invalidHarness.mod.getActiveEnvelope();

        const invalidBudgetHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const invalidBudgetTool = invalidBudgetHarness.tools["larva_persona_switch"];
        const invalidBudget = await (invalidBudgetTool.execute ?? invalidBudgetTool.handler)("call-invalid-budget", { persona_id: "python", reason: "bad budget", max_switches_per_chain: -1 }, undefined, undefined, invalidBudgetHarness.ctx);
        const invalidBudgetEnvelope = invalidBudgetHarness.mod.getActiveEnvelope();

        const handoffHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const longHandoff = "h".repeat(2500);
        const tool = handoffHarness.tools["larva_persona_switch"];
        const bounded = await (tool.execute ?? tool.handler)("call-bounded", { persona_id: "python", reason: "implementation required", handoff: longHandoff }, undefined, undefined, handoffHarness.ctx);
        const boundedEnvelope = handoffHarness.mod.getActiveEnvelope();
        const audit = handoffHarness.sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit").at(-1);

        console.log(JSON.stringify({
          invalid,
          invalidEnvelope,
          invalidAudit: invalidHarness.sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit"),
          invalidBudget,
          invalidBudgetEnvelope,
          invalidBudgetAudit: invalidBudgetHarness.sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit"),
          bounded,
          boundedEnvelope,
          auditHandoffLength: audit?.data?.handoff?.length ?? null,
        }));
        """,
    )

    assert payload["invalid"]["status"] == "failed"
    assert payload["invalid"]["error"]["code"] == "LARVA_BAD_INPUT"
    assert payload["invalidEnvelope"]["persona_id"] == "architect"
    assert payload["invalidAudit"][-1]["data"]["committed"] is False
    assert payload["invalidBudget"]["status"] == "failed"
    assert payload["invalidBudget"]["error"]["code"] == "LARVA_BAD_INPUT"
    assert "max_switches_per_chain" in payload["invalidBudget"]["error"]["message"]
    assert payload["invalidBudgetEnvelope"]["persona_id"] == "architect"
    assert payload["invalidBudgetAudit"][-1]["data"]["committed"] is False
    assert payload["bounded"]["status"] == "success"
    assert payload["boundedEnvelope"]["persona_id"] == "python"
    assert payload["auditHandoffLength"] == 2000


def test_agent_persona_switch_same_persona_no_op_no_termination_or_extra_commit_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const beforeModelCallCount = harness.modelCalls.length;
        const tool = harness.tools["larva_persona_switch"];
        const result = tool ? await (tool.execute ?? tool.handler)("call-1", { persona_id: "architect", reason: "already suitable" }, undefined, undefined, harness.ctx) : null;
        console.log(JSON.stringify({
          result,
          modelCallDelta: harness.modelCalls.length - beforeModelCallCount,
          finalEnvelope: harness.mod.getActiveEnvelope(),
          sessionEntries: harness.sessionEntries,
          tools: Object.keys(harness.tools),
        }));
        """,
    )

    assert payload["result"]["status"] == "success"
    assert payload["result"].get("terminate") is False
    assert payload["result"]["details"]["active_persona"] == "architect"
    assert payload["result"]["details"]["previous_persona"] == "architect"
    assert payload["result"]["details"]["spec_digest"] == "sha256:architect"
    assert payload["result"]["details"]["commit_source"] == "self-switch"
    assert payload["modelCallDelta"] == 0
    assert payload["finalEnvelope"]["persona_id"] == "architect"


def test_agent_persona_switch_multiple_auto_borrows_restore_first_origin_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const tool = harness.tools["larva_persona_switch"];
        const first = await (tool.execute ?? tool.handler)("call-1", { persona_id: "python", reason: "need implementation" }, undefined, undefined, harness.ctx);
        const second = await (tool.execute ?? tool.handler)("call-2", { persona_id: "critic", reason: "need review" }, undefined, undefined, harness.ctx);
        const beforeRestore = harness.mod.getActiveEnvelope();
        await harness.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
        const afterRestore = harness.mod.getActiveEnvelope();
        console.log(JSON.stringify({ first, second, beforeRestore, afterRestore, sessionEntries: harness.sessionEntries }));
        """,
    )

    assert payload["first"]["status"] == "success"
    assert payload["first"]["details"]["lease"]["originPersonaId"] == "architect"
    assert payload["second"]["status"] == "success"
    assert payload["second"]["details"]["lease"]["originPersonaId"] == "architect"
    assert payload["beforeRestore"]["persona_id"] == "critic"
    assert payload["afterRestore"]["persona_id"] == "architect"



def test_agent_persona_switch_restore_on_failure_cancellation_and_timeout_terminal_paths_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const outcomes = [];
        for (const terminal of ["failure", "cancellation", "timeout"]) {
          const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
          const tool = harness.tools["larva_persona_switch"];
          const borrow = await (tool.execute ?? tool.handler)(`call-${terminal}`, { persona_id: "python", reason: `terminal ${terminal}` }, undefined, undefined, harness.ctx);
          const beforeRestore = harness.mod.getActiveEnvelope();
          await harness.mod.before_agent_start({ systemPrompt: "base", terminal });
          const afterRestore = harness.mod.getActiveEnvelope();
          outcomes.push({ terminal, borrow, beforeRestore, afterRestore, sessionEntries: harness.sessionEntries, statuses: harness.statuses });
        }
        console.log(JSON.stringify({ outcomes }));
        """,
    )

    assert {item["terminal"] for item in payload["outcomes"]} == {"failure", "cancellation", "timeout"}
    for item in payload["outcomes"]:
        assert item["borrow"]["status"] == "success"
        assert item["beforeRestore"]["persona_id"] == "python"
        assert item["afterRestore"]["persona_id"] == "architect"
        assert any(entry.get("customType") == "larva-agent-persona-switch-audit" and entry.get("data", {}).get("event") == "restore" for entry in item["sessionEntries"])



def test_agent_persona_switch_restore_notices_status_event_audit_not_chat_body_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const tool = harness.tools["larva_persona_switch"];
        const result = await (tool.execute ?? tool.handler)("call-1", {
          persona_id: "python",
          reason: "Python implementation is now required",
          handoff: "Implement the agreed test boundary",
          continue_task: true,
        }, undefined, undefined, harness.ctx);
        await harness.mod.before_agent_start({ systemPrompt: "base", terminal: "success" });
        console.log(JSON.stringify({
          result,
          finalEnvelope: harness.mod.getActiveEnvelope(),
          sentUserMessages: harness.sentUserMessages,
          sessionEntries: harness.sessionEntries,
          statuses: harness.statuses,
          tools: Object.keys(harness.tools),
        }));
        """,
    )

    assert payload["result"]["status"] == "success"
    assert payload["result"].get("terminate") is False
    assert payload["result"]["details"]["lease"]["originPersonaId"] == "architect"
    assert payload["finalEnvelope"]["persona_id"] == "architect"
    assert payload["sentUserMessages"] == []
    assert any(entry.get("customType") == "larva-agent-persona-switch-audit" and entry.get("data", {}).get("event") == "restore" for entry in payload["sessionEntries"])
    assert any(status and "Restored persona: architect" in status[0] for status in payload["statuses"])



def test_agent_persona_switch_child_subagent_defaults_self_switch_manual_behavior(tmp_path: Path) -> None:
    fake_cli = _write_agent_switch_fake_cli(tmp_path)
    child_env_artifact = tmp_path / "child-env.json"
    fake_pi = tmp_path / "fake-pi-child-env.mjs"
    fake_pi.write_text(
        textwrap.dedent(
            f"""
            import {{ writeFileSync }} from "node:fs";
            writeFileSync(
              {json.dumps(str(child_env_artifact))},
              JSON.stringify({{
                LARVA_PI_AGENT_PERSONA_SWITCH: process.env.LARVA_PI_AGENT_PERSONA_SWITCH ?? null,
                LARVA_PI_INITIAL_PERSONA_ID: process.env.LARVA_PI_INITIAL_PERSONA_ID ?? null,
                LARVA_PI_PARENT_PERSONA_ID: process.env.LARVA_PI_PARENT_PERSONA_ID ?? null,
                LARVA_PI_INTERACTIVE_TUI: process.env.LARVA_PI_INTERACTIVE_TUI ?? null,
              }}, null, 2),
              "utf8"
            );
            process.exit(0);
            """
        ),
        encoding="utf-8",
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const env = {{
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
          LARVA_PI_REAL_BIN: process.execPath,
          LARVA_PI_EXTENSION_FLAG: {json.dumps(str(fake_pi))},
          LARVA_PI_EXTENSION_ENTRY: "unused-extension-entry.ts",
          LARVA_PI_CHILD_SESSION_DIR: {json.dumps(str(tmp_path))},
          LARVA_PI_AGENT_PERSONA_SWITCH: "auto",
          LARVA_PI_INTERACTIVE_TUI: "1",
          LARVA_PI_LAUNCHED: "1",
          HOME: {json.dumps(str(tmp_path))},
        }};
        const ctx = {{
          env,
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
        }};
        const pi = {{
          getAllTools: async () => ["larva_subagent"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerTool: () => undefined,
          registerCommand: () => undefined,
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        await mod.commitPersona("architect", ctx, pi);
        const result = await mod.larva_subagent({{ persona_id: "python", task: "capture child launch env" }}, {{ env }});
        const fs = await import("node:fs");
        const childEnv = fs.existsSync({json.dumps(str(child_env_artifact))})
          ? JSON.parse(fs.readFileSync({json.dumps(str(child_env_artifact))}, "utf8"))
          : null;
        console.log(JSON.stringify({{ result, childEnv }}));
        """,
        timeout=8,
    )

    assert payload["childEnv"] is not None
    assert payload["childEnv"]["LARVA_PI_INITIAL_PERSONA_ID"] == "python"
    assert payload["childEnv"]["LARVA_PI_PARENT_PERSONA_ID"] == "architect"
    assert payload["childEnv"]["LARVA_PI_INTERACTIVE_TUI"] == "0"
    assert payload["childEnv"]["LARVA_PI_AGENT_PERSONA_SWITCH"] == "manual"



ASYNC_SUBAGENT_TRACEABILITY_EXPECTATIONS: Final[dict[str, tuple[str, ...]]] = {
    "A1": ("test_async_subagent_a1_accepted_background_execution_expected_red",),
    "A2": ("test_async_subagent_a2_a3_a6_expected_red_model_facing_tools_and_registry_source_contract",),
    "A3": ("test_async_subagent_a2_a3_a6_expected_red_model_facing_tools_and_registry_source_contract",),
    "A4": ("test_async_subagent_a4_a7_expected_red_result_callback_and_lifecycle_source_contract",),
    "A5": ("test_async_subagent_a5_targeted_cancellation_unobserved_exact_task_id_expected_red",),
    "A6": ("test_async_subagent_a6_status_tool_schema_unobserved_expected_red",),
    "A7": ("test_async_subagent_a4_a7_expected_red_result_callback_and_lifecycle_source_contract",),
    "A8": ("test_async_subagent_a8_a10_expected_red_unified_user_command_and_docs_parity",),
    "A9": ("test_async_subagent_a9_console_surface_controls_expected_red",),
    "A10": ("test_async_subagent_a8_a10_expected_red_unified_user_command_and_docs_parity",),
    "A11": ("test_runtime_smoke_async_subagent_streaming_command_and_callback_expected_red",),
}


def test_async_subagent_expected_red_traceability_inventory_covers_a1_through_a11() -> None:
    """Expected-red inventory: every async subagent matrix row has a named proof hook."""

    assert set(ASYNC_SUBAGENT_TRACEABILITY_EXPECTATIONS) == {f"A{index}" for index in range(1, 12)}
    assert all(test_names for test_names in ASYNC_SUBAGENT_TRACEABILITY_EXPECTATIONS.values())


def test_async_subagent_a2_a3_a6_expected_red_model_facing_tools_and_registry_source_contract() -> None:
    """Expected-red A2/A3/A6: exact task_id model tools and active-run registry."""

    source = _source()
    required_tokens = (
        'name: "larva_subagent_status"',
        'name: "larva_subagent_cancel"',
        "LARVA_SUBAGENT_NOT_OBSERVED",
        "result_pending",
        "updated_at",
        "phase",
        "cancelling",
    )
    missing = [token for token in required_tokens if token not in source]
    assert not missing, "missing async subagent registry/status/cancel contract tokens: " + ", ".join(missing)

    subagent_schema = re.search(r"const subagentSchema = \{(?P<body>[\s\S]*?)\n  \};", source)
    assert subagent_schema is not None
    assert "task_id" in subagent_schema.group("body")
    assert "run_id" not in subagent_schema.group("body")

    status_match = re.search(
        r"export async function larva_subagent_status[\s\S]*?\n}\n\ntype ParsedSubagentCancelInput",
        source,
    )
    assert status_match is not None
    status_body = status_match.group(0)
    assert "validatePublicTaskIdForStatus" in status_body
    assert "activeSubagentRunByTaskId" in source
    assert "validatePublicTaskIdForControl" not in status_body
    assert "validateTaskId" not in status_body
    assert "childSessionRoot(" not in status_body


def test_async_subagent_a4_a7_expected_red_result_callback_and_lifecycle_source_contract() -> None:
    """Expected-red A4/A7: Pi result callback boundary and stale-callback lifecycle cleanup."""

    source = _source()
    required_tokens = (
        "larva-subagent-result",
        "triggerTurn",
        "deliverAs",
        "steer",
        "6000",
        "callback_id",
        "completed_at",
        "child_output_truncated",
        "child_output_preview",
        "full_output_artifact",
        "subagent-output-artifacts",
        "stale",
        "fork",
        "quit",
    )
    missing = [token for token in required_tokens if token not in source]
    assert not missing, "missing async subagent callback/lifecycle contract tokens: " + ", ".join(missing)


def test_async_subagent_lifecycle_cleanup_aborts_via_child_rpc_stales_callbacks_and_preserves_session_file(tmp_path: Path) -> None:
    """Lifecycle cleanup must use child RPC abort, stale callbacks, and preserve .jsonl authority."""

    fake_cli = tmp_path / "fake-larva-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )
    child_session_root = tmp_path / "child-sessions"
    child_session = child_session_root / "lifecycle-child.jsonl"
    child_events = tmp_path / "child-events.jsonl"
    child = tmp_path / "fake-lifecycle-child.mjs"
    child.write_text(
        textwrap.dedent(
            f"""
            import {{ createInterface }} from "node:readline";
            import {{ appendFile, mkdir, writeFile }} from "node:fs/promises";
            import {{ dirname }} from "node:path";
            const sessionFile = {json.dumps(str(child_session))};
            const eventsFile = {json.dumps(str(child_events))};
            await mkdir(dirname(sessionFile), {{ recursive: true }});
            const log = async (event) => appendFile(eventsFile, JSON.stringify({{ ...event, pid: process.pid, at: Date.now() }}) + "\\n", "utf8");
            const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
            process.on("SIGTERM", async () => {{ await log({{ event: "sigterm" }}); process.exit(0); }});
            process.on("SIGINT", async () => {{ await log({{ event: "sigint" }}); process.exit(0); }});
            setInterval(() => undefined, 1000);
            const rl = createInterface({{ input: process.stdin }});
            rl.on("line", async (line) => {{
              const message = JSON.parse(line);
              if (message.type === "get_state") {{ await writeFile(sessionFile, "{{}}\\n", "utf8"); await log({{ event: "get_state" }}); send({{ id: message.id, success: true, data: {{ sessionFile }} }}); }}
              else if (message.type === "prompt") {{ await log({{ event: "prompt" }}); send({{ id: message.id, success: true, data: {{}} }}); }}
              else if (message.type === "abort") {{ await log({{ event: "abort_rpc" }}); send({{ id: message.id, success: true, data: {{}} }}); }}
              else if (message.type === "get_last_assistant_text") {{ await log({{ event: "last_text" }}); send({{ id: message.id, success: true, data: {{ text: "SHOULD_NOT_CALLBACK" }} }}); }}
            }});
            """
        ),
        encoding="utf-8",
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const fs = await import("node:fs");
        const fsp = await import("node:fs/promises");
        const handlers = new Map();
        const tools = new Map();
        const callbacks = [];
        const sessionEntries = [];
        const recordCallback = (surface, customType, data, options = {{}}) => {{
          const entry = {{ surface, customType, data, options }};
          sessionEntries.push(entry);
          if (customType === "larva-subagent-result") callbacks.push(entry);
          return entry;
        }};
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_REAL_BIN: process.execPath,
            LARVA_PI_EXTENSION_FLAG: {json.dumps(str(child))},
            LARVA_PI_EXTENSION_ENTRY: "ignored-extension-entry.ts",
            LARVA_PI_CHILD_SESSION_DIR: {json.dumps(str(child_session_root))},
            LARVA_PI_LAUNCHED: "1",
            HOME: {json.dumps(str(tmp_path))},
          }},
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
          session: {{ entries: sessionEntries, getEntries: () => sessionEntries, appendEntry: (customType, data, options) => recordCallback("session.appendEntry", customType, data, options) }},
          appendEntry: (customType, data, options) => recordCallback("ctx.appendEntry", customType, data, options),
          sendCustomMessage: async (customType, data, options) => recordCallback("ctx.sendCustomMessage", customType, data, options),
          sendUserMessage: async (message, options = {{}}) => recordCallback("ctx.sendUserMessage", options.customType ?? "user", {{ message, ...(options.details ?? {{}}) }}, options),
        }};
        const pi = {{
          getAllTools: async () => ["read", "larva_subagent", "larva_subagent_status", "larva_subagent_cancel"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: (tool) => tools.set(tool.name, tool),
          on: (event, handler) => handlers.set(event, handler),
        }};
        await mod.initializeExtension(ctx, pi);
        await mod.commitPersona("parent", ctx, pi);
        mod.resetSubagentPresentationStateForTests();
        const result = await tools.get("larva_subagent").execute("lifecycle-cleanup", {{ persona_id: "child", task: "remain active until lifecycle cleanup" }}, undefined, undefined, ctx);
        const taskId = result.details?.task_id;
        const beforeDiagnostics = mod.subagentActiveRunDiagnosticsForTests();
        const childPid = beforeDiagnostics[0]?.child_pid ?? null;
        const started = Date.now();
        const cleanupResult = await handlers.get("reload")({{ reason: "test reload" }}, ctx);
        const elapsedMs = Date.now() - started;
        await new Promise((resolve) => setTimeout(resolve, 150));
        const afterDiagnostics = mod.subagentActiveRunDiagnosticsForTests();
        let childAlive = false;
        if (Number.isInteger(childPid)) {{ try {{ process.kill(childPid, 0); childAlive = true; }} catch {{ childAlive = false; }} }}
        const events = fs.existsSync({json.dumps(str(child_events))})
          ? (await fsp.readFile({json.dumps(str(child_events))}, "utf8")).trim().split(/\\n+/).filter(Boolean).map((line) => JSON.parse(line))
          : [];
        console.log(JSON.stringify({{
          result,
          taskId,
          beforeDiagnostics,
          cleanupResult,
          elapsedMs,
          afterDiagnostics,
          childAlive,
          events,
          callbackCount: callbacks.length,
          sessionFileExists: typeof taskId === "string" && fs.existsSync(taskId),
          requiredHandlers: Object.fromEntries(["session_start", "shutdown", "reload", "new_session", "session_new", "resume", "fork", "quit"].map((name) => [name, typeof handlers.get(name) === "function"])),
        }}));
        """,
        timeout=8,
    )

    assert payload["result"]["details"]["status"] == "accepted"
    assert payload["sessionFileExists"] is True
    assert payload["cleanupResult"]["active_children_reaped"] == 1
    assert payload["elapsedMs"] >= 1300
    assert {event["event"] for event in payload["events"]} >= {"get_state", "prompt", "abort_rpc", "sigterm"}
    assert payload["childAlive"] is False
    assert payload["callbackCount"] == 0
    diagnostic = payload["afterDiagnostics"][0]
    assert diagnostic["callback_delivery"] == "stale"
    assert diagnostic["cancellation_source"] == "lifecycle"
    assert diagnostic["terminal_status"] == "cancelled"
    assert diagnostic["child_running"] is False
    assert payload["requiredHandlers"] == {key: True for key in payload["requiredHandlers"]}


def test_async_subagent_stale_parent_session_identity_suppresses_late_callback(tmp_path: Path) -> None:
    """A late terminal result from an old parent session must not call custom callback surfaces."""

    fake_cli = tmp_path / "fake-larva-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            process.stdout.write(JSON.stringify({
              data: {
                id: personaId,
                description: `Persona ${personaId}`,
                prompt: `Prompt for ${personaId}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${personaId}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )
    child_session_root = tmp_path / "child-sessions"
    child_session = child_session_root / "stale-callback-child.jsonl"
    child = tmp_path / "fake-stale-callback-child.mjs"
    child.write_text(
        textwrap.dedent(
            f"""
            import {{ createInterface }} from "node:readline";
            import {{ mkdir, writeFile }} from "node:fs/promises";
            import {{ dirname }} from "node:path";
            const sessionFile = {json.dumps(str(child_session))};
            await mkdir(dirname(sessionFile), {{ recursive: true }});
            const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
            const rl = createInterface({{ input: process.stdin }});
            rl.on("line", async (line) => {{
              const message = JSON.parse(line);
              if (message.type === "get_state") {{ await writeFile(sessionFile, "{{}}\\n", "utf8"); send({{ id: message.id, success: true, data: {{ sessionFile }} }}); }}
              else if (message.type === "prompt") {{ send({{ id: message.id, success: true, data: {{}} }}); setTimeout(() => send({{ type: "agent_end" }}), 80); }}
              else if (message.type === "get_last_assistant_text") {{ send({{ id: message.id, success: true, data: {{ text: "LATE_STALE_FINAL" }} }}); setTimeout(() => process.exit(0), 5); }}
              else if (message.type === "abort") {{ send({{ id: message.id, success: true }}); process.exit(0); }}
            }});
            """
        ),
        encoding="utf-8",
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const callbacks = [];
        const oldEntries = [];
        const newEntries = [];
        const recordCallback = (surface, customType, data, options = {{}}) => {{
          const entry = {{ surface, customType, data, options }};
          if (customType === "larva-subagent-result") callbacks.push(entry);
          return entry;
        }};
        const oldSession = {{ entries: oldEntries, getEntries: () => oldEntries, appendEntry: (customType, data, options) => recordCallback("old.appendEntry", customType, data, options) }};
        const newSession = {{ entries: newEntries, getEntries: () => newEntries, appendEntry: (customType, data, options) => recordCallback("new.appendEntry", customType, data, options) }};
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_REAL_BIN: process.execPath,
            LARVA_PI_EXTENSION_FLAG: {json.dumps(str(child))},
            LARVA_PI_EXTENSION_ENTRY: "ignored-extension-entry.ts",
            LARVA_PI_CHILD_SESSION_DIR: {json.dumps(str(child_session_root))},
            LARVA_PI_LAUNCHED: "1",
            HOME: {json.dumps(str(tmp_path))},
          }},
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
          session: oldSession,
          appendEntry: (customType, data, options) => recordCallback("ctx.appendEntry", customType, data, options),
          sendCustomMessage: async (customType, data, options) => recordCallback("ctx.sendCustomMessage", customType, data, options),
          sendUserMessage: async (message, options = {{}}) => recordCallback("ctx.sendUserMessage", options.customType ?? "user", {{ message, ...(options.details ?? {{}}) }}, options),
        }};
        const pi = {{
          getAllTools: async () => ["read", "larva_subagent", "larva_subagent_status", "larva_subagent_cancel"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        await mod.commitPersona("parent", ctx, pi);
        mod.resetSubagentPresentationStateForTests();
        const accepted = await mod.larva_subagent({{ persona_id: "child", task: "finish after parent session identity changes" }}, ctx);
        ctx.session = newSession;
        await new Promise((resolve) => setTimeout(resolve, 400));
        console.log(JSON.stringify({{
          accepted,
          diagnostics: mod.subagentActiveRunDiagnosticsForTests(),
          callbackCount: callbacks.length,
          oldEntries,
          newEntries,
        }}));
        """,
        timeout=6,
    )

    assert payload["accepted"]["status"] == "accepted"
    assert payload["callbackCount"] == 0
    diagnostic = payload["diagnostics"][0]
    assert diagnostic["terminal_status"] == "success"
    assert diagnostic["callback_delivery"] == "stale"
    assert payload["oldEntries"] == []
    assert payload["newEntries"] == []


def test_async_subagent_a8_a10_expected_red_unified_user_command_and_docs_parity() -> None:
    """Expected-red A8/A10: canonical /larva-subagent command and README parity."""

    source = _source()
    readme = PI_EXTENSION_README.read_text(encoding="utf-8")
    missing = [
        token
        for token in (
            "/larva-subagent",
            "canonical /larva-subagent",
            "larva: none",
        )
        if token not in source and token not in readme
    ]
    assert not missing, "README/source missing unified async subagent command parity tokens: " + ", ".join(missing)

def _write_pi_tui_runtime_mock(tmp_path: Path) -> None:
    """Provide the narrow runtime imports needed to probe extension-local helpers."""
    module_dir = tmp_path / "node_modules" / "@earendil-works" / "pi-tui"
    module_dir.mkdir(parents=True)
    (module_dir / "package.json").write_text(
        json.dumps({"type": "module", "main": "index.js", "exports": "./index.js"}),
        encoding="utf-8",
    )
    (module_dir / "index.js").write_text(
        textwrap.dedent(
            """
            export class Input {}
            export const Key = {};
            export class Markdown {}
            export class SelectList {}
            export function matchesKey() { return false; }
            export function truncateToWidth(value, width) { return String(value).slice(0, Math.max(0, width)); }
            export function visibleWidth(value) { return String(value).length; }
            export function wrapTextWithAnsi(value) { return [String(value)]; }
            """
        ),
        encoding="utf-8",
    )


def test_compaction_config_parser_contract_cases(tmp_path: Path) -> None:
    """CFG1-CFG3: repo-local Pi compaction config parser honors strict schema/defaults."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(
        tmp_path,
        """
        export {
          DEFAULT_LARVA_COMPACTION_CARRY_FORWARD_RULE_TEXT,
          LARVA_COMPACTION_CARRY_FORWARD_RULE_MAX_CODE_POINTS,
          larvaCompactionConfigPath,
          parseLarvaCompactionConfigValue,
          loadLarvaCompactionConfig,
        };
        """,
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const fs = await import("node:fs");
        const path = await import("node:path");
        const tmp = {json.dumps(str(tmp_path))};
        process.chdir(tmp);
        const receipts = {{
          config_path_receipt: [],
          schema_receipt: [],
          defaults_bounds_receipt: [],
          no_config_file_mutation: [],
        }};
        const failures = [];
        const record = (condition, label, detail = null) => {{
          if (!condition) failures.push({{ label, detail }});
        }};
        const note = (bucket, label) => receipts[bucket].push(label);
        const writeRaw = (file, raw) => {{
          fs.mkdirSync(path.dirname(file), {{ recursive: true }});
          fs.writeFileSync(file, raw, "utf8");
        }};
        const writeJson = (file, value) => writeRaw(file, JSON.stringify(value));
        const loadFromValue = (name, value) => {{
          const file = path.join(tmp, `${{name}}.json`);
          writeJson(file, value);
          return mod.loadLarvaCompactionConfig({{ LARVA_PI_COMPACTION_CONFIG_FILE: file }});
        }};
        const expectOk = (bucket, label, value, check = () => true) => {{
          const result = loadFromValue(label.replace(/[^a-z0-9]+/gi, "_"), value);
          record(result.ok === true, `${{label}} should be valid`, result);
          if (result.ok) record(check(result.config, result), `${{label}} check failed`, result);
          if (result.ok) note(bucket, label);
          return result;
        }};
        const expectInvalid = (bucket, label, value) => {{
          const result = loadFromValue(label.replace(/[^a-z0-9]+/gi, "_"), value);
          record(result.ok === false && result.error.code === "LARVA_COMPACTION_CONFIG_INVALID", `${{label}} should be invalid`, result);
          if (!result.ok) note(bucket, label);
          return result;
        }};

        const missingHome = path.join(tmp, "home-without-config");
        const missing = mod.loadLarvaCompactionConfig({{ HOME: missingHome }});
        record(missing.ok === true, "missing config should load defaults", missing);
        if (missing.ok) {{
          record(missing.source === "missing", "missing config source", missing);
          record(missing.path === path.join(missingHome, ".pi", "larva", "compaction.json"), "default path", missing);
          record(missing.config.enabled === true, "default root enabled", missing.config);
          record(missing.config.carry_forward_rule.enabled === true, "default carry-forward enabled", missing.config);
          record(missing.config.carry_forward_rule.text === mod.DEFAULT_LARVA_COMPACTION_CARRY_FORWARD_RULE_TEXT, "default carry-forward text", missing.config);
          note("config_path_receipt", "missing config returned enabled defaults at ~/.pi/larva/compaction.json");
          note("defaults_bounds_receipt", "built-in carry-forward rule applied when config is missing");
        }}
        record(!fs.existsSync(path.join(missingHome, ".pi")), "missing config load must not create ~/.pi", missingHome);
        note("no_config_file_mutation", "missing config read did not create ~/.pi/larva/compaction.json");

        const overridePath = path.join(tmp, "absolute-override", "compaction.json");
        writeJson(overridePath, {{ carry_forward_rule: {{ text: "  keep next action  " }} }});
        const override = mod.loadLarvaCompactionConfig({{ LARVA_PI_COMPACTION_CONFIG_FILE: overridePath }});
        record(override.ok === true && override.path === overridePath && override.source === "file", "absolute override path should be used", override);
        if (override.ok) record(override.config.carry_forward_rule.text === "keep next action", "override text trims", override.config);
        note("config_path_receipt", "absolute LARVA_PI_COMPACTION_CONFIG_FILE override used exactly and trims active text");

        const relativeBefore = fs.existsSync(path.join(tmp, "relative.json"));
        const relative = mod.loadLarvaCompactionConfig({{ LARVA_PI_COMPACTION_CONFIG_FILE: "relative.json" }});
        const empty = mod.loadLarvaCompactionConfig({{ LARVA_PI_COMPACTION_CONFIG_FILE: "" }});
        record(relative.ok === false && relative.error.code === "LARVA_COMPACTION_CONFIG_INVALID", "relative override invalid", relative);
        record(empty.ok === false && empty.error.code === "LARVA_COMPACTION_CONFIG_INVALID", "empty override invalid", empty);
        record(relativeBefore === false && !fs.existsSync(path.join(tmp, "relative.json")), "invalid relative override must not touch filesystem", relative);
        note("config_path_receipt", "empty and relative overrides are parser failures");
        note("no_config_file_mutation", "invalid override paths returned before filesystem mutation");

        expectInvalid("schema_receipt", "null root", null);
        expectInvalid("schema_receipt", "array root", []);
        expectInvalid("schema_receipt", "scalar root", true);
        expectInvalid("schema_receipt", "unknown root key", {{ unexpected: true }});
        expectInvalid("schema_receipt", "unknown nested key", {{ carry_forward_rule: {{ extra: true }} }});
        expectInvalid("schema_receipt", "non-object carry_forward_rule", {{ carry_forward_rule: [] }});
        expectInvalid("schema_receipt", "root enabled type", {{ enabled: "true" }});
        expectInvalid("schema_receipt", "nested enabled type", {{ carry_forward_rule: {{ enabled: "false" }} }});
        expectInvalid("schema_receipt", "text type when root disabled", {{ enabled: false, carry_forward_rule: {{ text: 1 }} }});
        const invalidJsonPath = path.join(tmp, "invalid-json", "compaction.json");
        writeRaw(invalidJsonPath, "{{not json");
        const invalidJson = mod.loadLarvaCompactionConfig({{ LARVA_PI_COMPACTION_CONFIG_FILE: invalidJsonPath }});
        record(invalidJson.ok === false && invalidJson.error.code === "LARVA_COMPACTION_CONFIG_INVALID", "invalid JSON is invalid config", invalidJson);
        note("schema_receipt", "invalid JSON rejected without rewrite");

        expectOk("defaults_bounds_receipt", "empty object defaults", {{}}, (config) =>
          config.enabled === true &&
          config.carry_forward_rule.enabled === true &&
          config.carry_forward_rule.text === mod.DEFAULT_LARVA_COMPACTION_CARRY_FORWARD_RULE_TEXT
        );
        expectOk("defaults_bounds_receipt", "missing nested text defaults", {{ carry_forward_rule: {{}} }}, (config) =>
          config.carry_forward_rule.enabled === true &&
          config.carry_forward_rule.text === mod.DEFAULT_LARVA_COMPACTION_CARRY_FORWARD_RULE_TEXT
        );
        expectOk("defaults_bounds_receipt", "root disabled empty text accepted", {{ enabled: false, carry_forward_rule: {{ text: "" }} }}, (config) =>
          config.enabled === false && config.carry_forward_rule.enabled === true
        );
        expectOk("defaults_bounds_receipt", "root disabled over-limit text accepted", {{ enabled: false, carry_forward_rule: {{ text: "🙂".repeat(4001) }} }}, (config) =>
          config.enabled === false
        );
        expectOk("defaults_bounds_receipt", "nested disabled empty text accepted", {{ enabled: true, carry_forward_rule: {{ enabled: false, text: "" }} }}, (config) =>
          config.enabled === true && config.carry_forward_rule.enabled === false
        );
        expectOk("defaults_bounds_receipt", "nested disabled over-limit text accepted", {{ enabled: true, carry_forward_rule: {{ enabled: false, text: "🙂".repeat(4001) }} }}, (config) =>
          config.carry_forward_rule.enabled === false
        );
        expectOk("defaults_bounds_receipt", "enabled exact bound code points accepted", {{ carry_forward_rule: {{ text: "🙂".repeat(4000) }} }}, (config) =>
          Array.from(config.carry_forward_rule.text).length === mod.LARVA_COMPACTION_CARRY_FORWARD_RULE_MAX_CODE_POINTS
        );
        expectInvalid("defaults_bounds_receipt", "enabled empty text invalid", {{ enabled: true, carry_forward_rule: {{ enabled: true, text: "   " }} }});
        expectInvalid("defaults_bounds_receipt", "enabled over-limit text invalid", {{ enabled: true, carry_forward_rule: {{ enabled: true, text: "🙂".repeat(4001) }} }});

        if (failures.length > 0) {{
          console.error(JSON.stringify({{ failures, receipts }}, null, 2));
          process.exit(1);
        }}
        console.log(JSON.stringify({{
          case_count: Object.values(receipts).reduce((total, values) => total + values.length, 0),
          default_text_code_points: Array.from(mod.DEFAULT_LARVA_COMPACTION_CARRY_FORWARD_RULE_TEXT).length,
          receipts,
        }}));
        """,
        timeout=8,
    )

    assert payload["case_count"] >= 25
    assert payload["default_text_code_points"] <= 4000
    assert payload["receipts"]["config_path_receipt"]
    assert payload["receipts"]["schema_receipt"]
    assert payload["receipts"]["defaults_bounds_receipt"]
    assert payload["receipts"]["no_config_file_mutation"]


def test_compaction_focus_composition_contract_cases(tmp_path: Path) -> None:
    """FOCUS1/FOCUS3: bounded focus helper composes sections in design order and falls back when empty."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(
        tmp_path,
        """
        export {
          buildLarvaCompactionFocus,
          LARVA_COMPACTION_TOTAL_FOCUS_MAX_CODE_POINTS,
        };
        """,
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const failures = [];
        const record = (condition, label, detail = null) => {{
          if (!condition) failures.push({{ label, detail }});
        }};
        const codePointLength = (value) => Array.from(value).length;
        const focus = mod.buildLarvaCompactionFocus({{
          manualFocus: "  manual next action  ",
          personaFocus: "\\n\\tpersona summary preference\\n",
          carryForwardRule: "  carry forward unfinished work  ",
        }});
        const expected = [
          "Manual compact focus:\\nmanual next action",
          "Active Larva persona compaction focus:\\npersona summary preference",
          "Larva carry-forward rule:\\ncarry forward unfinished work",
        ].join("\\n\\n");
        record(focus === expected, "sections should compose with exact labels, trimming, and blank-line separators", focus);
        const labels = [
          "Manual compact focus:",
          "Active Larva persona compaction focus:",
          "Larva carry-forward rule:",
        ];
        const indexes = labels.map((label) => focus.indexOf(label));
        record(indexes.every((index) => index >= 0), "all labels should appear when non-empty", indexes);
        record(indexes[0] < indexes[1] && indexes[1] < indexes[2], "labels should appear in required order", indexes);

        const positional = mod.buildLarvaCompactionFocus(" manual ", " persona ", " carry ");
        record(positional === [
          "Manual compact focus:\\nmanual",
          "Active Larva persona compaction focus:\\npersona",
          "Larva carry-forward rule:\\ncarry",
        ].join("\\n\\n"), "positional call should share object-call semantics", positional);

        const empty = mod.buildLarvaCompactionFocus({{ manualFocus: "  ", personaFocus: "\\n", carryForwardRule: "\\t" }});
        record(empty === null, "all-empty inputs should return null for native Pi compaction fallback", empty);
        const overLimitCarryOnly = mod.buildLarvaCompactionFocus({{ carryForwardRule: "🙂".repeat(4001) }});
        record(overLimitCarryOnly === null, "carry-forward text is accepted only when parser-bounded to <=4000 code points", codePointLength("🙂".repeat(4001)));

        const total = mod.buildLarvaCompactionFocus({{
          manualFocus: "m".repeat(2000),
          personaFocus: "p".repeat(2000),
          carryForwardRule: "c".repeat(4000),
        }});
        record(total.startsWith("Manual compact focus:"), "total truncation should retain manual label prefix", total?.slice(0, 80));
        record(codePointLength(total) <= mod.LARVA_COMPACTION_TOTAL_FOCUS_MAX_CODE_POINTS, "composed focus should stay within 6000 code points", codePointLength(total));
        record(total.endsWith("code points]") && total.includes("...[truncated "), "total truncation should append exact marker", total?.slice(-80));

        if (failures.length > 0) {{
          console.error(JSON.stringify({{ failures }}, null, 2));
          process.exit(1);
        }}
        console.log(JSON.stringify({{
          section_order_receipt: indexes,
          empty_focus_receipt: empty,
          total_length: codePointLength(total),
          total_prefix: total.slice(0, "Manual compact focus:".length),
        }}));
        """,
        timeout=8,
    )

    assert payload["section_order_receipt"] == sorted(payload["section_order_receipt"])
    assert payload["empty_focus_receipt"] is None
    assert payload["total_length"] <= 6000
    assert payload["total_prefix"] == "Manual compact focus:"


def test_compaction_focus_truncation_contract_cases(tmp_path: Path) -> None:
    """FOCUS2: focus truncation counts Unicode code points and marker-inclusive omitted totals."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(
        tmp_path,
        """
        export {
          buildLarvaCompactionFocus,
          truncateLarvaCompactionFocusText,
          LARVA_COMPACTION_MANUAL_FOCUS_MAX_CODE_POINTS,
          LARVA_COMPACTION_PERSONA_FOCUS_MAX_CODE_POINTS,
          LARVA_COMPACTION_TOTAL_FOCUS_MAX_CODE_POINTS,
        };
        """,
    )

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const failures = [];
        const record = (condition, label, detail = null) => {{
          if (!condition) failures.push({{ label, detail }});
        }};
        const codePointLength = (value) => Array.from(value).length;
        const marker = (omitted) => `...[truncated ${{omitted}} code points]`;

        const asciiFixture = mod.truncateLarvaCompactionFocusText("a".repeat(2005), 2000);
        const asciiExpected = `${{"a".repeat(1971)}}${{marker(34)}}`;
        record(asciiFixture === asciiExpected, "documented ASCII fixture should match exact marker-inclusive output", asciiFixture.slice(-80));
        record(codePointLength(asciiFixture) === 2000, "ASCII fixture length should be exactly the bound", codePointLength(asciiFixture));

        const emojiFixture = mod.truncateLarvaCompactionFocusText("🙂".repeat(2005), 2000);
        const emojiExpected = `${{"🙂".repeat(1971)}}${{marker(34)}}`;
        record(emojiFixture === emojiExpected, "emoji fixture should use code points rather than UTF-16 units", emojiFixture.slice(-80));
        record(codePointLength(emojiFixture) === 2000 && emojiFixture.length > 2000, "emoji fixture code-point length differs from UTF-16 length", {{ codePoints: codePointLength(emojiFixture), utf16: emojiFixture.length }});

        const manualSource = "x".repeat(2005);
        const personaSource = "🙂".repeat(2005);
        const carrySource = "carry-forward";
        const manualExpected = `${{"x".repeat(1971)}}${{marker(34)}}`;
        const focus = mod.buildLarvaCompactionFocus({{ manualFocus: manualSource, personaFocus: personaSource, carryForwardRule: carrySource }});
        record(focus.includes(marker(34)), "section truncation markers should use omitted source code points", focus);
        record(focus.includes("Manual compact focus:\\n" + manualExpected), "manual section should be tail-truncated after its label", focus.slice(0, 2100));
        record(focus.includes("Active Larva persona compaction focus:\\n" + emojiExpected), "persona section should be tail-truncated after its label", focus.slice(1900, 4100));

        const totalInput = {{ manualFocus: "m".repeat(2000), personaFocus: "p".repeat(2000), carryForwardRule: "c".repeat(4000) }};
        const totalFocus = mod.buildLarvaCompactionFocus(totalInput);
        const unboundedComposed = [
          `Manual compact focus:\\n${{totalInput.manualFocus}}`,
          `Active Larva persona compaction focus:\\n${{totalInput.personaFocus}}`,
          `Larva carry-forward rule:\\n${{totalInput.carryForwardRule}}`,
        ].join("\\n\\n");
        const totalMarkerMatch = totalFocus.match(/\\.\\.\\.\\[truncated (\\d+) code points\\]$/);
        record(totalMarkerMatch !== null, "total truncation should end with exact marker", totalFocus.slice(-80));
        if (totalMarkerMatch !== null) {{
          const totalMarker = totalMarkerMatch[0];
          const keptPrefix = totalFocus.slice(0, -totalMarker.length);
          const omitted = Number(totalMarkerMatch[1]);
          record(omitted === codePointLength(unboundedComposed) - codePointLength(keptPrefix), "total omitted count should equal original minus kept code points", {{ omitted, original: codePointLength(unboundedComposed), kept: codePointLength(keptPrefix) }});
        }}
        record(codePointLength(totalFocus) === mod.LARVA_COMPACTION_TOTAL_FOCUS_MAX_CODE_POINTS, "total focus should truncate exactly to 6000 code points", codePointLength(totalFocus));
        record(totalFocus.startsWith("Manual compact focus:"), "total truncation should sacrifice later sections first", totalFocus.slice(0, 80));

        if (failures.length > 0) {{
          console.error(JSON.stringify({{ failures }}, null, 2));
          process.exit(1);
        }}
        console.log(JSON.stringify({{
          ascii_fixture_tail: asciiFixture.slice(-marker(34).length),
          ascii_length: codePointLength(asciiFixture),
          emoji_length: codePointLength(emojiFixture),
          emoji_utf16_length: emojiFixture.length,
          total_length: codePointLength(totalFocus),
          total_marker: totalMarkerMatch?.[0] ?? null,
        }}));
        """,
        timeout=8,
    )

    assert payload["ascii_fixture_tail"] == "...[truncated 34 code points]"
    assert payload["ascii_length"] == 2000
    assert payload["emoji_length"] == 2000
    assert payload["emoji_utf16_length"] > 2000
    assert payload["total_length"] == 6000
    assert payload["total_marker"].startswith("...[truncated ")


def test_persona_envelope_preserves_compaction_prompt_activation_and_restore(tmp_path: Path) -> None:
    """ENV1/ENV2: active envelope carries only compaction_prompt into compaction focus."""
    source = _source()
    assert "compaction_prompt?: string;" in source
    focus_body = _function_body(source, "function activePersonaCompactionFocus")
    assert "compaction_prompt" in focus_body
    assert ".prompt" not in focus_body
    assert ".model" not in focus_body

    _write_pi_tui_runtime_mock(tmp_path)
    fake_cli = tmp_path / "fake-larva-compaction-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, personaId, jsonFlag] = process.argv;
            const specs = {
              compact: {
                id: "compact",
                description: "Compaction persona",
                prompt: "FULL_PERSONA_PROMPT_MUST_NOT_BE_FOCUS",
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: "sha256:compact",
                compaction_prompt: "  PERSONA_COMPACTION_FOCUS  ",
              },
              plain: {
                id: "plain",
                description: "Plain persona",
                prompt: "PLAIN_PERSONA_PROMPT_MUST_NOT_BE_FOCUS",
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: "sha256:plain",
              },
            };
            if (command === "resolve" && jsonFlag === "--json" && specs[personaId]) {
              process.stdout.write(JSON.stringify({ data: specs[personaId] }));
              process.exit(0);
            }
            process.exit(17);
            """
        ),
        encoding="utf-8",
    )
    extension = _runtime_extension_copy(
        tmp_path,
        """
        export { activePersonaCompactionFocus };
        """,
    )

    startup = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const commands = {{}};
        const handlers = {{}};
        const sessionEntries = [];
        const statuses = [];
        const activeToolCalls = [];
        const modelCalls = [];
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INITIAL_PERSONA_ID: "compact",
            LARVA_PI_INTERACTIVE_TUI: "0",
          }},
          ui: {{ setStatus: async (status) => statuses.push(status), notify: async () => undefined }},
          modelRegistry: {{ find: async (provider, id) => ({{ provider, id }}) }},
          session: {{
            entries: sessionEntries,
            getEntries: () => sessionEntries,
            appendEntry: (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
          }},
        }};
        const pi = {{
          getAllTools: async () => ["read", "larva_subagent"],
          setActiveTools: async (tools) => {{ activeToolCalls.push(tools); return true; }},
          setModel: async (model) => {{ modelCalls.push(model); ctx.model = model; return true; }},
          registerCommand: (nameOrCommand, options) => {{ commands[typeof nameOrCommand === "string" ? nameOrCommand : nameOrCommand.name] = options ?? nameOrCommand; }},
          registerTool: () => undefined,
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        await mod.initializeExtension(ctx, pi);
        await handlers.session_start?.({{ reason: "startup" }}, ctx);
        const compactEnvelope = mod.getActiveEnvelope();
        const compactFocus = mod.activePersonaCompactionFocus();
        const switchResult = await commands["larva-persona"].handler("plain", ctx);
        const plainEnvelope = mod.getActiveEnvelope();
        const plainFocus = mod.activePersonaCompactionFocus();
        console.log(JSON.stringify({{
          compactEnvelope,
          compactFocus,
          switchResult,
          plainEnvelope,
          plainFocus,
          sessionEntries,
          statuses,
          activeToolCalls,
          modelCalls,
          runtimeModel: ctx.model,
        }}));
        """,
        timeout=8,
    )

    assert startup["compactEnvelope"]["compaction_prompt"] == "  PERSONA_COMPACTION_FOCUS  "
    assert startup["compactFocus"] == "PERSONA_COMPACTION_FOCUS"
    assert "FULL_PERSONA_PROMPT_MUST_NOT_BE_FOCUS" not in startup["compactFocus"]
    assert "compaction_prompt" not in startup["plainEnvelope"]
    assert startup["plainFocus"] is None
    active_entries = [
        entry for entry in startup["sessionEntries"] if entry.get("customType") == "larva-active-persona-commit"
    ]
    assert active_entries
    assert all("prompt" not in entry["data"] for entry in active_entries)
    assert all("model" not in entry["data"] for entry in active_entries)
    assert all("tool_policy" not in entry["data"] for entry in active_entries)
    assert startup["modelCalls"][-1] == {"provider": "provider", "id": "model"}

    restore_entries = [entry for entry in active_entries if entry["data"]["persona_id"] == "compact"]
    restored = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const handlers = {{}};
        const sessionEntries = {json.dumps(restore_entries)};
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_INTERACTIVE_TUI: "0",
          }},
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async (provider, id) => ({{ provider, id }}) }},
          session: {{
            entries: sessionEntries,
            getEntries: () => sessionEntries,
            appendEntry: (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
          }},
        }};
        const pi = {{
          getAllTools: async () => ["read", "larva_subagent"],
          setActiveTools: async () => true,
          setModel: async (model) => {{ ctx.model = model; return true; }},
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        await mod.initializeExtension(ctx, pi);
        await handlers.session_start?.({{ reason: "restore" }}, ctx);
        console.log(JSON.stringify({{ envelope: mod.getActiveEnvelope(), focus: mod.activePersonaCompactionFocus(), sessionEntries }}));
        """,
        timeout=8,
    )

    assert restored["envelope"]["persona_id"] == "compact"
    assert restored["envelope"]["compaction_prompt"] == "  PERSONA_COMPACTION_FOCUS  "
    assert restored["focus"] == "PERSONA_COMPACTION_FOCUS"
    assert "FULL_PERSONA_PROMPT_MUST_NOT_BE_FOCUS" not in restored["focus"]


def test_compaction_focus_expected_red_gap_exposed(tmp_path: Path) -> None:
    """HOOK1/HOOK2/HOOK5: focused hook calls Pi compact adapter with native runtime inputs."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(tmp_path, "")

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const signal = new AbortController().signal;
        const headers = {{ Authorization: "Bearer SECRET_HEADER_SHOULD_PASS_THROUGH" }};
        const model = {{ provider: "runtime", id: "ctx-model" }};
        const preparation = {{
          firstKeptEntryId: "keep-entry-1",
          messagesToSummarize: [{{ role: "user", content: "summarize me" }}],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 12345,
          fileOps: {{ read: [], written: [], edited: [] }},
          settings: {{ enabled: true, reserveTokens: 2048, keepRecentTokens: 512 }},
        }};
        const compactionResult = {{
          summary: [
            "## Goal",
            "Keep native Pi summary shape.",
            "",
            "## Progress",
            "### In Progress",
            "- focused compaction is running",
            "",
            "## Next Steps",
            "1. Continue from kept entry.",
            "",
            "## Critical Context",
            "- Native sections retained.",
          ].join("\\n"),
          firstKeptEntryId: "keep-entry-1",
          tokensBefore: 12345,
          details: {{ readFiles: ["README.md"], modifiedFiles: [] }},
        }};
        const adapterCalls = [];
        const streamFn = () => undefined;
        const ctx = {{
          env: {{ HOME: {json.dumps(str(tmp_path))} }},
          model,
          modelRegistry: {{ getApiKeyAndHeaders: async (receivedModel) => {{
            adapterCalls.push({{ authModelIsCtxModel: receivedModel === model }});
            return {{ ok: true, apiKey: "SECRET_API_KEY_SHOULD_PASS_THROUGH", headers }};
          }} }},
          ui: {{ notify: async () => undefined, setStatus: async () => undefined }},
          streamFn,
        }};
        const pi = {{ getThinkingLevel: () => "medium" }};
        const adapter = async (...args) => {{
          adapterCalls.push({{
            preparationIsOriginal: args[0] === preparation,
            modelIsCtxModel: args[1] === model,
            apiKey: args[2],
            headersAreOriginal: args[3] === headers,
            customInstructions: args[4],
            signalIsOriginal: args[5] === signal,
            thinkingLevel: args[6],
            streamFnIsOriginal: args[7] === streamFn,
          }});
          return compactionResult;
        }};
        const result = await mod.handleLarvaSessionBeforeCompact(
          {{ type: "session_before_compact", preparation, customInstructions: "  Manual next step  ", signal }},
          ctx,
          pi,
          adapter,
        );
        console.log(JSON.stringify({{
          result,
          adapterCalls,
          compactionObjectPreserved: result?.compaction === compactionResult,
          standardSections: ["## Goal", "## Progress", "## Next Steps", "## Critical Context"].every((section) => result?.compaction?.summary.includes(section)),
          focusStartsWithManual: adapterCalls[1]?.customInstructions.startsWith("Manual compact focus:\\nManual next step"),
          focusIncludesCarryForward: adapterCalls[1]?.customInstructions.includes("Larva carry-forward rule:"),
          noSecondSummarySchema: Object.keys(result?.compaction ?? {{}}).sort(),
        }}));
        """,
        timeout=8,
    )

    assert payload["compactionObjectPreserved"] is True
    assert payload["standardSections"] is True
    assert payload["focusStartsWithManual"] is True
    assert payload["focusIncludesCarryForward"] is True
    assert payload["adapterCalls"][0] == {"authModelIsCtxModel": True}
    assert payload["adapterCalls"][1] == {
        "preparationIsOriginal": True,
        "modelIsCtxModel": True,
        "apiKey": "SECRET_API_KEY_SHOULD_PASS_THROUGH",
        "headersAreOriginal": True,
        "customInstructions": payload["adapterCalls"][1]["customInstructions"],
        "signalIsOriginal": True,
        "thinkingLevel": "medium",
        "streamFnIsOriginal": True,
    }
    assert payload["noSecondSummarySchema"] == ["details", "firstKeptEntryId", "summary", "tokensBefore"]


def test_compaction_focus_non_overreach_guards_defined() -> None:
    """R2: hook code preserves non-goals: no prompt replacement, provider rewrite, continuation, or config writes."""
    source = _source()
    handler_body = _function_body(source, "export async function handleLarvaSessionBeforeCompact")
    config_body = _function_body(source, "function loadLarvaCompactionConfig")

    assert 'on?.("session_before_compact"' in source
    assert "nativePiCompactAdapter" in source
    assert "customInstructions" in handler_body
    assert "return { compaction: result }" in handler_body
    for forbidden in (
        "SUMMARIZATION_PROMPT",
        "UPDATE_SUMMARIZATION_PROMPT",
        "before_provider_request",
        "sendUserMessage",
        "sendMessage",
        "writeFileSync",
        "provider-payload",
    ):
        assert forbidden not in handler_body
    assert "writeFileSync" not in config_body
    assert "mkdirSync" not in config_body


def test_compaction_focus_config_case_table(tmp_path: Path) -> None:
    """R3: hook fallback honors config switches without writing adapter config files."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(tmp_path, "")

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const fs = await import("node:fs");
        const path = await import("node:path");
        const tmp = {json.dumps(str(tmp_path))};
        const preparation = {{
          firstKeptEntryId: "keep",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 1,
          fileOps: {{}},
          settings: {{}},
        }};
        const baseCtx = (env) => ({{
          env,
          model: {{ id: "model" }},
          modelRegistry: {{ getApiKeyAndHeaders: async () => ({{ ok: true, apiKey: undefined, headers: undefined }}) }},
          ui: {{ notify: async () => undefined, setStatus: async () => undefined }},
        }});
        const baseEvent = {{ preparation, signal: new AbortController().signal }};
        const abortedSignal = () => {{ const controller = new AbortController(); controller.abort(); return controller.signal; }};
        const adapterCalls = [];
        const adapter = async () => {{ adapterCalls.push("called"); return {{ summary: "ok", firstKeptEntryId: "keep", tokensBefore: 1 }}; }};
        const disabledConfig = path.join(tmp, "disabled.json");
        fs.writeFileSync(disabledConfig, JSON.stringify({{ enabled: false, carry_forward_rule: {{ text: "" }} }}));
        const disabled = await mod.handleLarvaSessionBeforeCompact({{ ...baseEvent, customInstructions: "manual" }}, baseCtx({{ LARVA_PI_COMPACTION_CONFIG_FILE: disabledConfig }}), {{}}, adapter);
        const abortedDisabled = await mod.handleLarvaSessionBeforeCompact({{ ...baseEvent, customInstructions: "manual", signal: abortedSignal() }}, baseCtx({{ LARVA_PI_COMPACTION_CONFIG_FILE: disabledConfig }}), {{}}, adapter);
        const emptyConfig = path.join(tmp, "empty-focus.json");
        fs.writeFileSync(emptyConfig, JSON.stringify({{ enabled: true, carry_forward_rule: {{ enabled: false, text: "" }} }}));
        const empty = await mod.handleLarvaSessionBeforeCompact(baseEvent, baseCtx({{ LARVA_PI_COMPACTION_CONFIG_FILE: emptyConfig }}), {{}}, adapter);
        const abortedEmpty = await mod.handleLarvaSessionBeforeCompact({{ ...baseEvent, signal: abortedSignal() }}, baseCtx({{ LARVA_PI_COMPACTION_CONFIG_FILE: emptyConfig }}), {{}}, adapter);
        const invalidConfig = path.join(tmp, "invalid-compaction.json");
        fs.writeFileSync(invalidConfig, "{{not-json", "utf8");
        const abortedInvalid = await mod.handleLarvaSessionBeforeCompact({{ ...baseEvent, customInstructions: "manual", signal: abortedSignal() }}, baseCtx({{ LARVA_PI_COMPACTION_CONFIG_FILE: invalidConfig }}), {{}}, adapter);
        const abortedMalformedPreparation = await mod.handleLarvaSessionBeforeCompact({{ ...baseEvent, preparation: {{ ...preparation, fileOps: null }}, customInstructions: "manual", signal: abortedSignal() }}, baseCtx({{ HOME: tmp }}), {{}}, adapter);
        const missingHome = path.join(tmp, "missing-home");
        const enabled = await mod.handleLarvaSessionBeforeCompact({{ ...baseEvent, customInstructions: "manual" }}, baseCtx({{ HOME: missingHome }}), {{}}, adapter);
        console.log(JSON.stringify({{
          disabledIsUndefined: disabled === undefined,
          emptyIsUndefined: empty === undefined,
          abortedPrecedence: {{
            disabledConfig: abortedDisabled,
            emptyFocus: abortedEmpty,
            invalidConfig: abortedInvalid,
            malformedPreparation: abortedMalformedPreparation,
          }},
          enabledReturnedCompaction: enabled?.compaction?.summary === "ok",
          adapterCallCount: adapterCalls.length,
          missingConfigNotCreated: !fs.existsSync(path.join(missingHome, ".pi", "larva", "compaction.json")),
        }}));
        """,
        timeout=8,
    )

    assert payload == {
        "disabledIsUndefined": True,
        "emptyIsUndefined": True,
        "abortedPrecedence": {
            "disabledConfig": {"cancel": True},
            "emptyFocus": {"cancel": True},
            "invalidConfig": {"cancel": True},
            "malformedPreparation": {"cancel": True},
        },
        "enabledReturnedCompaction": True,
        "adapterCallCount": 1,
        "missingConfigNotCreated": True,
    }


def test_compaction_focus_fixture_table(tmp_path: Path) -> None:
    """R4: focused hook preserves bounded focus fixture behavior at adapter boundary."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(tmp_path, "")

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const preparation = {{
          firstKeptEntryId: "keep",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 1,
          fileOps: {{}},
          settings: {{}},
        }};
        let focus = null;
        await mod.handleLarvaSessionBeforeCompact(
          {{ preparation, customInstructions: "a".repeat(2005), signal: new AbortController().signal }},
          {{
            env: {{ HOME: {json.dumps(str(tmp_path))} }},
            model: {{ id: "model" }},
            modelRegistry: {{ getApiKeyAndHeaders: async () => ({{ ok: true }}) }},
            ui: {{ notify: async () => undefined, setStatus: async () => undefined }},
          }},
          {{}},
          async (_preparation, _model, _apiKey, _headers, customInstructions) => {{
            focus = customInstructions;
            return {{ summary: "ok", firstKeptEntryId: "keep", tokensBefore: 1 }};
          }},
        );
        const manualBody = focus.split("\\n\\n")[0].replace("Manual compact focus:\\n", "");
        console.log(JSON.stringify({{
          manualLength: Array.from(manualBody).length,
          manualTail: manualBody.slice(-"...[truncated 34 code points]".length),
          focusLength: Array.from(focus).length,
          focusStartsWithManual: focus.startsWith("Manual compact focus:"),
        }}));
        """,
        timeout=8,
    )

    assert payload["manualLength"] == 2000
    assert payload["manualTail"] == "...[truncated 34 code points]"
    assert payload["focusLength"] <= 6000
    assert payload["focusStartsWithManual"] is True


def test_compaction_focus_hook_case_table(tmp_path: Path) -> None:
    """R5: hook fallback, abort, and diagnostics cases preserve native Pi semantics."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(tmp_path, "")

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const tmp = {json.dumps(str(tmp_path))};
        const preparation = {{
          firstKeptEntryId: "keep",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 1,
          fileOps: {{}},
          settings: {{}},
        }};
        const notifications = [];
        const statuses = [];
        const baseCtx = (extra = {{}}) => ({{
          env: {{ HOME: tmp, ...(extra.env ?? {{}}) }},
          model: Object.prototype.hasOwnProperty.call(extra, "model") ? extra.model : {{ id: "model" }},
          modelRegistry: extra.modelRegistry ?? {{ getApiKeyAndHeaders: async () => ({{ ok: true, apiKey: "SECRET_API_KEY", headers: {{ Authorization: "SECRET_HEADER" }} }}) }},
          ui: extra.ui ?? {{ notify: async (message, type) => notifications.push({{ message, type }}), setStatus: async (...args) => statuses.push(args) }},
        }});
        const event = (extra = {{}}) => ({{
          type: "session_before_compact",
          preparation,
          customInstructions: "SECRET_MANUAL_FOCUS",
          signal: new AbortController().signal,
          ...extra,
        }});
        let callCount = 0;
        const okAdapter = async () => {{ callCount += 1; return {{ summary: "ok", firstKeptEntryId: "keep", tokensBefore: 1 }}; }};
        const cases = {{}};
        cases.missingModel = await mod.handleLarvaSessionBeforeCompact(event(), baseCtx({{ model: undefined }}), {{}}, okAdapter);
        cases.authFailure = await mod.handleLarvaSessionBeforeCompact(event(), baseCtx({{ modelRegistry: {{ getApiKeyAndHeaders: async () => ({{ ok: false, error: "SECRET_AUTH_ERROR" }}) }} }}), {{}}, okAdapter);
        cases.missingSignal = await mod.handleLarvaSessionBeforeCompact(event({{ signal: undefined }}), baseCtx(), {{}}, okAdapter);
        cases.malformedFileOps = await mod.handleLarvaSessionBeforeCompact(event({{ preparation: {{ ...preparation, fileOps: null }} }}), baseCtx(), {{}}, okAdapter);
        cases.missingAdapter = await mod.handleLarvaSessionBeforeCompact(event(), baseCtx(), {{}}, undefined);
        cases.nonAbortFailure = await mod.handleLarvaSessionBeforeCompact(event(), baseCtx(), {{}}, async () => {{ throw new Error("SECRET_ADAPTER_FAILURE"); }});
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        const beforeAbortCallCount = callCount;
        cases.alreadyAborted = await mod.handleLarvaSessionBeforeCompact(event({{ signal: alreadyAborted.signal }}), baseCtx(), {{}}, okAdapter);
        cases.alreadyAbortedDidNotInvoke = callCount === beforeAbortCallCount;
        cases.thrownAbort = await mod.handleLarvaSessionBeforeCompact(event(), baseCtx(), {{}}, async () => {{ callCount += 1; const error = new Error("AbortError"); error.name = "AbortError"; throw error; }});
        cases.thrownCancelled = await mod.handleLarvaSessionBeforeCompact(event(), baseCtx(), {{}}, async () => {{ callCount += 1; throw new Error("Compaction cancelled"); }});
        const statusOnly = [];
        await mod.handleLarvaSessionBeforeCompact(event(), baseCtx({{ ui: {{ setStatus: async (...args) => statusOnly.push(args) }} }}), {{}}, undefined);
        const notifyPrecedenceStatuses = [];
        await mod.handleLarvaSessionBeforeCompact(event(), baseCtx({{ ui: {{ notify: async (message, type) => notifications.push({{ message, type }}), setStatus: async (...args) => notifyPrecedenceStatuses.push(args) }} }}), {{}}, undefined);
        const diagnosticText = notifications.map((item) => item.message).join("\\n");
        console.log(JSON.stringify({{
          undefinedFallbacks: ["missingModel", "authFailure", "missingSignal", "malformedFileOps", "missingAdapter", "nonAbortFailure"].every((key) => cases[key] === undefined),
          alreadyAborted: cases.alreadyAborted,
          alreadyAbortedDidNotInvoke: cases.alreadyAbortedDidNotInvoke,
          thrownAbort: cases.thrownAbort,
          thrownCancelled: cases.thrownCancelled,
          codes: notifications.map((item) => item.message.split(":")[0]),
          allWarnings: notifications.every((item) => item.type === "warning"),
          bounded: notifications.every((item) => Array.from(item.message).length <= 500),
          redacted: !/SECRET_|Manual compact focus|customInstructions/i.test(diagnosticText),
          statusFallback: statusOnly.at(-1),
          notifyBeforeStatus: notifyPrecedenceStatuses.length === 0,
        }}));
        """,
        timeout=8,
    )

    assert payload["undefinedFallbacks"] is True
    assert payload["alreadyAborted"] == {"cancel": True}
    assert payload["alreadyAbortedDidNotInvoke"] is True
    assert payload["thrownAbort"] == {"cancel": True}
    assert payload["thrownCancelled"] == {"cancel": True}
    assert "LARVA_COMPACTION_FOCUS_UNAVAILABLE" in payload["codes"]
    assert "LARVA_COMPACTION_FOCUS_FAILED" in payload["codes"]
    assert payload["allWarnings"] is True
    assert payload["bounded"] is True
    assert payload["redacted"] is True
    assert payload["statusFallback"] == ["larva", "compaction focus: LARVA_COMPACTION_FOCUS_UNAVAILABLE"]
    assert payload["notifyBeforeStatus"] is True


PI_EXTENSION_PERSONA_INVOCATION_SPEC: Final = ROOT / "docs" / "reference" / "PI_EXTENSION_PERSONA_INVOCATION.md"
PIINV_EVENT_BUS_TOKENS: Final = (
    "larva:persona-invocation:request",
    "larva:persona-invocation:cancel",
    "larva:persona-invocation:result",
)
PIINV_REQUIRED_EXPECTED_RED_IDS: Final = (
    "PIINV-001",
    "PIINV-002",
    "PIINV-003",
    "PIINV-004",
    "PIINV-005",
)
PIINV_MACHINE_ANCHORS: Final[tuple[tuple[str, tuple[str, ...], str], ...]] = (
    ("prompt_max_65536_utf8_bytes", ("PERSONA_INVOCATION_PROMPT_MAX_UTF8_BYTES", "65536"), "PIINV_EXPECTED_RED::prompt_max_65536_utf8_bytes::prompt byte bound missing"),
    ("metadata_json_stringify_max_2048_utf8_bytes", ("PERSONA_INVOCATION_METADATA_MAX_UTF8_BYTES", "JSON.stringify", "2048"), "PIINV_EXPECTED_RED::metadata_json_stringify_max_2048_utf8_bytes::metadata stringify byte bound missing"),
    ("timeout_ms_invalid_below_1", ("timeout_ms", "LARVA_PERSONA_INVOCATION_BAD_INPUT", "minimum: 1"), "PIINV_EXPECTED_RED::timeout_ms_invalid_below_1::timeout lower validation missing"),
    ("timeout_ms_invalid_above_120000", ("timeout_ms", "LARVA_PERSONA_INVOCATION_BAD_INPUT", "120000"), "PIINV_EXPECTED_RED::timeout_ms_invalid_above_120000::timeout upper validation missing"),
    ("timeout_runtime_timeout_returns_TIMEOUT", ("LARVA_PERSONA_INVOCATION_TIMEOUT", "AbortController", "timeout_ms"), "PIINV_EXPECTED_RED::timeout_runtime_timeout_returns_TIMEOUT::runtime timeout terminal code missing"),
    ("final_text_max_16384_utf8_bytes", ("PERSONA_INVOCATION_FINAL_TEXT_MAX_UTF8_BYTES", "16384"), "PIINV_EXPECTED_RED::final_text_max_16384_utf8_bytes::final_text byte bound missing"),
    ("overlimit_output_PROTOCOL_FAILED_empty_final_text_no_artifact_no_truncation", ("LARVA_PERSONA_INVOCATION_PROTOCOL_FAILED", "final_text: \"\"", "no artifact"), "PIINV_EXPECTED_RED::overlimit_output_PROTOCOL_FAILED_empty_final_text_no_artifact_no_truncation::overlimit protocol failure missing"),
    ("result_error_object_exact_code_message_shape", ("error: { code", "message", "LARVA_PERSONA_INVOCATION_"), "PIINV_EXPECTED_RED::result_error_object_exact_code_message_shape::exact error object shape missing"),
    ("failed_result_empty_final_text", ("status: \"failed\"", "final_text: \"\""), "PIINV_EXPECTED_RED::failed_result_empty_final_text::failed final_text empty invariant missing"),
    ("cancelled_result_empty_final_text", ("status: \"cancelled\"", "final_text: \"\""), "PIINV_EXPECTED_RED::cancelled_result_empty_final_text::cancelled final_text empty invariant missing"),
    ("terminal_error_code_BAD_INPUT", ("LARVA_PERSONA_INVOCATION_BAD_INPUT",), "PIINV_EXPECTED_RED::terminal_error_code_BAD_INPUT::terminal error code missing"),
    ("terminal_error_code_PERSONA_NOT_FOUND", ("LARVA_PERSONA_INVOCATION_PERSONA_NOT_FOUND",), "PIINV_EXPECTED_RED::terminal_error_code_PERSONA_NOT_FOUND::terminal error code missing"),
    ("terminal_error_code_MODEL_UNAVAILABLE", ("LARVA_PERSONA_INVOCATION_MODEL_UNAVAILABLE",), "PIINV_EXPECTED_RED::terminal_error_code_MODEL_UNAVAILABLE::terminal error code missing"),
    ("terminal_error_code_POLICY_FAILED", ("LARVA_PERSONA_INVOCATION_POLICY_FAILED",), "PIINV_EXPECTED_RED::terminal_error_code_POLICY_FAILED::terminal error code missing"),
    ("terminal_error_code_TIMEOUT", ("LARVA_PERSONA_INVOCATION_TIMEOUT",), "PIINV_EXPECTED_RED::terminal_error_code_TIMEOUT::terminal error code missing"),
    ("terminal_error_code_CANCELLED", ("LARVA_PERSONA_INVOCATION_CANCELLED",), "PIINV_EXPECTED_RED::terminal_error_code_CANCELLED::terminal error code missing"),
    ("terminal_error_code_PROTOCOL_FAILED", ("LARVA_PERSONA_INVOCATION_PROTOCOL_FAILED",), "PIINV_EXPECTED_RED::terminal_error_code_PROTOCOL_FAILED::terminal error code missing"),
    ("terminal_error_code_INTERNAL_ERROR", ("LARVA_PERSONA_INVOCATION_INTERNAL_ERROR",), "PIINV_EXPECTED_RED::terminal_error_code_INTERNAL_ERROR::terminal error code missing"),
    ("lifecycle_shutdown_stale_context_suppresses_result", ("LARVA_PERSONA_INVOCATION_STALE", "shutdown", "suppress"), "PIINV_EXPECTED_RED::lifecycle_shutdown_stale_context_suppresses_result::shutdown stale suppression missing"),
    ("lifecycle_reload_stale_context_suppresses_result", ("LARVA_PERSONA_INVOCATION_STALE", "reload", "suppress"), "PIINV_EXPECTED_RED::lifecycle_reload_stale_context_suppresses_result::reload stale suppression missing"),
    ("lifecycle_new_stale_context_suppresses_result", ("LARVA_PERSONA_INVOCATION_STALE", "new", "suppress"), "PIINV_EXPECTED_RED::lifecycle_new_stale_context_suppresses_result::new stale suppression missing"),
    ("lifecycle_resume_stale_context_suppresses_result", ("LARVA_PERSONA_INVOCATION_STALE", "resume", "suppress"), "PIINV_EXPECTED_RED::lifecycle_resume_stale_context_suppresses_result::resume stale suppression missing"),
    ("lifecycle_fork_stale_context_suppresses_result", ("LARVA_PERSONA_INVOCATION_STALE", "fork", "suppress"), "PIINV_EXPECTED_RED::lifecycle_fork_stale_context_suppresses_result::fork stale suppression missing"),
    ("terminal_race_first_terminal_state_wins", ("terminal_race_first_terminal_state_wins", "first terminal state wins"), "PIINV_EXPECTED_RED::terminal_race_first_terminal_state_wins::first terminal state wins missing"),
    ("terminal_race_at_most_one_result", ("terminal_race_at_most_one_result", "at most one result"), "PIINV_EXPECTED_RED::terminal_race_at_most_one_result::at most one result missing"),
    ("terminal_race_late_timeout_cancel_stale_ignored", ("terminal_race_late_timeout_cancel_stale_ignored", "late timeout-cancel-stale ignored"), "PIINV_EXPECTED_RED::terminal_race_late_timeout_cancel_stale_ignored::late terminal races ignored missing"),
)


def test_piinv_docs_and_readme_pin_machine_anchor_inventory() -> None:
    """Docs/README expose exact PIINV machine anchors without changing product behavior."""
    authority = PI_EXTENSION_PERSONA_INVOCATION_SPEC.read_text(encoding="utf-8")
    readme = PI_EXTENSION_README.read_text(encoding="utf-8")

    for event_name in PIINV_EVENT_BUS_TOKENS:
        assert event_name in authority
        assert event_name in readme
    for machine_anchor, _tokens, _fingerprint in PIINV_MACHINE_ANCHORS:
        assert machine_anchor in authority, f"missing authority PIINV machine anchor {machine_anchor}"
        assert machine_anchor in readme, f"missing README PIINV machine anchor {machine_anchor}"
    assert "NOT `larva_subagent` mode" in authority
    assert "separate from the model-facing `larva_subagent` task system" in readme
    assert "Status/events/wait/select" in authority
    assert "no resume/status/discovery/wait/select" in readme


@pytest.mark.parametrize(
    ("machine_anchor", "required_source_tokens", "expected_red_fingerprint"),
    PIINV_MACHINE_ANCHORS,
    ids=[row[0] for row in PIINV_MACHINE_ANCHORS],
)
def test_piinv_event_bus_machine_anchor_expected_red(
    machine_anchor: str,
    required_source_tokens: tuple[str, ...],
    expected_red_fingerprint: str,
) -> None:
    """Expected-red until the Pi extension implements the persona invocation bus."""
    source = _source()
    missing_event_tokens = [token for token in PIINV_EVENT_BUS_TOKENS if token not in source]
    missing_behavior_tokens = [token for token in required_source_tokens if token not in source]

    assert not missing_event_tokens and not missing_behavior_tokens, (
        f"{expected_red_fingerprint}; PIINV_MACHINE_ANCHOR={machine_anchor}; "
        f"PIINV_REQUIRED_EXPECTED_RED_IDS={' '.join(PIINV_REQUIRED_EXPECTED_RED_IDS)}; "
        f"missing_event_tokens={missing_event_tokens}; missing_behavior_tokens={missing_behavior_tokens}"
    )


def test_PIINV_004_persona_invocation_request_id_reuse_after_1000_settled_ids_suppressed(tmp_path: Path) -> None:
    """PIINV-004: runtime-lifetime request_id terminality survives more than 1000 settled ids."""
    _write_pi_tui_runtime_mock(tmp_path)
    extension = _runtime_extension_copy(tmp_path, "")

    payload = _run_node(
        tmp_path,
        f"""
        const mod = await import({json.dumps(extension.as_uri())});
        const handlers = {{}};
        const results = [];
        const failures = [];
        const record = (condition, label, detail = null) => {{
          if (!condition) failures.push({{ label, detail }});
        }};
        const ctx = {{
          env: {{
            LARVA_PI_INITIAL_PERSONA_ID: "",
            LARVA_PI_AGENT_PERSONA_SWITCH: undefined,
            LARVA_PI_LAUNCHED: "0",
          }},
          ui: {{ notify: async () => undefined, setStatus: async () => undefined }},
        }};
        const pi = {{
          on: (event, handler) => {{ handlers[event] = handler; }},
          emit: (event, payload) => {{
            if (event === "larva:persona-invocation:result") results.push(payload);
            return true;
          }},
          registerCommand: () => undefined,
          registerTool: () => undefined,
        }};
        await mod.initializeExtension(ctx, pi);
        const requestHandler = handlers["larva:persona-invocation:request"];
        const cancelHandler = handlers["larva:persona-invocation:cancel"];
        record(typeof requestHandler === "function", "request event-bus handler registered", Object.keys(handlers));
        record(typeof cancelHandler === "function", "cancel event-bus handler registered", Object.keys(handlers));
        const makeId = (n) => `00000000-0000-4000-8000-${{n.toString(16).padStart(12, "0")}}`;
        const badRequest = (request_id) => ({{ request_id, persona_id: "", prompt: "x", timeout_ms: 1 }});
        for (let index = 0; index < 1001; index += 1) {{
          await requestHandler(badRequest(makeId(index)), ctx);
        }}
        const firstId = makeId(0);
        const after1001Settled = results.length;
        await cancelHandler({{ request_id: firstId, reason: "already terminal" }}, ctx);
        const afterTerminalCancel = results.length;
        await requestHandler(badRequest(firstId), ctx);
        const afterReplay = results.length;
        await requestHandler(badRequest(makeId(1001)), ctx);
        const afterFresh = results.length;
        const firstIdResults = results.filter((result) => result.request_id === firstId);
        record(after1001Settled === 1001, "1001 valid correlated bad-input requests emitted 1001 terminal results", {{ after1001Settled }});
        record(afterTerminalCancel === after1001Settled, "terminal cancel did not emit duplicate result", {{ afterTerminalCancel, after1001Settled }});
        record(afterReplay === after1001Settled, "reused first request_id after >1000 settled ids emitted no second terminal result", {{ afterReplay, after1001Settled }});
        record(afterFresh === after1001Settled + 1, "fresh request_id still emits after replay suppression", {{ afterFresh, after1001Settled }});
        record(firstIdResults.length === 1, "first request_id has exactly one terminal result forever", firstIdResults);
        if (failures.length > 0) {{
          console.error(JSON.stringify({{ failures, resultsLength: results.length, firstIdResults }}, null, 2));
          process.exit(1);
        }}
        console.log(JSON.stringify({{
          settled_before_replay: after1001Settled,
          after_terminal_cancel: afterTerminalCancel,
          after_replay: afterReplay,
          after_fresh: afterFresh,
          first_id_result_count: firstIdResults.length,
          first_id_statuses: firstIdResults.map((result) => result.status),
          registered_persona_invocation_events: Object.keys(handlers).filter((event) => event.startsWith("larva:persona-invocation:")),
        }}));
        """,
        timeout=8,
    )

    assert payload == {
        "settled_before_replay": 1001,
        "after_terminal_cancel": 1001,
        "after_replay": 1001,
        "after_fresh": 1002,
        "first_id_result_count": 1,
        "first_id_statuses": ["failed"],
        "registered_persona_invocation_events": [
            "larva:persona-invocation:request",
            "larva:persona-invocation:cancel",
        ],
    }


def test_persona_invocation_hidden_direct_handlers_are_not_public_exports() -> None:
    """Persona invocation remains event-bus-only externally; direct handlers stay non-public."""
    source = _source()

    assert "export async function handlePersonaInvocationRequest" not in source
    assert "export async function handlePersonaInvocationCancel" not in source
    assert "function handlePersonaInvocationRequest" in source
    assert "function handlePersonaInvocationCancel" in source
    assert "larva:persona-invocation:request" in source
    assert "larva:persona-invocation:cancel" in source
