"""Contract and behavior tests for ``larva.core.validate``.

Responsibilities:
- verify signature/type-contract invariants
- verify fail-closed canonical admission errors
- verify non-blocking canonical warning semantics
- verify TypedDict report shapes remain stable
"""

import pytest
from hypothesis import given
from hypothesis import strategies as st
from typing import get_type_hints

from larva.core import validate as validate_module


class TestValidateSpecExists:
    """Test that validate_spec exists and has correct signature."""

    def test_function_exists(self):
        """validate_spec should exist in the module."""
        assert hasattr(validate_module, "validate_spec")

    def test_function_is_callable(self):
        """validate_spec should be callable."""
        assert callable(validate_module.validate_spec)

    def test_function_signature(self):
        """validate_spec should accept a dict parameter named spec."""
        import inspect

        sig = inspect.signature(validate_module.validate_spec)
        params = list(sig.parameters.keys())
        assert params == ["spec"]

    def test_function_return_type(self):
        """validate_spec return type should be ValidationReport."""
        hints = get_type_hints(validate_module.validate_spec)
        assert "return" in hints
        assert hints["return"] == validate_module.ValidationReport


class TestValidateSpecContract:
    """Test that contract annotations are present."""

    def test_pre_annotation_present(self):
        """validate_spec should have @pre annotation."""
        func = validate_module.validate_spec
        # Deal adds __deal_contract attribute when pre/post decorators are used
        contract = getattr(func, "__deal_contract", None)
        assert contract is not None, "validate_spec should have @pre/@post decorator"
        assert len(contract.pres) > 0, "Should have pre conditions"

    def test_post_annotation_present(self):
        """validate_spec should have @post annotation."""
        func = validate_module.validate_spec
        contract = getattr(func, "__deal_contract", None)
        assert contract is not None, "validate_spec should have @pre/@post decorator"
        assert len(contract.posts) > 0, "Should have post conditions"


