"""Tests for facade clone operation.

Sources:
- ARCHITECTURE.md section 7 (Clone use-case contract)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

import pytest
from returns.result import Failure, Result, Success

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


class TestFacadeClone:
    """Pinned acceptance tests for facade clone operation.

    These tests pin the contract between shell/registry and app/facade
    before implementation. Tests exercise clone contract:
    - Clone source persona to new id
    - Preserve all non-id fields from source
    - Recompute spec_digest for cloned copy
    - Validate cloned spec before saving
    - Overwrite semantics when target exists

    These tests verify the implemented behavior contract at the app boundary.
    """

    def test_clone_success_returns_cloned_spec_with_new_id_and_recomputed_digest(
        self,
    ) -> None:
        """Success clone returns PersonaSpec with new id and recomputed spec_digest."""
        source_spec = _canonical_spec("source-persona", digest="sha256:old-digest")
        calls: list[str] = []
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.clone("source-persona", "cloned-persona")

        assert isinstance(result, Success)
        cloned = result.unwrap()
        assert cloned["id"] == "cloned-persona"
        assert cloned["description"] == "Persona source-persona"
        assert cloned["prompt"] == "You are careful."
        assert cloned["model"] == "gpt-4o-mini"
        # Canonical clone path preserves canonical capability field.
        assert cloned["capabilities"] == {"shell": "read_only"}
        assert cloned["model_params"] == {"temperature": 0.1}
        assert cloned["can_spawn"] is False
        assert cloned["compaction_prompt"] == "Summarize facts."
        assert cloned["spec_version"] == "0.1.0"
        assert cloned["spec_digest"] == _digest_for(cloned)
        assert cloned["spec_digest"] != "sha256:old-digest"
        # Hard-cut policy: normalize-then-validate replaces validate-then-normalize-then-validate
        assert calls == ["normalize", "validate"]
        assert registry.get_inputs == ["source-persona"]
        assert validate_module.inputs[0]["id"] == "cloned-persona"
        assert normalize_module.inputs[0]["id"] == "cloned-persona"

    def test_clone_hard_cut_rejects_forbidden_fields_from_source(self) -> None:
        """Clone of a stored historical non-canonical spec rejects forbidden fields."""
        source_spec = _canonical_spec("historical-source", digest="sha256:stale")
        # Simulate a stored historical record with forbidden and unknown fields.
        source_with_legacy = dict(source_spec)
        source_with_legacy["tools"] = {"shell": "full_access"}
        source_with_legacy["side_effect_policy"] = "full_access"
        source_with_legacy["custom_field"] = "custom_value"

        registry = InMemoryRegistryStore(get_result=Success(source_with_legacy))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.clone("historical-source", "cloned-from-historical")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "FORBIDDEN_FIELD"
        assert error["numeric_code"] == 115
        assert error["details"]["field"] in {"tools", "side_effect_policy"}
        assert registry.save_inputs == []

    def test_clone_source_not_found_returns_persona_not_found_error(self) -> None:
        """Clone when source does not exist returns PERSONA_NOT_FOUND error."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing-source' not found in registry",
                    "persona_id": "missing-source",
                }
            )
        )
        facade, _, validate_module, normalize_module = _facade(registry=registry)

        result = facade.clone("missing-source", "new-cloned")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "missing-source"
        assert registry.get_inputs == ["missing-source"]
        assert validate_module.inputs == []
        assert normalize_module.inputs == []

    def test_clone_invalid_source_id_returns_invalid_persona_id_error(self) -> None:
        """Clone with invalid source id format returns INVALID_PERSONA_ID error."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "INVALID_PERSONA_ID",
                    "message": "invalid persona id 'Bad_Source': expected flat kebab-case",
                    "persona_id": "Bad_Source",
                }
            )
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.clone("Bad_Source", "valid-clone")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_PERSONA_ID"
        assert error["numeric_code"] == 104
        assert error["details"]["persona_id"] == "Bad_Source"

    def test_clone_invalid_new_id_returns_validation_error(self) -> None:
        """Clone with invalid new_id validates cloned spec.

        Returns PERSONA_INVALID on failure.
        """
        source_spec = _canonical_spec("valid-source", digest="sha256:valid")
        calls: list[str] = []
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade, _, validate_module, normalize_module = _facade(
            report=_invalid_report("INVALID_PERSONA_ID"),
            registry=registry,
            calls=calls,
        )

        result = facade.clone("valid-source", "Invalid_Clone_Id")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert validate_module.inputs[0]["id"] == "Invalid_Clone_Id"
        # Hard-cut policy: normalize is called before validation
        assert normalize_module.inputs[0]["id"] == "Invalid_Clone_Id"
        assert calls == ["normalize", "validate"]
        assert registry.get_inputs == ["valid-source"]

    def test_clone_overwrites_existing_target_without_check(self) -> None:
        """Clone overwrites target persona when new_id already exists (no existence check)."""
        source_spec = _canonical_spec("source-clone", digest="sha256:source")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.clone("source-clone", "existing-target")

        assert isinstance(result, Success)
        cloned = result.unwrap()
        assert cloned["id"] == "existing-target"
        assert len(registry.save_inputs) == 1
        assert registry.save_inputs[0]["id"] == "existing-target"

    def test_clone_spec_digest_recomputed_not_copied(self) -> None:
        """Clone recomputes spec_digest based on cloned content, not copied from source."""
        source_spec = _canonical_spec("digest-source", digest="sha256:source-digest")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.clone("digest-source", "digest-clone")

        assert isinstance(result, Success)
        cloned = result.unwrap()
        expected_digest = _digest_for(
            {
                "id": "digest-clone",
                **{k: v for k, v in source_spec.items() if k not in ("id", "spec_digest")},
            }
        )
        assert cloned["spec_digest"] == expected_digest
        assert cloned["spec_digest"] != "sha256:source-digest"

    def test_clone_maps_registry_write_failure_to_app_error(self) -> None:
        """Clone maps registry save failure to REGISTRY_WRITE_FAILED error."""
        source_spec = _canonical_spec("write-fail-source", digest="sha256:write-fail")
        registry = InMemoryRegistryStore(
            get_result=Success(source_spec),
            save_result=Failure(
                {
                    "code": "REGISTRY_WRITE_FAILED",
                    "message": "disk full during save",
                    "persona_id": "write-fail-clone",
                    "path": "/tmp/write-fail-clone.json",
                }
            ),
        )
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.clone("write-fail-source", "write-fail-clone")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_WRITE_FAILED"
        assert error["numeric_code"] == 109
        assert error["details"]["persona_id"] == "write-fail-clone"
        assert error["details"]["path"] == "/tmp/write-fail-clone.json"

    def test_clone_flow_order_get_then_normalize_then_validate_then_save(self) -> None:
        """Clone calls registry.get, then normalize, then validate, then registry.save in order."""
        source_spec = _canonical_spec("ordered-source", digest="sha256:ordered")
        calls: list[str] = []
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.clone("ordered-source", "ordered-clone")

        assert isinstance(result, Success)
        # Hard-cut policy: normalize-then-validate replaces validate-then-normalize-then-validate
        assert calls == ["normalize", "validate"]
        assert registry.get_inputs == ["ordered-source"]
        assert validate_module.inputs[0]["id"] == "ordered-clone"
        assert normalize_module.inputs[0]["id"] == "ordered-clone"
        saved_spec = registry.save_inputs[0]
        assert saved_spec["id"] == "ordered-clone"
        assert saved_spec["spec_digest"] == _digest_for(saved_spec)
