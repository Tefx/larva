"""Contracted PersonaSpec assembly from in-memory components."""

import re
from typing import Any, Mapping, cast

from deal import post, pre, raises

from larva.core.assembly_error import AssemblyError, assembly_error
from larva.core.spec import ModelComponent, PersonaSpec, ToolPosture

_assembly_error = assembly_error
_VALID_TOOL_POSTURES = frozenset({"none", "read_only", "read_write", "destructive"})


_PROMPT_PLACEHOLDER_PATTERN = re.compile(r"(?<!\{)\{([a-zA-Z_][a-zA-Z0-9_.-]*)\}(?!\})")


@pre(lambda mapping: not isinstance(mapping, dict) or all(key is not None for key in mapping))
@post(
    lambda result: (
        isinstance(result, list)
        and all(isinstance(item, tuple) and len(item) == 2 for item in result)
    )
)
def _safe_items(mapping: Mapping[Any, Any]) -> list[tuple[Any, Any]]:
    """Return mapping items without propagating symbolic Mapping key errors.

    >>> _safe_items({"k": "v"})
    [('k', 'v')]
    >>> _safe_items({})
    []
    """
    if not isinstance(mapping, dict):
        return []
    try:
        return list(mapping.items())
    except (KeyError, TypeError, ValueError):
        return []


@pre(lambda data: all(isinstance(key, str) for key in data))
@post(lambda result: isinstance(result, bool))
def _has_scalar_conflicts(data: dict[str, object]) -> bool:
    """Return True when scalar assembly sources contain conflicting values."""
    constraints_obj = data.get("constraints", [])
    constraints = (
        [item for item in constraints_obj if isinstance(item, dict)]
        if isinstance(constraints_obj, list)
        else []
    )
    model = data.get("model")
    model_sources: list[dict[str, Any]] = []
    if isinstance(model, str):
        model_sources.append({"model": model})
    elif isinstance(model, dict):
        model_sources.append(cast("dict[str, Any]", model))

    sources = constraints + model_sources
    scalar_fields = ("model", "can_spawn", "compaction_prompt")
    for field in scalar_fields:
        values = [source.get(field) for source in sources if field in source]
        values = [value for value in values if value is not None]
        if len(values) > 1:
            first = values[0]
            if any(value != first for value in values):
                return True
    return False


@pre(
    lambda sources, field, allow_multiple=False: (
        isinstance(sources, list)
        and isinstance(field, str)
        and len(field) > 0
        and isinstance(allow_multiple, bool)
    )
)
@raises(AssemblyError)
def _collect_scalar(
    sources: list[dict[str, Any]],
    field: str,
    allow_multiple: bool = False,
) -> Any:
    """Collect a scalar field from multiple sources."""
    values = [source.get(field) for source in sources if field in source]
    values = [value for value in values if value is not None]

    if not values:
        return None

    if not allow_multiple and len(values) > 1:
        first = values[0]
        if any(value != first for value in values):
            raise assembly_error(
                code="COMPONENT_CONFLICT",
                message=f"Multiple sources provide different values for '{field}': {values}",
                details={"field": field, "values": values},
            )

    return values[0]


@pre(
    lambda toolsets: isinstance(toolsets, list) and all(isinstance(item, dict) for item in toolsets)
)
@raises(AssemblyError)
def _merge_capabilities(toolsets: list[dict[str, object]]) -> dict[str, str]:
    """Merge capabilities from multiple toolset components.

    Per ADR-002 canonical cutover:
    - Only 'capabilities' field is accepted (canonical)
    - 'tools' field is legacy content and NOT admissible
    - Missing 'capabilities' in a toolset raises AssemblyError

    >>> _merge_capabilities([{"capabilities": {"read": "read_only"}}])
    {'read': 'read_only'}
    >>> _merge_capabilities([])
    {}
    """
    merged: dict[str, str] = {}

    for toolset in toolsets:
        if "tools" in toolset:
            raise assembly_error(
                code="FORBIDDEN_TOOLSET_FIELD",
                message="toolset field 'tools' is not permitted at canonical assembly boundary",
                details={"field": "tools", "toolset": toolset},
            )

        if "capabilities" not in toolset:
            raise assembly_error(
                code="TOOLSET_MISSING_CAPABILITIES",
                message=(
                    "Toolset is missing 'capabilities' field. "
                    "Toolset tools content is not admissible at canonical cutover."
                ),
                details={"toolset": toolset},
            )

        caps_obj = toolset.get("capabilities")
        if not isinstance(caps_obj, dict):
            raise assembly_error(
                code="INVALID_TOOLSET_CAPABILITIES_SHAPE",
                message="toolset capabilities must be a mapping of capability names to posture strings",
                details={"toolset": toolset, "capabilities": caps_obj},
            )

        source = cast("Mapping[object, object]", caps_obj)
        for cap_name, posture in _safe_items(source):
            if not isinstance(cap_name, str) or not isinstance(posture, str):
                raise assembly_error(
                    code="INVALID_TOOLSET_CAPABILITY_ENTRY",
                    message=(
                        "toolset capabilities entries must use string capability names "
                        "and posture strings"
                    ),
                    details={"toolset": toolset, "capability": cap_name, "posture": posture},
                )
            if posture not in _VALID_TOOL_POSTURES:
                raise assembly_error(
                    code="INVALID_TOOLSET_CAPABILITY_ENTRY",
                    message=(
                        "toolset capability posture must be one of none, read_only, "
                        "read_write, destructive"
                    ),
                    details={"toolset": toolset, "capability": cap_name, "posture": posture},
                )
            if cap_name in merged and merged[cap_name] != posture:
                raise assembly_error(
                    code="COMPONENT_CONFLICT",
                    message=(
                        f"Contradictory posture for capability '{cap_name}': "
                        f"'{merged[cap_name]}' vs '{posture}'"
                    ),
                    details={"capability": cap_name, "postures": [merged[cap_name], posture]},
                )
            merged[cap_name] = posture

    return merged


