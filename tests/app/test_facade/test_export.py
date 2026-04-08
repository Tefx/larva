"""Tests for facade export_all and export_ids operations.

Sources:
- ARCHITECTURE.md section 7 (Export use-case contracts)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast
from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError
from larva.core.spec import PersonaSpec
from larva.shell.registry import RegistryError

from .conftest import (
    InMemoryRegistryStore,
    _canonical_spec,
    _facade,
    _failure,
)


class TestFacadeExportAll:
    """Pinned acceptance tests for facade export_all operation.

    These tests pin the contract between shell/registry and app/facade.
    """

    def test_export_all_returns_full_canonical_specs_from_registry(self) -> None:
        """Success export_all returns complete PersonaSpec records, not summaries."""
        spec_alpha = _canonical_spec("export-alpha", digest="sha256:alpha-digest")
        spec_beta = _canonical_spec("export-beta", digest="sha256:beta-digest")
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_all()

        assert isinstance(result, Success)
        exported_specs = result.unwrap()
        assert len(exported_specs) == 2
        assert exported_specs[0] == spec_alpha
        assert exported_specs[1] == spec_beta
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


class TestFacadeExportIds:
    """Pinned acceptance tests for facade export_ids operation.

    These tests pin the contract between shell/registry and app/facade.
    """

    def test_export_ids_returns_full_canonical_specs_in_input_order(self) -> None:
        """Success export_ids returns complete PersonaSpec records preserving order."""
        spec_one = _canonical_spec("export-one", digest="sha256:one-digest")
        spec_two = _canonical_spec("export-two", digest="sha256:two-digest")
        spec_three = _canonical_spec("export-three", digest="sha256:three-digest")

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
        assert exported_specs[0] == spec_two
        assert exported_specs[1] == spec_one
        assert exported_specs[2] == spec_three
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
        spec_valid = _canonical_spec("export-valid", digest="sha256:valid")

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
        """Single id returns list with one spec, not the spec directly."""
        spec_single = _canonical_spec("export-single", digest="sha256:single")
        registry = InMemoryRegistryStore(get_result=Success(spec_single))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.export_ids(["export-single"])

        assert isinstance(result, Success)
        exported = result.unwrap()
        assert isinstance(exported, list)
        assert len(exported) == 1
        assert exported[0] == spec_single
