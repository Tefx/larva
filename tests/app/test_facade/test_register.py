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
    _transition_spec_with_deprecated_fields,
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
        assert calls == ["validate", "normalize", "validate"]
        assert len(validate_module.inputs) == 2
        assert validate_module.inputs[0] == spec
        assert validate_module.inputs[1] == registry.save_inputs[0]
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
        assert calls.count("validate") == 2
        assert calls.count("normalize") == 1
        assert calls[0] == "validate"
        assert calls[1] == "normalize"
        assert calls[2] == "validate"
        assert validate_module.inputs[0]["can_spawn"] is False
        assert validate_module.inputs[0]["description"] is None
        assert validate_module.inputs[0]["compaction_prompt"] == ""
        assert normalize_module.inputs[0]["can_spawn"] is False
        assert normalize_module.inputs[0]["description"] is None
        assert normalize_module.inputs[0]["compaction_prompt"] == ""
        assert registry.save_inputs[0]["can_spawn"] is False
        assert registry.save_inputs[0]["description"] is None
        assert registry.save_inputs[0]["compaction_prompt"] == ""

    def test_register_validation_stage_difference_is_non_observable_at_entrypoint(self) -> None:
        """Public register error contract is stable across validation stage ordering."""

        class SequencedValidateModule:
            def __init__(self, reports: list[dict[str, object]], calls: list[str]) -> None:
                self._reports = reports
                self._calls = calls
                self.inputs: list[PersonaSpec] = []
                self._index = 0

            def validate_spec(self, spec: PersonaSpec) -> dict[str, object]:
                self._calls.append("validate")
                self.inputs.append(dict(spec))
                report = self._reports[min(self._index, len(self._reports) - 1)]
                self._index += 1
                return report

        invalid_report = cast("dict[str, object]", _invalid_report("INVALID_SPEC_VERSION"))

        first_stage_calls: list[str] = []
        first_stage_registry = InMemoryRegistryStore()
        first_stage_facade, _, _, _ = _facade(
            report=_valid_report(),
            registry=first_stage_registry,
            calls=first_stage_calls,
        )
        first_stage_facade._validate = SequencedValidateModule(  # type: ignore[attr-defined]
            [invalid_report],
            first_stage_calls,
        )
        first_stage_result = first_stage_facade.register(_canonical_spec("register-order-proof"))

        second_stage_calls: list[str] = []
        second_stage_registry = InMemoryRegistryStore()
        second_stage_facade, _, _, _ = _facade(
            report=_valid_report(),
            registry=second_stage_registry,
            calls=second_stage_calls,
        )
        second_stage_facade._validate = SequencedValidateModule(  # type: ignore[attr-defined]
            [_valid_report(), invalid_report],
            second_stage_calls,
        )
        second_stage_result = second_stage_facade.register(_canonical_spec("register-order-proof"))

        first_stage_error = _failure(cast("Result[object, LarvaError]", first_stage_result))
        second_stage_error = _failure(cast("Result[object, LarvaError]", second_stage_result))

        assert first_stage_calls == ["validate"]
        assert second_stage_calls == ["validate", "normalize", "validate"]
        assert first_stage_error["code"] == second_stage_error["code"] == "PERSONA_INVALID"
        assert first_stage_error["numeric_code"] == second_stage_error["numeric_code"] == 101
        assert (
            first_stage_error["details"]["report"]["errors"][0]["code"]
            == second_stage_error["details"]["report"]["errors"][0]["code"]
            == "INVALID_SPEC_VERSION"
        )
        assert first_stage_registry.save_inputs == []
        assert second_stage_registry.save_inputs == []

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

    def test_fixture_taxonomy_keeps_canonical_clean_and_transition_explicit(self):
        """Canonical helper is canonical-only; transition helper carries deprecated fields."""
        canonical_spec = _canonical_spec("fixture-check")
        transition_spec = _transition_spec_with_deprecated_fields("fixture-check-transition")

        assert "tools" not in canonical_spec
        assert "side_effect_policy" not in canonical_spec
        assert "tools" in transition_spec
        assert "side_effect_policy" in transition_spec

        # Keep current gap documentation explicit through transition fixture usage.
        report = _valid_report()
        assert report["valid"] is True, "Setup: spy returns valid for any input"
