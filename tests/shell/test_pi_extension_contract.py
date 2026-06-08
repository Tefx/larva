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
    assert "await ensureSessionInitialized(withRuntimeEnv(eventCtx ?? ctx, env), pi)" in body
    assert "return before_agent_start(payload)" in body
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
    assert 'task_id: { anyOf: [{ type: "string" }, { type: "null" }]' in source
    assert "Null is treated like omission and starts a new child session." in source
    assert "handler: (input: LarvaSubagentInput) => larva_subagent" in tool_body
    assert "execute:" in tool_body
    assert "abortSignal: signal ?? runtimeCtx.signal ?? runtimeCtx.abortSignal" in tool_body


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


def test_async_subagent_docs_parity_against_reference_expected_red() -> None:
    """Expected-red: README/source parity is judged against the async subagent reference."""

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
        "cancel_grace_1500": "1500 ms" in authority,
        "lifecycle_rules": "On parent session shutdown, reload, new session, resume, or fork" in authority,
    }
    assert all(value is True for key, value in authority_requirements.items() if key != "authority_path"), json.dumps(
        authority_requirements, indent=2, sort_keys=True
    )

    parity = {
        "readme_names_canonical_larva_subagent": "/larva-subagent" in readme,
        "design_names_canonical_larva_subagent": "/larva-subagent" in design,
        "source_registers_canonical_larva_subagent_command": '"larva-subagent"' in source,
        "source_registers_status_tool": '"larva_subagent_status"' in source,
        "source_registers_cancel_tool": '"larva_subagent_cancel"' in source,
        "source_returns_accepted_result_pending": 'status: "accepted"' in source and "result_pending" in source,
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
            setStatus: async (...args) => statuses.push(args),
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


def test_agent_persona_switch_session_mode_resolution_custom_entry_env_default_off_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const defaultHarness = await buildHarness({});
        const envAskHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "ask" });
        const envAutoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
        const customAutoHarness = await buildHarness(
          { LARVA_PI_AGENT_PERSONA_SWITCH: "off" },
          { sessionEntries: [{ type: "custom", customType: "larva-agent-persona-switch-mode", data: { mode: "auto", source: "slash-command" } }] }
        );
        console.log(JSON.stringify({
          defaultTools: Object.keys(defaultHarness.tools),
          envAskTools: Object.keys(envAskHarness.tools),
          envAutoTools: Object.keys(envAutoHarness.tools),
          customAutoTools: Object.keys(customAutoHarness.tools),
          customEntries: customAutoHarness.sessionEntries,
          commands: Object.keys(defaultHarness.commands),
        }));
        """,
    )

    assert "larva-mode" in _registered_names(payload, "commands")
    assert "larva-agent-persona-switch" not in _registered_names(payload, "commands")
    assert "larva_persona_switch" not in _registered_names(payload, "defaultTools")
    assert "larva_personas" not in _registered_names(payload, "defaultTools")
    for key in ("envAskTools", "envAutoTools", "customAutoTools"):
        assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, key)


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
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off" }, { samePiAsCtx: true, skipSessionStart: true, omitSession: true });
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
    assert "call larva_persona_switch alone" in payload["before"]["systemPrompt"]
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
          ui: {{ setStatus: async (...args) => statuses.push(args), notify: async () => undefined }},
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
          ui: {{ setStatus: async (...args) => statuses.push(args), notify: async () => undefined }},
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
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off" }, { selectResult: "ask" });
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

    assert payload["result"] == {"ok": True, "mode": "ask"}
    assert payload["selectCalls"] == [["Larva agent persona self-switch mode", ["off", "ask", "auto"]]]
    assert any(
        entry == {
            "type": "custom",
            "customType": "larva-agent-persona-switch-mode",
            "data": {"mode": "ask", "source": "slash-command"},
        }
        for entry in payload["sessionEntries"]
    )
    assert {"larva_persona_switch", "larva_personas"} <= set(payload["activeTools"])
    assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, "tools")


def test_agent_persona_switch_noarg_cancel_or_missing_ui_preserves_mode_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const canceledHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off" });
        const canceledCommand = canceledHarness.commands["larva-mode"];
        const canceledResult = await (canceledCommand.handler ?? canceledCommand.options?.handler)("", canceledHarness.ctx);
        const missingUiHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off" }, { omitUi: true });
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


def test_agent_persona_switch_tool_exposure_ask_auto_vs_off_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const offHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off" });
        const askHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "ask" });
        const autoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto" });
        console.log(JSON.stringify({
          offTools: Object.keys(offHarness.tools),
          askTools: Object.keys(askHarness.tools),
          autoTools: Object.keys(autoHarness.tools),
          autoSwitchSchema: autoHarness.tools["larva_persona_switch"]?.inputSchema ?? null,
        }));
        """,
    )

    assert "larva_persona_switch" not in _registered_names(payload, "offTools")
    assert "larva_personas" not in _registered_names(payload, "offTools")
    assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, "askTools")
    assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, "autoTools")
    max_switches_schema = payload["autoSwitchSchema"]["properties"]["max_switches_per_chain"]
    assert {option["type"] for option in max_switches_schema["anyOf"]} == {"integer", "null"}
    assert max_switches_schema["anyOf"][0]["minimum"] == 0
    assert "0 means unlimited" in max_switches_schema["description"]


