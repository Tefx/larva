"""Tests for facade delete operation.

Sources:
- ARCHITECTURE.md section 7 (Delete use-case contract)
- INTERFACES.md section A/G (use-cases + app-level error codes)
- design/registry-local-variants-and-assembly-removal.md (variant delete contracts)
"""

from __future__ import annotations

from typing import cast

import pytest
from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError

from .conftest import (
    InMemoryRegistryStore,
    _facade,
    _failure,
)


class TestFacadeDelete:
    """Pinned acceptance tests for facade delete operation.

    These tests pin the contract between shell/registry and app/facade
    before implementation. Tests exercise delete contract:
    - Delete persona by id
    - Return {id, deleted: True} on success
    - Map PERSONA_NOT_FOUND to app error
    - Map INVALID_PERSONA_ID to app error
    """

    def test_delete_returns_deleted_persona_payload(self) -> None:
        """Success delete returns exactly {id, deleted: True}."""
        registry = InMemoryRegistryStore(
            delete_result=Success(None),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("persona-to-delete")

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload == {"id": "persona-to-delete", "deleted": True}
        # Pin: only these two keys allowed in success shape
        assert set(payload.keys()) == {"id", "deleted"}

    def test_delete_maps_persona_not_found_to_app_error_envelope(self) -> None:
        """PERSONA_NOT_FOUND from registry maps to LarvaError preserving code/message."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("missing")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "missing"

    def test_delete_maps_invalid_persona_id_to_app_error_envelope(self) -> None:
        """INVALID_PERSONA_ID from registry maps to LarvaError preserving code/message."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "INVALID_PERSONA_ID",
                    "message": "invalid persona id 'Bad_Id': expected flat kebab-case",
                    "persona_id": "Bad_Id",
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("Bad_Id")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_PERSONA_ID"
        assert error["numeric_code"] == 104
        assert error["details"]["persona_id"] == "Bad_Id"

    def test_delete_maps_registry_delete_failure_to_app_error_details(self) -> None:
        """DeleteFailureError from registry maps to REGISTRY_DELETE_FAILED with details."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to unlink spec file: OSError",
                    "operation": "delete",
                    "persona_id": "stuck-persona",
                    "path": "/home/.larva/registry/stuck-persona.json",
                    "failed_spec_paths": ["/home/.larva/registry/stuck-persona.json"],
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("stuck-persona")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_DELETE_FAILED"
        assert error["numeric_code"] == 111
        # Registry code/message preserved at facade level
        assert "failed to unlink" in error["message"]
        # Extra registry fields moved to details
        assert error["details"]["operation"] == "delete"
        assert error["details"]["persona_id"] == "stuck-persona"
        assert error["details"]["path"] == "/home/.larva/registry/stuck-persona.json"
        assert error["details"]["failed_spec_paths"] == ["/home/.larva/registry/stuck-persona.json"]


# ===========================================================================
# REGISTRY-LOCAL VARIANT TESTS (expected-red until implementation lands)
# ===========================================================================


class TestFacadeVariantDelete:
    """variant_delete: reject active, reject last variant, accept inactive.

    Target contract:
    - variant_delete(id, variant) deletes an inactive, non-last variant
    - Returns {id, variant, deleted: true}
    - Reject active variant => ACTIVE_VARIANT_DELETE_FORBIDDEN
    - Reject last variant => LAST_VARIANT_DELETE_FORBIDDEN
    - Invalid variant name => INVALID_VARIANT_NAME
    - variant is operation parameter, not inside spec
    - delete(id) deletes base persona and ALL variants

    Expected-RED because variant_delete does not exist yet.
    """

    def test_variant_delete_inactive_non_last_succeeds(self) -> None:
        """variant_delete(id, variant) on inactive non-last returns {id, variant, deleted: true}."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "expected ACTIVE_VARIANT_DELETE_FORBIDDEN after implementation"
        )

    def test_variant_delete_active_variant_rejected(self) -> None:
        """Deleting the active variant => ACTIVE_VARIANT_DELETE_FORBIDDEN."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "expected ACTIVE_VARIANT_DELETE_FORBIDDEN after implementation"
        )

    def test_variant_delete_last_variant_rejected(self) -> None:
        """Deleting the last remaining variant => LAST_VARIANT_DELETE_FORBIDDEN."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "expected LAST_VARIANT_DELETE_FORBIDDEN after implementation"
        )

    def test_variant_delete_invalid_variant_name_rejected(self) -> None:
        """Invalid variant name => INVALID_VARIANT_NAME."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "expected INVALID_VARIANT_NAME after implementation"
        )

    def test_variant_delete_unknown_variant_rejected(self) -> None:
        """Variant not found under persona => VARIANT_NOT_FOUND."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "expected VARIANT_NOT_FOUND after implementation"
        )

    def test_delete_base_persona_removes_all_variants(self) -> None:
        """delete(id) removes the entire persona directory including all variants."""
        pytest.xfail(
            "variant-aware delete(id) removing all variants does not exist yet; "
            "expected to remove full <id>/ directory after implementation"
        )
