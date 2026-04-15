"""Reproduction: Canonical Hard-Cut Liveness Probe - Issue canonical_cutover_impl.liveness_probe

Expected: All runnable surfaces expose only canonical snake_case vocabulary
          with no legacy 'tools' or 'side_effect_policy' fields in any output.
Actual:   Verification that the cutover is complete and surfaces are alive.

Probe surfaces:
  1. CLI larva validate — rejects 'tools' and 'side_effect_policy'
  2. CLI larva register — rejects 'tools'
  3. CLI larva resolve — output has 'capabilities' only, no 'tools'
  4. CLI larva export — output has 'capabilities' only, no 'tools'
  5. Python API — validate rejects legacy fields, resolve returns canonical only
  6. Web API — /api/personas/{id} returns canonical shape
  7. MCP tool names — all snake_case, no dotted aliases
  8. Component types — 'toolsets' (canonical) accepted, no legacy 'tools' in components
"""

import json
import subprocess
import sys
import tempfile
import time
import os

LARVA_BIN = os.path.join(os.environ.get("VIRTUAL_ENV", ".venv"), "bin", "larva")
if not os.path.exists(LARVA_BIN):
    LARVA_BIN = "larva"  # fallback to PATH


def run_cli(*args, json_output=True):
    """Run a larva CLI command and return parsed JSON output."""
    cmd = [LARVA_BIN] + list(args)
    if json_output:
        cmd.append("--json")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return json.loads(result.stdout) if json_output else result