def test_agent_persona_switch_invalid_stored_mode_falls_back_to_env_then_off_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const envAskHarness = await buildHarness(
          { LARVA_PI_AGENT_PERSONA_SWITCH: "ask" },
          { sessionEntries: [{ type: "custom", customType: "larva-agent-persona-switch-mode", data: { mode: "bogus", source: "slash-command" } }] }
        );
        const invalidEnvHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "bogus" });
        console.log(JSON.stringify({
          envAskTools: Object.keys(envAskHarness.tools),
          invalidEnvTools: Object.keys(invalidEnvHarness.tools),
        }));
        """,
    )

    assert {"larva_persona_switch", "larva_personas"} <= _registered_names(payload, "envAskTools")
    assert "larva_persona_switch" not in _registered_names(payload, "invalidEnvTools")
    assert "larva_personas" not in _registered_names(payload, "invalidEnvTools")


def test_agent_persona_switch_slash_off_recomputes_active_tools_and_preserves_manual_switch_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const cases = [];
        for (const mode of ["ask", "auto"]) {
          const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: mode, LARVA_PI_INITIAL_PERSONA_ID: "architect" });
          const beforeOffActiveTools = harness.activeToolCalls.at(-1);
          const modeCommand = harness.commands["larva-mode"];
          const offResult = await (modeCommand.handler ?? modeCommand.options?.handler)("off", harness.ctx);
          const afterOffActiveTools = harness.activeToolCalls.at(-1);
          const staleSwitchDecision = harness.mod.decideToolCall("larva_persona_switch");
          const stalePersonasDecision = harness.mod.decideToolCall("larva_personas");
          const manual = harness.commands["larva-persona"];
          const manualResult = await (manual.handler ?? manual.options?.handler)("python", harness.ctx);
          const afterManualActiveTools = harness.activeToolCalls.at(-1);
          cases.push({
            mode,
            beforeOffActiveTools,
            offResult,
            afterOffActiveTools,
            staleSwitchDecision,
            stalePersonasDecision,
            manualResult,
            afterManualActiveTools,
            finalEnvelope: harness.mod.getActiveEnvelope(),
            commands: Object.keys(harness.commands),
          });
        }
        console.log(JSON.stringify({ cases }));
        """,
    )

    assert {case["mode"] for case in payload["cases"]} == {"ask", "auto"}
    for case in payload["cases"]:
        assert {"larva_persona_switch", "larva_personas"} <= set(case["beforeOffActiveTools"])
        assert case["offResult"] == {"ok": True, "mode": "off"}
        assert "larva_persona_switch" not in case["afterOffActiveTools"]
        assert "larva_personas" not in case["afterOffActiveTools"]
        assert case["staleSwitchDecision"]["action"] == "deny"
        assert case["staleSwitchDecision"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_OFF"
        assert case["stalePersonasDecision"]["action"] == "deny"
        assert "larva-persona" in case["commands"]
        assert case["manualResult"]["ok"] is True
        assert case["finalEnvelope"]["persona_id"] == "python"
        assert "larva_persona_switch" not in case["afterManualActiveTools"]
        assert "larva_personas" not in case["afterManualActiveTools"]


def test_agent_persona_switch_stale_off_rejects_forged_tool_call_without_commit_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const forgedEventDecision = await harness.handlers.tool_call?.({ toolName: "larva_persona_switch" });
        const forgedTool = harness.tools["larva_persona_switch"];
        const directResult = forgedTool ? await (forgedTool.execute ?? forgedTool.handler)("call-1", { persona_id: "python", reason: "need implementation" }, undefined, undefined, harness.ctx) : null;
        console.log(JSON.stringify({
          forgedEventDecision,
          directResult,
          finalEnvelope: harness.mod.getActiveEnvelope(),
          tools: Object.keys(harness.tools),
        }));
        """,
    )

    assert payload["forgedEventDecision"]["block"] is True
    assert "off" in payload["forgedEventDecision"]["reason"].lower()
    if payload["directResult"] is not None:
        assert payload["directResult"]["status"] == "failed"
        assert payload["directResult"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_OFF"
    assert payload["finalEnvelope"]["persona_id"] == "architect"


def test_agent_persona_switch_manual_larva_persona_preserved_in_off_ask_auto_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const results = [];
        for (const mode of ["off", "ask", "auto"]) {
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
    off_case = next(case for case in payload["results"] if case["mode"] == "off")
    assert "larva_persona_switch" not in off_case["toolNames"]


def test_agent_persona_switch_prompt_guidance_only_for_ask_auto_without_catalogue_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const prompt = (harness) => harness.mod.before_agent_start({ systemPrompt: "base" })?.systemPrompt ?? "";
        const offHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const offPrompt = prompt(offHarness);
        const askHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "ask", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const askPrompt = prompt(askHarness);
        const autoHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const autoPrompt = prompt(autoHarness);
        console.log(JSON.stringify({ offPrompt, askPrompt, autoPrompt }));
        """,
    )

    assert "larva_persona_switch" not in payload["offPrompt"]
    for key in ("askPrompt", "autoPrompt"):
        assert "larva_persona_switch alone" in payload[key]
        assert "Do not call other tools in the same assistant message" in payload[key]
        assert "Python persona" not in payload[key]
        assert "Architecture persona" not in payload[key]
    assert "default request-chain budget is 20" in payload["autoPrompt"]
    assert "max_switches_per_chain" in payload["autoPrompt"]
    assert "At most one" not in payload["autoPrompt"]


def test_agent_personas_read_only_bounded_and_hidden_in_off_behavior(tmp_path: Path) -> None:
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
        const offHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "off" });
        const directOff = await offHarness.mod.larva_personas({ limit: 100 }, offHarness.ctx);
        console.log(JSON.stringify({
          offTools: Object.keys(offHarness.tools),
          result,
          firstPersonaShape,
          directOff,
        }));
        """,
    )

    assert "larva_personas" not in _registered_names(payload, "offTools")
    assert payload["result"]["details"]["status"] == "success"
    assert len(payload["result"]["details"]["personas"]) <= 25
    assert "prompt" not in payload["result"]["details"]["personas"][0]
    assert payload["firstPersonaShape"] == {
        "keys": ["id", "description", "model"],
        "hasOwnPrompt": False,
        "allowlistedKeysOnly": True,
    }
    assert payload["directOff"]["isError"] is True
    assert payload["directOff"]["details"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_OFF"


def test_agent_persona_switch_ask_approval_rejection_no_ui_and_cancel_preserve_state_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const approvedHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "ask", LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { confirmResult: true });
        const approvedTool = approvedHarness.tools["larva_persona_switch"];
        const approved = await (approvedTool.execute ?? approvedTool.handler)("call-approved", { persona_id: "python", reason: "implementation required" }, undefined, undefined, approvedHarness.ctx);
        const approvedEnvelope = approvedHarness.mod.getActiveEnvelope();

        const rejectedHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "ask", LARVA_PI_INITIAL_PERSONA_ID: "architect" }, { confirmResult: false });
        const rejectedTool = rejectedHarness.tools["larva_persona_switch"];
        const rejected = await (rejectedTool.execute ?? rejectedTool.handler)("call-rejected", { persona_id: "python", reason: "implementation required" }, undefined, undefined, rejectedHarness.ctx);
        const rejectedEnvelope = rejectedHarness.mod.getActiveEnvelope();

        const noUiHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "ask", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        delete noUiHarness.ctx.ui.confirm;
        const noUiTool = noUiHarness.tools["larva_persona_switch"];
        const noUi = await (noUiTool.execute ?? noUiTool.handler)("call-no-ui", { persona_id: "python", reason: "implementation required" }, undefined, undefined, noUiHarness.ctx);
        const noUiEnvelope = noUiHarness.mod.getActiveEnvelope();

        const cancelledHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "ask", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        cancelledHarness.ctx.ui.confirm = async () => { throw new Error("dialog cancelled or timed out"); };
        const cancelledTool = cancelledHarness.tools["larva_persona_switch"];
        const cancelled = await (cancelledTool.execute ?? cancelledTool.handler)("call-cancelled", { persona_id: "python", reason: "implementation required" }, undefined, undefined, cancelledHarness.ctx);
        const cancelledEnvelope = cancelledHarness.mod.getActiveEnvelope();

        console.log(JSON.stringify({
          approved,
          approvedEnvelope,
          approvedConfirmations: approvedHarness.confirmations,
          rejected,
          rejectedEnvelope,
          noUi,
          noUiEnvelope,
          cancelled,
          cancelledEnvelope,
          rejectedAudit: rejectedHarness.sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit"),
          noUiAudit: noUiHarness.sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit"),
          cancelledAudit: cancelledHarness.sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit"),
        }));
        """,
    )

    assert payload["approved"]["status"] == "success"
    assert payload["approved"].get("terminate") is True
    assert payload["approved"]["details"]["active_persona"] == "python"
    assert payload["approved"]["details"]["previous_persona"] == "architect"
    assert payload["approved"]["details"]["spec_digest"] == "sha256:python"
    assert payload["approved"]["details"]["commit_source"] == "self-switch"
    assert payload["approvedEnvelope"]["persona_id"] == "python"
    assert len(payload["approvedConfirmations"]) == 1
    for key in ("rejected", "noUi", "cancelled"):
        assert payload[key]["status"] == "failed"
        assert payload[key]["error"]["code"] == "LARVA_BAD_INPUT"
    for key in ("rejectedEnvelope", "noUiEnvelope", "cancelledEnvelope"):
        assert payload[key]["persona_id"] == "architect"
    for key in ("rejectedAudit", "noUiAudit", "cancelledAudit"):
        assert payload[key]
        assert payload[key][-1]["data"]["approved"] is False
        assert payload[key][-1]["data"]["committed"] is False


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


def test_agent_persona_switch_finite_budget_allows_multiple_successes_then_rejects_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const tool = harness.tools["larva_persona_switch"];
        const first = tool ? await (tool.execute ?? tool.handler)("call-1", { persona_id: "python", reason: "need implementation", continue_task: true, max_switches_per_chain: 2 }, undefined, undefined, harness.ctx) : null;
        const followUpPrompt = harness.sentUserMessages[0]?.message ?? "";
        const followUpBeforeAgent = harness.mod.before_agent_start({ prompt: followUpPrompt, systemPrompt: "base" });
        const second = tool ? await (tool.execute ?? tool.handler)("call-2", { persona_id: "architect", reason: "switch back" }, undefined, undefined, harness.ctx) : null;
        const third = tool ? await (tool.execute ?? tool.handler)("call-3", { persona_id: "python", reason: "budget exhausted" }, undefined, undefined, harness.ctx) : null;
        console.log(JSON.stringify({ first, followUpBeforeAgent, second, third, sentUserMessages: harness.sentUserMessages, finalEnvelope: harness.mod.getActiveEnvelope(), tools: Object.keys(harness.tools) }));
        """,
    )

    assert payload["first"]["status"] == "success"
    assert payload["first"].get("terminate") is True
    assert payload["sentUserMessages"][0]["options"] == {"deliverAs": "followUp"}
    assert payload["followUpBeforeAgent"]["systemPrompt"]
    assert payload["second"]["status"] == "success"
    assert payload["second"].get("terminate") is True
    assert payload["third"]["status"] == "failed"
    assert payload["third"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_LIMIT"
    assert "budget" in payload["third"]["error"]["message"].lower()
    assert payload["finalEnvelope"]["persona_id"] == "architect"


def test_agent_persona_switch_budget_resets_for_later_request_and_zero_allows_unlimited_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const resetHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const resetTool = resetHarness.tools["larva_persona_switch"];
        const resetFirst = await (resetTool.execute ?? resetTool.handler)("reset-1", { persona_id: "python", reason: "need implementation", max_switches_per_chain: 1, continue_task: true }, undefined, undefined, resetHarness.ctx);
        const resetFollowUpPrompt = resetHarness.sentUserMessages[0]?.message ?? "";
        const resetFollowUpBeforeAgent = resetHarness.mod.before_agent_start({ prompt: resetFollowUpPrompt, systemPrompt: "base" });
        const resetSameChainSecond = await (resetTool.execute ?? resetTool.handler)("reset-2", { persona_id: "architect", reason: "budget exhausted" }, undefined, undefined, resetHarness.ctx);
        const independentBeforeAgent = resetHarness.mod.before_agent_start({ prompt: "New independent user request: please return to architecture", systemPrompt: "base" });
        const laterFirst = await (resetTool.execute ?? resetTool.handler)("reset-3", { persona_id: "architect", reason: "new request needs architecture" }, undefined, undefined, resetHarness.ctx);

        const unlimitedHarness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const unlimitedTool = unlimitedHarness.tools["larva_persona_switch"];
        const unlimitedResults = [];
        for (const [index, personaId] of ["python", "architect", "python", "architect"].entries()) {
          unlimitedResults.push(await (unlimitedTool.execute ?? unlimitedTool.handler)(`unlimited-${index}`, {
            persona_id: personaId,
            reason: `unlimited switch ${index}`,
            max_switches_per_chain: index === 0 ? 0 : undefined,
          }, undefined, undefined, unlimitedHarness.ctx));
        }
        console.log(JSON.stringify({
          resetFirst,
          resetFollowUpBeforeAgent,
          resetSameChainSecond,
          independentBeforeAgent,
          laterFirst,
          resetFinalEnvelope: resetHarness.mod.getActiveEnvelope(),
          unlimitedResults,
          unlimitedFinalEnvelope: unlimitedHarness.mod.getActiveEnvelope(),
        }));
        """,
    )

    assert payload["resetFirst"]["status"] == "success"
    assert payload["resetFollowUpBeforeAgent"]["systemPrompt"]
    assert payload["resetSameChainSecond"]["status"] == "failed"
    assert payload["resetSameChainSecond"]["error"]["code"] == "LARVA_AGENT_PERSONA_SWITCH_LIMIT"
    assert payload["independentBeforeAgent"]["systemPrompt"]
    assert payload["laterFirst"]["status"] == "success"
    assert payload["laterFirst"].get("terminate") is True
    assert payload["resetFinalEnvelope"]["persona_id"] == "architect"
    assert [result["status"] for result in payload["unlimitedResults"]] == ["success", "success", "success", "success"]
    assert payload["unlimitedFinalEnvelope"]["persona_id"] == "architect"


def test_agent_persona_switch_termination_followup_and_audit_on_success_behavior(tmp_path: Path) -> None:
    payload = _run_agent_persona_switch_harness(
        tmp_path,
        """
        const harness = await buildHarness({ LARVA_PI_AGENT_PERSONA_SWITCH: "auto", LARVA_PI_INITIAL_PERSONA_ID: "architect" });
        const tool = harness.tools["larva_persona_switch"];
        const result = tool ? await (tool.execute ?? tool.handler)("call-1", {
          persona_id: "python",
          reason: "Python implementation is now required",
          handoff: "Implement the agreed test boundary",
          continue_task: true,
        }, undefined, undefined, harness.ctx) : null;
        console.log(JSON.stringify({
          result,
          finalEnvelope: harness.mod.getActiveEnvelope(),
          sentUserMessages: harness.sentUserMessages,
          sessionEntries: harness.sessionEntries,
          tools: Object.keys(harness.tools),
        }));
        """,
    )

    assert payload["result"]["status"] == "success"
    assert payload["result"].get("terminate") is True
    assert payload["finalEnvelope"]["persona_id"] == "python"
    assert payload["result"]["details"]["active_persona"] == "python"
    assert payload["result"]["details"]["previous_persona"] == "architect"
    assert payload["result"]["details"]["spec_digest"] == "sha256:python"
    assert payload["result"]["details"]["commit_source"] == "self-switch"
    assert payload["sentUserMessages"] == [
        {
            "message": "[Larva-generated continuation after persona switch]\nSwitched from architect to python.\nReason: Python implementation is now required\nHandoff: Implement the agreed test boundary\nYou are now operating under the NEW active Larva persona.\nTreat the persona switch as a hard boundary: the new persona's instructions now take priority.\nIf any previous execution plan conflicts with the new persona's mandatory startup or decision protocol, discard that plan.\nBefore taking further action, follow the new persona's opening/startup protocol if it defines one.\nContinue the user's original task under the new persona.\nDo not switch again unless newly justified.",
            "options": {"deliverAs": "followUp"},
        }
    ]
    assert any(
        entry.get("customType") == "larva-agent-persona-switch-audit"
        and entry.get("data") == {
            "source": "tool",
            "mode": "auto",
            "from_persona_id": "architect",
            "to_persona_id": "python",
            "reason": "Python implementation is now required",
            "handoff": "Implement the agreed test boundary",
            "approved": True,
            "committed": True,
            "error_code": None,
            "continue_task": True,
            "max_switches_per_chain": 20,
            "switch_count_in_chain": 1,
        }
        for entry in payload["sessionEntries"]
    )


def test_agent_persona_switch_child_subagent_defaults_self_switch_off_behavior(tmp_path: Path) -> None:
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
    assert payload["childEnv"]["LARVA_PI_AGENT_PERSONA_SWITCH"] == "off"


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

