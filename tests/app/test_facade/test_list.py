from __future__ import annotations

from returns.result import Success
from .conftest import _canonical_spec, _facade, InMemoryRegistryStore


def test_list_returns_persona_summaries() -> None:
    registry = InMemoryRegistryStore(list_result=Success([_canonical_spec("listed")]))
    facade, _, _, _ = _facade(registry=registry)

    result = facade.list()
    assert isinstance(result, Success)
    assert result.unwrap()[0]["id"] == "listed"
