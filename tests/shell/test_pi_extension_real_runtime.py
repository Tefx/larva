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


@pytest.mark.parametrize("case,force", [("tab-force", True), ("tab-regular", False)])
def test_autocomplete_tui_provider_uses_argument_prefix_for_force_modes(case: str, force: bool) -> None:
    payload = _run_autocomplete_case(case, prefix="vectl")

    assert payload["command"] == "larva-persona"
    assert payload["force"] is force
    assert payload["prefix"] == "vectl"
    assert payload["editorLine"] == "/larva-persona vectl"
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
        "tool-call-block",
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


def test_runtime_object_registers_larva_subagent_parameters_and_execute() -> None:
    payload = _run_runtime_scenario("tool-shape")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {
        "hasLarvaSubagent": True,
        "hasParameters": True,
        "hasExecute": True,
    }
    assert "larva_subagent" in payload["runtime"]["registeredToolNames"]


def test_registered_larva_subagent_results_are_renderer_safe_toolresults() -> None:
    """Expected-red: Pi renderer calls result.content.filter(...) on tool output.

    This invokes the registered ``larva_subagent`` handler/execute functions via
    the runtime smoke harness and requires a Pi ToolResult-style content array.
    Current raw LarvaSubagentResult payloads omit ``content`` and are therefore
    unsafe for Pi's renderer.
    """

    payload = _run_runtime_scenario("tool-result-renderer-shape")
    cases = payload["runtime"]["toolResultCases"]
    assertions = payload["runtime"]["assertions"]

    assert cases["failedBeforeSession"]["status"] == "failed"
    assert cases["failedBeforeSession"]["error"]["code"] == "LARVA_NO_ACTIVE_PERSONA"
    assert cases["cancelled"]["status"] == "cancelled"
    assert cases["failedAfterAllocation"]["status"] == "failed"
    assert cases["failedAfterAllocation"]["task_id"].endswith("allocated.jsonl")

    assert assertions == {
        "failedBeforeSession": True,
        "cancelled": True,
        "failedAfterAllocation": True,
    }


def test_runtime_tool_call_event_with_tool_name_blocks_with_reason() -> None:
    payload = _run_runtime_scenario("tool-call-block")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {"blockTrue": True, "nonEmptyReason": True}
    result = payload["runtime"]["toolCallResult"]
    assert result["block"] is True
    assert isinstance(result["reason"], str) and result["reason"]
