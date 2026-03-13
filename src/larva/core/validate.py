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
from typing import TypedDict, cast

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


@pre(
    lambda code, message, details: len(code) > 0 and len(message) > 0 and isinstance(details, dict)
)
@post(lambda result: "code" in result and "message" in result and "details" in result)
def _issue(code: str, message: str, details: dict[str, object]) -> ValidationIssue:
    return {"code": code, "message": message, "details": details}


@pre(lambda spec: isinstance(spec, dict))
@post(lambda result: isinstance(result, list))
def _validate_identity_fields(spec: PersonaSpec) -> list[ValidationIssue]:
    errors: list[ValidationIssue] = []
    persona_id = spec.get("id")
    if (
        not isinstance(persona_id, str)
        or persona_id == ""
        or not _PERSONA_ID_PATTERN.fullmatch(persona_id)
    ):
        errors.append(
            _issue(
                "INVALID_PERSONA_ID",
                "id is required and must match ^[a-z0-9]+(-[a-z0-9]+)*$",
                {"field": "id", "value": persona_id},
            )
        )

    spec_version = spec.get("spec_version")
    if spec_version is not None and spec_version != "0.1.0":
        errors.append(
            _issue(
                "INVALID_SPEC_VERSION",
                "spec_version must be '0.1.0'",
                {"field": "spec_version", "value": spec_version},
            )
        )

    side_effect_policy = spec.get("side_effect_policy")
    valid_policies: set[str] = {"allow", "approval_required", "read_only"}
    if side_effect_policy is not None and side_effect_policy not in valid_policies:
        errors.append(
            _issue(
                "INVALID_SIDE_EFFECT_POLICY",
                "side_effect_policy must be one of allow, approval_required, read_only",
                {"field": "side_effect_policy", "value": side_effect_policy},
            )
        )

    return errors


@pre(lambda spec: isinstance(spec, dict))
@post(lambda result: isinstance(result, dict) and "errors" in result and "warnings" in result)
def _validate_prompt_variables(spec: PersonaSpec) -> dict[str, object]:
    errors: list[ValidationIssue] = []
    warnings: list[str] = []

    prompt_obj = spec.get("prompt", "")
    if not isinstance(prompt_obj, str):
        errors.append(
            _issue(
                "INVALID_PROMPT",
                "prompt must be a string",
                {"field": "prompt", "value": prompt_obj},
            )
        )
        return {"errors": errors, "warnings": warnings}
    found_vars = set(_PROMPT_VARIABLE_PATTERN.findall(prompt_obj))

    provided_vars_obj = spec.get("variables", {})
    provided_vars: dict[str, str] = {}
    if isinstance(provided_vars_obj, dict):
        provided_vars = {
            key: value
            for key, value in provided_vars_obj.items()
            if isinstance(key, str) and isinstance(value, str)
        }

    unresolved = found_vars - set(provided_vars.keys())
    if unresolved:
        errors.append(
            _issue(
                "VARIABLE_UNRESOLVED",
                f"prompt contains unresolved variables: {', '.join(sorted(unresolved))}",
                {"field": "prompt", "unresolved_variables": sorted(unresolved)},
            )
        )

    unused_vars = set(provided_vars.keys()) - found_vars
    if unused_vars:
        warnings.append(
            "UNUSED_VARIABLES: supplied variables are not referenced by prompt: "
            + ", ".join(sorted(unused_vars))
        )

    return {"errors": errors, "warnings": warnings}


@pre(lambda spec: isinstance(spec, dict))
@post(lambda result: "valid" in result and "errors" in result and "warnings" in result)
def validate_spec(spec: PersonaSpec) -> ValidationReport:
    """Validate a PersonaSpec candidate and return structured results.

    Contract (from INTERFACES.md):
    - Validates field types and allowed values
    - Produces structured errors with code, message, and details
    - Produces warnings for non-critical unused variable declarations

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
    errors = _validate_identity_fields(spec)
    variable_result = _validate_prompt_variables(spec)
    errors.extend(cast("list[ValidationIssue]", variable_result["errors"]))
    warnings = cast("list[str]", variable_result["warnings"])

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }
