from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = ROOT / "contrib" / "pi-extension" / "larva.ts"
SMOKE = ROOT / "scripts" / "pi-extension-autocomplete-smoke.mjs"
RUNTIME_SMOKE = ROOT / "scripts" / "pi-extension-runtime-smoke.mjs"
AUTOCOMPLETE_RUNTIME = ROOT / "contrib" / "pi-extension" / "test-autocomplete-runtime.mjs"


def _run_autocomplete_case(case: str, *, prefix: str | None = None) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension autocomplete runtime smoke")
    command = [node, str(SMOKE), "--case", case]
    if prefix is not None:
        command.extend(["--prefix", prefix])
    completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=5)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _run_autocomplete_runtime_case(case: str, *, prefix: str | None = None) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension autocomplete runtime smoke")
    command = [node, str(AUTOCOMPLETE_RUNTIME), "--case", case]
    if prefix is not None:
        command.extend(["--prefix", prefix])
    completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=8)
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def test_autocomplete_substring_case_and_prefix_first_stable_order_runtime() -> None:
    payload = _run_autocomplete_runtime_case("substring-case-ordering", prefix="DEV")

    assert payload["providerValues"] == ["DevOps", "devrel", "qa-dev", "backend-dev"]
    assert payload["providerResultIsObject"] is True
    assert payload["resultItemsIsArray"] is True
    assert payload["prefixFromProvider"] == "DEV"
    assert payload["commandValues"] == payload["providerValues"]
    assert payload["substringCaseInsensitive"] is True
    assert payload["prefixFirstStableOrder"] is True
    assert payload["forcedAndCommandSharePath"] is True


def test_autocomplete_cache_reuse_and_concurrent_inflight_dedupe_runtime() -> None:
    payload = _run_autocomplete_runtime_case("cache-inflight")

    assert payload["listInvocationCountDuringOverlap"] == 1
    assert payload["listInvocationCountAfterCacheReuse"] == 1
    assert payload["coldResultsAreNullOrObjects"] is True
    assert payload["cachedResultIsObject"] is True
    assert payload["resultItemsAreArrays"] is True
    assert payload["prefixesFromProvider"][-1] == "vectl"
    assert payload["inFlightDedupeProven"] is True
    assert payload["cacheReuseProven"] is True


def test_autocomplete_delegation_and_failure_fail_closed_runtime() -> None:
    payload = _run_autocomplete_runtime_case("delegation-failure", prefix="vectl")

    assert payload["delegated"] is True
    assert payload["calls"] == [["/not-larva vectl", "object"]]
    assert payload["delegatedItems"] == [
        {"value": "file.txt", "label": "file.txt", "description": "base file completion"}
    ]
    assert payload["failed"] is None
    assert payload["malformed"] is None
    assert payload["failClosedNoCrash"] is True


def test_autocomplete_fixture_uses_documented_list_json_shape_without_alias_fields() -> None:
    payload = _run_autocomplete_runtime_case("fixture-shape")

    assert payload["exactDocumentedShape"] == {
        "data": [
            {
                "id": "vectl-planner",
                "description": "Plan with vectl",
                "spec_digest": "sha256:vectl-planner",
                "model": "openai/gpt-5.5",
            },
            {
                "id": "vectl-reviewer",
                "description": "Review with vectl",
                "spec_digest": "sha256:vectl-reviewer",
                "model": "openai/gpt-5.5",
            },
        ]
    }
    assert payload["providerResultIsObject"] is True
    assert payload["resultItemsIsArray"] is True
    assert payload["prefixFromProvider"] == "vectl"
    assert payload["candidateKeys"] == [["description", "label", "value"], ["description", "label", "value"]]
    assert payload["noAliasFuzzyRegexWildcardFields"] is True


def test_autocomplete_installed_provider_mentions_namespace_without_vectl_filter_runtime() -> None:
    payload = _run_autocomplete_runtime_case("mention-namespace")

    expected = [
        "@persona:ok",
        "@persona:startup",
        "@persona:child",
        "@persona:vectl-planner",
        "@persona:vectl-reviewer",
        "@persona:qa-dev",
        "@persona:DevOps",
        "@persona:devrel",
        "@persona:backend-dev",
    ]
    assert payload["namespacePartialValues"] == expected
    assert payload["namespacePartialResultIsObject"] is True
    assert payload["bareNamespaceResultIsObject"] is True
    assert payload["queryResultIsObject"] is True
    assert payload["namespacePartialItemsIsArray"] is True
    assert payload["bareNamespaceItemsIsArray"] is True
    assert payload["queryItemsIsArray"] is True
    assert payload["namespacePartialPrefix"] == "@p"
    assert payload["bareNamespacePrefix"] == "@persona:"
    assert payload["queryPrefix"] == "@persona:DEV"
    assert payload["bareNamespaceValues"] == expected
    assert payload["namespacePartialReturnsAllEligible"] is True
    assert payload["bareNamespaceReturnsAllEligible"] is True
    assert payload["queryValues"] == ["@persona:DevOps", "@persona:devrel", "@persona:qa-dev", "@persona:backend-dev"]
    assert payload["queryUsesSuffixOnly"] is True
    assert payload["delegatedRawShort"] is None
    assert payload["rawShortDelegatesOnly"] is True
    assert payload["applyCompletionInsertedMention"] is True


