"""Contract-focused tests for larva.core.validate module.

This test module validates the contract of the validate_spec function
and its associated types. It does NOT test implementation since the function
is currently a stub.

Responsibility:
- Verify function signature and type hints
- Verify contract annotations (@pre, @post) are present
- Verify stub behavior raises NotImplementedError
- Verify TypedDict shapes for ValidationIssue, ValidationReport

Non-Responsibility:
- No implementation tests (function is stub)
- No downstream module tests
"""

import pytest
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
                "spec_version": "0.1.0",
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert report["warnings"] == []

    def test_missing_id_produces_invalid_persona_id(self):
        """validate_spec should reject specs that omit required id."""
        report = validate_module.validate_spec({"spec_version": "0.1.0"})
        assert report["valid"] is False
        assert report["errors"][0]["code"] == "INVALID_PERSONA_ID"

    def test_invalid_spec_version_produces_structured_error(self):
        """validate_spec should report INVALID_SPEC_VERSION for unsupported version."""
        report = validate_module.validate_spec({"id": "test-persona", "spec_version": "0.2.0"})
        assert report["valid"] is False
        assert report["errors"][0]["code"] == "INVALID_SPEC_VERSION"

    def test_invalid_side_effect_policy_produces_structured_error(self):
        """validate_spec should report INVALID_SIDE_EFFECT_POLICY for bad policy values."""
        report = validate_module.validate_spec(
            {"id": "test-persona", "side_effect_policy": "forbidden"}
        )
        assert report["valid"] is False
        assert report["errors"][0]["code"] == "INVALID_SIDE_EFFECT_POLICY"

    def test_unresolved_prompt_variables_produce_variable_unresolved_code(self):
        """validate_spec should use canonical VARIABLE_UNRESOLVED code for unresolved vars."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "prompt": "You are {role} speaking to {target}",
                "variables": {"role": "assistant"},
            }
        )
        assert report["valid"] is False
        assert report["errors"][0]["code"] == "VARIABLE_UNRESOLVED"


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
            "warnings": ["model 'gpt-6' not in known models list"],
        }
        assert report["valid"] is False
        assert len(report["errors"]) == 1
        assert report["errors"][0]["code"] == "INVALID_SPEC_VERSION"
        assert len(report["warnings"]) == 1
        # Warnings are now list[str], not list[ValidationWarning]
        assert isinstance(report["warnings"][0], str)


class TestUnusedVariablesWarning:
    """Test UNUSED_VARIABLES warning contract from INTERFACES.md.

    Authoritative warning semantics for v1:
    - `warnings` is reserved for the deterministic `UNUSED_VARIABLES` family.
    - Emit a warning when `spec.variables` provides one or more keys that are not
      referenced by any `{name}` placeholder in `spec.prompt`.
    - Warning strings use this canonical format:
      `UNUSED_VARIABLES: supplied variables are not referenced by prompt: <sorted comma-separated keys>`.
    - Missing variables remain validation errors via `VARIABLE_UNRESOLVED`; they are
      not warnings.
    """

    def test_unused_variables_produces_warning(self):
        """validate_spec should emit UNUSED_VARIABLES warning when variables are not used."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "prompt": "You are a helpful assistant.",  # No variables used
                "variables": {"role": "assistant", "project": "demo"},
            }
        )
        # Spec is valid (no errors), but has warnings
        assert report["valid"] is True
        assert report["errors"] == []
        assert len(report["warnings"]) == 1

    def test_unused_variables_warning_format(self):
        """UNUSED_VARIABLES warning should use canonical format with sorted keys."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "prompt": "Hello.",  # No variables used
                "variables": {"zebra": "a", "apple": "b", "mango": "c"},
            }
        )
        warning = report["warnings"][0]
        # Should start with the canonical prefix
        assert warning.startswith(
            "UNUSED_VARIABLES: supplied variables are not referenced by prompt: "
        )
        # Keys should be sorted (alphabetically)
        assert "apple, mango, zebra" in warning

    def test_multiple_unused_variables_sorted(self):
        """Multiple unused variables should appear in sorted order in warning."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "prompt": "Hello.",  # No variables used
                "variables": {"z": "1", "a": "2", "m": "3"},
            }
        )
        warning = report["warnings"][0]
        # Sorted order: a, m, z
        assert "a, m, z" in warning

    def test_unused_variables_with_used_variables(self):
        """Should emit warning for unused variables even when some are used."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "prompt": "You are {role}.",  # 'role' is used
                "variables": {"role": "assistant", "unused_key": "value"},
            }
        )
        assert report["valid"] is True
        assert report["errors"] == []
        assert len(report["warnings"]) == 1
        assert "unused_key" in report["warnings"][0]
        assert "role" not in report["warnings"][0]  # role is used, not unused

    def test_unused_variables_with_unresolved_variables(self):
        """Should have both VARIABLE_UNRESOLVED error and UNUSED_VARIABLES warning."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "prompt": "You are {role} talking to {target}.",  # target is unresolved
                "variables": {
                    "role": "assistant",
                    "unused": "value",
                },  # unused is provided but not referenced
            }
        )
        # Should have error for unresolved variable
        assert report["valid"] is False
        assert len(report["errors"]) == 1
        assert report["errors"][0]["code"] == "VARIABLE_UNRESOLVED"
        # Should have warning for unused variable
        assert len(report["warnings"]) == 1
        assert "UNUSED_VARIABLES" in report["warnings"][0]
        assert "unused" in report["warnings"][0]

    def test_empty_variables_no_warning(self):
        """Empty variables dict should not produce warnings."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "prompt": "Hello.",
                "variables": {},
            }
        )
        assert report["valid"] is True
        assert report["warnings"] == []

    def test_no_variables_key_no_warning(self):
        """Missing variables key should not produce warnings."""
        report = validate_module.validate_spec(
            {
                "id": "test-persona",
                "spec_version": "0.1.0",
                "prompt": "Hello.",
            }
        )
        assert report["valid"] is True
        assert report["warnings"] == []
