"""Pure patch application logic for PersonaSpec overrides.

Examples:
    Scalar overwrite:
    >>> apply_patches({"model": "gpt-4", "spec_digest": "old"}, {"model": "gpt-5"})
    {'model': 'gpt-5'}

    Protected metadata rejection:
    >>> apply_patches(  # doctest: +ELLIPSIS
    ...     {"id": "base-id", "x": 1},
    ...     {"id": "patch-id", "x": 2},
    ... )
    Traceback (most recent call last):
    ...
    patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'id' is not permitted...
    >>> apply_patches(  # doctest: +ELLIPSIS
    ...     {"spec_version": "0.1.0"},
    ...     {"spec_version": "9.9.9", "x": 1},
    ... )
    Traceback (most recent call last):
    ...
    patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'spec_version' is not permitted...

    Deep merge (model_params):
    >>> apply_patches(
    ...     {"model_params": {"temperature": 0.2, "top_p": 0.9}},
    ...     {"model_params": {"temperature": 0.7}},
    ... )
    {'model_params': {'temperature': 0.7, 'top_p': 0.9}}

    Deep merge (capabilities):
    >>> apply_patches(
    ...     {"capabilities": {"code_edit": {"allowed": True}}},
    ...     {"capabilities": {"bash_tool": {"allowed": False}}},
    ... )
    {'capabilities': {'code_edit': {'allowed': True}, 'bash_tool': {'allowed': False}}}

    Dot-notation expansion:
    >>> apply_patches({"model_params": {"top_p": 0.95}}, {"model_params.temperature": 0.4})
    {'model_params': {'top_p': 0.95, 'temperature': 0.4}}
"""

from typing import Any, TypeGuard, cast

from deal import post, pre, raises

from larva.core._structured_error import _build_structured_exception

PROTECTED_KEYS = frozenset({"id", "spec_digest", "spec_version"})
DEEP_MERGE_KEYS = frozenset({"model_params", "capabilities"})
DOT_KEY_SEPARATOR = "."
FORBIDDEN_PATCH_FIELDS = frozenset({"tools", "side_effect_policy", "variables"})


class PatchError(Exception):
    """Patch contract failure."""

    code: str
    message: str
    details: dict[str, Any]


