from __future__ import annotations

from returns.result import Success
from .conftest import _canonical_spec, _facade, InMemoryRegistryStore


def test_clone_resolves_source_and_saves_new_id() -> None:
    registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("source")))
    facade, _, _, _ = _facade(registry=registry)

    result = facade.clone("source", "clone")
    assert isinstance(result, Success)
    assert result.unwrap()["id"] == "clone"
    assert registry.save_inputs[-1]["id"] == "clone"
