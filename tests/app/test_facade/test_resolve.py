from __future__ import annotations

from returns.result import Success


from .conftest import _canonical_spec, _digest_for, _facade, _failure, InMemoryRegistryStore


def test_resolve_named_variant_returns_bare_persona_spec() -> None:
    registry = InMemoryRegistryStore()
    registry.save(_canonical_spec("resolve-named"), variant="default")
    tacit = _canonical_spec("resolve-named")
    tacit["description"] = "Tacit"
    tacit["spec_digest"] = _digest_for(tacit)
    registry.save(tacit, variant="tacit")
    facade, _, _, _ = _facade(registry=registry)

    result = facade.resolve("resolve-named", variant="tacit")

    assert isinstance(result, Success)
    resolved = result.unwrap()
    assert resolved["description"] == "Tacit"
    assert "variant" not in resolved


def test_resolve_unknown_variant_returns_variant_not_found() -> None:
    registry = InMemoryRegistryStore()
    registry.save(_canonical_spec("resolve-missing"))
    facade, _, _, _ = _facade(registry=registry)

    error = _failure(facade.resolve("resolve-missing", variant="missing"))
    assert error["code"] == "VARIANT_NOT_FOUND"