class TestValidateSpecBehavior:
    """Test validate_spec runtime behavior."""

    def test_valid_spec_returns_valid_report(self):
        """validate_spec should mark canonical spec_version as valid."""
        report = validate_module.validate_spec(
            {
                "id": "valid-persona",
                "description": "A valid persona for canonical validate success coverage.",
                "prompt": "You are a helpful assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert report["warnings"] == []

    def test_missing_id_produces_invalid_persona_id(self):
        """validate_spec should reject specs that omit required id."""
        report = validate_module.validate_spec(
            {
                "description": "A persona without id",
                "prompt": "You are a helpful assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is False
        assert any(
            e["code"] == "MISSING_REQUIRED_FIELD" and e["details"]["field"] == "id"
            for e in report["errors"]
        )

    def test_invalid_spec_version_produces_structured_error(self):
        """validate_spec should report INVALID_SPEC_VERSION for unsupported version."""
        report = validate_module.validate_spec({"id": "test-persona", "spec_version": "0.2.0"})
        assert report["valid"] is False
        assert report["errors"][0]["code"] == "INVALID_SPEC_VERSION"

    def test_side_effect_policy_forbidden_field_rejected(self):
        """validate_spec should report EXTRA_FIELD_NOT_ALLOWED for side_effect_policy.

        Per canonical authority (opifex-canonical-authority-basis.md):
        side_effect_policy is a removed/forbidden field - reject-immediate on admission.
        The field name itself is forbidden, not just invalid values.
        """
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "description": "Test persona",
                "prompt": "You are a test assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "side_effect_policy": "forbidden",  # forbidden at canonical boundary
            }
        )
        assert report["valid"] is False
        assert report["errors"][0]["code"] == "EXTRA_FIELD_NOT_ALLOWED"

    def test_unresolved_prompt_placeholders_produce_canonical_error(self):
        """validate_spec should fail closed on unresolved placeholders in prompt."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "description": "Test persona",
                "prompt": "You are {role} speaking to {target}",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "UNRESOLVED_PLACEHOLDER" for e in report["errors"])


class TestCanonicalWarningSemantics:
    """Canonical warning channel is non-blocking but populated when expected."""

    def test_unknown_model_emits_warning_but_keeps_valid_true(self):
        report = validate_module.validate_spec(
            {
                "id": "warning-unknown-model",
                "description": "A canonical persona that intentionally uses an unknown model id.",
                "prompt": "You are a warning test persona.",
                "model": "custom-model-x",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert any("unknown model identifier 'custom-model-x'" in w for w in report["warnings"])

    def test_empty_capabilities_emits_warning_but_is_valid(self):
        report = validate_module.validate_spec(
            {
                "id": "warning-empty-capabilities",
                "description": "A canonical persona with an intentionally empty capabilities map.",
                "prompt": "You are a warning test persona.",
                "model": "gpt-4o-mini",
                "capabilities": {},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert (
            "capabilities is empty; this is valid but likely under-specified" in report["warnings"]
        )

    def test_all_none_capabilities_emits_warning_but_is_valid(self):
        report = validate_module.validate_spec(
            {
                "id": "warning-none-capabilities",
                "description": "A canonical persona where all capabilities are intentionally none.",
                "prompt": "You are a warning test persona.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "none", "git": "none"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert (
            "all declared capabilities are 'none'; this is valid but operationally inert"
            in report["warnings"]
        )

    def test_unknown_tool_family_emits_warning_but_is_valid(self):
        report = validate_module.validate_spec(
            {
                "id": "warning-unknown-tool-family",
                "description": "A canonical persona with one unrecognized tool-family identifier.",
                "prompt": "You are a warning test persona.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only", "custom_tool": "read_only"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert any("unknown tool families" in w and "custom_tool" in w for w in report["warnings"])

    def test_short_description_emits_warning_but_is_valid(self):
        report = validate_module.validate_spec(
            {
                "id": "warning-short-description",
                "description": "Too short",
                "prompt": "You are a warning test persona.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert any("description length is outside guidance range" in w for w in report["warnings"])


class TestValidationIssueTypedDict:
    """Test ValidationIssue TypedDict shape (canonical schema).

    Canonical shape from ARCHITECTURE.md:
    - code: Machine-readable issue code (e.g., "INVALID_SPEC_VERSION")
    - message: Human-readable issue message
    - details: Extra context for machine handling and diagnostics
    """

    def test_validation_issue_exists(self):
        """ValidationIssue should exist in the module."""
        assert hasattr(validate_module, "ValidationIssue")

    def test_validation_issue_has_required_fields(self):
        """ValidationIssue should have code, message, details."""
        hints = get_type_hints(validate_module.ValidationIssue)
        assert "code" in hints
        assert "message" in hints
        assert "details" in hints


class TestValidationReportTypedDict:
    """Test ValidationReport TypedDict shape (canonical schema).

    Canonical shape from ARCHITECTURE.md:
    - valid: True if the spec passes all validation rules
    - errors: List of ValidationIssue (empty if valid)
    - warnings: List of warning messages (always present, may be empty)
    """

    def test_validation_report_exists(self):
        """ValidationReport should exist in the module."""
        assert hasattr(validate_module, "ValidationReport")

    def test_validation_report_has_required_fields(self):
        """ValidationReport should have valid, errors, warnings."""
        hints = get_type_hints(validate_module.ValidationReport)
        assert "valid" in hints
        assert "errors" in hints
        assert "warnings" in hints


class TestValidationReportShapes:
    """Integration tests for TypedDict shapes."""

    def test_can_create_validation_issue(self):
        """Should be able to create a ValidationIssue dict."""
        issue: validate_module.ValidationIssue = {
            "code": "INVALID_SPEC_VERSION",
            "message": "spec_version must be '0.1.0'",
            "details": {"field": "spec_version", "value": "0.2.0"},
        }
        assert issue["code"] == "INVALID_SPEC_VERSION"
        assert issue["message"] == "spec_version must be '0.1.0'"
        assert "field" in issue["details"]

    def test_can_create_validation_report(self):
        """Should be able to create a ValidationReport dict."""
        report: validate_module.ValidationReport = {
            "valid": True,
            "errors": [],
            "warnings": [],
        }
        assert report["valid"] is True
        assert report["errors"] == []
        assert report["warnings"] == []

    def test_validation_report_with_errors(self):
        """ValidationReport should hold errors and warnings."""
        issue: validate_module.ValidationIssue = {
            "code": "INVALID_SPEC_VERSION",
            "message": "spec_version must be '0.1.0'",
            "details": {"field": "spec_version", "value": "0.2.0"},
        }
        report: validate_module.ValidationReport = {
            "valid": False,
            "errors": [issue],
            "warnings": ["unknown model identifier: custom-model"],
        }
        assert report["valid"] is False
        assert len(report["errors"]) == 1
        assert report["errors"][0]["code"] == "INVALID_SPEC_VERSION"
        assert len(report["warnings"]) == 1
        # Warnings are now list[str], not list[ValidationWarning]
        assert isinstance(report["warnings"][0], str)


class TestCanonicalFieldRejections:
    """Canonical validator rejects removed historical legacy fields."""

    def test_variables_field_rejected_as_extra(self):
        """variables is not part of canonical PersonaSpec v1."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "description": "Test persona used for extra-field rejection coverage",
                "prompt": "Hello.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
                "variables": {"role": "assistant"},
            }
        )
        assert report["valid"] is False
        assert report["warnings"] == []
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])

    @given(extra_field=st.sampled_from(("variables", "tools", "side_effect_policy")))
    def test_extra_fields_use_canonical_extra_field_error(self, extra_field: str):
        """Every forbidden legacy extra field should map to EXTRA_FIELD_NOT_ALLOWED."""
        extra_value = (
            {"shell": "read_only"} if extra_field in {"variables", "tools"} else "read_only"
        )
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "description": "Test persona used for canonical extra-field taxonomy",
                "prompt": "You are a helpful assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
                extra_field: extra_value,
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])