def test_autocomplete_registration_defers_to_session_context_and_dedupes_runtime() -> None:
    payload = _run_autocomplete_runtime_case("registration-lifecycle")

    assert payload["registeredName"] == "larva-persona"
    assert payload["hasSessionStart"] is True
    assert payload["afterFactory"] == 0
    assert payload["afterFirstSession"] == 1
    assert payload["afterSecondSession"] == 1


@pytest.mark.parametrize("case,force", [("tab-force", True), ("tab-regular", False)])
def test_autocomplete_tui_provider_uses_argument_prefix_for_force_modes(case: str, force: bool) -> None:
    payload = _run_autocomplete_case(case, prefix="vectl")

    assert payload["command"] == "larva-persona"
    assert payload["force"] is force
    assert payload["prefix"] == "vectl"
    assert payload["editorLine"] == "/larva-persona vectl"
    assert payload["resultIsObject"] is True
    assert payload["prefixFromProvider"] == "vectl"
    assert payload["values"] == ["vectl-planner", "vectl-reviewer"]
    assert payload["allValuesAreStrings"] is True
    assert payload["valuesEqualPersonaIds"] is True
    assert payload["provesArgumentPrefix"] is True
    assert payload["exactShape"] is True


def test_autocomplete_delegates_non_larva_persona_input_to_base_provider() -> None:
    payload = _run_autocomplete_case("delegate-other-input")

    assert payload["delegated"] is True
    assert payload["items"] == [
        {"value": "file.txt", "label": "file.txt", "description": "base file completion"}
    ]
    assert payload["calls"] == [["/not-larva vectl", "object"]]


def test_autocomplete_smoke_mentions_namespace_returns_all_eligible_personas() -> None:
    payload = _run_autocomplete_case("mention-namespace")

    assert payload["values"] == payload["expected"]
    assert payload["resultIsObject"] is True
    assert payload["resultItemsIsArray"] is True
    assert payload["prefixFromProvider"] == "@persona:"
    assert payload["allValuesAreStrings"] is True
    assert payload["allValuesArePersonaMentions"] is True
    assert payload["allEligiblePersonaMentionsReturned"] is True
    assert payload["applyCompletionInsertedMention"] is True


def test_autocomplete_list_failure_and_malformed_json_return_null_without_crash() -> None:
    payload = _run_autocomplete_case("list-failure", prefix="vectl")

    assert payload == {
        "case": "list-failure",
        "failed": None,
        "malformed": None,
        "noCrash": True,
    }


def _run_runtime_scenario_raw(
    scenario: str, *, persona: str | None = None, timeout: float = 8.0
) -> tuple[dict[str, Any], int, str, str]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime smoke")
    command = [node, str(RUNTIME_SMOKE), "--scenario", scenario]
    if persona is not None:
        command.extend(["--persona", persona])
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert completed.stdout.strip(), completed.stderr
    return json.loads(completed.stdout), completed.returncode, completed.stdout, completed.stderr


def _run_runtime_scenario(scenario: str, *, persona: str | None = None, timeout: float = 8.0) -> dict[str, Any]:
    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        scenario, persona=persona, timeout=timeout
    )
    assert returncode == 0, f"stdout:\n{raw_stdout}\nstderr:\n{raw_stderr}"
    return payload