@pre(
    lambda base, patch: (
        all(isinstance(key, str) for key in base) and all(isinstance(key, str) for key in patch)
    )
)
def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge patch dict into base dict (patch values override base)."""
    result = dict(base)
    for key, value in _safe_items(patch):
        if not isinstance(key, str):
            continue
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


@pre(lambda prompt: isinstance(prompt, str) and "\x00" not in prompt)
@post(lambda result: isinstance(result, list) and all(isinstance(item, str) for item in result))
def _find_unresolved_placeholders(prompt: str) -> list[str]:
    """Return unresolved placeholder names in prompt text.

    >>> _find_unresolved_placeholders("You are {role}.")
    ['role']
    >>> _find_unresolved_placeholders("Use {{literal}} braces.")
    []
    """
    return sorted(set(_PROMPT_PLACEHOLDER_PATTERN.findall(prompt)))


@pre(lambda data: all(isinstance(key, str) for key in data))
@post(lambda result: isinstance(result, list) and all(isinstance(item, str) for item in result))
@raises(AssemblyError)
def _collect_prompt_texts(data: dict[str, object]) -> list[str]:
    prompts_obj = data.get("prompts", [])
    prompts = prompts_obj if isinstance(prompts_obj, list) else []

    prompt_texts: list[str] = []
    for prompt_component in prompts:
        if not isinstance(prompt_component, dict):
            continue
        text = prompt_component.get("text", "")
        if not isinstance(text, str):
            text = ""
        placeholders = _find_unresolved_placeholders(text)
        if placeholders:
            raise assembly_error(
                code="UNRESOLVED_PROMPT_TEXT",
                message="prompt text contains unresolved placeholders and must already be fully composed",
                details={"placeholders": placeholders, "prompt": text},
            )
        prompt_texts.append(text)
    return prompt_texts


@pre(lambda data: all(isinstance(key, str) for key in data))
@post(lambda result: isinstance(result, list) and all(isinstance(item, dict) for item in result))
def _collect_constraint_sources(data: dict[str, object]) -> list[dict[str, Any]]:
    constraints_obj = data.get("constraints", [])
    constraints = constraints_obj if isinstance(constraints_obj, list) else []
    constraint_sources: list[dict[str, Any]] = [
        cast("dict[str, Any]", item) for item in constraints if isinstance(item, dict)
    ]

    model = data.get("model")
    if isinstance(model, str):
        constraint_sources.append({"model": model})
    elif isinstance(model, dict):
        constraint_sources.append(cast("dict[str, Any]", model))
    return constraint_sources


_FORBIDDEN_OVERRIDE_FIELDS = frozenset({"tools", "side_effect_policy", "variables"})


@pre(lambda data: all(isinstance(key, str) for key in data))
@post(lambda result: result is None)
@raises(AssemblyError)
def _reject_noncanonical_assembly_input(data: dict[str, object]) -> None:
    """Reject legacy assembly inputs before composition.

    >>> _reject_noncanonical_assembly_input({"id": "p"})
    >>> _reject_noncanonical_assembly_input({"id": "p", "variables": {"role": "assistant"}})
    Traceback (most recent call last):
    ...
    larva.core.assembly_error.AssemblyError: VARIABLES_NOT_ALLOWED: variables are not permitted at canonical assembly boundary
    """
    if "variables" in data:
        raise assembly_error(
            code="VARIABLES_NOT_ALLOWED",
            message="variables are not permitted at canonical assembly boundary",
            details={"field": "variables"},
        )


@pre(lambda result, overrides: isinstance(result, dict) and isinstance(overrides, dict))
@post(lambda result: isinstance(result, dict))
@raises(AssemblyError)
def _apply_overrides(result: Mapping[str, object], overrides: dict[str, Any]) -> dict[str, object]:
    updated = dict(result)

    # Reject forbidden fields at canonical admission boundary
    for key, _ in _safe_items(overrides):
        if not isinstance(key, str):
            continue
        if key in _FORBIDDEN_OVERRIDE_FIELDS:
            raise assembly_error(
                code="FORBIDDEN_OVERRIDE_FIELD",
                message=f"Override field '{key}' is not permitted at canonical admission boundary",
                details={"field": key},
            )

    if "model_params" in updated and isinstance(overrides.get("model_params"), dict):
        updated["model_params"] = _deep_merge(
            cast("dict[str, Any]", updated["model_params"]),
            cast("dict[str, Any]", overrides["model_params"]),
        )
        return updated

    for key, value in _safe_items(overrides):
        if not isinstance(key, str):
            continue
        if key != "model_params":
            updated[key] = value  # type: ignore[literal-required]
    return updated


@pre(lambda data: isinstance(data, dict) and "id" in data and not _has_scalar_conflicts(data))
@post(lambda result: isinstance(result, dict) and "id" in result)
@raises(AssemblyError)
def assemble_candidate(data: dict[str, object]) -> PersonaSpec:
    """Assemble a PersonaSpec candidate from component inputs.

    Contract (from INTERFACES.md Section C Assembly Rules):
    - Prompts concatenate in declared order with "\\n\\n" separator
    - Scalars (model, can_spawn, compaction_prompt):
      Multiple sources for same field -> error (COMPONENT_CONFLICT)
    - Capabilities (canonical): Merged from 'capabilities' field in toolsets
    - Tools (legacy input): not admitted at canonical cutover
    - model_params: Deep-merged from model component, overrides can patch keys

    Acceptance notes:
    - This function defines candidate-shape expectations only; canonical
      admission remains owned by ``validate_spec`` under opifex authority.
    - The exact larva files that must not widen PersonaSpec authority are
      ``spec.py``, ``validate.py``, ``assemble.py``, and ``facade.py``.
    - Any success through larva production admission paths must eventually mean
      conformance to the opifex canonical PersonaSpec contract.

    Args:
        data: Mapping containing in-memory component values and overrides.

    Returns:
        PersonaSpec candidate (not yet normalized/validated)

    Raises:
        AssemblyError: On component conflicts or non-canonical assembly input.

    Examples:
        >>> assemble_candidate({"id": "p", "prompts": [{"text": "You are {role}"}]})
        Traceback (most recent call last):
        ...
        larva.core.assembly_error.AssemblyError: UNRESOLVED_PROMPT_TEXT: prompt text contains unresolved placeholders and must already be fully composed
        >>> # Capabilities input (canonical)
        >>> result = assemble_candidate(
        ...     {"id": "p", "toolsets": [{"capabilities": {"read": "read_only"}}]}
        ... )
        >>> result["capabilities"]
        {'read': 'read_only'}
        >>> assemble_candidate({"id": "p", "variables": {"role": "assistant"}})
        Traceback (most recent call last):
        ...
        larva.core.assembly_error.AssemblyError: VARIABLES_NOT_ALLOWED: variables are not permitted at canonical assembly boundary
    """
    _reject_noncanonical_assembly_input(data)
    persona_id = cast("str", data.get("id"))
    result: dict[str, object] = {"id": persona_id}

    description = data.get("description")
    if isinstance(description, str):
        result["description"] = description

    prompt_texts = _collect_prompt_texts(data)

    if prompt_texts:
        result["prompt"] = "\n\n".join(prompt_texts)

    model = data.get("model")
    constraint_sources = _collect_constraint_sources(data)
    scalar_fields = ["model", "can_spawn", "compaction_prompt"]
    for field in scalar_fields:
        value = _collect_scalar(constraint_sources, field)
        if value is not None:
            result[field] = value  # type: ignore[literal-required]

    toolsets_obj = data.get("toolsets", [])
    toolsets = (
        [cast("dict[str, object]", item) for item in toolsets_obj if isinstance(item, dict)]
        if isinstance(toolsets_obj, list)
        else []
    )
    if toolsets:
        merged_caps = cast("dict[str, ToolPosture]", _merge_capabilities(toolsets))
        # Set canonical capability declaration surface only.
        result["capabilities"] = merged_caps

    model_component: ModelComponent | None = None
    if isinstance(model, dict):
        model_component = cast("ModelComponent", model)
    elif model is None:
        model_component = {}

    if model_component and "model_params" in model_component:
        result["model_params"] = dict(model_component["model_params"])

    overrides_obj = data.get("overrides", {})
    overrides = overrides_obj if isinstance(overrides_obj, dict) else {}
    if overrides:
        result = _apply_overrides(result, cast("dict[str, Any]", overrides))

    return cast("PersonaSpec", result)
