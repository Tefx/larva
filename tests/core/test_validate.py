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


class TestValidateSpecStub:
    """Test that the stub raises NotImplementedError."""

    def test_raises_not_implemented_error(self):
        """Calling validate_spec should raise NotImplementedError.

        Note: Due to a bug in invar_runtime (invar_runtime/contracts.py:128),
        the contract validation fails with AttributeError before reaching
        the NotImplementedError when the input is a dict. This test uses
        deal.disable() to bypass the contract validation and test the
        underlying stub behavior.
        """
        import deal

        deal.disable()
        try:
            with pytest.raises(NotImplementedError):
                validate_module.validate_spec({})
        finally:
            deal.enable()

    def test_error_message_mentions_implementation_pending(self):
        """NotImplementedError message should mention implementation is pending."""
        import deal

        deal.disable()
        try:
            with pytest.raises(NotImplementedError) as exc_info:
                validate_module.validate_spec({})
            assert "implementation" in str(exc_info.value).lower()
        finally:
            deal.enable()


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
