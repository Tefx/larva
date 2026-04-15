"""Tests for facade list operation.

Sources:
- ARCHITECTURE.md section 7 (Registry listing)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError
from larva.core.spec import PersonaSpec

from .conftest import (
    InMemoryRegistryStore,
    _canonical_spec,
    _facade,
    _failure,
)


class TestFacadeList:
    def test_list_returns_facade_summaries_only(self) -> None:
        specs = [
            _canonical_spec("alpha", digest="sha256:a"),
            _canonical_spec("beta", digest="sha256:b"),
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

    def test_list_malformed_registry_record_returns_persona_invalid_without_keyerror(self) -> None:
        malformed = cast(
            "PersonaSpec",
            {
                "id": "alpha",
                "spec_digest": "sha256:alpha",
                "model": "gpt-4o-mini",
            },
        )
        registry = InMemoryRegistryStore(list_result=Success([malformed]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert "malformed" in error["message"]
        assert "description" in error["message"]
        assert "record" in error["details"]
