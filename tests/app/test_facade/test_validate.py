"""Tests for facade validate operation.

Sources:
- ARCHITECTURE.md section 7 (Assembly -> Validation -> Normalization)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from larva.core.validate import ValidationReport

from .conftest import _canonical_spec, _facade


class TestFacadeValidate:
    def test_validate_returns_core_report_unchanged(self) -> None:
        report = {
            "valid": True,
            "errors": [],
            "warnings": ["model is unknown"],
        }
        facade, _, validate_module, _ = _facade(report=cast("ValidationReport", report))

        spec = _canonical_spec("validate-me")
        result = facade.validate(spec)

        assert result is report
        assert validate_module.inputs == [spec]
