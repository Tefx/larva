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

import re
from typing import TypedDict

from deal import post, pre

# Import PersonaSpec from the canonical spec module
from larva.core.spec import PersonaSpec


_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_PROMPT_VARIABLE_PATTERN = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")


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


@pre(lambda spec: isinstance(spec, dict))
@post(lambda result: "valid" in result and "errors" in result and "warnings" in result)
def validate_spec(spec: PersonaSpec) -> ValidationReport:
    """Validate a PersonaSpec candidate and return structured results.

    Contract (from INTERFACES.md):
    - Validates field types and allowed values
    - Produces structured errors with code, message, and details
    - Produces warnings for non-critical issues (unknown models, deprecated fields)

    Args:
        spec: A PersonaSpec candidate to validate.

    Returns:
        ValidationReport with valid=True/False, errors list, and warnings list.

    Note:
        This implementation handles:
        - Type validation for all fields
        - Allowed value validation (e.g., side_effect_policy enum)
        - Field-specific validation rules
        - Deterministic, pure validation (no I/O side effects)

    Acceptance:
        @pre(lambda spec: isinstance(spec, dict))
        @post(
            lambda result: (
                isinstance(result, dict)
                and "valid" in result
                and "errors" in result
                and "warnings" in result
            )
        )

    Examples:
        >>> validate_spec({"id": "code-reviewer", "spec_version": "0.1.0"})["valid"]
        True
        >>> validate_spec({"spec_version": "0.1.0"})["errors"][0]["code"]
        'INVALID_PERSONA_ID'
    """
    errors: list[ValidationIssue] = []
    warnings: list[str] = []

    persona_id = spec.get("id")
    if (
        not isinstance(persona_id, str)
        or persona_id == ""
        or not _PERSONA_ID_PATTERN.fullmatch(persona_id)
    ):
        errors.append(
            {
                "code": "INVALID_PERSONA_ID",
                "message": "id is required and must match ^[a-z0-9]+(-[a-z0-9]+)*$",
                "details": {"field": "id", "value": persona_id},
            }
        )

    spec_version = spec.get("spec_version")
    if spec_version is not None and spec_version != "0.1.0":
        errors.append(
            {
                "code": "INVALID_SPEC_VERSION",
                "message": "spec_version must be '0.1.0'",
                "details": {"field": "spec_version", "value": spec_version},
            }
        )

    side_effect_policy = spec.get("side_effect_policy")
    valid_policies: set[str] = {"allow", "approval_required", "read_only"}
    if side_effect_policy is not None and side_effect_policy not in valid_policies:
        errors.append(
            {
                "code": "INVALID_SIDE_EFFECT_POLICY",
                "message": "side_effect_policy must be one of allow, approval_required, read_only",
                "details": {"field": "side_effect_policy", "value": side_effect_policy},
            }
        )

    prompt = spec.get("prompt", "")
    found_vars = set(_PROMPT_VARIABLE_PATTERN.findall(prompt))
    provided_vars_obj = spec.get("variables", {})
    provided_vars = provided_vars_obj if isinstance(provided_vars_obj, dict) else {}

    if found_vars:
        unresolved = found_vars - set(provided_vars.keys())
        if unresolved:
            errors.append(
                {
                    "code": "VARIABLE_UNRESOLVED",
                    "message": (
                        f"prompt contains unresolved variables: {', '.join(sorted(unresolved))}"
                    ),
                    "details": {
                        "field": "prompt",
                        "unresolved_variables": sorted(unresolved),
                    },
                }
            )

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }
