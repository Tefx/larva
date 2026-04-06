"""Contracted PersonaSpec assembly from in-memory components.

Assembly is an upstream candidate-construction step, not the canonical
PersonaSpec authority. opifex owns the canonical contract; larva assembly must
stay subordinate to that authority and must not widen canonical admission.

Acceptance notes for this module boundary:
- assembly may construct a candidate for later validation
- assembly must not redefine required PersonaSpec fields
- assembly must not justify re-admitting ``tools`` or ``side_effect_policy`` at
  canonical larva admission
- any repo-local schema artifact remains reference-only and does not override
  the canonical authority basis
"""

from typing import Any, Mapping, cast

from deal import post, pre, raises

from larva.core.spec import ModelComponent, PersonaSpec, ToolPosture


class AssemblyError(Exception):
    """Base exception for assembly errors.

    Error-shape expectation:
        Assembly errors are lower-level contract failures surfaced before or
        during candidate construction. Facade mapping should preserve the
        assembly ``code`` when it already aligns with the shared taxonomy.
    """

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
        isinstance(result, AssemblyError)
        and isinstance(result.code, str)
        and len(result.code) > 0
        and isinstance(result.message, str)
        and len(result.message) > 0
        and isinstance(result.details, dict)
    )
)
def _assembly_error(
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> AssemblyError:
    error = AssemblyError(f"{code}: {message}")
    error.code = code
    error.message = message
    error.details = {} if details is None else details
    return error


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
            raise _assembly_error(
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

    Per ADR-002 transition:
    - Reads 'capabilities' field first (canonical)
    - Falls back to 'tools' field (deprecated)
    - Returns merged capability mapping

    >>> _merge_capabilities([{"capabilities": {"read": "read_only"}}])
    {'read': 'read_only'}
    >>> _merge_capabilities([{"tools": {"write": "read_write"}}])
    {'write': 'read_write'}
    >>> _merge_capabilities([{"capabilities": {"read": "read_only"}}, {"tools": {"write": "read_write"}}])
    {'read': 'read_only', 'write': 'read_write'}
    """
    merged: dict[str, str] = {}

    for toolset in toolsets:
        # Prefer 'capabilities' (canonical), fall back to 'tools' (deprecated)
        caps_obj = toolset.get("capabilities")
        tools_obj = toolset.get("tools")

        # Use capabilities if present, otherwise use tools
        source_obj = caps_obj if caps_obj is not None else tools_obj
        if source_obj is None:
            continue
        if not isinstance(source_obj, dict):
            continue

        source = cast("Mapping[object, object]", source_obj)
        for cap_name, posture in _safe_items(source):
            if not isinstance(cap_name, str) or not isinstance(posture, str):
                continue
            if cap_name in merged and merged[cap_name] != posture:
                raise _assembly_error(
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


@pre(
    lambda prompt, variables: (
        isinstance(prompt, str)
        and isinstance(variables, dict)
        and all(
            isinstance(key, str) and isinstance(value, str) for key, value in _safe_items(variables)
        )
    )
)
@raises(AssemblyError)
def _inject_variables(prompt: str, variables: dict[str, str]) -> str:
    """Inject variables into prompt text using str.format_map."""
    try:
        return prompt.format_map(variables)
    except KeyError as error:
        missing = list(error.args)
        raise _assembly_error(
            code="VARIABLE_UNRESOLVED",
            message=f"Missing required variable(s): {missing}",
            details={"missing_variables": missing},
        ) from error
    except ValueError as error:
        raise _assembly_error(
            code="INVALID_PROMPT_TEMPLATE",
            message=f"Prompt template is malformed: {error}",
            details={"prompt": prompt},
        ) from error


@pre(lambda data: all(isinstance(key, str) for key in data))
@post(lambda result: isinstance(result, list) and all(isinstance(item, str) for item in result))
def _collect_prompt_texts(data: dict[str, object]) -> list[str]:
    prompts_obj = data.get("prompts", [])
    prompts = prompts_obj if isinstance(prompts_obj, list) else []
    variables_obj = data.get("variables", {})
    variables = (
        {
            key: value
            for key, value in _safe_items(cast("Mapping[Any, Any]", variables_obj))
            if isinstance(key, str) and isinstance(value, str)
        }
        if isinstance(variables_obj, dict)
        else {}
    )

    prompt_texts: list[str] = []
    for prompt_component in prompts:
        if not isinstance(prompt_component, dict):
            continue
        text = prompt_component.get("text", "")
        if not isinstance(text, str):
            text = ""
        if variables and "{" in text:
            text = _inject_variables(text, variables)
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


@pre(lambda result, overrides: isinstance(result, dict) and isinstance(overrides, dict))
@post(lambda result: isinstance(result, dict))
def _apply_overrides(result: Mapping[str, object], overrides: dict[str, Any]) -> dict[str, object]:
    updated = dict(result)
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
    - Tools (deprecated input): read for backward compatibility but NOT emitted
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
        AssemblyError: On component conflicts or unresolved variables.

    Examples:
        >>> result = assemble_candidate(
        ...     {
        ...         "id": "p",
        ...         "prompts": [{"text": "You are {role}"}],
        ...         "variables": {"role": "assistant"},
        ...     }
        ... )
        >>> result["id"]
        'p'
        >>> result["prompt"]
        'You are assistant'
        >>> # Capabilities input (canonical)
        >>> result = assemble_candidate(
        ...     {"id": "p", "toolsets": [{"capabilities": {"read": "read_only"}}]}
        ... )
        >>> result["capabilities"]
        {'read': 'read_only'}
        >>> # Tools input (deprecated, still works)
        >>> result = assemble_candidate(
        ...     {"id": "p", "toolsets": [{"tools": {"write": "read_write"}}]}
        ... )
        >>> result["capabilities"]
        {'write': 'read_write'}
    """
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
