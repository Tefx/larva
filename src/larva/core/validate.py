"""Contract-only validate module for PersonaSpec validation.

This module defines the validation contract for PersonaSpec candidates.
Validation applies deterministic rules and produces a structured validation
report with errors and warnings.

Responsibility (from ARCHITECTURE.md):
- Apply deterministic validation rules to PersonaSpec candidates
- Produce a validation report

Non-Responsibility (from ARCHITECTURE.md):
- No filesystem access
- No registry persistence
- No component lookup
- No CLI/MCP error formatting

See:
- INTERFACES.md :: A. MCP Server Interface :: larva.validate(spec)
- ARCHITECTURE.md :: Module: larva.core.validate
- Depends on: larva.core.spec (PersonaSpec type)
"""

from typing import TypedDict

from invar import post
from invar import pre

# Import PersonaSpec from the canonical spec module
from larva.core.spec import PersonaSpec


class ValidationIssue(TypedDict):
    """Single structured validation issue for a PersonaSpec candidate.

    Fields:
        code: Machine-readable issue code (e.g., "INVALID_SPEC_VERSION")
        message: Human-readable issue message
        details: Extra context for machine handling and diagnostics
    """

    code: str
    message: str
    details: dict[str, object]


class ValidationReport(TypedDict):
    """Structured validation result for a PersonaSpec candidate.

    Fields:
        valid: True if the spec passes all validation rules
        errors: List of structured validation issues (empty if valid)
        warnings: List of warning messages (always present, may be empty)
    """

    valid: bool
    errors: list[ValidationIssue]
    warnings: list[str]


# Contract-only stub - implementation handles validation logic
@pre(lambda spec: isinstance(spec, dict))
@post(lambda result: "valid" in result and "errors" in result and "warnings" in result)
def validate_spec(spec: PersonaSpec) -> ValidationReport:
    """Validate a PersonaSpec candidate and return structured results.

    This is a contract stub - full implementation follows in a subsequent
    step.

    Contract (from INTERFACES.md):
    - Validates field types and allowed values
    - Produces structured errors with code, message, and details
    - Produces warnings for non-critical issues (unknown models, deprecated fields)

    Args:
        spec: A PersonaSpec candidate to validate.

    Returns:
        ValidationReport with valid=True/False, errors list, and warnings list.

    Note:
        This is a contract stub. Implementation handles:
        - Type validation for all fields
        - Allowed value validation (e.g., side_effect_policy enum)
        - Field-specific validation rules
        - Deterministic, pure validation (no I/O side effects)

    Acceptance:
        @pre(lambda spec: isinstance(spec, dict))
        @post(lambda result: isinstance(result, dict) and "valid" in result and "errors" in result and "warnings" in result)

    Examples:
        >>> validate_spec({})  # doctest: +SKIP
        Traceback (most recent call last):
            ...
    """
    raise NotImplementedError(
        "validate_spec implementation pending core_validate.core-validate-implement"
    )
