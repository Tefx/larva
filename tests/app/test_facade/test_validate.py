"""Tests for facade validate operation.

Sources:
- ARCHITECTURE.md section 7 (Assembly -> Validation -> Normalization)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from larva.core.validate import ValidationReport

from .conftest import _canonical_spec, _facade, _historical_spec_with_legacy_fields


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

    def test_validate_forwards_historical_noncanonical_fixture_to_core_validator(self) -> None:
        """Facade validate remains a thin pass-through over the core validator."""
        report = {
            "valid": False,
            "errors": [
                {
                    "code": "EXTRA_FIELD_NOT_ALLOWED",
                    "message": "field 'tools' is not permitted",
                    "details": {"field": "tools"},
                }
            ],
            "warnings": [],
        }
        facade, _, validate_module, _ = _facade(report=cast("ValidationReport", report))

        spec = _historical_spec_with_legacy_fields("historical-tools")
        result = facade.validate(spec)

        assert result["valid"] is False
        assert result["errors"][0]["code"] == "EXTRA_FIELD_NOT_ALLOWED"
        assert validate_module.inputs == [spec]

    def test_fixture_taxonomy_separates_canonical_and_historical_noncanonical_specs(self) -> None:
        canonical_spec = _canonical_spec("canonical-fixture")
        historical_spec = _historical_spec_with_legacy_fields("historical-fixture")

        assert "tools" not in canonical_spec
        assert "side_effect_policy" not in canonical_spec
        assert "tools" in historical_spec
        assert "side_effect_policy" in historical_spec
