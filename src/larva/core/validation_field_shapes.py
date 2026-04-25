"""Field-shape validation helpers for canonical PersonaSpec admission."""

from __future__ import annotations

import math

from deal import post, pre

from larva.core.validation_contract import ValidationIssue, validation_issue

_REQUIRED_STRING_TYPE_FIELDS: tuple[str, ...] = ("description", "model")
_OPTIONAL_STRING_TYPE_FIELDS: tuple[str, ...] = ("compaction_prompt", "spec_digest")
_NUMBER_MODEL_PARAMS: dict[str, tuple[float, float]] = {
    "temperature": (0.0, 2.0),
    "top_p": (0.0, 1.0),
}
_INTEGER_MODEL_PARAMS: dict[str, int] = {
    "top_k": 1,
    "max_tokens": 1,
}


@pre(
    lambda code, message, details: isinstance(code, str)
    and code != ""
    and isinstance(message, str)
    and message != ""
    and isinstance(details, dict)
)
@post(
    lambda result: isinstance(result, dict)
    and isinstance(result.get("code"), str)
    and isinstance(result.get("message"), str)
    and isinstance(result.get("details"), dict)
)
def _issue(code: str, message: str, details: dict[str, object]) -> ValidationIssue:
    """Local alias delegating to the canonical helper.

    >>> _issue("INVALID_FIELD_TYPE", "bad", {"field": "model"})["code"]
    'INVALID_FIELD_TYPE'
    """
    return validation_issue(code, message, details)


@pre(lambda value: value is not None)
@post(lambda result: isinstance(result, bool))
def _is_finite_number(value: object) -> bool:
    """Return True for finite JSON-style numbers excluding booleans.

    >>> _is_finite_number(0.7)
    True
    >>> _is_finite_number(True)
    False
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


@pre(
    lambda spec, field, required=False: isinstance(spec, dict)
    and isinstance(field, str)
    and field != ""
    and isinstance(required, bool)
)
@post(lambda result: isinstance(result, list) and all(isinstance(item, dict) for item in result))
def _validate_string_field_type(
    spec: dict[str, object],
    field: str,
    required: bool = False,
) -> list[ValidationIssue]:
    """Reject non-string values for canonical string fields.

    >>> _validate_string_field_type({"description": "ok"}, "description", required=True)
    []
    >>> _validate_string_field_type({"compaction_prompt": []}, "compaction_prompt", required=False)[0]["details"]["field"]
    'compaction_prompt'
    """
    if field not in spec:
        return []
    value = spec.get(field)
    if isinstance(value, str):
        return []

    suffix = "" if required else " when present"
    return [
        _issue(
            "INVALID_FIELD_TYPE",
            f"{field} must be a string{suffix}",
            {"field": field, "value": value},
        )
    ]


@pre(lambda value=None: value is not Ellipsis)
@post(
    lambda result: isinstance(result, dict)
    and result.get("code") == "INVALID_MODEL_PARAMS"
    and isinstance(result.get("details"), dict)
)
def _model_params_shape_issue(value: object) -> ValidationIssue:
    """Build the canonical shape error for model_params.

    >>> _model_params_shape_issue("bad")["details"]["field"]
    'model_params'
    """
    return _issue(
        "INVALID_MODEL_PARAMS",
        "model_params must be an object when present",
        {"field": "model_params", "value": value},
    )


@pre(lambda key, value=None: isinstance(key, str) and value is not Ellipsis)
@post(lambda result: result is None or isinstance(result, dict))
def _validate_number_model_param(key: str, value: object) -> ValidationIssue | None:
    """Validate canonical numeric model_params entries.

    >>> _validate_number_model_param("temperature", 0.7) is None
    True
    >>> _validate_number_model_param("temperature", "hot")["code"]
    'INVALID_MODEL_PARAMS'
    """
    if key not in _NUMBER_MODEL_PARAMS:
        return None
    minimum, maximum = _NUMBER_MODEL_PARAMS[key]
    if _is_finite_number(value) and value >= minimum and value <= maximum:
        return None
    return _issue(
        "INVALID_MODEL_PARAMS",
        f"model_params.{key} must be a finite number between {minimum:g} and {maximum:g}",
        {"field": f"model_params.{key}", "value": value},
    )


@pre(lambda key, value=None: isinstance(key, str) and value is not Ellipsis)
@post(lambda result: result is None or isinstance(result, dict))
def _validate_integer_model_param(key: str, value: object) -> ValidationIssue | None:
    """Validate canonical integer model_params entries.

    >>> _validate_integer_model_param("top_k", 10) is None
    True
    >>> _validate_integer_model_param("top_k", 0)["details"]["field"]
    'model_params.top_k'
    """
    if key not in _INTEGER_MODEL_PARAMS:
        return None
    minimum = _INTEGER_MODEL_PARAMS[key]
    if isinstance(value, int) and not isinstance(value, bool) and value >= minimum:
        return None
    return _issue(
        "INVALID_MODEL_PARAMS",
        f"model_params.{key} must be an integer greater than or equal to {minimum}",
        {"field": f"model_params.{key}", "value": value},
    )


@pre(lambda spec: isinstance(spec, dict) and all(isinstance(key, str) for key in spec))
@post(lambda result: isinstance(result, list) and all(isinstance(item, dict) for item in result))
def _validate_model_params(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate canonical model_params typing and common schema-supported fields.

    >>> _validate_model_params({"model_params": {"temperature": 0.7}})
    []
    >>> _validate_model_params({"model_params": "bad"})[0]["code"]
    'INVALID_MODEL_PARAMS'
    >>> _validate_model_params({"model_params": {"top_k": 0}})[0]["details"]["field"]
    'model_params.top_k'
    """
    if "model_params" not in spec:
        return []

    model_params = spec.get("model_params")
    if not isinstance(model_params, dict):
        return [_model_params_shape_issue(model_params)]

    try:
        items = list(model_params.items())
    except Exception:
        return [_model_params_shape_issue(model_params)]

    issues: list[ValidationIssue] = []
    for key, value in items:
        if not isinstance(key, str):
            issues.append(
                _issue(
                    "INVALID_MODEL_PARAMS",
                    "model_params keys must be strings",
                    {"field": "model_params", "key": key},
                )
            )
            continue
        number_issue = _validate_number_model_param(key, value)
        if number_issue is not None:
            issues.append(number_issue)
            continue
        integer_issue = _validate_integer_model_param(key, value)
        if integer_issue is not None:
            issues.append(integer_issue)
    return issues


