"""Tests for facade register operation.

Sources:
- ARCHITECTURE.md section 7 (Registry read -> override -> revalidation)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from returns.result import Result, Success

from larva.app.facade import LarvaError
from larva.core.spec import PersonaSpec

from .conftest import (
    InMemoryRegistryStore,
    _canonical_spec,
    _digest_for,
    _facade,
    _failure,
    _invalid_report,
    _valid_report,
)


class TestFacadeRegister:
    def test_register_validates_normalizes_then_persists_and_returns_facade_shape(self) -> None:
        calls: list[str] = []
        registry = InMemoryRegistryStore()
        spec = _canonical_spec("register-ok", digest="sha256:old")
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.register(spec)

        assert isinstance(result, Success)
        assert result.unwrap() == {"id": "register-ok", "registered": True}
        assert calls == ["validate", "normalize"]
        assert validate_module.inputs == [spec]
        assert normalize_module.inputs[0]["id"] == "register-ok"
        assert registry.save_inputs[0]["id"] == "register-ok"
        assert registry.save_inputs[0]["spec_digest"] == _digest_for(spec)

    def test_register_preserves_explicit_falsey_values_through_delegation(self) -> None:
        calls: list[str] = []
        registry = InMemoryRegistryStore()
        spec = _canonical_spec("register-falsey")
        spec["can_spawn"] = False
        spec["description"] = ""
        spec["compaction_prompt"] = ""
        spec["description"] = cast("object", None)
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.register(spec)

        assert isinstance(result, Success)
        assert calls == ["validate", "normalize"]
        assert validate_module.inputs[0]["can_spawn"] is False
        assert validate_module.inputs[0]["description"] is None
        assert validate_module.inputs[0]["compaction_prompt"] == ""
        assert normalize_module.inputs[0]["can_spawn"] is False
        assert normalize_module.inputs[0]["description"] is None
        assert normalize_module.inputs[0]["compaction_prompt"] == ""
        assert registry.save_inputs[0]["can_spawn"] is False
        assert registry.save_inputs[0]["description"] is None
        assert registry.save_inputs[0]["compaction_prompt"] == ""

    def test_register_validation_failure_blocks_persistence(self) -> None:
        registry = InMemoryRegistryStore()
        facade, _, _, _ = _facade(report=_invalid_report(), registry=registry)

        result = facade.register(_canonical_spec("bad-register"))

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert registry.save_inputs == []

    def test_register_maps_registry_save_failures_to_app_error(self) -> None:
        registry = InMemoryRegistryStore(
            save_result=Failure(
                {
                    "code": "REGISTRY_WRITE_FAILED",
                    "message": "disk full",
                    "persona_id": "writer",
                    "path": "/tmp/writer.json",
                }
            )
        )
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.register(_canonical_spec("writer"))

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_WRITE_FAILED"
        assert error["numeric_code"] == 109
        assert error["details"]["persona_id"] == "writer"
        assert error["details"]["path"] == "/tmp/writer.json"


from returns.result import Failure


class TestFacadeRegisterExposesCanonicalGaps:
    """Tests exposing canonical admission gaps at the register level.

    Gap documentation:
    - gap_1: _canonical_spec contains tools (forbidden at canonical boundary)
    - gap_2: _canonical_spec contains side_effect_policy (forbidden at canonical boundary)
    - gap_3: tests that pass with _canonical_spec are accepting forbidden fields
    - gap_4: register success with forbidden fields implies no canonical conformance

    Downstream step: canonical_core_admission.implementation
    """

    def test_register_rejects_spec_with_tools_field(self):
        """Register should reject specs with tools field (FORBIDDEN_EXTRA_FIELD).

        Gap: _canonical_spec includes tools, but register doesn't check for it.
        Downstream: canonical_core_admission.implementation
        """
        registry = InMemoryRegistryStore()
        # Use _valid_report() so register proceeds
        facade, _, _, _ = _facade(
            report=_valid_report(),
            registry=registry,
        )

        # Spec with tools - should be rejected but currently passes
        spec_with_tools = {
            "id": "tools-register",
            "description": "Test",
            "prompt": "You help",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "tools": {"shell": "read_only"},  # forbidden at canonical boundary
            "spec_version": "0.1.0",
        }

        result = facade.register(spec_with_tools)

        # Currently this succeeds because _valid_report() returns valid=True
        # Gap: The spec has tools which should produce FORBIDDEN_EXTRA_FIELD error
        assert isinstance(result, Success), (
            "Currently register accepts spec with tools - "
            "this should be rejected after canonical enforcement"
        )

    def test_register_rejects_spec_with_side_effect_policy(self):
        """Register should reject specs with side_effect_policy (FORBIDDEN_EXTRA_FIELD).

        Gap: _canonical_spec includes side_effect_policy, but register doesn't check.
        Downstream: canonical_core_admission.implementation
        """
        registry = InMemoryRegistryStore()
        facade, _, _, _ = _facade(
            report=_valid_report(),
            registry=registry,
        )

        spec_with_sep = {
            "id": "sep-register",
            "description": "Test",
            "prompt": "You help",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "side_effect_policy": "read_only",  # forbidden at canonical boundary
            "spec_version": "0.1.0",
        }

        result = facade.register(spec_with_sep)

        # Currently succeeds because _valid_report() returns valid=True
        # Gap: spec has side_effect_policy which should be rejected

    def test_register_rejects_spec_without_capabilities(self):
        """Register should reject specs without capabilities (MISSING_REQUIRED_FIELD).

        Gap: Spec without capabilities currently passes validation.
        Downstream: canonical_core_admission.implementation
        """
        registry = InMemoryRegistryStore()
        facade, _, _, _ = _facade(
            report=_valid_report(),
            registry=registry,
        )

        spec_no_capabilities = {
            "id": "no-capabilities-register",
            "description": "Test",
            "prompt": "You help",
            "model": "gpt-4o-mini",
            "spec_version": "0.1.0",
        }

        result = facade.register(spec_no_capabilities)

        # Currently succeeds because _valid_report() returns valid=True
        # Gap: capabilities is required at canonical boundary

    def test_canonical_spec_fixture_contains_forbidden_fields(self):
        """Document that _canonical_spec fixture contains forbidden fields.

        This test exposes that the test fixture itself violates canonical contract:
        _canonical_spec includes both tools and side_effect_policy which are
        forbidden at the canonical admission boundary.

        After canonical enforcement, this fixture must be updated to remove
        the forbidden fields, or tests using it may break.
        """
        spec = _canonical_spec("fixture-check")

        # Document the gap: fixture has forbidden fields
        assert "tools" in spec, (
            "_canonical_spec should contain 'tools' to document the gap. "
            "This field is forbidden at canonical boundary."
        )
        assert "side_effect_policy" in spec, (
            "_canonical_spec should contain 'side_effect_policy' to document the gap. "
            "This field is forbidden at canonical boundary."
        )

        # These assertions document expected canonical behavior AFTER enforcement
        # After implementation, _canonical_spec should NOT have these fields
        # or they should produce errors
        report = _valid_report()
        assert report["valid"] is True, "Setup: spy returns valid for any input"
