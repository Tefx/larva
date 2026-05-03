from __future__ import annotations

from returns.result import Success

from .conftest import _canonical_spec, _facade, _failure, InMemoryRegistryStore


def test_update_named_variant_patches_that_variant() -> None:
    registry = InMemoryRegistryStore()
    registry.save(_canonical_spec("update-named"), variant="default")
    registry.save(_canonical_spec("update-named"), variant="tacit")
    facade, _, _, _ = _facade(registry=registry)

    result = facade.update("update-named", {"description": "Updated"}, variant="tacit")

    assert isinstance(result, Success)
    assert registry.variant_save_inputs[-1][1] == "tacit"
    assert result.unwrap()["description"] == "Updated"


def test_update_rejects_variant_inside_patches() -> None:
    registry = InMemoryRegistryStore()
    registry.save(_canonical_spec("update-patch-variant"))
    facade, _, _, _ = _facade(registry=registry)

    error = _failure(facade.update("update-patch-variant", {"variant": "tacit"}))
    assert error["code"] == "FORBIDDEN_PATCH_FIELD"
