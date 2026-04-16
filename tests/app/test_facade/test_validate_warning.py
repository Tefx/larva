"""Tests for facade validate operation under canonical rejection semantics.

Sources:
- ARCHITECTURE.md section 7 (Validation flow)
- INTERFACES.md section A/G (validate returns ValidationReport)
- ADR-002 / ADR-003 (side_effect_policy and tools are rejected at admission)
"""

from __future__ import annotations

from larva.core.validate import validate_spec


def _canonical_spec(persona_id: str) -> dict[str, object]:
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "read_only"},
        "model_params": {"temperature": 0.1},
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
        "spec_digest": f"sha256:{persona_id}",
    }


class TestValidateCanonicalRejection:
    """Test forbidden-field rejection propagated through facade.validate().

    Per INTERFACES.md / ADR-003:
    - side_effect_policy is rejected at canonical admission
    - tools is rejected at canonical admission; use capabilities instead
    - capabilities is the canonical capability declaration surface

    These tests verify that forbidden fields produce validation errors rather
    than deprecation warnings.
    """

    def test_side_effect_policy_in_spec_is_rejected(self) -> None:
        """side_effect_policy in spec should produce forbidden-field rejection."""
        spec = _canonical_spec("rejected-policy")
        spec["side_effect_policy"] = "allow"

        report = validate_spec(spec)

        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"]), (
            f"Expected forbidden-field rejection for side_effect_policy, got: {report['errors']}"
        )

    def test_tools_without_capabilities_is_rejected(self) -> None:
        """tools without capabilities should be rejected, not warned."""
        spec = _canonical_spec("rejected-tools-only")
        del spec["capabilities"]
        spec["tools"] = {"git": "read_only"}

        report = validate_spec(spec)

        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes
        assert "MISSING_REQUIRED_FIELD" in error_codes

    def test_tools_with_capabilities_is_rejected_without_migration_note(self) -> None:
        """Both tools and capabilities should still produce rejection, not migration notes."""
        spec = _canonical_spec("rejected-both-fields")
        spec["tools"] = {"git": "read_only"}

        report = validate_spec(spec)

        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])
        warnings_text = " ".join(report["warnings"])
        assert "DEPRECATED_FIELD" not in warnings_text
        assert "MIGRATION_NOTE" not in warnings_text

    def test_valid_capabilities_has_no_forbidden_field_errors(self) -> None:
        """Spec with only canonical fields should validate cleanly."""
        spec = _canonical_spec("clean-spec")

        report = validate_spec(spec)

        assert report["valid"] is True
        assert report["errors"] == []
        warnings_text = " ".join(report["warnings"])
        assert "EXTRA_FIELD_NOT_ALLOWED" not in warnings_text
        assert "DEPRECATED_FIELD" not in warnings_text
