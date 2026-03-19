"""Tests for facade validate operation with deprecation warnings.

Sources:
- ARCHITECTURE.md section 7 (Validation flow)
- INTERFACES.md section A/G (validate returns ValidationReport)
- ADR-002 (side_effect_policy and tools deprecation)
"""

from __future__ import annotations

import pytest

from larva.core.validate import validate_spec

from .conftest import _canonical_spec


class TestValidateDeprecationWarnings:
    """Test deprecation warnings propagated through facade.validate().

    Per INTERFACES.md ADR-002:
    - side_effect_policy is deprecated
    - tools is deprecated; use capabilities instead
    - capabilities is the canonical capability declaration surface

    These tests verify that deprecation warnings are present in the
    ValidationReport.warnings list returned by facade.validate().
    """

    def test_side_effect_policy_in_spec_produces_warning_in_report(self) -> None:
        """side_effect_policy in spec should produce deprecation warning in validation report."""
        spec = _canonical_spec("deprecated-policy")
        spec["side_effect_policy"] = "allow"

        report = validate_spec(spec)

        assert report["valid"] is True
        assert report["errors"] == []
        assert any("DEPRECATED_FIELD: side_effect_policy" in w for w in report["warnings"]), (
            f"Expected deprecation warning for side_effect_policy, got: {report['warnings']}"
        )

    def test_tools_without_capabilities_produces_deprecation_warning(self) -> None:
        """tools without capabilities should produce deprecation warning in validation report."""
        spec = _canonical_spec("deprecated-tools")
        del spec["capabilities"]
        spec["tools"] = {"git": "read_only"}

        report = validate_spec(spec)

        assert report["valid"] is True
        assert report["errors"] == []
        assert any("DEPRECATED_FIELD: tools" in w for w in report["warnings"]), (
            f"Expected deprecation warning for tools, got: {report['warnings']}"
        )

    def test_tools_with_capabilities_produces_migration_note(self) -> None:
        """Both tools and capabilities should produce deprecation warning and migration note."""
        spec = _canonical_spec("both-fields")
        spec["tools"] = {"git": "read_only"}
        spec["capabilities"] = {"git": "read_write"}

        report = validate_spec(spec)

        assert report["valid"] is True
        assert report["errors"] == []
        warnings_text = " ".join(report["warnings"])
        assert "DEPRECATED_FIELD: tools" in warnings_text
        assert "MIGRATION_NOTE: both tools and capabilities present" in warnings_text

    def test_valid_capabilities_no_deprecation_warning(self) -> None:
        """Spec with only capabilities (no tools, no side_effect_policy) should have no deprecation warnings."""
        spec = _canonical_spec("clean-spec")
        del spec["tools"]
        del spec["side_effect_policy"]

        report = validate_spec(spec)

        assert report["valid"] is True
        assert report["errors"] == []
        deprecation_warnings = [w for w in report["warnings"] if "DEPRECATED_FIELD" in w]
        assert deprecation_warnings == [], (
            f"Unexpected deprecation warnings: {deprecation_warnings}"
        )