@pre(
    lambda code, message, details=None: (
        isinstance(code, str)
        and len(code) > 0
        and isinstance(message, str)
        and len(message) > 0
        and (details is None or isinstance(details, dict))
    )
)
@post(
    lambda result: (
        isinstance(result, PatchError)
        and isinstance(result.code, str)
        and len(result.code) > 0
        and isinstance(result.message, str)
        and len(result.message) > 0
        and isinstance(result.details, dict)
    )
)
def _patch_error(
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> PatchError:
    """Build a structured patch error.

    >>> err = _patch_error("FORBIDDEN_FIELD", "patch field is forbidden", {"field": "id"})
    >>> (err.code, err.message, err.details)
    ('FORBIDDEN_FIELD', 'patch field is forbidden', {'field': 'id'})
    """
    return cast("PatchError", _build_structured_exception(PatchError, code, message, details))


@post(lambda result: result is None)
@pre(lambda patches: all(isinstance(key, str) for key in patches))
@raises(PatchError)
def _reject_forbidden_patch_fields(patches: dict[str, object]) -> None:
    """Reject forbidden legacy patch roots before merge semantics.

    >>> _reject_forbidden_patch_fields({"prompt": "ok"})
    >>> _reject_forbidden_patch_fields(  # doctest: +ELLIPSIS
    ...     {"tools": {"shell": "read_only"}}
    ... )
    Traceback (most recent call last):
    ...
    patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'tools' is not permitted...
    >>> _reject_forbidden_patch_fields({"variables.role": "assistant"})  # doctest: +ELLIPSIS
    Traceback (most recent call last):
    ...
    patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'variables' is not permitted...
    """
    for key in patches:
        root = key.split(DOT_KEY_SEPARATOR, 1)[0]
        if root in FORBIDDEN_PATCH_FIELDS:
            raise _patch_error(
                code="FORBIDDEN_PATCH_FIELD",
                message=f"patch field '{root}' is not permitted at canonical update boundary",
                details={"field": root, "key": key},
            )


@post(lambda result: isinstance(result, bool))
def _is_str_dict(value: object) -> TypeGuard[dict[str, object]]:
    """Return True when value is a dictionary with string keys."""
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


@post(lambda result: isinstance(result, dict))
@pre(lambda mapping: all(isinstance(key, str) for key in mapping))
def _copy_dict(mapping: dict[str, object]) -> dict[str, object]:
    """Copy dictionary structure recursively.

    Args:
        mapping: Dictionary to copy.

    Returns:
        A new dictionary with recursively copied dictionary values.
    """
    copied: dict[str, object] = {}
    for key, value in mapping.items():
        if _is_str_dict(value):
            copied[key] = _copy_dict(value)
            continue
        copied[key] = value
    return copied


@post(lambda result: result is None)
@pre(lambda patches: all(isinstance(key, str) for key in patches))
@raises(PatchError)
def _reject_protected_patch_fields(patches: dict[str, object]) -> None:
    """Reject protected metadata keys from incoming patches.

    >>> _reject_protected_patch_fields({"prompt": "ok"})
    >>> _reject_protected_patch_fields({"spec_version": "9.9.9"})  # doctest: +ELLIPSIS
    Traceback (most recent call last):
    ...
    patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'spec_version' is not permitted...
    >>> _reject_protected_patch_fields(  # doctest: +ELLIPSIS
    ...     {"spec_digest.value": "sha256:bad"}
    ... )
    Traceback (most recent call last):
    ...
    patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'spec_digest' is not permitted...

    Args:
        patches: Runtime override mapping.
    """
    for key in patches:
        root = key.split(DOT_KEY_SEPARATOR, 1)[0]
        if root in PROTECTED_KEYS:
            raise _patch_error(
                code="FORBIDDEN_PATCH_FIELD",
                message=f"patch field '{root}' is not permitted at canonical update boundary",
                details={"field": root, "key": key},
            )


@post(lambda result: isinstance(result, dict))
@pre(
    lambda base, patch: (
        all(isinstance(key, str) for key in base) and all(isinstance(key, str) for key in patch)
    )
)
def _deep_merge_dicts(base: dict[str, object], patch: dict[str, object]) -> dict[str, object]:
    """Recursively merge ``patch`` into ``base``.

    Args:
        base: Existing mapping.
        patch: Incoming mapping.

    Returns:
        Deep-merged mapping where patch values take precedence.
    """
    merged: dict[str, object] = _copy_dict(base)
    for key, patch_value in patch.items():
        base_value = merged.get(key)
        if isinstance(base_value, dict) and isinstance(patch_value, dict):
            merged[key] = _deep_merge_dicts(base_value, patch_value)
            continue
        merged[key] = _copy_dict(patch_value) if _is_str_dict(patch_value) else patch_value
    return merged


@post(lambda result: isinstance(result, dict))
@pre(lambda patches: all(isinstance(key, str) for key in patches))
def _expand_dot_keys(patches: dict[str, object]) -> dict[str, object]:
    """Expand dot-notation patch keys into nested dictionaries.

    Args:
        patches: Runtime override mapping with optional dot-notation keys.

    Returns:
        Expanded mapping where ``a.b = value`` becomes ``{"a": {"b": value}}``.
    """
    expanded: dict[str, object] = {}
    for key, value in patches.items():
        if not isinstance(key, str):
            continue
        if DOT_KEY_SEPARATOR not in key:
            existing = expanded.get(key)
            if isinstance(existing, dict) and isinstance(value, dict):
                expanded[key] = _deep_merge_dicts(existing, value)
            else:
                expanded[key] = _copy_dict(value) if _is_str_dict(value) else value
            continue

        parts = [part for part in key.split(DOT_KEY_SEPARATOR) if part]
        if not parts:
            continue
        nested: object = _copy_dict(value) if _is_str_dict(value) else value
        for part in reversed(parts):
            nested = {part: nested}
        if not isinstance(nested, dict):
            continue
        top_key = parts[0]
        existing_top = expanded.get(top_key)
        nested_top = nested[top_key]
        if isinstance(existing_top, dict) and isinstance(nested_top, dict):
            expanded[top_key] = _deep_merge_dicts(existing_top, nested_top)
        else:
            expanded[top_key] = _copy_dict(nested_top) if _is_str_dict(nested_top) else nested_top
    return expanded


@pre(
    lambda spec, patches: (
        all(isinstance(key, str) for key in spec) and all(isinstance(key, str) for key in patches)
    )
)
@post(lambda result: isinstance(result, dict))
def apply_patches(spec: dict[str, object], patches: dict[str, object]) -> dict[str, object]:
    """Apply runtime patches to a spec using plan-defined merge semantics.

    Args:
        spec: Canonical base specification.
        patches: Runtime override mapping.

    Returns:
        New dictionary containing patched values.

    Examples:
        >>> apply_patches({"model": "gpt-4", "spec_digest": "old"}, {"model": "gpt-5"})
        {'model': 'gpt-5'}
        >>> apply_patches(  # doctest: +ELLIPSIS
        ...     {"spec_version": "0.1.0"},
        ...     {"spec_version": "9.9.9", "x": 1},
        ... )
        Traceback (most recent call last):
        ...
        patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'spec_version' is not permitted...
        >>> apply_patches(
        ...     {"model_params": {"temperature": 0.2, "top_p": 0.9}},
        ...     {"model_params": {"temperature": 0.7}},
        ... )
        {'model_params': {'temperature': 0.7, 'top_p': 0.9}}
        >>> apply_patches(
        ...     {"model_params": {"top_p": 0.95}},
        ...     {"model_params.temperature": 0.4},
        ... )
        {'model_params': {'top_p': 0.95, 'temperature': 0.4}}
        >>> apply_patches({"id": "p"}, {"tools": {"shell": "read_only"}})  # doctest: +ELLIPSIS
        Traceback (most recent call last):
        ...
        patch.PatchError: FORBIDDEN_PATCH_FIELD: patch field 'tools' is not permitted...
    """
    _reject_forbidden_patch_fields(patches)
    _reject_protected_patch_fields(patches)
    expanded = _expand_dot_keys(patches)

    result: dict[str, object] = _copy_dict(spec)
    for key, patch_value in expanded.items():
        current_value = result.get(key)
        if (
            key in DEEP_MERGE_KEYS
            and isinstance(current_value, dict)
            and isinstance(patch_value, dict)
        ):
            result[key] = _deep_merge_dicts(current_value, patch_value)
            continue
        if isinstance(patch_value, dict):
            result[key] = _copy_dict(patch_value)
            continue
        result[key] = patch_value

    result.pop("spec_digest", None)
    return result


__all__ = [
    "DEEP_MERGE_KEYS",
    "DOT_KEY_SEPARATOR",
    "FORBIDDEN_PATCH_FIELDS",
    "PatchError",
    "PROTECTED_KEYS",
    "apply_patches",
]
