"""Canonical PersonaSpec validation.

Errors block admission; warnings stay non-blocking.
"""

import re
from typing import cast

from deal import post, pre, raises

from larva.core._structured_error import _build_structured_exception
from larva.core.validation_contract import (
    CANONICAL_CAPABILITIES_REQUIRED_CLAUSE,  # noqa: F401 # public re-export
    CANONICAL_CONTRACT_METADATA,  # noqa: F401 # public re-export
    CANONICAL_FORBIDDEN_FIELD_MESSAGE,
    CANONICAL_FORBIDDEN_FIELDS,
    CANONICAL_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE,  # noqa: F401 # public re-export
    CANONICAL_OPTIONAL_FIELDS,
    CANONICAL_REQUIRED_FIELD_MESSAGE,
    CANONICAL_REQUIRED_FIELDS,
    CANONICAL_TOOLS_REJECTED_CLAUSE,  # noqa: F401 # public re-export
    CANONICAL_UNKNOWN_FIELD_MESSAGE,
    VALIDATION_ISSUE_KEYS,  # noqa: F401 # public re-export
    VALIDATION_REPORT_KEYS,  # noqa: F401 # public re-export
    ValidationIssue,
    ValidationReport,
    validation_issue,
)
from larva.core.validation_field_shapes import validate_field_shapes
from larva.core.validation_warnings import collect_non_blocking_warnings

_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_VARIANT_NAME_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_VARIANT_NAME_MAX_LENGTH = 64

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
            validation_issue(
                "INVALID_ID_FORMAT",
                "id must match canonical kebab-case syntax ^[a-z0-9]+(-[a-z0-9]+)*$",
                {"field": "id", "value": persona_id},
            )
        )

    spec_version = spec.get("spec_version")
    if spec_version is not None and spec_version != "0.1.0":
        errors.append(
            validation_issue(
                "INVALID_SPEC_VERSION",
                "spec_version must be '0.1.0'",
                {"field": "spec_version", "value": spec_version},
            )
        )

    return errors


class VariantNameError(Exception):
    """Variant name validation failure."""

    code: str
    message: str
    details: dict[str, object]


@pre(
    lambda message, details=None: (
        isinstance(message, str)
        and len(message) > 0
        and (details is None or isinstance(details, dict))
    )
)
@post(
    lambda result: (
        isinstance(result, VariantNameError)
        and isinstance(result.code, str)
        and len(result.code) > 0
        and isinstance(result.message, str)
        and len(result.message) > 0
        and isinstance(result.details, dict)
    )
)
def _build_variant_name_error(
    message: str,
    details: dict[str, object] | None = None,
) -> VariantNameError:
    """Build a structured VariantNameError with INVALID_VARIANT_NAME code.

    >>> err = _build_variant_name_error("bad name", {"field": "variant"})
    >>> (err.code, err.details)
    ('INVALID_VARIANT_NAME', {'field': 'variant'})
    """
    return cast(
        "VariantNameError",
        _build_structured_exception(VariantNameError, "INVALID_VARIANT_NAME", message, details),
    )


