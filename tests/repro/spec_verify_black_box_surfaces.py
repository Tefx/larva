"""Reproduction: Black-box verification across CLI/Python API/MCP/Web surfaces.

Expected: All four public surfaces enforce canonical admission:
  - Register accepts canonical-success fixtures
  - Register rejects forbidden-field fixtures (tools, side_effect_policy, unknown fields)
  - Validate rejects forbidden-field fixtures
  - Update rejects forbidden fields in patches
  - Resolve rejects forbidden fields in overrides
  - Normalize rejects forbidden fields for downstream rejection; it never maps them into canonical acceptance
  - Assemble rejects forbidden override fields

Actual: To be determined by running this script.
"""

import json
import tempfile
from pathlib import Path

# ============================================================================
# Canonical success fixture (from INTERFACES.md normative shape)
# ============================================================================
CANONICAL_SUCCESS = {
    "id": "developer",
    "description": "Local coding persona",
    "prompt": "You are a helpful assistant.",
    "model": "claude-sonnet-4",
    "capabilities": {
        "filesystem": "read_write",
        "git": "read_only",
    },
    "spec_version": "0.1.0",
}

# ============================================================================
# Forbidden fixture set (from INTERFACES.md canonical admission rules)
# ============================================================================

# Fixture: spec with rejected field "tools"
FORBIDDEN_TOOLS = dict(CANONICAL_SUCCESS, tools={"shell": "read_write"})

# Fixture: spec with rejected field "side_effect_policy"
FORBIDDEN_SIDE_EFFECT = dict(CANONICAL_SUCCESS, side_effect_policy="approval_required")

# Fixture: spec with unknown top-level field
FORBIDDEN_UNKNOWN_FIELD = dict(CANONICAL_SUCCESS, custom_runtime_flag=True)

# Fixture: spec missing required field "capabilities"
MISSING_CAPABILITIES = {
    "id": "no-caps",
    "description": "Missing capabilities",
    "prompt": "test",
    "model": "test",
    "spec_version": "0.1.0",
}

# Fixture: spec with invalid spec_version
INVALID_SPEC_VERSION = dict(CANONICAL_SUCCESS, spec_version="2.0.0")

# Fixture: spec missing required field "description"
MISSING_DESCRIPTION = {
    "id": "no-desc",
    "prompt": "test",
    "model": "test",
    "capabilities": {"git": "read_only"},
    "spec_version": "0.1.0",
}


def test_validate_canonical_success():
    """validate_spec accepts canonical-success fixture."""
    from larva.core.validate import validate_spec

    report = validate_spec(CANONICAL_SUCCESS)
    assert report["valid"] is True, (
        f"Issue: canonical success fixture must validate as valid. Got errors: {report['errors']}"
    )
    print("PASS: canonical success fixture validates as valid")


def test_validate_forbidden_tools():
    """validate_spec rejects spec with forbidden field 'tools'."""
    from larva.core.validate import validate_spec

    report = validate_spec(FORBIDDEN_TOOLS)
    assert report["valid"] is False, (
        "Issue: spec with 'tools' field must be rejected at canonical admission."
    )
    error_codes = [e["code"] for e in report["errors"]]
    assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
        f"Expected EXTRA_FIELD_NOT_ALLOWED error for 'tools', got: {error_codes}"
    )
    forbidden_messages = [
        e["message"] for e in report["errors"] if e["code"] == "EXTRA_FIELD_NOT_ALLOWED"
    ]
    assert any("tools" in m.lower() for m in forbidden_messages), (
        f"Expected 'tools' in forbidden field message, got: {forbidden_messages}"
    )
    print("PASS: 'tools' is rejected at canonical admission")


def test_validate_forbidden_side_effect_policy():
    """validate_spec rejects spec with forbidden field 'side_effect_policy'."""
    from larva.core.validate import validate_spec

    report = validate_spec(FORBIDDEN_SIDE_EFFECT)
    assert report["valid"] is False, "Issue: spec with 'side_effect_policy' must be rejected."
    error_codes = [e["code"] for e in report["errors"]]
    assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
        f"Expected EXTRA_FIELD_NOT_ALLOWED for 'side_effect_policy', got: {error_codes}"
    )
    print("PASS: 'side_effect_policy' is rejected at canonical admission")