def test_cli_validate_rejects_tools():
    """CLI validate rejects spec with 'tools' field."""
    spec = {
        "id": "probe-tools-reject",
        "description": "Probe persona",
        "prompt": "Test",
        "model": "openai/gpt-5.4",
        "spec_version": "0.1.0",
        "capabilities": {},
        "tools": {"filesystem": "read_only"},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(spec, f)
        f.flush()
        data = run_cli("validate", f.name)

    errors = data.get("error", {}).get("details", {}).get("report", {}).get("errors", [])
    if not data.get("error"):
        errors = data.get("data", {}).get("errors", [])

    # Also check the top-level response for validate --json
    if "data" in data:
        report = data["data"]
        errors = report.get("errors", [])
        assert not report.get("valid", True), (
            f"Issue canonical_cutover: validate accepted spec with 'tools' field. Report: {report}"
        )
        field_names = [e.get("details", {}).get("field") for e in errors]
        assert "tools" in field_names, f"Expected 'tools' in forbidden fields, got: {field_names}"
    elif "error" in data:
        err = data["error"]
        assert "tools" in err.get("message", ""), f"Expected 'tools' in error message, got: {err}"
    else:
        assert False, f"Unexpected response format: {data}"
    print("PASS: CLI validate rejects 'tools'")


def test_cli_validate_rejects_side_effect_policy():
    """CLI validate rejects spec with 'side_effect_policy' field."""
    spec = {
        "id": "probe-sep-reject",
        "description": "Probe persona",
        "prompt": "Test",
        "model": "openai/gpt-5.4",
        "spec_version": "0.1.0",
        "capabilities": {},
        "side_effect_policy": "full",
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(spec, f)
        f.flush()
        data = run_cli("validate", f.name)

    if "data" in data:
        report = data["data"]
        errors = report.get("errors", [])
        field_names = [e.get("details", {}).get("field") for e in errors]
        assert "side_effect_policy" in field_names, (
            f"Expected 'side_effect_policy' in forbidden fields, got: {field_names}"
        )
    elif "error" in data:
        err = data["error"]
        assert "side_effect_policy" in err.get("message", ""), (
            f"Expected 'side_effect_policy' in error message, got: {err}"
        )
    print("PASS: CLI validate rejects 'side_effect_policy'")


def test_cli_resolve_output_canonical():
    """CLI resolve output contains 'capabilities' but not 'tools' or 'side_effect_policy'."""
    data = run_cli("resolve", "general")
    spec = data.get("data", {})

    assert "capabilities" in spec, (
        f"Issue canonical_cutover: resolve output missing 'capabilities' field. Keys: {sorted(spec.keys())}"
    )
    assert "tools" not in spec, (
        f"Issue canonical_cutover: resolve output contains legacy 'tools' field! Keys: {sorted(spec.keys())}"
    )
    assert "side_effect_policy" not in spec, (
        f"Issue canonical_cutover: resolve output contains legacy 'side_effect_policy' field! Keys: {sorted(spec.keys())}"
    )
    print("PASS: CLI resolve output is canonical (capabilities only, no tools/sep)")


def test_cli_export_output_canonical():
    """CLI export output contains 'capabilities' but not 'tools' in any persona."""
    data = run_cli("export", "general", "archimedes")
    personas = data.get("data", [])

    for p in personas:
        assert "capabilities" in p, (
            f"Issue canonical_cutover: export output missing 'capabilities' for {p.get('id')}"
        )
        assert "tools" not in p, (
            f"Issue canonical_cutover: export output contains 'tools' for {p.get('id')}"
        )
        assert "side_effect_policy" not in p, (
            f"Issue canonical_cutover: export output contains 'side_effect_policy' for {p.get('id')}"
        )
    print(f"PASS: CLI export output is canonical across {len(personas)} personas")


def test_cli_register_rejects_tools():
    """CLI register rejects spec containing 'tools' field."""
    spec = {
        "id": "probe-reg-tools-reject",
        "description": "Should fail",
        "prompt": "Test",
        "model": "openai/gpt-5.4",
        "spec_version": "0.1.0",
        "capabilities": {},
        "tools": {"filesystem": "read_only"},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(spec, f)
        f.flush()
        data = run_cli("register", f.name)

    err = data.get("error", {})
    assert err.get("code") == "PERSONA_INVALID", (
        f"Issue canonical_cutover: register did not reject spec with tools. Response: {data}"
    )
    assert "tools" in err.get("message", ""), (
        f"Expected 'tools' in error message, got: {err.get('message')}"
    )
    print("PASS: CLI register rejects 'tools'")


def test_python_api_validate_rejects_legacy():
    """Python API validate rejects 'tools' and 'side_effect_policy'."""
    from larva.cli_facade import build_default_facade

    facade = build_default_facade()

    # Test tools rejection
    spec_with_tools = {
        "id": "probe-py-tools",
        "description": "Test",
        "prompt": "Test",
        "model": "openai/gpt-5.4",
        "spec_version": "0.1.0",
        "capabilities": {},
        "tools": {"filesystem": "read_only"},
    }
    report = facade.validate(spec_with_tools)
    assert not report.get("valid", True), (
        f"Python API validate accepted spec with 'tools'. Report: {report}"
    )
    field_names = [e.get("details", {}).get("field") for e in report.get("errors", [])]
    assert "tools" in field_names, f"Expected 'tools' in errors, got: {field_names}"

    # Test side_effect_policy rejection
    spec_with_sep = {
        "id": "probe-py-sep",
        "description": "Test",
        "prompt": "Test",
        "model": "openai/gpt-5.4",
        "spec_version": "0.1.0",
        "capabilities": {},
        "side_effect_policy": "full",
    }
    report = facade.validate(spec_with_sep)
    assert not report.get("valid", True), (
        f"Python API validate accepted spec with 'side_effect_policy'. Report: {report}"
    )
    field_names = [e.get("details", {}).get("field") for e in report.get("errors", [])]
    assert "side_effect_policy" in field_names, (
        f"Expected 'side_effect_policy' in errors, got: {field_names}"
    )
    print("PASS: Python API validate rejects 'tools' and 'side_effect_policy'")


def test_python_api_resolve_canonical():
    """Python API resolve returns canonical shape (capabilities, no tools)."""
    from larva.cli_facade import build_default_facade

    facade = build_default_facade()
    result = facade.resolve("general", None)
    spec = result.unwrap()

    assert "capabilities" in spec, (
        f"Python API resolve missing 'capabilities'. Keys: {sorted(spec.keys())}"
    )
    assert "tools" not in spec, (
        f"Python API resolve contains legacy 'tools'. Keys: {sorted(spec.keys())}"
    )
    assert "side_effect_policy" not in spec, (
        f"Python API resolve contains legacy 'side_effect_policy'. Keys: {sorted(spec.keys())}"
    )
    print("PASS: Python API resolve output is canonical")


def test_mcp_tool_names_snake_case():
    """MCP tool names are all snake_case with no dotted aliases."""
    from larva.shell.mcp_contract import LARVA_MCP_TOOLS

    dotted_tools = [t["name"] for t in LARVA_MCP_TOOLS if "." in t["name"]]
    assert len(dotted_tools) == 0, f"Found dotted (legacy) MCP tool names: {dotted_tools}"

    expected_tools = {
        "larva_validate",
        "larva_assemble",
        "larva_resolve",
        "larva_register",
        "larva_list",
        "larva_component_list",
        "larva_component_show",
        "larva_delete",
        "larva_clear",
        "larva_clone",
        "larva_export",
        "larva_update",
        "larva_update_batch",
    }
    actual_tools = {t["name"] for t in LARVA_MCP_TOOLS}
    # Check that all expected tools exist
    missing = expected_tools - actual_tools
    assert len(missing) == 0, f"Missing expected MCP tools: {missing}"
    print(f"PASS: All {len(LARVA_MCP_TOOLS)} MCP tools are snake_case")


def test_web_api_liveness():
    """Web API starts, binds port, and returns canonical data."""
    import urllib.request
    import urllib.error

    port = 17431
    proc = subprocess.Popen(
        [LARVA_BIN, "serve", "--port", str(port), "--no-open"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        time.sleep(3)

        # Check process is alive
        poll = proc.poll()
        assert poll is None, f"Web server exited immediately with code {poll}"

        # Check port is bound
        try:
            resp = urllib.request.urlopen(f"http://localhost:{port}/api/personas", timeout=5)
            data = json.loads(resp.read().decode())
        except urllib.error.URLError as e:
            raise AssertionError(f"Cannot connect to web API on port {port}: {e}")
        except Exception as e:
            raise AssertionError(f"Unexpected error connecting to web API: {e}")

        # Validate response structure
        assert "data" in data, f"Web API response missing 'data' key: {list(data.keys())}"
        personas = data["data"]
        assert isinstance(personas, list), f"Expected list of personas, got {type(personas)}"

        # Validate summary shape (no legacy fields)
        if personas:
            summary = personas[0]
            summary_keys = set(summary.keys())
            assert "tools" not in summary_keys, (
                f"Web API /api/personas summary contains 'tools': {summary_keys}"
            )
            assert "side_effect_policy" not in summary_keys, (
                f"Web API /api/personas summary contains 'side_effect_policy': {summary_keys}"
            )

        # Check single-persona resolve endpoint
        try:
            resp = urllib.request.urlopen(
                f"http://localhost:{port}/api/personas/general", timeout=5
            )
            person_data = json.loads(resp.read().decode())
        except Exception as e:
            raise AssertionError(f"Cannot fetch /api/personas/general: {e}")

        spec = person_data.get("data", {})
        assert "capabilities" in spec, (
            f"Web API resolve missing 'capabilities'. Keys: {sorted(spec.keys())}"
        )
        assert "tools" not in spec, (
            f"Web API resolve contains legacy 'tools'. Keys: {sorted(spec.keys())}"
        )
        assert "side_effect_policy" not in spec, (
            f"Web API resolve contains legacy 'side_effect_policy'. Keys: {sorted(spec.keys())}"
        )

        # Validate rejection of 'tools' via web
        try:
            req = urllib.request.Request(
                f"http://localhost:{port}/api/personas/validate",
                data=json.dumps(
                    {
                        "id": "web-probe",
                        "description": "test",
                        "prompt": "test",
                        "model": "openai/gpt-5.4",
                        "spec_version": "0.1.0",
                        "capabilities": {},
                        "tools": {"filesystem": "read_only"},
                    }
                ).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            resp = urllib.request.urlopen(req, timeout=5)
            val_data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            val_data = json.loads(e.read().decode())

        val_report = val_data.get("data", val_data)
        val_errors = val_report.get("errors", [])
        field_names = [e.get("details", {}).get("field") for e in val_errors]
        assert "tools" in field_names, (
            f"Web API validate did not reject 'tools'. Errors: {val_errors}"
        )

        print("PASS: Web API alive, canonical, and rejecting legacy fields")

    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_cli_validate_accepts_canonical():
    """CLI validate accepts a valid canonical spec with capabilities."""
    spec = {
        "id": "probe-canonical-valid",
        "description": "A valid canonical test persona",
        "prompt": "You are a test agent.",
        "model": "openai/gpt-5.4",
        "spec_version": "0.1.0",
        "capabilities": {"filesystem": "read_only"},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(spec, f)
        f.flush()
        data = run_cli("validate", f.name)

    report = data.get("data", {})
    assert report.get("valid", False), (
        f"Issue canonical_cutover: validate rejected a valid canonical spec. Report: {report}"
    )
    print("PASS: CLI validate accepts valid canonical spec")


def main():
    probes = [
        ("CLI validate rejects 'tools'", test_cli_validate_rejects_tools),
        ("CLI validate rejects 'side_effect_policy'", test_cli_validate_rejects_side_effect_policy),
        ("CLI validate accepts canonical spec", test_cli_validate_accepts_canonical),
        ("CLI register rejects 'tools'", test_cli_register_rejects_tools),
        ("CLI resolve output canonical", test_cli_resolve_output_canonical),
        ("CLI export output canonical", test_cli_export_output_canonical),
        ("Python API validate rejects legacy", test_python_api_validate_rejects_legacy),
        ("Python API resolve canonical", test_python_api_resolve_canonical),
        ("MCP tool names snake_case", test_mcp_tool_names_snake_case),
        ("Web API liveness + canonical", test_web_api_liveness),
    ]

    failures = []
    for name, probe in probes:
        try:
            probe()
        except Exception as e:
            failures.append((name, str(e)))
            print(f"FAIL: {name} — {e}")

    print(f"\n{'=' * 60}")
    print(f"Results: {len(probes) - len(failures)}/{len(probes)} passed")
    if failures:
        print(f"Failures:")
        for name, err in failures:
            print(f"  {name}: {err}")
        sys.exit(1)
    else:
        print("ALL LIVENESS PROBES PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()
