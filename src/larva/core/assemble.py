"""Contract-only assembly module for PersonaSpec construction.

This module defines the `assemble_candidate` contract over canonical
in-memory component types from `larva.core.spec`. Implementation follows
the assembly rules documented in INTERFACES.md Section C.

Behavioral notes (contract-only):
- Prompts concatenate in declared order with "\\n\\n" separator
- Scalar conflicts (model, can_spawn, side_effect_policy) require explicit overrides
- Tool conflicts surface deterministically
- Output remains a PersonaSpec candidate inside core boundary
"""

from typing import Any

from deal import post
from deal import pre

from larva.core.spec import AssemblyInput
from larva.core.spec import ModelComponent
from larva.core.spec import PersonaSpec
from larva.core.spec import ToolsetComponent


class AssemblyError(Exception):
    """Base exception for assembly errors."""

    @pre(
        lambda self, code, message, details=None: (
            isinstance(code, str)
            and len(code) > 0
            and isinstance(message, str)
            and len(message) > 0
        )
    )
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(f"{code}: {message}")


@pre(
    lambda sources, field, allow_multiple=False: (
        isinstance(sources, list) and isinstance(field, str) and len(field) > 0
    )
)
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
            raise AssemblyError(
                code="COMPONENT_CONFLICT",
                message=f"Multiple sources provide different values for '{field}': {values}",
                details={"field": field, "values": values},
            )

    return values[0]


@pre(lambda toolsets: isinstance(toolsets, list))
def _merge_tools(toolsets: list[ToolsetComponent]) -> dict[str, str]:
    """Merge tools from multiple toolset components."""
    merged: dict[str, str] = {}

    for toolset in toolsets:
        if "tools" not in toolset:
            continue
        for tool_name, posture in toolset["tools"].items():
            if tool_name in merged and merged[tool_name] != posture:
                raise AssemblyError(
                    code="COMPONENT_CONFLICT",
                    message=(
                        f"Contradictory posture for tool '{tool_name}': "
                        f"'{merged[tool_name]}' vs '{posture}'"
                    ),
                    details={"tool": tool_name, "postures": [merged[tool_name], posture]},
                )
            merged[tool_name] = posture

    return merged


@pre(lambda base, patch: isinstance(base, dict) and isinstance(patch, dict))
def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge patch dict into base dict (patch values override base)."""
    result = dict(base)
    for key, value in patch.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


@pre(lambda prompt, variables: isinstance(prompt, str) and isinstance(variables, dict))
def _inject_variables(prompt: str, variables: dict[str, str]) -> str:
    """Inject variables into prompt text using str.format_map."""
    try:
        return prompt.format_map(variables)
    except KeyError as error:
        missing = list(error.args)
        raise AssemblyError(
            code="VARIABLE_UNRESOLVED",
            message=f"Missing required variable(s): {missing}",
            details={"missing_variables": missing},
        )


@pre(lambda data: isinstance(data, dict) and "id" in data)
@post(lambda result: isinstance(result, dict) and "id" in result)
def assemble_candidate(data: AssemblyInput) -> PersonaSpec:
    """Assemble a PersonaSpec candidate from component inputs.

    Contract (from INTERFACES.md Section C Assembly Rules):
    - Prompts concatenate in declared order with "\\n\\n" separator
    - Scalars (model, can_spawn, side_effect_policy): Multiple sources for same field -> error (COMPONENT_CONFLICT)
    - Tools: Merged only if no contradictory posture values for same tool family
    - model_params: Deep-merged from model component, overrides can patch keys

    Args:
        data: AssemblyInput containing in-memory component values and overrides.

    Returns:
        PersonaSpec candidate (not yet normalized/validated)

    Raises:
        AssemblyError: On component conflicts or unresolved variables.

    Examples:
        >>> result = assemble_candidate({"id": "p", "prompts": [{"text": "You are {role}"}], "variables": {"role": "assistant"}})
        >>> result["id"]
        'p'
        >>> result["prompt"]
        'You are assistant'
    """
    result: PersonaSpec = {"id": data["id"]}

    prompts = data.get("prompts", [])
    prompt_texts: list[str] = []
    for prompt_component in prompts:
        text = prompt_component.get("text", "")
        variables = data.get("variables", {})
        if variables and "{" in text:
            text = _inject_variables(text, variables)
        prompt_texts.append(text)

    if prompt_texts:
        result["prompt"] = "\n\n".join(prompt_texts)

    constraints = data.get("constraints", [])
    model_sources: list[dict[str, Any]] = []
    model = data.get("model")
    if model:
        if isinstance(model, str):
            model_sources.append({"model": model})
        elif isinstance(model, dict):
            model_sources.append(model)

    constraint_sources: list[dict[str, Any]] = list(constraints) + model_sources
    scalar_fields = ["model", "can_spawn", "side_effect_policy", "compaction_prompt"]
    for field in scalar_fields:
        value = _collect_scalar(constraint_sources, field)
        if value is not None:
            result[field] = value  # type: ignore[literal-required]

    toolsets = data.get("toolsets", [])
    if toolsets:
        result["tools"] = _merge_tools(toolsets)

    model_component: ModelComponent | None = None
    if isinstance(model, dict):
        model_component = model
    elif model is None:
        model_component = {}

    if model_component and "model_params" in model_component:
        result["model_params"] = dict(model_component["model_params"])

    overrides = data.get("overrides", {})
    if "model_params" in result and isinstance(overrides.get("model_params"), dict):
        result["model_params"] = _deep_merge(result["model_params"], overrides["model_params"])
    elif overrides:
        for key, value in overrides.items():
            if key != "model_params":
                result[key] = value  # type: ignore[literal-required]

    return result