def test_validate_unknown_field():
    """validate_spec rejects spec with unknown top-level field."""
    from larva.core.validate import validate_spec

    report = validate_spec(FORBIDDEN_UNKNOWN_FIELD)
    assert report["valid"] is False, "Issue: spec with unknown top-level field must be rejected."
    error_codes = [e["code"] for e in report["errors"]]
    assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
        f"Expected EXTRA_FIELD_NOT_ALLOWED for unknown field, got: {error_codes}"
    )
    print("PASS: unknown top-level field is rejected at canonical admission")


def test_validate_missing_capabilities():
    """validate_spec rejects spec missing required field 'capabilities'."""
    from larva.core.validate import validate_spec

    report = validate_spec(MISSING_CAPABILITIES)
    assert report["valid"] is False, "Issue: spec missing 'capabilities' must be rejected."
    error_codes = [e["code"] for e in report["errors"]]
    assert "MISSING_REQUIRED_FIELD" in error_codes, (
        f"Expected MISSING_REQUIRED_FIELD for 'capabilities', got: {error_codes}"
    )
    print("PASS: missing 'capabilities' field is rejected")


def test_validate_invalid_spec_version():
    """validate_spec rejects spec with invalid spec_version."""
    from larva.core.validate import validate_spec

    report = validate_spec(INVALID_SPEC_VERSION)
    assert report["valid"] is False, "Issue: spec with invalid spec_version must be rejected."
    error_codes = [e["code"] for e in report["errors"]]
    assert "INVALID_SPEC_VERSION" in error_codes, (
        f"Expected INVALID_SPEC_VERSION, got: {error_codes}"
    )
    print("PASS: invalid spec_version is rejected")


def test_normalize_rejects_forbidden_fields_strictly():
    """normalize_spec rejects forbidden fields instead of preserving compatibility."""
    import pytest

    from larva.core.normalize import NormalizeError, normalize_spec

    with pytest.raises(NormalizeError) as tools_error:
        normalize_spec({"id": "test", "spec_version": "0.1.0", "tools": {"shell": "read_write"}})
    assert tools_error.value.code == "FORBIDDEN_FIELD"
    assert tools_error.value.details == {"field": "tools"}

    with pytest.raises(NormalizeError) as side_effect_error:
        normalize_spec(dict(CANONICAL_SUCCESS, side_effect_policy="read_only"))
    assert side_effect_error.value.code == "FORBIDDEN_FIELD"
    assert side_effect_error.value.details == {"field": "side_effect_policy"}

    print("PASS: normalize rejects forbidden fields without canonicalizing them")


def test_normalize_computes_spec_digest():
    """normalize_spec computes spec_digest while preserving required spec_version."""
    from larva.core.normalize import normalize_spec

    result = normalize_spec(dict(CANONICAL_SUCCESS))
    assert "spec_digest" in result, "Issue: normalize must compute spec_digest."
    assert result["spec_digest"].startswith("sha256:"), (
        f"Issue: spec_digest must start with 'sha256:', got: {result['spec_digest']}"
    )
    assert result["spec_version"] == "0.1.0", (
        f"Issue: spec_version must stay pinned to '0.1.0', got: {result['spec_version']}"
    )
    print("PASS: normalize computes spec_digest and preserves required spec_version")


def test_normalize_deterministic():
    """normalize_spec is deterministic: same input = same output."""
    from larva.core.normalize import normalize_spec

    result1 = normalize_spec(dict(CANONICAL_SUCCESS))
    result2 = normalize_spec(dict(CANONICAL_SUCCESS))
    assert result1["spec_digest"] == result2["spec_digest"], (
        "Issue: normalize must be deterministic."
    )
    print("PASS: normalize is deterministic")


def test_python_api_register_accepts_canonical():
    """Python API: register accepts canonical-success fixture."""
    from larva.shell.python_api import register

    # Clean registry
    _clear_registry()
    result = register(dict(CANONICAL_SUCCESS))
    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    assert result.get("id") == CANONICAL_SUCCESS["id"], (
        f"Expected id={CANONICAL_SUCCESS['id']}, got {result.get('id')}"
    )
    print("PASS: Python API register accepts canonical fixture")