@pre(lambda name: isinstance(name, str))
@post(lambda result: isinstance(result, str) and 0 < len(result) <= _VARIANT_NAME_MAX_LENGTH)
@raises(VariantNameError)
def validate_variant_name(name: str) -> str:
    """Validate a variant name against canonical slug rules.

    Variant names must match ``^[a-z0-9]+(-[a-z0-9]+)*$`` and be at most
    64 characters.  Empty names, path separators, uppercase letters,
    underscores, dots, ``..``, and names exceeding 64 characters are
    rejected with ``INVALID_VARIANT_NAME``.

    >>> validate_variant_name("default")
    'default'
    >>> validate_variant_name("tacit")
    'tacit'
    >>> validate_variant_name("code-reviewer")
    'code-reviewer'
    >>> validate_variant_name("a" * 64)  # exactly 64 chars is valid
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    >>> try:
    ...     validate_variant_name("a" * 65)
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    >>> try:
    ...     validate_variant_name("")
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    >>> try:
    ...     validate_variant_name("MyVariant")
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    >>> try:
    ...     validate_variant_name("my_variant")
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    >>> try:
    ...     validate_variant_name("my.variant")
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    >>> try:
    ...     validate_variant_name("a--b")
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    >>> try:
    ...     validate_variant_name("-leading")
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    >>> try:
    ...     validate_variant_name("trailing-")
    ... except VariantNameError as e:
    ...     e.code
    'INVALID_VARIANT_NAME'

    Args:
        name: Variant name candidate.

    Returns:
        The validated variant name string.

    Raises:
        VariantNameError: When the name violates the canonical slug rules.
    """
    if len(name) == 0 or len(name) > _VARIANT_NAME_MAX_LENGTH:
        reason = (
            "variant name must not be empty"
            if len(name) == 0
            else (
                f"variant name exceeds maximum length of {_VARIANT_NAME_MAX_LENGTH} "
                f"characters (got {len(name)})"
            )
        )
        raise _build_variant_name_error(
            reason,
            {"field": "variant", "value": name, "max_length": _VARIANT_NAME_MAX_LENGTH},
        )

    if not _VARIANT_NAME_PATTERN.fullmatch(name):
        raise _build_variant_name_error(
            f"variant name must match ^[a-z0-9]+(-[a-z0-9]+)*$, got '{name}'",
            {"field": "variant", "value": name},
        )

    return name


@pre(lambda spec: _is_json_safe_dict(spec))
@post(lambda result: isinstance(result, list))
def _validate_required_string_fields(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate whitespace-only required string fields.

    >>> spec = {"id": " ", "description": "ok", "prompt": "ok"}
    >>> spec.update({"model": "ok", "spec_version": "0.1.0"})
    >>> _validate_required_string_fields(spec)[0]["code"]
    'EMPTY_REQUIRED_FIELD'
    >>> _validate_required_string_fields({"description": "ok"})
    []
    """
    errors: list[ValidationIssue] = []

    for field in _REQUIRED_STRING_FIELDS:
        value = spec.get(field)
        if isinstance(value, str) and value.strip() == "":
            errors.append(
                validation_issue(
                    "EMPTY_REQUIRED_FIELD",
                    f"required string field '{field}' must not be empty or whitespace-only",
                    {"field": field, "value": value},
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
            validation_issue(
                "INVALID_CAPABILITIES_SHAPE",
                "capabilities must be a dict mapping tool-family names to posture values",
                {"field": "capabilities", "value": capabilities},
            )
        )
        return errors

    for tool_name, posture in capabilities.items():
        if not isinstance(tool_name, str):
            errors.append(
                validation_issue(
                    "INVALID_CAPABILITIES_SHAPE",
                    "capabilities keys must be strings",
                    {"field": "capabilities", "tool": tool_name},
                )
            )
            continue

        if not isinstance(posture, str) or posture not in _VALID_POSTURES:
            errors.append(
                validation_issue(
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
                validation_issue(
                    "EXTRA_FIELD_NOT_ALLOWED",
                    CANONICAL_FORBIDDEN_FIELD_MESSAGE.format(field=key),
                    {"field": key, "value": spec.get(key)},
                )
            )
        elif key not in _CANONICAL_ALLOWED_FIELDS:
            errors.append(
                validation_issue(
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
            validation_issue(
                "INVALID_CAN_SPAWN",
                "can_spawn must be false, true, or a list of canonical persona ids",
                {"field": "can_spawn", "value": can_spawn},
            )
        ]

    if len(can_spawn) > _MAX_CAN_SPAWN_TARGETS:
        return [
            validation_issue(
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
            validation_issue(
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
                validation_issue(
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
    errors.extend(validate_field_shapes(spec))

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
