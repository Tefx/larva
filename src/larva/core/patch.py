"""Pure patch application logic for PersonaSpec overrides.

Examples:
    Scalar overwrite:
    >>> apply_patches({"model": "gpt-4", "spec_digest": "old"}, {"model": "gpt-5"})
    {'model': 'gpt-5'}

    Protected stripping:
    >>> apply_patches({"id": "base-id", "x": 1}, {"id": "patch-id", "x": 2})
    {'id': 'base-id', 'x': 2}
    >>> apply_patches({"spec_version": "0.1.0"}, {"spec_version": "9.9.9", "x": 1})
    {'spec_version': '0.1.0', 'x': 1}

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

from typing import TypeGuard

from deal import post, pre

PROTECTED_KEYS = frozenset({"id", "spec_digest", "spec_version"})
DEEP_MERGE_KEYS = frozenset({"model_params", "capabilities"})
DOT_KEY_SEPARATOR = "."


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


@post(lambda result: isinstance(result, dict))
@pre(lambda patches: all(isinstance(key, str) for key in patches))
def _strip_protected_keys(patches: dict[str, object]) -> dict[str, object]:
    """Remove protected keys from incoming patches.

    Args:
        patches: Runtime override mapping.

    Returns:
        Patch mapping without protected top-level keys or protected dot-path roots.
    """
    stripped: dict[str, object] = {}
    for key, value in patches.items():
        if not isinstance(key, str):
            continue
        if key.split(DOT_KEY_SEPARATOR, 1)[0] in PROTECTED_KEYS:
            continue
        stripped[key] = _copy_dict(value) if _is_str_dict(value) else value
    return stripped


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
        >>> apply_patches({"spec_version": "0.1.0"}, {"spec_version": "9.9.9", "x": 1})
        {'spec_version': '0.1.0', 'x': 1}
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
    """
    sanitized = _strip_protected_keys(patches)
    expanded = _expand_dot_keys(sanitized)

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
    "PROTECTED_KEYS",
    "apply_patches",
]