def test_python_api_register_rejects_tools():
    """Python API: register rejects spec with forbidden 'tools' field."""
    from larva.shell.python_api import register
    from larva.shell.python_api import LarvaApiError

    _clear_registry()
    try:
        result = register(dict(FORBIDDEN_TOOLS))
        print(f"UNEXPECTED: register accepted spec with 'tools': {result}")
        assert False, "register must reject spec with 'tools' field"
    except LarvaApiError as e:
        error = e.error
        assert error.get("code") == "PERSONA_INVALID", (
            f"Expected PERSONA_INVALID error, got: {error.get('code')}"
        )
        print("PASS: Python API register rejects 'tools' field")


def test_python_api_register_rejects_side_effect_policy():
    """Python API: register rejects spec with forbidden 'side_effect_policy' field."""
    from larva.shell.python_api import register
    from larva.shell.python_api import LarvaApiError

    _clear_registry()
    try:
        result = register(dict(FORBIDDEN_SIDE_EFFECT))
        print(f"UNEXPECTED: register accepted spec with 'side_effect_policy': {result}")
        assert False, "register must reject spec with 'side_effect_policy' field"
    except LarvaApiError as e:
        error = e.error
        assert error.get("code") == "PERSONA_INVALID", (
            f"Expected PERSONA_INVALID error, got: {error.get('code')}"
        )
        print("PASS: Python API register rejects 'side_effect_policy' field")


def test_python_api_validate_rejects_tools():
    """Python API: validate rejects spec with forbidden 'tools' field."""
    from larva.shell.python_api import validate

    report = validate(dict(FORBIDDEN_TOOLS))
    assert report["valid"] is False, "Python API validate must reject spec with 'tools' field."
    print("PASS: Python API validate rejects 'tools' field")


def test_python_api_update_rejects_tools_patch():
    """Python API: update rejects patches containing 'tools' field."""
    from larva.shell.python_api import register, update
    from larva.shell.python_api import LarvaApiError

    _clear_registry()
    # Register a valid persona first
    register(dict(CANONICAL_SUCCESS))

    try:
        result = update("developer", {"tools": {"shell": "destructive"}})
        # If we get here, the update was accepted - check if result has tools
        if isinstance(result, dict) and "tools" in result:
            print(f"UNEXPECTED: update accepted 'tools' patch and tools is in result: {result}")
            assert False, "update must reject patches with 'tools' field"
        # It's also possible update rejected it with an error dict rather than exception
        # The python_api dispatches through facade which returns Result, so
        # LarvaApiError should be raised on failure
        print(f"Update result type: {type(result)}, value: {result}")
    except LarvaApiError as e:
        error = e.error
        assert error.get("code") == "FORBIDDEN_PATCH_FIELD", (
            f"Expected FORBIDDEN_PATCH_FIELD error, got: {error.get('code')}"
        )
        print("PASS: Python API update rejects 'tools' in patches")


def test_python_api_resolve_rejects_tools_override():
    """Python API: resolve rejects overrides containing 'tools' field."""
    from larva.shell.python_api import register, resolve
    from larva.shell.python_api import LarvaApiError

    _clear_registry()
    register(dict(CANONICAL_SUCCESS))

    try:
        result = resolve("developer", overrides={"tools": {"shell": "destructive"}})
        if isinstance(result, dict) and "tools" in result:
            print(f"UNEXPECTED: resolve accepted 'tools' override: {result}")
            assert False, "resolve must reject overrides with 'tools' field"
        print(f"Resolve result: {result}")
    except LarvaApiError as e:
        error = e.error
        assert error.get("code") == "FORBIDDEN_OVERRIDE_FIELD", (
            f"Expected FORBIDDEN_OVERRIDE_FIELD error, got: {error.get('code')}"
        )
        print("PASS: Python API resolve rejects 'tools' in overrides")


def test_python_api_assembly_removed():
    """Python API: assemble has been removed; the symbol must not be importable
    from the canonical Python API surface.

    Source: INTERFACES.md lines 120-125; design doc lines 125-129.
    Assemble is a removed subsystem per the registry-local variants cutover.
    """
    import larva.shell.python_api as pyapi

    # The canonical Python API must not expose assemble
    assert not hasattr(pyapi, "assemble") or not callable(getattr(pyapi, "assemble", None)), (
        "assemble must be removed from the canonical Python API after cutover"
    )
    print("PASS: assemble is removed from Python API")


