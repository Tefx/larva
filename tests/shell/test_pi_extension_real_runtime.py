from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
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
    assert payload["providerResultsAreObjects"] is True
    assert payload["resultItemsAreArrays"] is True
    assert payload["prefixesFromProvider"] == ["vectl", "vectl", "vectl"]
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


def _run_runtime_scenario(scenario: str, *, persona: str | None = None, timeout: float = 8.0) -> dict[str, Any]:
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
        "failure-path",
        "tool-shape",
        "tool-result-renderer-shape",
        "fresh-session-validation",
        "tool-call-block",
        "capability-gates",
        "live-child-rpc-proof",
    ):
        assert scenario in completed.stdout


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
    gate = payload["runtime"]["hardGates"]["uiAutocompleteProvider"]

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

    assert cases["success"]["status"] == "success"
    assert cases["success"]["result_text"] == "child final text"
    assert cases["success"]["details"]["result_text"] == "child final text"
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
    assert fresh["status"] == "success"
    assert fresh["result_text"] == "fresh child final text"
    assert fresh["task_id"].endswith("fresh-created-on-prompt.jsonl")

    missing_resume = validation["missingResume"]
    assert missing_resume["status"] == "failed"
    assert missing_resume["error"]["code"] == "LARVA_SESSION_NOT_FOUND"
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
