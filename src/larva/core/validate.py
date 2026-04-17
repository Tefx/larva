"""Canonical PersonaSpec validation.

Owns larva's admission metadata seam and enforces fail-closed canonical rules
for required fields, extra fields, prompt composition, capabilities, and
spawn semantics.

Validation report semantics:
- ``errors`` block admission (``valid == False``)
- ``warnings`` are non-blocking canonical guidance signals (``valid`` may stay
  ``True``)
"""

import re

from deal import post, pre
from larva.core.validation_contract import (
    CANONICAL_CAPABILITIES_REQUIRED_CLAUSE,
    CANONICAL_CONTRACT_METADATA,
    CANONICAL_FORBIDDEN_FIELDS,
    CANONICAL_FORBIDDEN_FIELD_MESSAGE,
    CANONICAL_OPTIONAL_FIELDS,
    CANONICAL_REQUIRED_FIELDS,
    CANONICAL_REQUIRED_FIELD_MESSAGE,
    CANONICAL_TOOLS_REJECTED_CLAUSE,
    CANONICAL_UNKNOWN_FIELD_MESSAGE,
    VALIDATION_ISSUE_KEYS,
    VALIDATION_REPORT_KEYS,
    ValidationIssue,
    ValidationReport,
)
from larva.core.validation_warnings import collect_non_blocking_warnings

_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_PROMPT_PLACEHOLDER_PATTERN = re.compile(r"(?<!\{)\{([a-zA-Z_][a-zA-Z0-9_.-]*)\}(?!\})")

_JSON_SAFE_TYPES = (str, int, float, bool, type(None), list, dict)

# Valid postures for capabilities/tools (from ToolPosture in spec.py)
_VALID_POSTURES: set[str] = {"none", "read_only", "read_write", "destructive"}
_REQUIRED_STRING_FIELDS: tuple[str, ...] = ("id", "description", "prompt", "model", "spec_version")
_MAX_CAN_SPAWN_TARGETS = 100

_CANONICAL_REQUIRED_FIELDS: set[str] = set(CANONICAL_REQUIRED_FIELDS)
_CANONICAL_ALLOWED_FIELDS: set[str] = _CANONICAL_REQUIRED_FIELDS | set(CANONICAL_OPTIONAL_FIELDS)
_CANONICAL_FORBIDDEN_FIELDS: set[str] = set(CANONICAL_FORBIDDEN_FIELDS)


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


