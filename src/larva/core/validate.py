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


class ValidationError(TypedDict):
    """Single validation error for a PersonaSpec field.

    Fields:
        field: The field path that failed validation (e.g., "spec_version")
        message: Human-readable error message
        code: Machine-readable error code (e.g., "INVALID_SPEC_VERSION")
    """

    field: str
    message: str
    code: str


class ValidationWarning(TypedDict):
    """Single validation warning for a PersonaSpec field.

    Warnings indicate non-critical issues that don't invalidate the spec
    but may indicate potential problems or deprecated usage.

    Fields:
        field: The field path with the warning (e.g., "model")
        message: Human-readable warning message
    """

    field: str
    message: str


class ValidationResult(TypedDict):
    """Structured validation result for a PersonaSpec candidate.

    Fields:
        valid: True if the spec passes all validation rules
        errors: List of validation errors (empty if valid)
        warnings: List of validation warnings (always present, may be empty)
    """

    valid: bool
    errors: list[ValidationError]
    warnings: list[ValidationWarning]


# Contract-only stub - implementation handles validation logic
@pre(lambda candidate: isinstance(candidate, dict))
@post(lambda result: "valid" in result and "errors" in result and "warnings" in result)
def validate_persona_spec(candidate: dict) -> ValidationResult:
    """Validate a PersonaSpec candidate and return structured results.

    This is a contract stub - full implementation follows in a subsequent
    step.

    Contract (from INTERFACES.md):
    - Validates required fields: spec_version, spec_id, name
    - Validates field types and allowed values
    - Produces structured errors with field path, message, and error code
    - Produces warnings for non-critical issues (unknown models, deprecated fields)

    Args:
        candidate: A dict representing a PersonaSpec candidate to validate.
            Expected to be a dict (possibly with validation issues).

    Returns:
        ValidationResult with valid=True/False, errors list, and warnings list.

    Note:
        This is a contract stub. Implementation handles:
        - Required field validation (spec_version, spec_id, name)
        - Type validation for all fields
        - Allowed value validation (e.g., side_effect_policy enum)
        - Field-specific validation rules
        - Deterministic, pure validation (no I/O side effects)

    Acceptance:
        @pre(lambda candidate: isinstance(candidate, dict))
        @post(lambda result: isinstance(result, ValidationResult))

    Examples:
        >>> validate_persona_spec({})  # pragma: no cover
        Traceback (most recent call last):
            ...
        NotImplementedError: validate_persona_spec implementation pending core_validate.core-validate-implement
    """
    raise NotImplementedError(
        "validate_persona_spec implementation pending core_validate.core-validate-implement"
    )
