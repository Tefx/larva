from __future__ import annotations

from returns.result import Success

from .conftest import _canonical_spec, _facade, InMemoryRegistryStore


def test_register_default_variant_auto_activates_for_new_persona() -> None:
    registry = InMemoryRegistryStore()
    facade, _, _, _ = _facade(registry=registry)

    result = facade.register(_canonical_spec("variant-default"))

    assert isinstance(result, Success)
    assert registry.active_variants["variant-default"] == "default"
    assert set(registry.variants["variant-default"]) == {"default"}


def test_register_named_variant_for_new_persona_auto_activates() -> None:
    registry = InMemoryRegistryStore()
    facade, _, _, _ = _facade(registry=registry)

    result = facade.register(_canonical_spec("variant-tacit"), variant="tacit")

    assert isinstance(result, Success)
    assert registry.active_variants["variant-tacit"] == "tacit"
    assert set(registry.variants["variant-tacit"]) == {"tacit"}
