"""Tests for facade list operation.

Sources:
- ARCHITECTURE.md section 7 (Registry listing)
- INTERFACES.md section A/G (use-cases + app-level error codes)
- design/registry-local-variants-and-assembly-removal.md (active-only listing)
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
from larva.core.spec import PersonaSpec

from .conftest import (
    InMemoryComponentStore,
    InMemoryRegistryStore,
    _canonical_spec,
    _facade,
    _failure,
)


class TestFacadeList:
    def test_list_returns_facade_summaries_only(self) -> None:
        specs = [
            _canonical_spec("alpha"),
            _canonical_spec("beta"),
        ]
        registry = InMemoryRegistryStore(list_result=Success(specs))
        facade, _, _, normalize_module = _facade(registry=registry)

        result = facade.list()

        assert isinstance(result, Success)
        summaries = result.unwrap()
        # Hard-cut policy: list normalizes specs before building summaries
        # spec_digest values are recomputed by normalization
        assert len(summaries) == 2
        assert summaries[0]["id"] == "alpha"
        assert summaries[0]["description"] == "Persona alpha"
        assert summaries[1]["id"] == "beta"
        assert summaries[1]["description"] == "Persona beta"
        # Verify normalization was called for both specs
        assert len(normalize_module.inputs) == 2

    def test_list_returns_exactly_empty_list_for_empty_registry(self) -> None:
        """Verify empty registry returns exactly [] not wrapped in transport envelope."""
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        assert isinstance(result, Success)
        # Explicit assertion: returns exactly [] (empty list, not None, not wrapped)
        assert result.unwrap() == []
        # Ensure it's a list type, not any other shape
        assert isinstance(result.unwrap(), list)
        assert len(result.unwrap()) == 0
        # No transport envelope leakage - plain Result with plain list
        assert result.unwrap() is not None
        # Verify no null/None values leak into the result structure
        assert result.unwrap() != [None]
        assert result.unwrap() != [{"error": None}]
        assert result.unwrap() != {"data": [], "error": None}
        assert result.unwrap() != {"items": [], "total": 0}

    def test_list_maps_registry_read_failures_to_app_error_without_success(self) -> None:
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "index unreadable",
                    "path": "/tmp/index.json",
                }
            )
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert error["numeric_code"] == 107
        assert error["details"]["path"] == "/tmp/index.json"

    def test_list_malformed_registry_record_returns_missing_spec_version_without_keyerror(
        self,
    ) -> None:
        malformed = cast(
            "PersonaSpec",
            {
                "id": "alpha",
                "spec_digest": "sha256:alpha",
                "model": "gpt-4o-mini",
            },
        )
        registry = InMemoryRegistryStore(list_result=Success([malformed]))
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=registry,
        )

        result = facade.list()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        issues = error["details"]["report"]["errors"]
        assert any(issue["code"] == "MISSING_REQUIRED_FIELD" for issue in issues)
        assert any(issue["details"]["field"] == "spec_version" for issue in issues)

    def test_list_rejects_stored_spec_with_mismatched_digest(self) -> None:
        bad_spec = dict(_canonical_spec("alpha"))
        bad_spec["spec_digest"] = "sha256:bad-digest"
        registry = InMemoryRegistryStore(list_result=Success([cast("PersonaSpec", bad_spec)]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        issue = error["details"]["report"]["errors"][0]
        assert issue["code"] == "INVALID_SPEC_DIGEST"
        assert issue["details"]["field"] == "spec_digest"


# ===========================================================================
# REGISTRY-LOCAL VARIANT TESTS (expected-red until implementation lands)
# ===========================================================================


class TestFacadeListActiveOnly:
    """list() returns active canonical specs only, no registry metadata.

    Target contract:
    - list() shows base persona ids only
    - Each summary comes from the active variant
    - No variant, _registry, active, or manifest metadata in output
    - variant_list(id) returns registry metadata separately

    Expected-RED because the variant-aware listing is not implemented yet.
    """

    def test_list_returns_one_entry_per_base_persona_id(self) -> None:
        """list() returns one PersonaSummary per base persona id (active variant only)."""
        pytest.xfail(
            "variant-aware list (one entry per base id) does not exist yet; "
            "expected to return active-only summaries after implementation"
        )

    def test_list_does_not_include_variant_metadata(self) -> None:
        """list() summaries must not contain variant, active, or _registry fields."""
        pytest.xfail(
            "variant metadata exclusion in list does not exist yet; "
            "expected to return bare PersonaSummary without variant fields"
        )

    def test_variant_list_returns_registry_metadata_only(self) -> None:
        """variant_list(id) returns {id, active, variants} without prompt/capabilities/spec fields.

        Target: variant_list returns registry metadata (id, active variant name,
        list of variant names) separate from PersonaSpec content.
        """
        pytest.xfail(
            "variant_list(id) does not exist yet; "
            "expected to return {id, active, variants} after implementation"
        )

    def test_variant_list_returns_complete_unbounded_variant_list(self) -> None:
        """variant_list returns complete list of variants, no pagination in v1."""
        pytest.xfail(
            "variant_list unbounded listing does not exist yet; "
            "expected to return all variants without pagination"
        )
