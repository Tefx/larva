"""Tests for facade resolve operation.

Sources:
- ARCHITECTURE.md section 7 (Registry read -> override -> revalidation)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError

from .conftest import (
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
        canonical = _canonical_spec("resolve-me", digest="sha256:canonical-old")
        registry = InMemoryRegistryStore(get_result=Success(canonical))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve("resolve-me")

        assert isinstance(result, Success)
        assert registry.get_inputs == ["resolve-me"]
        # Hard-cut policy: normalize-then-validate replaces validate-then-normalize-then-validate
        assert calls == ["normalize", "validate"]
        assert len(validate_module.inputs) == 1
        assert validate_module.inputs[0]["id"] == "resolve-me"
        assert normalize_module.inputs[0]["id"] == "resolve-me"
        assert result.unwrap()["spec_digest"] == _digest_for(result.unwrap())
        assert result.unwrap()["spec_digest"] != "sha256:canonical-old"

    def test_resolve_applies_falsey_overrides_exactly_and_recomputes_digest(self) -> None:
        calls: list[str] = []
        canonical = _canonical_spec("resolve-overrides", digest="sha256:canonical-old")
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
        # Hard-cut policy: normalize-then-validate replaces validate-then-normalize-then-validate
        assert calls == ["normalize", "validate"]
        assert len(validate_module.inputs) == 1
        assert validate_module.inputs[0]["description"] is None
        assert validate_module.inputs[0]["can_spawn"] is False
        assert validate_module.inputs[0]["compaction_prompt"] == ""
        assert validate_module.inputs[0]["model_params"] == {"temperature": 0}
        assert normalize_module.inputs[0]["description"] is None
        assert normalize_module.inputs[0]["can_spawn"] is False
        assert normalize_module.inputs[0]["compaction_prompt"] == ""
        assert normalize_module.inputs[0]["model_params"] == {"temperature": 0}
        assert resolved["description"] is None
        assert resolved["can_spawn"] is False
        assert resolved["compaction_prompt"] == ""
        assert resolved["model_params"] == {"temperature": 0}
        assert resolved["spec_digest"] == _digest_for(resolved)
        assert resolved["spec_digest"] != "sha256:canonical-old"

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
        # Hard-cut policy: normalize is called before validation
        assert normalize_module.inputs[0]["id"] == "resolve-invalid"
        assert calls == ["normalize", "validate"]

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