@pre(
    lambda code, message, details: len(code) > 0 and len(message) > 0 and isinstance(details, dict)
)
@post(lambda result: "code" in result and "message" in result and "details" in result)
def _issue(code: str, message: str, details: dict[str, object]) -> ValidationIssue:
    return {"code": code, "message": message, "details": details}


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, list))
def _validate_identity_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate id format and spec_version value."""
    errors: list[ValidationIssue] = []

    persona_id = spec.get("id")
    if (
        persona_id is not None
        and not (isinstance(persona_id, str) and persona_id.strip() == "")
        and (not isinstance(persona_id, str) or not _PERSONA_ID_PATTERN.fullmatch(persona_id))
    ):
        errors.append(
            _issue(
                "INVALID_ID_FORMAT",
                "id must match canonical kebab-case syntax ^[a-z0-9]+(-[a-z0-9]+)*$",
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
@post(lambda result: isinstance(result, list))
def _validate_required_string_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate whitespace-only required string fields.

    >>> _validate_required_string_fields({"id": " ", "description": "ok", "prompt": "ok", "model": "ok", "spec_version": "0.1.0"})[0]["code"]
    'EMPTY_REQUIRED_FIELD'
    >>> _validate_required_string_fields({"description": "ok"})
    []
    """
    errors: list[ValidationIssue] = []

    for field in _REQUIRED_STRING_FIELDS:
        value = spec.get(field)
        if isinstance(value, str) and value.strip() == "":
            errors.append(
                _issue(
                    "EMPTY_REQUIRED_FIELD",
                    f"required string field '{field}' must not be empty or whitespace-only",
                    {"field": field, "value": value},
                )
            )

    return errors


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, list))
def _validate_prompt_semantics(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate canonical prompt semantics.

    >>> _validate_prompt_semantics({"prompt": "You are {role}."})[0]["code"]
    'UNRESOLVED_PLACEHOLDER'
    >>> _validate_prompt_semantics({"prompt": "Use {{literal}} braces."})
    []
    """
    errors: list[ValidationIssue] = []

    prompt_obj = spec.get("prompt")
    if prompt_obj is None:
        return errors

    if not isinstance(prompt_obj, str):
        errors.append(
            _issue(
                "INVALID_PROMPT",
                "prompt must be a string",
                {"field": "prompt", "value": prompt_obj},
            )
        )
        return errors

    placeholders = sorted(set(_PROMPT_PLACEHOLDER_PATTERN.findall(prompt_obj)))
    if placeholders:
        errors.append(
            _issue(
                "UNRESOLVED_PLACEHOLDER",
                "prompt contains unresolved placeholders and must be fully composed before admission",
                {"field": "prompt", "placeholders": placeholders},
            )
        )

    return errors


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, list))
def _validate_capabilities(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate canonical capabilities field.

    >>> _validate_capabilities({"id": "test", "capabilities": {"git": "invalid"}})[0]["code"]
    'INVALID_POSTURE'
    >>> _validate_capabilities({"id": "test", "capabilities": "not-a-dict"})[0]["code"]
    'INVALID_CAPABILITIES_SHAPE'
    """
    errors: list[ValidationIssue] = []

    capabilities = spec.get("capabilities")
    if capabilities is None:
        return errors

    if not isinstance(capabilities, dict):
        errors.append(
            _issue(
                "INVALID_CAPABILITIES_SHAPE",
                "capabilities must be a dict mapping tool-family names to posture values",
                {"field": "capabilities", "value": capabilities},
            )
        )
        return errors

    for tool_name, posture in capabilities.items():
        if not isinstance(tool_name, str):
            errors.append(
                _issue(
                    "INVALID_CAPABILITIES_SHAPE",
                    "capabilities keys must be strings",
                    {"field": "capabilities", "tool": tool_name},
                )
            )
            continue

        if not isinstance(posture, str) or posture not in _VALID_POSTURES:
            errors.append(
                _issue(
                    "INVALID_POSTURE",
                    f"capability posture must be one of {', '.join(sorted(_VALID_POSTURES))}",
                    {"field": "capabilities", "tool": tool_name, "value": posture},
                )
            )

    return errors


@pre(lambda spec: all(isinstance(key, str) for key in spec))
@post(lambda result: isinstance(result, list))
def _validate_forbidden_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Reject forbidden and unknown top-level fields.

    >>> _validate_forbidden_fields({"id": "test", "tools": {"git": "read_only"}})[0]["code"]
    'EXTRA_FIELD_NOT_ALLOWED'
    """
    errors: list[ValidationIssue] = []

    for key in spec:
        if key in _CANONICAL_FORBIDDEN_FIELDS:
            errors.append(
                _issue(
                    "EXTRA_FIELD_NOT_ALLOWED",
                    CANONICAL_FORBIDDEN_FIELD_MESSAGE.format(field=key),
                    {"field": key, "value": spec.get(key)},
                )
            )
        elif key not in _CANONICAL_ALLOWED_FIELDS:
            errors.append(
                _issue(
                    "EXTRA_FIELD_NOT_ALLOWED",
                    CANONICAL_UNKNOWN_FIELD_MESSAGE.format(field=key),
                    {"field": key, "value": spec.get(key)},
                )
            )

    return errors


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, list))
def _validate_can_spawn(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate canonical can_spawn semantics.

    >>> _validate_can_spawn({"can_spawn": ["alpha", "beta"]})
    []
    >>> _validate_can_spawn({"can_spawn": [""]})[0]["code"]
    'INVALID_CAN_SPAWN'
    """
    can_spawn = spec.get("can_spawn")
    if can_spawn is None or isinstance(can_spawn, bool):
        return []

    if not isinstance(can_spawn, list):
        return [
            _issue(
                "INVALID_CAN_SPAWN",
                "can_spawn must be false, true, or a list of canonical persona ids",
                {"field": "can_spawn", "value": can_spawn},
            )
        ]

    if len(can_spawn) > _MAX_CAN_SPAWN_TARGETS:
        return [
            _issue(
                "INVALID_CAN_SPAWN",
                f"can_spawn list must contain at most {_MAX_CAN_SPAWN_TARGETS} persona ids",
                {"field": "can_spawn", "count": len(can_spawn)},
            )
        ]

    seen: set[str] = set()
    invalid_targets: list[object] = []
    duplicates: list[str] = []
    for target in can_spawn:
        if not isinstance(target, str) or target.strip() == "":
            invalid_targets.append(target)
            continue
        if not _PERSONA_ID_PATTERN.fullmatch(target):
            invalid_targets.append(target)
            continue
        if target in seen:
            duplicates.append(target)
            continue
        seen.add(target)

    if invalid_targets or duplicates:
        return [
            _issue(
                "INVALID_CAN_SPAWN",
                "can_spawn list members must be unique non-empty canonical persona ids",
                {
                    "field": "can_spawn",
                    "invalid_targets": invalid_targets,
                    "duplicate_targets": sorted(set(duplicates)),
                },
            )
        ]

    return []


@pre(lambda spec: all(isinstance(key, str) for key in spec))
@post(lambda result: isinstance(result, list))
def _validate_required_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate presence of required canonical fields.

    >>> _validate_required_fields({"id": "test"})[0]["code"]
    'MISSING_REQUIRED_FIELD'
    """
    errors: list[ValidationIssue] = []

    for field in _CANONICAL_REQUIRED_FIELDS:
        if field not in spec:
            errors.append(
                _issue(
                    "MISSING_REQUIRED_FIELD",
                    CANONICAL_REQUIRED_FIELD_MESSAGE.format(field=field),
                    {"field": field},
                )
            )

    return errors


@pre(
    lambda spec, registry_persona_ids=None: _is_json_safe_dict(spec)
    and (registry_persona_ids is None or isinstance(registry_persona_ids, frozenset))
)
@post(lambda result: "valid" in result and "errors" in result and "warnings" in result)
def validate_spec(
    spec: dict[str, object],
    registry_persona_ids: frozenset[str] | None = None,
) -> ValidationReport:
    """Validate a PersonaSpec candidate.

    >>> validate_spec({
    ...     "id": "code-reviewer",
    ...     "description": "Reviews code",
    ...     "prompt": "You review code",
    ...     "model": "gpt-4o-mini",
    ...     "capabilities": {"shell": "read_only"},
    ...     "spec_version": "0.1.0",
    ... })["valid"]
    True
    >>> validate_spec({"spec_version": "0.1.0"})["errors"][0]["code"]
    'MISSING_REQUIRED_FIELD'
    >>> validate_spec({
    ...     "id": "spawn-check",
    ...     "description": "Coordinates child personas with explicit scope.",
    ...     "prompt": "Keep work bounded.",
    ...     "model": "gpt-4o-mini",
    ...     "capabilities": {"shell": "read_only"},
    ...     "can_spawn": ["known-child", "missing-child"],
    ...     "spec_version": "0.1.0",
    ... }, frozenset({"known-child"}))["warnings"][-1]
    'can_spawn references ids outside the current registry snapshot: missing-child'
    """
    errors = _validate_identity_fields(spec)
    errors.extend(_validate_required_string_fields(spec))
    errors.extend(_validate_prompt_semantics(spec))

    capabilities_errors = _validate_capabilities(spec)
    errors.extend(capabilities_errors)
    errors.extend(_validate_can_spawn(spec))

    forbidden_errors = _validate_forbidden_fields(spec)
    errors.extend(forbidden_errors)

    required_errors = _validate_required_fields(spec)
    errors.extend(required_errors)

    warnings = collect_non_blocking_warnings(spec, registry_persona_ids)

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
    }