class TestPlaceholderSemantics:
    """Canonical prompt validation is fail-closed for unresolved placeholders."""

    @given(name=st.sampled_from(("role", "target", "agent_name")))
    def test_placeholder_like_tokens_are_rejected_without_variables(self, name: str):
        """Fully composed canonical prompts must not retain placeholder tokens."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "description": "Prompt placeholder rejection coverage for canonical validation",
                "prompt": f"You are {{{name}}}.",
                "model": "gpt-4o-mini",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "UNRESOLVED_PLACEHOLDER" for e in report["errors"])


class TestCapabilitiesValidation:
    """Test capabilities field validation.

    Valid ToolPosture values (from spec.py): none, read_only, read_write, destructive
    """

    def test_valid_capabilities(self):
        """Valid capabilities should pass validation."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "description": "Test persona",
                "prompt": "You are a test assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"git": "read_only", "filesystem": "read_write"},
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []

    def test_invalid_capability_posture(self):
        """Invalid posture value should produce error."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "description": "Test persona",
                "prompt": "You are a test assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"git": "invalid_posture"},
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "INVALID_POSTURE" for e in report["errors"])

    def test_capabilities_not_dict(self):
        """Non-dict capabilities should produce error."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "description": "Test persona",
                "prompt": "You are a test assistant.",
                "model": "gpt-4o-mini",
                "capabilities": "not-a-dict",
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "INVALID_CAPABILITIES_SHAPE" for e in report["errors"])

    def test_all_valid_postures(self):
        """All valid ToolPosture values should be accepted."""
        for posture in ["none", "read_only", "read_write", "destructive"]:
            report = validate_module.validate_spec(
                {
                    "id": "test-persona",
                    "spec_version": "0.1.0",
                    "description": "Test persona",
                    "prompt": "You are a test assistant.",
                    "model": "gpt-4o-mini",
                    "capabilities": {"tool": posture},
                }
            )
            assert report["valid"] is True, f"{posture} should be valid"

    def test_whitespace_only_required_string_is_rejected(self):
        """Whitespace-only required strings should fail with EMPTY_REQUIRED_FIELD."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "description": "   ",
                "prompt": "You are a test assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"git": "read_only"},
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "EMPTY_REQUIRED_FIELD" for e in report["errors"])

    def test_invalid_can_spawn_member_is_rejected(self):
        """can_spawn string lists must contain canonical persona ids only."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "description": "Test persona",
                "prompt": "You are a test assistant.",
                "model": "gpt-4o-mini",
                "capabilities": {"git": "read_only"},
                "can_spawn": ["child-persona", " ", "child-persona"],
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "INVALID_CAN_SPAWN" for e in report["errors"])


