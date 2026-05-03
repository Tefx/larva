from __future__ import annotations

from returns.result import Success

from .conftest import _canonical_spec, _digest_for, _facade, InMemoryRegistryStore


def test_export_all_returns_active_variants_only() -> None:
    registry = InMemoryRegistryStore()
    registry.save(_canonical_spec("export-active"), variant="default")
    tacit = _canonical_spec("export-active")
    tacit["description"] = "Active"
    tacit["spec_digest"] = _digest_for(tacit)
    registry.save(tacit, variant="tacit")
    registry.active_variants["export-active"] = "tacit"
    registry.list_result = Success([tacit])
    facade, _, _, _ = _facade(registry=registry)

    result = facade.export_all()
    assert isinstance(result, Success)
    assert result.unwrap()[0]["description"] == "Active"
