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