def _run_node_inline(tmp_path: Path, script: str, *, timeout: float = 8.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime artifact tests")
    script_path = tmp_path / "runtime-artifact.mjs"
    script_path.write_text(script, encoding="utf-8")
    completed = subprocess.run(
        [node, str(script_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _skip_if_pi_absent(payload: dict[str, Any]) -> None:
    pi = payload.get("pi", {})
    if pi.get("available") is not True:
        pytest.skip(f"Pi binary absent/unusable; availability evidence={json.dumps(pi, sort_keys=True)}")


def _xfail_if_rpc_surface_hidden(payload: dict[str, Any]) -> None:
    _skip_if_pi_absent(payload)
    rpc = payload.get("rpc", {})
    assert rpc.get("loadFailure") is not True, (
        "Pi binary is present but plugin/RPC startup failed; "
        f"rpc evidence={json.dumps(rpc, sort_keys=True)}"
    )
    if rpc.get("supported") is not True:
        pytest.xfail(
            "current Pi RPC did not expose extension UI/custom command surfaces; "
            f"rpc evidence={json.dumps(rpc, sort_keys=True)}"
        )


def test_rpc_skip_xfail_policy_does_not_hide_plugin_load_failure() -> None:
    payload = {
        "pi": {"available": True, "binary": "pi", "extensionFlag": "-e"},
        "rpc": {
            "supported": False,
            "loadFailure": True,
            "stderr": "failed to load contrib/pi-extension/larva.ts",
        },
    }

    with pytest.raises(AssertionError, match="plugin/RPC startup failed"):
        _xfail_if_rpc_surface_hidden(payload)


def test_runtime_smoke_help_lists_all_required_scenarios() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime smoke")
    completed = subprocess.run(
        [node, str(RUNTIME_SMOKE), "--help"],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert completed.returncode == 0, completed.stderr
    for scenario in (
        "availability",
        "get-commands",
        "slash-status",
        "startup-status",
        "startup-fatal",
        "failure-path",
        "tool-shape",
        "tool-result-renderer-shape",
        "fresh-session-validation",
        "tool-call-block",
        "capability-gates",
        "live-child-rpc-proof",
        "async-subagent-contract",
    ):
        assert scenario in completed.stdout


def test_agent_persona_switch_followup_queue_equivalent_next_turn_uses_new_persona_prompt(tmp_path: Path) -> None:
    """Accepted host-runtime AgentSession hook artifact for B2.

    The live Pi RPC surface does not currently expose a stable way to force a
    model tool call and then drain Pi's queued follow-up in this test
    environment. This harness therefore imports Pi's installed
    ``dist/core/agent-session.js`` and binds Larva's continuation to the real
    ``AgentSession.sendUserMessage`` implementation. The proof exercises the
    actual Pi queue routing path
    ``sendUserMessage -> prompt(streamingBehavior='followUp') -> _queueFollowUp``
    and then the next non-streaming AgentSession prompt path that invokes the
    extension ``before_agent_start`` hook against the committed persona envelope.
    """

    fake_cli = tmp_path / "fake-larva-followup-cli.mjs"
    fake_cli.write_text(
        textwrap.dedent(
            """
            const [, , command, arg, jsonFlag] = process.argv;
            if (command !== "resolve" || jsonFlag !== "--json") process.exit(3);
            const promptMarker = arg === "python" ? "PYTHON_RUNTIME_PROMPT_MARKER" : "ARCHITECT_RUNTIME_PROMPT_MARKER";
            process.stdout.write(JSON.stringify({
              data: {
                id: arg,
                description: `Persona ${arg}`,
                prompt: `Prompt for ${arg}\n${promptMarker}`,
                model: "provider/model",
                capabilities: {},
                spec_version: "0.1.0",
                spec_digest: `sha256:${arg}`,
                can_spawn: true
              }
            }));
            """
        ),
        encoding="utf-8",
    )

    payload = _run_node_inline(
        tmp_path,
        f"""
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const {{ AgentSession }} = await import("file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");

        const activeToolCalls = [];
        const tools = {{}};
        const handlers = {{}};
        const sessionEntries = [];
        const queueUpdates = [];
        const capturedAgentPrompts = [];
        const hostAgent = {{
          state: {{
            isStreaming: true,
            model: {{ provider: "provider", id: "model" }},
            messages: [],
            tools: [],
            systemPrompt: "base prompt before next provider call",
          }},
          followUp: (message) => {{ hostAgent.queuedFollowUps.push(message); }},
          steer: (message) => {{ hostAgent.queuedSteers.push(message); }},
          hasQueuedMessages: () => hostAgent.queuedFollowUps.length > 0 || hostAgent.queuedSteers.length > 0,
          clearAllQueues: () => {{ hostAgent.queuedFollowUps = []; hostAgent.queuedSteers = []; }},
          prompt: async (messages) => {{ capturedAgentPrompts.push({{ messages, systemPrompt: hostAgent.state.systemPrompt }}); hostAgent.state.messages.push(...messages); }},
          abort: () => undefined,
          waitForIdle: async () => undefined,
          queuedFollowUps: [],
          queuedSteers: [],
        }};
        const hostSession = Object.create(AgentSession.prototype);
        Object.assign(hostSession, {{
          agent: hostAgent,
          _followUpMessages: [],
          _steeringMessages: [],
          _pendingNextTurnMessages: [],
          _pendingBashMessages: [],
          _eventListeners: [(event) => {{ if (event.type === "queue_update") queueUpdates.push(event); }}],
          _baseSystemPrompt: "base prompt before next provider call",
          _baseSystemPromptOptions: {{}},
          _lastAssistantMessage: undefined,
          _retryAttempt: 0,
          _overflowRecoveryAttempted: false,
          _extensionRunner: {{
            hasHandlers: (name) => name === "before_agent_start",
            emitInput: async (text, images) => ({{ action: "continue" }}),
            emitBeforeAgentStart: async (_text, _images, systemPrompt) => mod.before_agent_start({{ systemPrompt }}),
            emit: async () => undefined,
          }},
          _modelRegistry: {{ hasConfiguredAuth: () => true, isUsingOAuth: () => false }},
          sessionManager: {{ appendMessage: () => undefined }},
          settingsManager: {{}},
        }});

        const pi = {{
          getAllTools: async () => ["read", "larva_persona_switch", "larva_personas"],
          setActiveTools: async (activeTools) => {{ activeToolCalls.push(activeTools); return true; }},
          setModel: async () => true,
          registerCommand: () => undefined,
          registerTool: (tool) => {{ tools[tool.name] = tool; }},
          on: (event, handler) => {{ handlers[event] = handler; }},
        }};
        const ctx = {{
          env: {{
            LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, {json.dumps(str(fake_cli))}]),
            LARVA_PI_AGENT_PERSONA_SWITCH: "auto",
            LARVA_PI_INITIAL_PERSONA_ID: "architect",
            LARVA_PI_INTERACTIVE_TUI: "0",
          }},
          ui: {{ setStatus: async () => undefined, notify: async () => undefined }},
          modelRegistry: {{ find: async () => ({{ id: "model" }}) }},
          session: {{
            entries: sessionEntries,
            getEntries: () => sessionEntries,
            appendEntry: (customType, data) => sessionEntries.push({{ type: "custom", customType, data }}),
          }},
          sendUserMessage: hostSession.sendUserMessage.bind(hostSession),
        }};
        await mod.initializeExtension(ctx, pi);
        await handlers.session_start?.({{ reason: "startup" }}, ctx);
        const switchTool = tools["larva_persona_switch"];
        const switchResult = await switchTool.execute("call-switch", {{
          persona_id: "python",
          reason: "Python runtime proof required",
          handoff: "Continue with the Python marker",
          continue_task: true,
        }}, undefined, undefined, ctx);

        const queuedFollowUpMessages = hostSession.getFollowUpMessages();
        const queuedAgentFollowUps = hostAgent.queuedFollowUps;
        const queuedText = queuedFollowUpMessages[0];
        if (switchResult.terminate === true && queuedText) {{
          hostAgent.state.isStreaming = false;
          await hostSession.sendUserMessage(queuedText, {{}});
        }}
        const nextPrompt = capturedAgentPrompts.at(-1)?.systemPrompt ?? "";
        console.log(JSON.stringify({{
          proofClass: "accepted_host_runtime_agent_session_hooks",
          piRuntimeSeams: [
            "AgentSession.sendUserMessage",
            "AgentSession.prompt streamingBehavior followUp routing",
            "AgentSession._queueFollowUp",
            "AgentSession.prompt next turn delivery",
            "AgentSession.prompt emitBeforeAgentStart hook",
          ],
          switchResult,
          queuedFollowUpMessages,
          queuedAgentFollowUps,
          queueUpdates,
          capturedAgentPrompts,
          nextPrompt,
          remainingFollowUpsAfterDelivery: hostSession.getFollowUpMessages(),
          finalEnvelope: mod.getActiveEnvelope(),
          activeToolCalls,
          auditEntries: sessionEntries.filter((entry) => entry.customType === "larva-agent-persona-switch-audit"),
          assertions: {{
            terminatedOldTurn: switchResult.terminate === true,
            followUpQueuedByAgentSession: queuedFollowUpMessages.length === 1 && queuedAgentFollowUps.length === 1,
            followUpDeliveryModeReachedPiAgentQueue: queuedAgentFollowUps[0]?.role === "user" && queuedAgentFollowUps[0]?.content?.[0]?.text === queuedText,
            nextTurnDeliveredThroughAgentSessionPrompt: capturedAgentPrompts.at(-1)?.messages?.[0]?.content?.[0]?.text === queuedText,
            larvaGeneratedMarkerPresent: queuedText?.startsWith("[Larva-generated continuation after persona switch]") === true,
            nextPromptUsesNewPersonaEnvelope: nextPrompt.includes("<!-- larva-spec: python@sha256:python -->"),
            nextPromptUsesNewPersonaPrompt: nextPrompt.includes("PYTHON_RUNTIME_PROMPT_MARKER") && !nextPrompt.includes("ARCHITECT_RUNTIME_PROMPT_MARKER"),
          }},
        }}));
        """,
    )

    assert payload["proofClass"] == "accepted_host_runtime_agent_session_hooks"
    assert payload["piRuntimeSeams"] == [
        "AgentSession.sendUserMessage",
        "AgentSession.prompt streamingBehavior followUp routing",
        "AgentSession._queueFollowUp",
        "AgentSession.prompt next turn delivery",
        "AgentSession.prompt emitBeforeAgentStart hook",
    ]
    assert payload["switchResult"]["status"] == "success"
    assert payload["switchResult"].get("terminate") is True
    assert payload["finalEnvelope"]["persona_id"] == "python"
    assert payload["queuedFollowUpMessages"] == [
        "[Larva-generated continuation after persona switch]\n"
        "Switched from architect to python.\n"
        "Reason: Python runtime proof required\n"
        "Handoff: Continue with the Python marker\n"
        "You are now operating under the NEW active Larva persona.\n"
        "Treat the persona switch as a hard boundary: the new persona's instructions now take priority.\n"
        "If any previous execution plan conflicts with the new persona's mandatory startup or decision protocol, discard that plan.\n"
        "Before taking further action, follow the new persona's opening/startup protocol if it defines one.\n"
        "Continue the user's original task under the new persona.\n"
        "Do not switch again unless newly justified."
    ]
    assert payload["assertions"] == {
        "terminatedOldTurn": True,
        "followUpQueuedByAgentSession": True,
        "followUpDeliveryModeReachedPiAgentQueue": True,
        "nextTurnDeliveredThroughAgentSessionPrompt": True,
        "larvaGeneratedMarkerPresent": True,
        "nextPromptUsesNewPersonaEnvelope": True,
        "nextPromptUsesNewPersonaPrompt": True,
    }
    assert payload["auditEntries"][-1]["data"]["committed"] is True


def test_real_pi_availability_records_binary_and_extension_flag() -> None:
    payload = _run_runtime_scenario("availability")
    _skip_if_pi_absent(payload)

    assert payload["pi"]["binary"]
    assert payload["pi"]["extensionFlag"] in {"-e", "--extension"}


@pytest.mark.parametrize("scenario", ["get-commands", "slash-status", "startup-status", "failure-path"])
def test_real_pi_rpc_smoke_collects_extension_ui_evidence_or_explicit_xfail(scenario: str) -> None:
    payload = _run_runtime_scenario(scenario)
    _xfail_if_rpc_surface_hidden(payload)

    assert payload["scenario"] == scenario
    assert payload["rpc"]["attempted"] is True
    assert payload["rpc"]["supported"] is True
    assert isinstance(payload["rpc"].get("events"), list)
    ui_requests = payload["rpc"].get("uiRequests", [])
    assert all(request.get("type") == "extension_ui_request" for request in ui_requests)
    if ui_requests:
        assert any(
            "statusKey" in request or "statusText" in request or "status" in request
            for request in ui_requests
        )


def test_real_pi_slash_status_commits_success_persona() -> None:
    payload = _run_runtime_scenario("slash-status", persona="ok")
    _xfail_if_rpc_surface_hidden(payload)

    ui_requests = payload["rpc"].get("uiRequests", [])
    assert any(
        request.get("method") == "setStatus"
        and request.get("statusKey") == "larva"
        and request.get("statusText") == "larva: ok"
        for request in ui_requests
    )
    assert any(
        request.get("method") == "notify"
        and request.get("message") == "Larva persona active: ok"
        and request.get("notifyType") == "info"
        for request in ui_requests
    )


def test_real_pi_startup_status_commits_startup_persona() -> None:
    payload = _run_runtime_scenario("startup-status", persona="startup")
    _xfail_if_rpc_surface_hidden(payload)

    assert any(
        request.get("method") == "setStatus"
        and request.get("statusKey") == "larva"
        and request.get("statusText") == "larva: startup"
        for request in payload["rpc"].get("uiRequests", [])
    )


def test_real_pi_initial_persona_invalid_model_fails_nonzero_before_prompt() -> None:
    payload = _run_runtime_scenario("startup-fatal")
    _skip_if_pi_absent(payload)

    fatal = payload["rpc"]["fatalStartup"]
    assert fatal["status"] == "PASS"
    assert fatal["firstPromptSent"] is False
    assert fatal["nonzeroBeforePrompt"] is True
    assert fatal["stderrHasLarvaStartupError"] is True
    assert "LARVA_MODEL_UNAVAILABLE" in fatal["stderr"]


def test_real_pi_failure_path_uses_slash_command_topology() -> None:
    payload = _run_runtime_scenario("failure-path", persona="missing")
    _xfail_if_rpc_surface_hidden(payload)

    responses = payload["rpc"].get("responses", [])
    assert [response.get("id") for response in responses] == ["prompt-missing", "prompt-unparseable"]
    messages = [request.get("message") for request in payload["rpc"].get("uiRequests", [])]
    assert "Larva persona switch failed: LARVA_PERSONA_NOT_FOUND: Unable to resolve persona missing" in messages
    assert "Larva persona switch failed: LARVA_PERSONA_NOT_FOUND: Invalid persona payload for unparseable" in messages


def test_runtime_capability_gate_rejects_mock_only_autocomplete_support() -> None:
    payload = _run_runtime_scenario("capability-gates")
    pi_tui_gate = payload["runtime"]["hardGates"]["piTuiDependency"]
    pi_tui_dependency = payload["package"]["piTuiDependency"]
    gate = payload["runtime"]["hardGates"]["uiAutocompleteProvider"]

    assert pi_tui_gate["supported"] is True
    assert pi_tui_dependency["packageJsonVersion"] == "0.78.0"
    assert pi_tui_dependency["lockfileRootDependency"] == "0.78.0"
    assert pi_tui_dependency["lockfileVersion"] == "0.78.0"
    assert pi_tui_dependency["installedVersion"] == "0.78.0"
    assert pi_tui_dependency["noHostGlobalFallback"] is True
    assert pi_tui_dependency["importOk"] is True
    assert gate["supported"] is False
    assert gate["status"] in {"unsupported", "unknown"}
    assert gate["provenance"] == "runtimeHarness.mock"
    assert gate["evidence"]["hook"]["hookType"] == "function"
    assert gate["evidence"]["hook"]["source"] == "runtimeHarness.mock"
    assert "live Pi interactive TUI runtime hook proof is missing" in gate["limitation"]
    assert "true requires non-mock Pi interactive TUI runtime/build provenance" in gate["supportRule"]


def test_runtime_object_registers_larva_subagent_parameters_and_execute() -> None:
    payload = _run_runtime_scenario("tool-shape")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {
        "hasLarvaSubagent": True,
        "hasParameters": True,
        "hasExecute": True,
        "hasRenderableCall": True,
        "hasRenderableResult": True,
        "wideCallLinesFit": True,
        "wideResultLinesFit": True,
    }
    assert "larva_subagent" in payload["runtime"]["registeredToolNames"]


def test_registered_larva_subagent_results_are_renderer_safe_toolresults() -> None:
    """Pi renderer calls result.content.filter(...) on tool output.

    This invokes the registered ``larva_subagent`` handler/execute functions via
    the runtime smoke harness and requires a Pi ToolResult-style content array.
    The smoke also preserves machine-readable semantic metadata in ``details``.
    """

    payload = _run_runtime_scenario("tool-result-renderer-shape")
    cases = payload["runtime"]["toolResultCases"]
    assertions = payload["runtime"]["assertions"]

    assert cases["success"]["status"] == "accepted"
    assert cases["success"]["result_pending"] is True
    assert cases["success"]["result_text"] == ""
    assert "result_text" not in cases["success"]["details"]
    assert cases["failedBeforeSession"]["status"] == "failed"
    assert cases["failedBeforeSession"]["error"]["code"] == "LARVA_NO_ACTIVE_PERSONA"
    assert cases["failedBeforeSession"]["details"]["error"]["code"] == "LARVA_NO_ACTIVE_PERSONA"
    assert cases["cancelled"]["status"] == "cancelled"
    assert cases["failedAfterAllocation"]["status"] == "failed"
    assert cases["failedAfterAllocation"]["task_id"].endswith("allocated.jsonl")

    for case_name in ("success", "failedBeforeSession", "cancelled", "failedAfterAllocation"):
        assertion = assertions[case_name]
        case = cases[case_name]
        assert assertion["hasRendererSafeTextContent"] is True
        assert assertion["rendererSafeContent"] is True
        assert assertion["textItem"]["type"] == "text"
        assert isinstance(assertion["textItem"]["text"], str)
        if case["status"] == "accepted":
            assert assertion["detailsPreserve"] == {
                "task_id": case["task_id"],
                "persona_id": case["persona_id"],
                "status": "accepted",
                "result_pending": True,
                "error": case["error"],
                "no_terminal_result_text": True,
            }
        else:
            assert assertion["detailsPreserve"] == {
                "task_id": case["task_id"],
                "persona_id": case["persona_id"],
                "status": case["status"],
                "result_text": case["result_text"],
                "error": case["error"],
            }


def test_larva_subagent_fresh_child_sessionfile_validation_split() -> None:
    payload = _run_runtime_scenario("fresh-session-validation")
    validation = payload["runtime"]["freshSessionValidation"]
    assertions = payload["runtime"]["assertions"]

    fresh = validation["freshMissingBeforePrompt"]
    assert validation["missingBeforePrompt"] is True
    assert validation["createdDuringPrompt"] is True
    assert fresh["status"] == "accepted"
    assert fresh["result_pending"] is True
    assert fresh["result_text"] == ""
    assert fresh["task_id"].endswith("fresh-created-on-prompt.jsonl")

    missing_resume = validation["missingResume"]
    assert missing_resume["status"] == "failed"
    assert missing_resume["error"]["code"] == "LARVA_BAD_INPUT"
    assert validation["resumeSpawned"] is False

    invalid = validation["invalidFresh"]
    assert sorted(invalid) == ["danglingSymlinkEscape", "outsideRoot", "relative", "symlinkEscape", "wrongSuffix"]
    for result in invalid.values():
        assert result["status"] == "failed"
        assert result["error"]["code"] == "LARVA_CHILD_PROTOCOL_FAILED"
        assert result["error"]["message"] == "Child returned invalid sessionFile."

    assert assertions == {
        "freshMissingBeforePromptAccepted": True,
        "strictResumeMissingRejected": True,
        "invalidFreshRejected": True,
        "authorityAndToolResultPreserved": True,
    }


def test_runtime_tool_call_event_with_tool_name_blocks_with_reason() -> None:
    payload = _run_runtime_scenario("tool-call-block")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {"blockTrue": True, "nonEmptyReason": True}
    result = payload["runtime"]["toolCallResult"]
    assert result["block"] is True
    assert isinstance(result["reason"], str) and result["reason"]


def test_live_child_rpc_terminal_cancel_and_orphan_cleanup_proof_passes() -> None:
    """Live Pi child RPC proof preserves accepted receipts while proving terminal cleanup."""

    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        "live-child-rpc-proof", timeout=120.0
    )
    _skip_if_pi_absent(payload)
    proof = payload["runtime"]["controlledLive"]
    raw_json_evidence = {
        "command": ["node", str(RUNTIME_SMOKE), "--scenario", "live-child-rpc-proof"],
        "exit_code": returncode,
        "raw_stdout": raw_stdout,
        "raw_stderr": raw_stderr,
        "status": proof["status"],
        "B1_startup": proof["B1_startup"],
        "B2_resume": proof["B2_resume"],
        "B3_abort": proof["B3_abort"],
        "B4_orphans": proof["B4_orphans"],
        "orphanProof": proof["orphanProof"],
    }

    assert returncode == 0, json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert proof["status"] == "PASS", json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert proof["B1_startup"]["status"] == "PASS"
    assert proof["B1_startup"]["acceptedStatus"] == "accepted"
    assert proof["B1_startup"]["terminalStatus"] == "success"
    assert proof["B1_startup"]["agentEndObserved"] is True
    assert proof["B1_startup"]["getLastAssistantTextObserved"] is True
    assert proof["B2_resume"]["status"] == "PASS"
    assert proof["B2_resume"]["acceptedStatus"] == "accepted"
    assert proof["B2_resume"]["terminalStatus"] == "success"
    assert proof["B2_resume"]["switchSessionObserved"] is True
    assert proof["B3_abort"]["status"] == "PASS"
    assert proof["B3_abort"]["acceptedStatus"] == "accepted"
    assert proof["B3_abort"]["cancelStatus"] in {"cancelling", "cancelled"}
    assert proof["B3_abort"]["terminalStatus"] == "cancelled"
    assert proof["B3_abort"]["abortEvents"]
    assert proof["B3_abort"]["cleanupObserved"] is True
    assert proof["B4_orphans"]["status"] == "PASS"
    assert proof["B4_orphans"]["allObservedPids"]
    assert all(alive is False for alive in proof["B4_orphans"]["postCleanupPidAlive"].values())
    assert proof["B4_orphans"]["postCleanupPs"]["survivors"] == []


def test_runtime_smoke_async_subagent_background_contract_expected_red_records_json_evidence() -> None:
    """Expected-red: async accepted receipt, one callback, streaming command, non-TUI fallbacks."""

    payload, returncode, raw_stdout, raw_stderr = _run_runtime_scenario_raw(
        "async-subagent-contract", timeout=12.0
    )
    contract = payload["runtime"]["asyncSubagentContract"]
    assertion_groups = contract["assertionGroups"]
    raw_json_evidence = {
        "command": ["node", str(RUNTIME_SMOKE), "--scenario", "async-subagent-contract"],
        "exit_code": returncode,
        "raw_stdout": raw_stdout,
        "raw_stderr": raw_stderr,
        "status": contract["status"],
        "assertionGroups": assertion_groups,
        "acceptedTiming": contract["acceptedTiming"],
        "streamingCommandProbe": contract["streamingCommandProbe"],
        "modeMatrixFallbacks": contract["modeMatrixFallbacks"],
        "statusSchemaProbe": contract.get("statusSchemaProbe"),
        "cancelReasonBoundProbe": contract.get("cancelReasonBoundProbe"),
        "callbackShapeProbe": contract.get("callbackShapeProbe"),
        "idempotencyStaleProbe": contract.get("idempotencyStaleProbe"),
        "cancellationSourceRulesProbe": contract.get("cancellationSourceRulesProbe"),
        "abortGraceProbe": contract.get("abortGraceProbe"),
        "lifecycleCleanupProbe": contract.get("lifecycleCleanupProbe"),
        "docsParityProbe": contract.get("docsParityProbe"),
        "subagentConsoleRuntimeProbe": contract.get("subagentConsoleRuntimeProbe"),
        "callbackEntries": contract["callbackEntries"],
    }

    assert payload["package"]["piTuiDependency"]["hardGateStatus"] == "PASS", json.dumps(
        raw_json_evidence, indent=2, sort_keys=True
    )
    assert returncode == 0, json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert contract["status"] == "PASS", json.dumps(raw_json_evidence, indent=2, sort_keys=True)
    assert assertion_groups == {
        "accepted_return_timing": {
            "acceptedStatus": True,
            "resultPendingTrue": True,
            "taskIdAllocated": True,
            "returnedBeforeTerminalOutput": True,
            "acceptedTextWarnsEvidencePending": True,
            "noFinalOutputInAcceptedResult": True,
        },
        "callbacks": {
            "singleCallbackEvent": True,
            "callbackShape": True,
        },
        "streaming_command": {
            "hasUnifiedSlashCommand": True,
            "deprecatedLarvaLogIsViewAliasOnly": True,
            "runningEntryPresentBeforeDispatch": True,
            "invokedWhileParentStreaming": True,
            "streamingSlashCommandDispatch": True,
        },
        "mode_matrix_fallbacks": {
            "rpcListTextualNoOverlay": True,
            "rpcExactTextualNoOverlay": True,
            "printJsonExactSummary": True,
            "printJsonViewUnavailable": True,
            "printJsonCancelUnavailable": True,
            "printJsonClearUnavailable": True,
        },
        "status_schema_phase_result_pending_updated_at_error": {
            "statusToolRegistered": True,
            "activeRecordSchema": True,
            "runningRecordSchema": True,
            "terminalRecordSchema": True,
            "exactTaskIdOnly": True,
        },
        "failed_cancelled_callback_shape": {
            "failedCallbackShape": True,
            "cancelledCallbackShape": True,
        },
        "callback_idempotency_duplicate_suppression": {
            "duplicateCallbackSuppressed": True,
            "staleLateCallbackSuppressed": True,
        },
        "cancellation_source_rules_sibling_parent_non_cancel_and_callback_suppression": {
            "taskACancelled": True,
            "siblingBNotCancelled": True,
            "parentNotAborted": True,
            "modelTerminalCancelSuppressesDuplicateCallback": True,
            "userOrConsoleCancelDeliversCallback": True,
        },
        "abort_kill_grace_1500ms": {
            "expectedGraceRecorded": True,
            "sourceUses1500Grace": True,
            "noFiveSecondAbortFallback": True,
        },
        "runtime_lifecycle_stale_cleanup": {
            "reloadCleanup": True,
            "resumeCleanup": True,
            "forkCleanup": True,
            "quitCleanup": True,
        },
        "docs_parity_against_reference": {
            "authorityReviewed": True,
            "readmeNamesCanonicalSubagent": True,
            "larvaLogDeprecatedOnly": True,
            "sourceRegistersCanonicalCommand": True,
            "sourceRegistersStatusAndCancelTools": True,
        },
        "subagent_console_runtime": {
            "consolePaneSummaryObserved": True,
            "consolePanePromptObserved": True,
            "consolePaneOutputObserved": True,
            "consolePaneTimelineObserved": True,
            "consolePaneMetadataObserved": True,
            "exactSelectedCancelRouteRegistered": True,
            "exactSelectedCancelInvokedCanonicalRoute": True,
            "exactSelectedCancelTargetsSelectedTask": True,
            "exactSelectedCancelPreservesSibling": True,
            "exactSelectedCancelPreservesParent": True,
            "rendererBoundsAllLinesFit": True,
            "rendererBoundsPromptSafe": True,
            "rendererBoundsOutputSafe": True,
            "rendererBoundsTimelineSafe": True,
            "rendererBoundsMetadataSafe": True,
            "canonicalClearRouteRegistered": True,
            "canonicalClearClearsPresentationOnly": True,
            "clearDeletesNoChildSessionFiles": True,
            "clearPreservesParentState": True,
            "legacyClearDemonstratesAdapterLocalSemanticsOnly": True,
        },
        "cancel_reason_bound_500_and_overlong_bad_input": {
            "exact500NormalizedCodePoints": True,
            "overlongNormalizedCodePoints": True,
            "exact500AcceptedForCancellation": True,
            "overlongRejectedAsBadInput": True,
        },
    }, json.dumps(raw_json_evidence, indent=2, sort_keys=True)