class TestCanonicalAdmissionRejection:
    """Pinned canonical admission rejections for forbidden and missing fields."""

    def test_tools_field_rejected_at_canonical_boundary(self):
        """tools is forbidden at canonical admission."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "tools": {"shell": "read_only"},  # forbidden at canonical boundary
            }
        )
        # Canonical contract: tools is not admissible canonical input
        assert report["valid"] is False, (
            "tools is forbidden at canonical admission boundary; got valid=True with warnings only"
        )
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"]), (
            f"Expected EXTRA_FIELD_NOT_ALLOWED error for 'tools', got: {[e['code'] for e in report['errors']]}"
        )

    def test_side_effect_policy_field_rejected_at_canonical_boundary(self):
        """side_effect_policy is forbidden at canonical admission boundary."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "side_effect_policy": "read_only",  # forbidden at canonical boundary
            }
        )
        # Canonical contract: side_effect_policy is not admissible canonical input
        assert report["valid"] is False, (
            "side_effect_policy is forbidden at canonical admission boundary; "
            "got valid=True with warnings only"
        )
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"]), (
            f"Expected EXTRA_FIELD_NOT_ALLOWED error for 'side_effect_policy', "
            f"got: {[e['code'] for e in report['errors']]}"
        )

    def test_extra_unknown_field_rejected(self):
        """Unknown top-level fields are forbidden at canonical admission."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "unknown_field": "some_value",  # not in canonical contract
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"]), (
            f"Expected EXTRA_FIELD_NOT_ALLOWED for unknown field, got: {[e['code'] for e in report['errors']]}"
        )

    def test_capabilities_required_at_canonical_boundary(self):
        """capabilities is required at canonical admission boundary."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is False, (
            "capabilities is required at canonical boundary; "
            "spec without capabilities should be rejected"
        )
        assert any(e["code"] == "MISSING_REQUIRED_FIELD" for e in report["errors"]), (
            f"Expected MISSING_REQUIRED_FIELD error for missing 'capabilities', "
            f"got: {[e['code'] for e in report['errors']]}"
        )

    def test_both_tools_and_capabilities_rejected(self):
        """Spec with both tools and capabilities is invalid at canonical boundary."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "capabilities": {"shell": "read_only"},
                "tools": {"shell": "read_only"},  # forbidden even when capabilities present
            }
        )
        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])


class TestCanonicalRequiredOnlyFixture:
    """Tests using canonical required-only shape from fixture.

    This section validates that a spec with ONLY the required canonical fields
    (and valid capabilities) passes validation. This is the spec shape that
    downstream implementation must admit without errors.
    """

    def test_canonical_required_only_shape_valid(self):
        """Spec with only required fields + capabilities should be valid.

        Canonical required fields: id, description, prompt, model, capabilities, spec_version
        No tools, no side_effect_policy, no extra fields.
        """
        canonical = {
            "id": "canonical-persona",
            "description": "A canonical test persona",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(canonical)
        assert report["valid"] is True, (
            f"Canonical required-only shape should be valid, got errors: {report['errors']}"
        )
        assert report["warnings"] == [], (
            f"Canonical shape should have no warnings, got: {report['warnings']}"
        )

    def test_canonical_shape_with_model_params_still_valid(self):
        """Canonical shape with optional model_params is still valid."""
        canonical = {
            "id": "canonical-with-params",
            "description": "Test persona with model params",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "model_params": {"temperature": 0.7},
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(canonical)
        assert report["valid"] is True
        assert report["warnings"] == []

    def test_canonical_shape_with_can_spawn_still_valid(self):
        """Canonical shape with optional can_spawn is still valid."""
        canonical = {
            "id": "spawnable-persona",
            "description": "A persona that can spawn",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "can_spawn": True,
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(canonical)
        assert report["valid"] is True
        assert report["warnings"] == []

    def test_canonical_shape_with_compaction_prompt_still_valid(self):
        """Canonical shape with optional compaction_prompt is still valid."""
        canonical = {
            "id": "compactable-persona",
            "description": "A persona with compaction",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "compaction_prompt": "Summarize the conversation.",
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(canonical)
        assert report["valid"] is True
        assert report["warnings"] == []

    def test_tools_field_in_canonical_fixture_produces_rejection(self):
        """Fixture variation: tools present = EXTRA_FIELD_NOT_ALLOWED."""
        spec = {
            "id": "persona-with-tools",
            "description": "Test persona with forbidden tools field",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "tools": {"shell": "read_only"},  # forbidden at canonical boundary
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])

    def test_side_effect_policy_in_canonical_fixture_produces_rejection(self):
        """Fixture variation: side_effect_policy present = EXTRA_FIELD_NOT_ALLOWED."""
        spec = {
            "id": "persona-with-sep",
            "description": "Test persona with forbidden side_effect_policy",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "side_effect_policy": "read_only",  # forbidden at canonical boundary
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])

    def test_extra_forbidden_field_produces_rejection(self):
        """Fixture variation: extra unknown field produces EXTRA_FIELD_NOT_ALLOWED."""
        spec = {
            "id": "persona-with-extra",
            "description": "Test persona with extra forbidden field",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "forbidden_extra_field": "some_value",  # not in canonical contract
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])


class TestAdmissionSuccessImpliesConformance:
    """Admission success implies conformance to the canonical PersonaSpec contract."""

    def test_valid_report_does_not_contain_forbidden_fields(self):
        """A valid report means the spec has no forbidden canonical fields."""
        spec_with_tools = {
            "id": "tools-persona",
            "description": "Test",
            "prompt": "You help.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "tools": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(spec_with_tools)
        assert report["valid"] is False

    def test_valid_report_does_not_contain_side_effect_policy(self):
        """A valid report means no side_effect_policy is present."""
        spec_with_sep = {
            "id": "sep-persona",
            "description": "Test",
            "prompt": "You help.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "side_effect_policy": "read_only",
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(spec_with_sep)
        assert report["valid"] is False
