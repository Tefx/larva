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
    assert payload["values"] == ["vectl-planner", "vectl-reviewer"]
    assert payload["allValuesAreStrings"] is True
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


def _run_runtime_scenario(scenario: str, *, timeout: float = 8.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime smoke")
    completed = subprocess.run(
        [node, str(RUNTIME_SMOKE), "--scenario", scenario],
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
    if rpc.get("supported") is not True:
        pytest.xfail(
            "current Pi RPC did not expose extension UI/custom command surfaces; "
            f"rpc evidence={json.dumps(rpc, sort_keys=True)}"
        )


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


def test_runtime_object_registers_larva_subagent_parameters_and_execute() -> None:
    payload = _run_runtime_scenario("tool-shape")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {
        "hasLarvaSubagent": True,
        "hasParameters": True,
        "hasExecute": True,
    }
    assert "larva_subagent" in payload["runtime"]["registeredToolNames"]


def test_runtime_tool_call_event_with_tool_name_blocks_with_reason() -> None:
    payload = _run_runtime_scenario("tool-call-block")

    assertions = payload["runtime"]["assertions"]
    assert assertions == {"blockTrue": True, "nonEmptyReason": True}
    result = payload["runtime"]["toolCallResult"]
    assert result["block"] is True
    assert isinstance(result["reason"], str) and result["reason"]
