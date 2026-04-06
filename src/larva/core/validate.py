"""Contract-only validate module for PersonaSpec validation.

This module defines the canonical larva admission contract for PersonaSpec
candidates as a downstream enforcement layer of the opifex-owned PersonaSpec
authority. Validation applies deterministic rules and produces a structured
validation report.

Admission notes:
- required PersonaSpec fields at the canonical boundary are ``id``,
  ``description``, ``prompt``, ``model``, ``capabilities``, and
  ``spec_version``
- ``tools`` and ``side_effect_policy`` are forbidden at the canonical
  admission boundary and belong in rejection errors, not deprecation warnings
- unknown top-level fields are forbidden at the canonical admission boundary
- ``contracts/persona_spec.schema.json`` is reference-only while present and
  must not own independent acceptance semantics

Files that must stop widening the contract are ``larva.core.spec``,
``larva.core.validate``, ``larva.core.assemble``, and ``larva.app.facade``.

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

_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_PROMPT_VARIABLE_PATTERN = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")

_JSON_SAFE_TYPES = (str, int, float, bool, type(None), list, dict)

# Valid postures for capabilities/tools (from ToolPosture in spec.py)
_VALID_POSTURES: set[str] = {"none", "read_only", "read_write", "destructive"}

_CANONICAL_REQUIRED_FIELDS: set[str] = {
    "id",
    "description",
    "prompt",
    "model",
    "capabilities",
    "spec_version",
}

_CANONICAL_ALLOWED_FIELDS: set[str] = _CANONICAL_REQUIRED_FIELDS | {
    "model_params",
    "can_spawn",
    "compaction_prompt",
    "spec_digest",
    "variables",
}

_CANONICAL_FORBIDDEN_FIELDS: set[str] = {"tools", "side_effect_policy"}


@post(lambda result: isinstance(result, bool))
def _is_json_safe_dict(d: object) -> bool:
    """Check that a dict contains only JSON-serializable value types.

    >>> _is_json_safe_dict({"a": 1, "b": "c"})
    True
    >>> _is_json_safe_dict({"a": [1, 2]})
    True
    >>> _is_json_safe_dict("not a dict")
    False
    >>> class AttrDict(dict):
    ...     def values(self):
    ...         raise KeyError("__ch_pytype__")
    >>> _is_json_safe_dict(AttrDict(a=1))
    False
    """
    if not isinstance(d, dict):
        return False
    try:
        values = d.values()
    except Exception:
        return False
    return all(isinstance(v, _JSON_SAFE_TYPES) for v in values)


class ValidationIssue(TypedDict):
    """Single structured validation issue for a PersonaSpec candidate.

    Fields:
        code: Machine-readable issue code (e.g., "INVALID_SPEC_VERSION")
        message: Human-readable issue message
        details: Extra context for machine handling and diagnostics

    Error-shape expectation:
        Validation issues are the fine-grained error vocabulary emitted by the
        canonical validator. Facade-level surfaces may wrap these into
        ``PERSONA_INVALID``, but they must preserve the underlying report in
        error details for reviewable mapping.
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

    Admission-success invariant:
        If ``valid`` is ``True`` for a spec accepted through larva production
        paths, that success must mean the candidate conforms to the opifex
        canonical PersonaSpec contract rather than a wider local larva shape.
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


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, list))
def _validate_identity_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate identity field values (id format, spec_version).

    Note: Required/forbidden field validation is delegated to separate functions.
    This function validates field content, not field presence.

    Args:
        spec: A PersonaSpec candidate to validate.

    Returns:
        List of validation errors for field value issues.
    """
    errors: list[ValidationIssue] = []

    persona_id = spec.get("id")
    if persona_id is not None and (
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

    return errors


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, dict) and "errors" in result and "warnings" in result)
def _validate_prompt_variables(spec: dict[str, object]) -> dict[str, object]:
    errors: list[ValidationIssue] = []
    warnings: list[str] = []

    prompt_obj = spec.get("prompt")
    if prompt_obj is None:
        return {"errors": errors, "warnings": warnings}

    if not isinstance(prompt_obj, str):
        errors.append(
            _issue(
                "INVALID_PROMPT",
                "prompt must be a string",
                {"field": "prompt", "value": prompt_obj},
            )
        )
        return {"errors": errors, "warnings": warnings}
    # Variable checking: only run when `variables` is explicitly provided.
    # Prompts commonly contain literal {braces} (code examples, templates)
    # that are NOT variable placeholders. Without explicit `variables`,
    # these should not be flagged as errors.
    provided_vars_obj = spec.get("variables")
    if provided_vars_obj is not None and isinstance(provided_vars_obj, dict):
        provided_vars: dict[str, str] = {}
        try:
            for key, value in provided_vars_obj.items():
                if isinstance(key, str) and isinstance(value, str):
                    provided_vars[key] = value
        except KeyError:
            provided_vars = {}

        found_vars = set(_PROMPT_VARIABLE_PATTERN.findall(prompt_obj))

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


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, list))
def _validate_capabilities(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate canonical capabilities field.

    Contract (from INTERFACES.md):
    - capabilities is the canonical capability declaration surface
    - tools and side_effect_policy are rejected at canonical admission

    Validation rules:
    - capabilities is required
    - capabilities must be dict[str, str]
    - capability values must be valid ToolPosture values

    Args:
        spec: A PersonaSpec candidate to validate.

    Returns:
        List of validation errors (warnings are added to parent warnings list).

    >>> _validate_capabilities({"id": "test"})
    []
    >>> _validate_capabilities({"id": "test", "capabilities": {"git": "read_only"}})
    []
    >>> _validate_capabilities({"id": "test", "capabilities": {"git": "invalid"}})[0]["code"]
    'INVALID_CAPABILITY_POSTURE'
    >>> _validate_capabilities({"id": "test", "capabilities": "not-a-dict"})[0]["code"]
    'INVALID_CAPABILITIES_TYPE'
    """
    errors: list[ValidationIssue] = []

    # Validate capabilities field
    capabilities = spec.get("capabilities")
    if capabilities is None:
        return errors

    if not isinstance(capabilities, dict):
        errors.append(
            _issue(
                "INVALID_CAPABILITIES_TYPE",
                "capabilities must be a dict mapping tool names to postures",
                {"field": "capabilities", "value": capabilities},
            )
        )
        return errors

    for tool_name, posture in capabilities.items():
        if not isinstance(posture, str) or posture not in _VALID_POSTURES:
            errors.append(
                _issue(
                    "INVALID_CAPABILITY_POSTURE",
                    f"capability posture must be one of {', '.join(sorted(_VALID_POSTURES))}",
                    {"field": "capabilities", "tool": tool_name, "value": posture},
                )
            )

    return errors


