"""Tests for facade export_all and export_ids operations.

Sources:
- ARCHITECTURE.md section 7 (Export use-case contracts)
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
from larva.core.spec import PersonaSpec
from larva.shell.registry import RegistryError

from .conftest import (
    InMemoryComponentStore,
    InMemoryRegistryStore,
    _canonical_spec,
    _digest_for,
    _facade,
    _failure,
)


class TestFacadeExportAll:
    """Pinned acceptance tests for facade export_all operation.

    These tests pin the contract between shell/registry and app/facade.
    """

    def test_export_all_returns_full_canonical_specs_from_registry(self) -> None:
        """Success export_all returns complete canonical PersonaSpec records after normalization."""
        spec_alpha = _canonical_spec("export-alpha")
        spec_beta = _canonical_spec("export-beta")
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_all()

        assert isinstance(result, Success)
        exported_specs = result.unwrap()
        assert len(exported_specs) == 2
        for spec in exported_specs:
            assert "id" in spec
            assert "description" in spec
            assert "prompt" in spec
            assert "model" in spec
            # Frozen canonical authority: export returns canonical shape.
            assert "capabilities" in spec
            assert "model_params" in spec
            assert "can_spawn" in spec
            assert "compaction_prompt" in spec
            assert "spec_version" in spec
            assert "spec_digest" in spec
            # Hard-cut policy: export normalizes, so spec_digests are recomputed
            assert spec["spec_digest"] == _digest_for(spec)
            # Hard-cut policy: no forbidden fields in exported output
            assert "tools" not in spec
            assert "side_effect_policy" not in spec

    def test_export_all_returns_exactly_empty_list_for_empty_registry(self) -> None:
        """Verify empty registry returns exactly Success([]), no transport envelope."""
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_all()

        assert isinstance(result, Success)
        assert result.unwrap() == []
        assert isinstance(result.unwrap(), list)
        assert len(result.unwrap()) == 0
        assert result.unwrap() is not None
        assert result.unwrap() != [None]
        assert result.unwrap() != [{"error": None}]
        assert result.unwrap() != {"data": [], "error": None}

    def test_export_all_maps_registry_list_failure_to_app_error(self) -> None:
        """REGISTRY_INDEX_READ_FAILED from registry maps to LarvaError."""
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "index file unreadable",
                    "path": "/tmp/registry/index.json",
                }
            )
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_all()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert error["numeric_code"] == 107
        assert error["details"]["path"] == "/tmp/registry/index.json"

    def test_export_all_rejects_invalid_optional_field_type_from_registry(self) -> None:
        bad_spec = dict(_canonical_spec("export-bad-shape"))
        bad_spec["model_params"] = "invalid"
        bad_spec["spec_digest"] = _digest_for(cast("PersonaSpec", bad_spec))
        registry = InMemoryRegistryStore(
            list_result=Success([cast("PersonaSpec", bad_spec)]),
        )
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.export_all()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_MODEL_PARAMS"

    def test_export_all_rejects_stored_spec_with_mismatched_digest(self) -> None:
        bad_spec = dict(_canonical_spec("export-bad-digest"))
        bad_spec["spec_digest"] = "sha256:bad-digest"
        registry = InMemoryRegistryStore(
            list_result=Success([cast("PersonaSpec", bad_spec)]),
        )
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.export_all()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        issue = error["details"]["report"]["errors"][0]
        assert issue["code"] == "INVALID_SPEC_DIGEST"
        assert issue["details"]["field"] == "spec_digest"


class TestFacadeExportIds:
    """Pinned acceptance tests for facade export_ids operation.

    These tests pin the contract between shell/registry and app/facade.
    """

    def test_export_ids_returns_full_canonical_specs_in_input_order(self) -> None:
        """Success export_ids returns complete canonical PersonaSpec records preserving order."""
        spec_one = _canonical_spec("export-one")
        spec_two = _canonical_spec("export-two")
        spec_three = _canonical_spec("export-three")

        def get_by_id(persona_id: str) -> Result[PersonaSpec, RegistryError]:
            if persona_id == "export-one":
                return Success(spec_one)
            if persona_id == "export-two":
                return Success(spec_two)
            if persona_id == "export-three":
                return Success(spec_three)
            return Failure({"code": "PERSONA_NOT_FOUND", "message": f"not found: {persona_id}"})

        registry = InMemoryRegistryStore(get_result=Success(spec_one))
        registry.get = get_by_id  # type: ignore[method-assign]
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_ids(["export-two", "export-one", "export-three"])

        assert isinstance(result, Success)
        exported_specs = result.unwrap()
        assert len(exported_specs) == 3
        # Hard-cut policy: export normalizes, so spec_digests may differ from stored
        for spec in exported_specs:
            assert "id" in spec
            assert "description" in spec
            assert "prompt" in spec
            assert "model" in spec
            assert "capabilities" in spec
            assert "model_params" in spec
            assert "can_spawn" in spec
            assert "compaction_prompt" in spec
            assert "spec_version" in spec
            assert "spec_digest" in spec
            assert spec["spec_digest"] == _digest_for(spec)
            assert "tools" not in spec
            assert "side_effect_policy" not in spec
        assert exported_specs[0]["id"] == "export-two"
        assert exported_specs[1]["id"] == "export-one"
        assert exported_specs[2]["id"] == "export-three"

    def test_export_ids_returns_empty_list_for_empty_ids_immediately(self) -> None:
        """Empty ids list returns Success([]) immediately with no registry calls."""
        get_calls: list[str] = []
        spec_default = _canonical_spec("default")

        def track_get_calls(persona_id: str) -> Result[PersonaSpec, RegistryError]:
            get_calls.append(persona_id)
            return Success(spec_default)

        registry = InMemoryRegistryStore(get_result=Success(spec_default))
        registry.get = track_get_calls  # type: ignore[method-assign]
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_ids([])

        assert isinstance(result, Success)
        assert result.unwrap() == []
        assert isinstance(result.unwrap(), list)
        assert len(result.unwrap()) == 0
        assert get_calls == []

    def test_export_ids_fail_fast_on_first_not_found(self) -> None:
        """First PERSONA_NOT_FOUND stops iteration, returns error immediately."""
        spec_valid = _canonical_spec("export-valid")

        def get_with_not_found(persona_id: str) -> Result[PersonaSpec, RegistryError]:
            if persona_id == "export-valid":
                return Success(spec_valid)
            return Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": f"persona '{persona_id}' not found in registry",
                    "persona_id": persona_id,
                }
            )

        registry = InMemoryRegistryStore(get_result=Success(spec_valid))
        registry.get = get_with_not_found  # type: ignore[method-assign]
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_ids(["export-valid", "export-missing", "export-another"])

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "export-missing"

    def test_export_ids_rejects_stored_spec_with_mismatched_digest(self) -> None:
        bad_spec = dict(_canonical_spec("export-bad-digest-id"))
        bad_spec["spec_digest"] = "sha256:bad-digest"

        def get_bad_digest(persona_id: str) -> Result[PersonaSpec, RegistryError]:
            if persona_id == "export-bad-digest-id":
                return Success(cast("PersonaSpec", bad_spec))
            return Failure({"code": "PERSONA_NOT_FOUND", "message": f"not found: {persona_id}"})

        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("default")))
        registry.get = get_bad_digest  # type: ignore[method-assign]
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.export_ids(["export-bad-digest-id"])

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        issue = error["details"]["report"]["errors"][0]
        assert issue["code"] == "INVALID_SPEC_DIGEST"
        assert issue["details"]["field"] == "spec_digest"

    def test_export_ids_maps_registry_spec_read_failed_to_app_error(self) -> None:
        """REGISTRY_SPEC_READ_FAILED from registry maps to LarvaError with context."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "REGISTRY_SPEC_READ_FAILED",
                    "message": "failed to read spec json",
                    "persona_id": "broken-spec",
                    "path": "/tmp/registry/broken-spec.json",
                }
            )
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_ids(["broken-spec"])

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert error["numeric_code"] == 108
        assert error["details"]["persona_id"] == "broken-spec"
        assert error["details"]["path"] == "/tmp/registry/broken-spec.json"

    def test_export_ids_single_id_returns_single_element_list(self) -> None:
        """Single id returns list with one canonical spec after normalization."""
        spec_single = _canonical_spec("export-single")
        registry = InMemoryRegistryStore(get_result=Success(spec_single))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_ids(["export-single"])

        assert isinstance(result, Success)
        exported = result.unwrap()
        assert isinstance(exported, list)
        assert len(exported) == 1
        # Hard-cut policy: export normalizes, verify canonical shape
        assert exported[0]["id"] == "export-single"
        assert "tools" not in exported[0]
        assert "side_effect_policy" not in exported[0]
        assert exported[0]["spec_digest"] == _digest_for(exported[0])