@pre(lambda spec: isinstance(spec, dict) and all(isinstance(key, str) for key in spec))
@post(lambda result: result is None or isinstance(result, list))
def _validate_prompt_string_shape(spec: dict[str, object]) -> list[ValidationIssue] | None:
    """Validate prompt field string type when present.

    >>> _validate_prompt_string_shape({"prompt": 123})[0]["code"]
    'INVALID_FIELD_TYPE'
    >>> _validate_prompt_string_shape({"prompt": "hello"}) is None
    True
    >>> _validate_prompt_string_shape({}) is None
    True
    """
    if "prompt" not in spec:
        return None
    prompt = spec.get("prompt")
    if isinstance(prompt, str):
        return None
    return [
        _issue(
            "INVALID_FIELD_TYPE",
            "prompt must be a string when present",
            {"field": "prompt", "value": prompt},
        )
    ]


@pre(lambda spec: isinstance(spec, dict) and all(isinstance(key, str) for key in spec))
@post(lambda result: isinstance(result, list) and all(isinstance(item, dict) for item in result))
def validate_field_shapes(spec: dict[str, object]) -> list[ValidationIssue]:
    """Validate canonical field shapes beyond required-field presence.

    >>> validate_field_shapes({"description": 1, "model": "gpt-4o-mini"})[0]["code"]
    'INVALID_FIELD_TYPE'
    >>> validate_field_shapes({"model_params": {"temperature": 0.2}, "compaction_prompt": "ok"})
    []
    >>> validate_field_shapes({"prompt": "Use {{literal}} braces."})
    []
    >>> validate_field_shapes({"prompt": "You are {role}."})
    []
    """
    issues: list[ValidationIssue] = []
    for field in _REQUIRED_STRING_TYPE_FIELDS:
        issues.extend(_validate_string_field_type(spec, field, required=True))
    for field in _OPTIONAL_STRING_TYPE_FIELDS:
        issues.extend(_validate_string_field_type(spec, field, required=False))
    issues.extend(_validate_model_params(spec))
    prompt_issues = _validate_prompt_string_shape(spec)
    if prompt_issues is not None:
        issues.extend(prompt_issues)
    return issues
