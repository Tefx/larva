"""Tests for facade clear operation.

Sources:
- ARCHITECTURE.md section 7 (Clear use-case contract)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError

from .conftest import (
    InMemoryRegistryStore,
    _facade,
    _failure,
)


class TestFacadeClear:
    """Pinned acceptance tests for facade clear operation.

    These tests pin the contract between shell/registry and app/facade
    before implementation. Tests exercise clear contract:
    - Clear all personas from registry
    - Require confirmation token
    - Return {cleared: True, count: <int>} on success
    """

    def test_clear_returns_cleared_registry_payload_with_count(self) -> None:
        """Success clear returns exactly {cleared: True, count: <int>}."""
        registry = InMemoryRegistryStore(
            clear_result=Success(3),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.clear(confirm="CLEAR REGISTRY")

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload == {"cleared": True, "count": 3}
        # Pin: only these two keys allowed in success shape
        assert set(payload.keys()) == {"cleared", "count"}
        # Pin: count is an int equal to registry-reported deleted count
        assert isinstance(payload["count"], int)

    def test_clear_maps_wrong_confirm_to_error_envelope_without_success_payload(self) -> None:
        """Wrong confirm token returns LarvaError with INVALID_CONFIRMATION_TOKEN."""
        registry = InMemoryRegistryStore(
            clear_result=Failure(
                {
                    "code": "INVALID_CONFIRMATION_TOKEN",
                    "message": "clear requires exact confirmation token 'CLEAR REGISTRY'",
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.clear(confirm="WRONG TOKEN")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_CONFIRMATION_TOKEN"
        assert error["numeric_code"] == 112
        assert error["message"] == "clear requires exact confirmation token 'CLEAR REGISTRY'"
        # No extra fields leak into details for this error type
        assert error["details"] == {}

    def test_clear_maps_registry_delete_failure_to_app_error_details(self) -> None:
        """DeleteFailureError during clear maps to REGISTRY_DELETE_FAILED with details."""
        registry = InMemoryRegistryStore(
            clear_result=Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to remove one or more persona specs during clear",
                    "operation": "clear",
                    "persona_id": None,
                    "path": "/home/.larva/registry/index.json",
                    "failed_spec_paths": [
                        "/home/.larva/registry/broken-one.json",
                        "/home/.larva/registry/broken-two.json",
                    ],
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.clear(confirm="CLEAR REGISTRY")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_DELETE_FAILED"
        assert error["numeric_code"] == 111
        # Registry code/message preserved at facade level
        assert "failed to remove one or more persona specs" in error["message"]
        # Extra registry fields moved to details
        assert error["details"]["operation"] == "clear"
        assert error["details"]["persona_id"] is None
        assert error["details"]["path"] == "/home/.larva/registry/index.json"
        assert error["details"]["failed_spec_paths"] == [
            "/home/.larva/registry/broken-one.json",
            "/home/.larva/registry/broken-two.json",
        ]
