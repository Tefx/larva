"""Tests for facade resolve operation.

Sources:
- ARCHITECTURE.md section 7 (Registry read -> override -> revalidation)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from returns.result import Failure, Result, Success

from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module

from .conftest import (
    InMemoryComponentStore,
    InMemoryRegistryStore,
    _canonical_spec,
    _digest_for,
    _facade,
    _failure,
    _invalid_report,
    _valid_report,
)


class TestFacadeResolve:
    def test_resolve_reads_registry_then_normalizes_then_validates(self) -> None:
        calls: list[str] = []
        canonical = _canonical_spec("resolve-me")
        registry = InMemoryRegistryStore(get_result=Success(canonical))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve("resolve-me")

        assert isinstance(result, Success)
        assert registry.get_inputs == ["resolve-me"]
        assert calls == ["validate", "normalize", "validate"]
        assert len(validate_module.inputs) == 2
        assert validate_module.inputs[0]["id"] == "resolve-me"
        assert validate_module.inputs[1]["id"] == "resolve-me"
        assert normalize_module.inputs[0]["id"] == "resolve-me"
        assert result.unwrap()["spec_digest"] == _digest_for(result.unwrap())

    def test_resolve_applies_falsey_overrides_exactly_and_recomputes_digest(self) -> None:
        calls: list[str] = []
        canonical = _canonical_spec("resolve-overrides")
        registry = InMemoryRegistryStore(get_result=Success(canonical))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve(
            "resolve-overrides",
            overrides={
                "description": None,
                "can_spawn": False,
                "compaction_prompt": "",
                "model_params": {"temperature": 0},
            },
        )

        assert isinstance(result, Success)
        resolved = result.unwrap()
        assert calls == ["validate", "normalize", "validate"]
        assert len(validate_module.inputs) == 2
        assert validate_module.inputs[1]["description"] is None
        assert validate_module.inputs[1]["can_spawn"] is False
        assert validate_module.inputs[1]["compaction_prompt"] == ""
        assert validate_module.inputs[1]["model_params"] == {"temperature": 0}
        assert normalize_module.inputs[0]["description"] is None
        assert normalize_module.inputs[0]["can_spawn"] is False
        assert normalize_module.inputs[0]["compaction_prompt"] == ""
        assert normalize_module.inputs[0]["model_params"] == {"temperature": 0}
        assert resolved["description"] is None
        assert resolved["can_spawn"] is False
        assert resolved["compaction_prompt"] == ""
        assert resolved["model_params"] == {"temperature": 0}
        assert resolved["spec_digest"] == _digest_for(resolved)

    def test_resolve_validation_failure_returns_persona_invalid(self) -> None:
        calls: list[str] = []
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("resolve-invalid")))
        facade, _, validate_module, normalize_module = _facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve("resolve-invalid", overrides={"spec_version": "invalid"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_SPEC_VERSION"
        assert normalize_module.inputs == []
        assert calls == ["validate"]

    def test_resolve_rejects_invalid_optional_field_type_from_registry(self) -> None:
        stored = dict(_canonical_spec("resolve-bad-shape"))
        stored["compaction_prompt"] = ["bad"]
        stored["spec_digest"] = _digest_for(cast("PersonaSpec", stored))
        registry = InMemoryRegistryStore(get_result=Success(cast("dict[str, object]", stored)))
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.resolve("resolve-bad-shape")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_FIELD_TYPE"
        assert error["details"]["report"]["errors"][0]["details"]["field"] == "compaction_prompt"

    def test_resolve_rejects_identity_override_before_normalization(self) -> None:
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("resolve-identity")))
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.resolve("resolve-identity", overrides={"id": "mutated-id"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "FORBIDDEN_OVERRIDE_FIELD"
        assert error["numeric_code"] == 113
        assert error["details"] == {"field": "id"}

    def test_resolve_rejects_stored_spec_with_mismatched_digest(self) -> None:
        stored = dict(_canonical_spec("resolve-bad-digest"))
        stored["spec_digest"] = "sha256:bad-digest"
        registry = InMemoryRegistryStore(get_result=Success(cast("PersonaSpec", stored)))
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.resolve("resolve-bad-digest")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        issue = error["details"]["report"]["errors"][0]
        assert issue["code"] == "INVALID_SPEC_DIGEST"
        assert issue["details"]["field"] == "spec_digest"

    def test_resolve_maps_persona_not_found_to_app_error(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade, _, validate_module, normalize_module = _facade(registry=registry)

        result = facade.resolve("missing")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "missing"
        assert registry.get_inputs == ["missing"]
        assert validate_module.inputs == []
        assert normalize_module.inputs == []

    def test_resolve_maps_registry_read_failures_to_app_error(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "REGISTRY_SPEC_READ_FAILED",
                    "message": "failed to read spec json",
                    "persona_id": "broken",
                    "path": "/tmp/broken.json",
                }
            )
        )
        facade, _, validate_module, normalize_module = _facade(registry=registry)

        result = facade.resolve("broken")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert error["numeric_code"] == 108
        assert error["details"]["persona_id"] == "broken"
        assert error["details"]["path"] == "/tmp/broken.json"
        assert validate_module.inputs == []
        assert normalize_module.inputs == []
