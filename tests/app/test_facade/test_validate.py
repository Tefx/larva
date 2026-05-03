from __future__ import annotations

from .conftest import _canonical_spec, _facade


def test_validate_delegates_to_validator() -> None:
    facade, _, validate_module, _ = _facade()

    report = facade.validate(_canonical_spec("valid"))

    assert report["valid"] is True
    assert validate_module.calls == ["validate"]
