from __future__ import annotations

from returns.result import Failure

from .conftest import _canonical_spec, _facade, _failure, InMemoryRegistryStore


def test_update_named_variant_rejects_contract_patch() -> None:
    registry = InMemoryRegistryStore()
    registry.save(_canonical_spec("update-named"), variant="default")
    registry.save(_canonical_spec("update-named"), variant="tacit")
    facade, _, _, _ = _facade(registry=registry)

    result = facade.update("update-named", {"description": "Updated"}, variant="tacit")

    assert isinstance(result, Failure)
    assert result.failure()["code"] == "FIELD_SCOPE_VIOLATION"


def test_update_rejects_variant_inside_patches() -> None:
    registry = InMemoryRegistryStore()
    registry.save(_canonical_spec("update-patch-variant"))
    facade, _, _, _ = _facade(registry=registry)

    error = _failure(facade.update("update-patch-variant", {"variant": "tacit"}))
    assert error["code"] == "FORBIDDEN_PATCH_FIELD"
