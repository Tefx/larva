"""Contract-only assembly module for PersonaSpec construction.

This module defines the assembly-facing TypedDict contracts and the
`assemble_candidate` function signature. Implementation follows the
assembly rules documented in INTERFACES.md Section C.

Behavioral notes (contract-only):
- Prompts concatenate in declared order with "\\n\\n" separator
- Scalar conflicts (model, can_spawn, side_effect_policy) require explicit overrides
- Tool conflicts surface deterministically
- Output remains a PersonaSpec candidate inside core boundary
"""

from typing import TypedDict


# Assembly-facing TypedDict contracts


class PromptComponent(TypedDict):
    """Single prompt component contributing to the final prompt field.

    In the assembly input, prompts are identified by name and their
    content is concatenated in declared order.
    """

    name: str


class ToolsetComponent(TypedDict):
    """Toolset component defining tool posture mappings.

    Each toolset maps tool_family -> posture (none|read_only|read_write|destructive).
    Multiple toolsets may be merged only if they don't have contradictory posture values.
    """

    name: str


class ConstraintComponent(TypedDict):
    """Constraint component defining policy boundaries.

    Contributes: can_spawn, side_effect_policy, compaction_prompt
    """

    name: str


class ModelComponent(TypedDict):
    """Model component defining model identifier and parameters.

    Contributes: model (string), model_params (object with temperature, top_p, max_tokens)
    """

    name: str


class AssemblyInput(TypedDict, total=False):
    """Complete input structure for persona assembly.

    Fields:
        id: Required persona identifier (kebab-case)
        prompts: List of prompt component names (concatenated in order)
        toolset: Optional toolset component name
        constraints: Optional constraint component name
        model: Optional model component name or literal model identifier
        overrides: Field overrides (wins over component values)
        variables: Variable substitution map for prompt text
    """

    id: str
    prompts: list[str]
    toolset: str | None
    constraints: str | None
    model: str | None
    overrides: dict[str, object]
    variables: dict[str, str]


def assemble_candidate(data: AssemblyInput) -> dict:
    """Assemble a PersonaSpec candidate from component inputs.

    This is a stub - full implementation follows in core_assemble.core-assemble-implement.

    Contract (from INTERFACES.md Section C Assembly Rules):
    - Prompts concatenate in declared order with "\\n\\n" separator
    - Scalars (model, can_spawn, side_effect_policy): Multiple sources for same field -> error (COMPONENT_CONFLICT)
    - Tools: Merged only if no contradictory posture values for same tool family
    - model_params: Deep-merged from model component, overrides can patch keys

    Args:
        data: AssemblyInput containing component references and overrides

    Returns:
        PersonaSpec candidate dict (not yet normalized/validated)

    Raises:
        NotImplementedError: Stub - implementation pending
    """
    raise NotImplementedError(
        "assemble_candidate implementation pending core_assemble.core-assemble-implement"
    )