@pre(lambda spec: all(isinstance(key, str) for key in spec))
@post(lambda result: isinstance(result, list))
def _validate_forbidden_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Reject forbidden fields at canonical admission boundary.

    Contract (from INTERFACES.md, narrowed by opifex authority):
    - ``tools`` is forbidden at canonical admission boundary
    - ``side_effect_policy`` is forbidden at canonical admission boundary
    - unknown top-level fields are forbidden at canonical admission boundary

    These are rejection errors, not deprecation warnings.

    Args:
        spec: A PersonaSpec candidate to validate.

    Returns:
        List of validation errors for forbidden fields.

    >>> _validate_forbidden_fields({"id": "test"})
    []
    >>> _validate_forbidden_fields({"id": "test", "tools": {"git": "read_only"}})[0]["code"]
    'FORBIDDEN_EXTRA_FIELD'
    >>> _validate_forbidden_fields({"id": "test", "side_effect_policy": "allow"})[0]["code"]
    'FORBIDDEN_EXTRA_FIELD'
    >>> _validate_forbidden_fields({"id": "test", "unknown_field": "value"})[0]["code"]
    'FORBIDDEN_EXTRA_FIELD'
    """
    errors: list[ValidationIssue] = []

    for key in spec:
        if key in _CANONICAL_FORBIDDEN_FIELDS:
            errors.append(
                _issue(
                    "FORBIDDEN_EXTRA_FIELD",
                    f"'{key}' is not permitted at canonical admission boundary",
                    {"field": key, "value": spec.get(key)},
                )
            )
        elif key not in _CANONICAL_ALLOWED_FIELDS:
            errors.append(
                _issue(
                    "FORBIDDEN_EXTRA_FIELD",
                    f"unknown top-level field '{key}' is not permitted at canonical admission boundary",
                    {"field": key, "value": spec.get(key)},
                )
            )

    return errors


@pre(lambda spec: all(isinstance(key, str) for key in spec))
@post(lambda result: isinstance(result, list))
def _validate_required_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate that required canonical fields are present.

    Contract (from INTERFACES.md, narrowed by opifex authority):
    - ``capabilities`` is required at canonical admission boundary

    Args:
        spec: A PersonaSpec candidate to validate.

    Returns:
        List of validation errors for missing required fields.

    >>> _validate_required_fields({"id": "test", "description": "Test", "prompt": "Help", "model": "gpt-4o", "capabilities": {"git": "read_only"}, "spec_version": "0.1.0"})
    []
    >>> _validate_required_fields({"id": "test"})[0]["code"]
    'MISSING_REQUIRED_FIELD'
    """
    errors: list[ValidationIssue] = []

    for field in _CANONICAL_REQUIRED_FIELDS:
        if field not in spec:
            errors.append(
                _issue(
                    "MISSING_REQUIRED_FIELD",
                    f"required field '{field}' is missing at canonical admission boundary",
                    {"field": field},
                )
            )

    return errors


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: "valid" in result and "errors" in result and "warnings" in result)
def validate_spec(spec: dict[str, object]) -> ValidationReport:
    """Validate a PersonaSpec candidate and return structured results.

        Contract (from INTERFACES.md, narrowed by the opifex authority basis):
        - validates field types and allowed values for the canonical PersonaSpec
          contract
        - produces structured errors with code, message, and details
        - facade mapping may collapse report failures to ``PERSONA_INVALID`` but
          must preserve the report in error details
        - ``tools``, ``side_effect_policy``, and unknown top-level fields are
          rejection cases at canonical admission, not admissible deprecated inputs

        Args:
            spec: A PersonaSpec candidate to validate.

        Returns:
            ValidationReport with valid=True/False, errors list, and warnings list.

        Note:
            This implementation handles:
            - Type validation for all fields
            - Allowed value validation for canonical fields
            - Field-specific validation rules
            - Deterministic, pure validation (no I/O side effects)

            Canonical authority remains external to this module. While the
            repo-local schema artifact exists, it is reference-only and may not be
            treated as an independent owner of requiredness, field removal, or
            extra-field policy.

        Acceptance:
            @pre(lambda spec: _is_json_safe_dict(spec))
            @post(
                lambda result: (
                    isinstance(result, dict)
                    and "valid" in result
                    and "errors" in result
                    and "warnings" in result
                )
            )

    Examples:
        >>> validate_spec({"id": "code-reviewer", "description": "Reviews code", "prompt": "You review code", "model": "gpt-4o-mini", "capabilities": {"shell": "read_only"}, "spec_version": "0.1.0"})["valid"]
        True
        >>> validate_spec({"spec_version": "0.1.0"})["errors"][0]["code"]
        'MISSING_REQUIRED_FIELD'
    """
    errors = _validate_identity_fields(spec)
    variable_result = _validate_prompt_variables(spec)
    errors.extend(cast("list[ValidationIssue]", variable_result["errors"]))
    warnings = cast("list[str]", variable_result["warnings"])

    # Validate capabilities field
    capabilities_errors = _validate_capabilities(spec)
    errors.extend(capabilities_errors)

    # Validate canonical admission requirements (forbidden fields, required fields)
    forbidden_errors = _validate_forbidden_fields(spec)
    errors.extend(forbidden_errors)

    required_errors = _validate_required_fields(spec)
    errors.extend(required_errors)

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }
