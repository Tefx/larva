"""Expected-red contract tests for the bundled Pi extension.

These tests intentionally pin the TypeScript extension contract before the
``contrib/pi-extension`` implementation exists.  They are source/harness-level
tests only: no production Pi extension code is implemented in this step.
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
        r"async function initializeSession[\s\S]+LARVA_PI_INITIAL_PERSONA_ID[\s\S]+commitPersona[\s\S]+setStatus",
        "initial persona must be committed by the session-start runtime before status/selector paths",
    )


def test_initialize_extension_wires_pi_surfaces_to_module_logic() -> None:
    source = _source()
    body = _function_body(source, "export async function initializeExtension")

    assert "initializeSession(withRuntimeEnv(ctx, env), pi)" in body
    assert 'on?.("session_start"' in body
    assert body.index("registerLarvaPersonaCommand") < body.index('on?.("before_agent_start"')
    assert body.index("registerTool") < body.index("initializeSession(withRuntimeEnv(ctx, env), pi)")
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
    assert session_body.group("body").index("registerLarvaPersonaAutocompleteProvider(runtimeCtx)") < session_body.group("body").index("initializeSession(runtimeCtx, pi)")
    assert 'on?.("before_agent_start", (payload: unknown) => before_agent_start(payload))' in body
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
        const pi = {{
          getAllTools: async () => ["read"],
          setActiveTools: async () => true,
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: () => undefined,
          on: () => undefined,
        }};
        try {{
          await mod.initializeExtension({{
            env: {{
              LARVA_PI_LAUNCHED: "1",
              LARVA_PI_INITIAL_PERSONA_ID: "startup",
              LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            }},
            ui: {{ setStatus: () => undefined, notify: () => undefined }},
          }}, pi);
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


def test_no_active_persona_sets_none_status() -> None:
    _assert_tokens(_source(), "larva: none", "setLarvaStatus")


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
    assert '"ask"' not in source


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

        await mod.initializeExtension(ctx, pi);
        const degradedEnvelope = mod.getActiveEnvelope();
        const degradedPrompt = mod.before_agent_start({{ systemPrompt: "base" }});
        const switched = await commandHandler("ok");
        const denied = mod.decideToolCall("bash");
        const allowed = mod.decideToolCall("read");
        console.log(JSON.stringify({{
          statuses,
          activeToolCalls,
          degradedEnvelope,
          degradedPrompt: degradedPrompt ?? null,
          switched,
          denied,
          allowed,
          finalEnvelope: mod.getActiveEnvelope(),
        }}));
        """,
    )

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
    subagent_body = _function_body(source, "export async function larva_subagent")
    child_sequence_body = _function_body(source, "async function runChildSequence")
    _assert_tokens(source, "switch_session", "LARVA_PI_INITIAL_PERSONA_ID")
    _assert_regex(
        source,
        r"validateTaskId[\s\S]+canSpawn[\s\S]+activeTaskIds",
        "parent resume preflight should validate path, spawn authority, and busy state only",
    )
    assert "resolvePersona" not in subagent_body
    assert "resolvePersona" not in child_sequence_body
    assert child_sequence_body.index("startChild(env, root, personaId)") < child_sequence_body.index('rpc.command("switch-1"')


def test_concurrent_same_task_resume_uses_in_memory_busy_set() -> None:
    _assert_tokens(_source(), "Set<string>", "activeTaskIds", "finally")


def test_busy_state_is_process_local_without_lock_files() -> None:
    source = _source()
    _assert_tokens(source, "activeTaskIds")
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