def test_python_api_register_rejects_variant_in_spec():
    """Python API: register rejects spec with 'variant' field as non-canonical."""
    from larva.shell.python_api import register
    from larva.shell.python_api import LarvaApiError

    _clear_registry()
    # 'variant' is a registry-local metadata field, not a PersonaSpec field
    spec_with_variant = dict(CANONICAL_SUCCESS, variant="tacit")
    try:
        result = register(spec_with_variant)
        print(f"UNEXPECTED: register accepted spec with 'variant': {result}")
        assert False, "register must reject spec with 'variant' field"
    except LarvaApiError as e:
        error = e.error
        assert error.get("code") == "PERSONA_INVALID", (
            f"Expected PERSONA_INVALID for 'variant' field, got: {error.get('code')}"
        )
        print("PASS: Python API register rejects 'variant' field in spec")


def test_python_api_resolve_no_variant_metadata_leak():
    """Python API: resolve output must not contain variant, _registry, or active."""
    from larva.shell.python_api import register, resolve

    _clear_registry()
    register(dict(CANONICAL_SUCCESS))

    resolved = resolve(CANONICAL_SUCCESS["id"])
    forbidden_keys = {"variant", "_registry", "active"}
    for key in forbidden_keys:
        assert key not in resolved, (
            f"Forbidden key '{key}' found in resolve output: {sorted(resolved.keys())}"
        )
    print("PASS: Python API resolve output has no registry metadata leak")


def test_python_api_list_no_variant_metadata():
    """Python API: list returns summaries without variant or active fields."""
    from larva.shell.python_api import register
    from larva.shell.python_api import list as list_personas

    _clear_registry()
    register(dict(CANONICAL_SUCCESS))

    personas = list_personas()
    assert isinstance(personas, list)
    for p in personas:
        assert "variant" not in p, f"'variant' must not appear in list summary: {sorted(p.keys())}"
        assert "active" not in p, f"'active' must not appear in list summary: {sorted(p.keys())}"
        assert "_registry" not in p, f"'_registry' must not appear in list summary: {sorted(p.keys())}"
    print("PASS: Python API list has no variant metadata leak")


def test_python_api_no_forbidden_fields_in_output():
    """Python API: registered personas never contain 'tools' or 'side_effect_policy'."""
    from larva.shell.python_api import register, list as list_personas

    _clear_registry()
    register(dict(CANONICAL_SUCCESS))

    personas = list_personas()
    assert isinstance(personas, list), f"Expected list, got {type(personas)}"
    for p in personas:
        assert "tools" not in p, (
            f"Forbidden field 'tools' found in registered persona output: {list(p.keys())}"
        )
        assert "side_effect_policy" not in p, (
            f"Forbidden field 'side_effect_policy' found in registered persona output: {list(p.keys())}"
        )
    print("PASS: Python API output never contains forbidden fields")


def _clear_registry():
    """Helper: clear registry for clean tests."""
    from larva.shell.python_api import clear

    try:
        clear(confirm="CLEAR REGISTRY")
    except Exception:
        pass  # Registry may be empty


if __name__ == "__main__":
    tests = [
        test_validate_canonical_success,
        test_validate_forbidden_tools,
        test_validate_forbidden_side_effect_policy,
        test_validate_unknown_field,
        test_validate_missing_capabilities,
        test_validate_invalid_spec_version,
        test_normalize_rejects_forbidden_fields_strictly,
        test_normalize_computes_spec_digest,
        test_normalize_deterministic,
        test_python_api_register_accepts_canonical,
        test_python_api_register_rejects_tools,
        test_python_api_register_rejects_side_effect_policy,
        test_python_api_validate_rejects_tools,
        test_python_api_update_rejects_tools_patch,
        test_python_api_resolve_rejects_tools_override,
        test_python_api_assembly_removed,
        test_python_api_register_rejects_variant_in_spec,
        test_python_api_resolve_no_variant_metadata_leak,
        test_python_api_list_no_variant_metadata,
        test_python_api_no_forbidden_fields_in_output,
    ]

    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"FAIL: {test.__name__}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    if failed > 0:
        raise SystemExit(1)
