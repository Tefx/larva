from __future__ import annotations

from larva.app.facade import DefaultLarvaFacade


def test_facade_constructor_has_no_assembly_or_component_seams() -> None:
    annotations = DefaultLarvaFacade.__init__.__annotations__
    assert "assemble" not in annotations
    assert "components" not in annotations
