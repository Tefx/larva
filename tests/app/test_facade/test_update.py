"""Tests for facade update operation.

Sources:
- ARCHITECTURE.md section 7 (Registry read -> patch -> validation -> save)
- INTERFACES.md section A/G (use-cases + app-level error codes)
- design/registry-local-variants-and-assembly-removal.md (variant-aware update)
"""

from __future__ import annotations

from typing import cast

import pytest
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


class TestFacadeUpdate:
    def test_update_reads_patches_normalizes_validates_saves_and_returns_spec(self) -> None:
        calls: list[str] = []
        existing = _canonical_spec("update-me")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.update(
            "update-me",
            patches={
                "description": "Updated description",
                "model_params.temperature": 0,
            },
        )

        assert isinstance(result, Success)
        updated = result.unwrap()
        assert registry.get_inputs == ["update-me"]
        assert calls == ["validate", "validate", "normalize", "validate"]
        assert len(validate_module.inputs) == 3
        assert validate_module.inputs[1]["description"] == "Updated description"
        assert validate_module.inputs[1]["model_params"] == {"temperature": 0}
        assert validate_module.inputs[2]["model_params"] == {"temperature": 0}
        assert normalize_module.inputs[0]["description"] == "Updated description"
        assert len(registry.save_inputs) == 1
        assert registry.save_inputs[0] == updated
        assert updated["spec_digest"] == _digest_for(updated)

    def test_update_missing_id_maps_to_persona_not_found(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing-update' not found in registry",
                    "persona_id": "missing-update",
                }
            )
        )
        facade, _, validate_module, normalize_module = _facade(registry=registry)

        result = facade.update("missing-update", patches={"description": "unused"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "missing-update"
        assert validate_module.inputs == []
        assert normalize_module.inputs == []
        assert registry.save_inputs == []

    def test_update_invalid_patched_spec_maps_to_persona_invalid(self) -> None:
        calls: list[str] = []
        existing = _canonical_spec("update-invalid")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade, _, validate_module, normalize_module = _facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            registry=registry,
            calls=calls,
        )

        result = facade.update("update-invalid", patches={"description": None})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_SPEC_VERSION"
        assert calls == ["validate"]
        assert normalize_module.inputs == []
        assert registry.save_inputs == []

    def test_update_rejects_invalid_optional_field_type_from_existing_record(self) -> None:
        stored = dict(_canonical_spec("update-bad-shape"))
        stored["spec_digest"] = 123
        registry = InMemoryRegistryStore(get_result=Success(cast("dict[str, object]", stored)))
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.update("update-bad-shape", patches={"description": "unused"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_FIELD_TYPE"
        assert error["details"]["report"]["errors"][0]["details"]["field"] == "spec_digest"

    def test_update_rejects_forbidden_patch_fields_before_normalization(self) -> None:
        calls: list[str] = []
        existing = _canonical_spec("update-tools")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.update("update-tools", patches={"tools": {"shell": "read_write"}})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "FORBIDDEN_PATCH_FIELD"
        assert error["numeric_code"] == 114
        assert error["details"] == {"field": "tools", "key": "tools"}
        assert calls == ["validate"]
        assert normalize_module.inputs == []
        assert len(validate_module.inputs) == 1
        assert registry.save_inputs == []

    def test_update_rejects_protected_metadata_patch_fields_before_normalization(self) -> None:
        calls: list[str] = []
        existing = _canonical_spec("update-metadata")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade, _, validate_module, normalize_module = _facade(
            registry=registry,
            calls=calls,
        )

        result = facade.update("update-metadata", patches={"spec_version": "0.2.0"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "FORBIDDEN_PATCH_FIELD"
        assert error["numeric_code"] == 114
        assert error["details"] == {"field": "spec_version", "key": "spec_version"}
        assert calls == ["validate"]
        assert normalize_module.inputs == []
        assert len(validate_module.inputs) == 1
        assert registry.save_inputs == []


# ===========================================================================
# REGISTRY-LOCAL VARIANT TESTS (expected-red until implementation lands)
# ===========================================================================


class TestFacadeUpdateVariant:
    """Update with variant parameter: variant-aware update contracts.

    Target: update(persona_id, patches, variant=None) where:
    - omitted variant => update active variant
    - named variant => update that specific variant
    - variant is operation parameter, not inside patches
    - variant name must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be <= 64 chars

    Expected-RED because facade.update() does not accept variant parameter yet.
    """

    def test_update_active_variant_by_default(self) -> None:
        """update(id, patches) patches the active variant."""
        pytest.xfail(
            "facade.update(id, patches, variant=None) does not exist yet; "
            "expected to patch active variant by default"
        )

    def test_update_named_variant(self) -> None:
        """update(id, patches, variant='tacit') patches that specific variant."""
        pytest.xfail(
            "facade.update(id, patches, variant='tacit') does not exist yet; "
            "expected to patch named variant"
        )

    def test_update_rejects_variant_inside_patches(self) -> None:
        """variant field inside patches must be rejected as FORBIDDEN_PATCH_FIELD."""
        pytest.xfail(
            "FORBIDDEN_PATCH_FIELD for variant inside patches does not exist yet; "
            "expected after variant-aware update implementation"
        )

    def test_update_invalid_variant_name_rejected(self) -> None:
        """Invalid variant name => INVALID_VARIANT_NAME error."""
        pytest.xfail(
            "INVALID_VARIANT_NAME error for update does not exist yet; "
            "expected after variant name validation implementation"
        )

    def test_update_unknown_variant_returns_variant_not_found(self) -> None:
        """Named variant that does not exist => VARIANT_NOT_FOUND."""
        pytest.xfail(
            "VARIANT_NOT_FOUND error for update does not exist yet; "
            "expected after variant-aware update implementation"
        )
