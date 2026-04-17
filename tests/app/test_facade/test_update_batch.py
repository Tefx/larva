"""Tests for facade batch update operation.

Sources:
- ARCHITECTURE.md section 7 (batch update shared facade path)
- INTERFACES.md section MCP Surface / Cross-Surface Authority Rules
"""

from __future__ import annotations

from typing import cast

import pytest
from returns.result import Result, Success

from larva.app.facade import LarvaError

from .conftest import InMemoryRegistryStore, _canonical_spec, _facade, _failure, _valid_report


class TestFacadeUpdateBatchWhere:
    """Pinned app-layer behavior for canonical update_batch where validation."""

    @pytest.mark.parametrize(
        ("where_key", "expected_field", "expected_value"),
        [
            ("tools.shell", "tools", "read_only"),
            ("side_effect_policy", "side_effect_policy", "read_only"),
            ("variables.role", "variables", "assistant"),
            ("custom_field", "custom_field", "value"),
        ],
    )
    def test_update_batch_rejects_noncanonical_where_roots(
        self,
        where_key: str,
        expected_field: str,
        expected_value: object,
    ) -> None:
        """Non-canonical where roots fail closed before any matching or writes."""
        registry = InMemoryRegistryStore(list_result=Success([_canonical_spec("alpha")]))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.update_batch({where_key: expected_value}, {"description": "Updated"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_INPUT"
        assert error["numeric_code"] == 1
        assert expected_field in error["message"]
        assert error["details"]["field"] == expected_field
        assert error["details"]["where_key"] == where_key
        assert registry.save_inputs == []

    def test_update_batch_rejects_dotted_selector_on_scalar_field(self) -> None:
        """Dotted selectors are limited to canonical nested object fields."""
        registry = InMemoryRegistryStore(list_result=Success([_canonical_spec("alpha")]))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.update_batch(
            {"model.name": "gpt-4o-mini"},
            {"description": "Updated"},
        )

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_INPUT"
        assert error["numeric_code"] == 1
        assert error["details"]["field"] == "model.name"
        assert error["details"]["root_field"] == "model"
        assert error["details"]["where_key"] == "model.name"
        assert registry.save_inputs == []
