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

from invar import post
from invar import pre

from larva.core.spec import AssemblyInput
from larva.core.spec import PersonaSpec


@pre(lambda data: isinstance(data, dict) and "id" in data)
@post(lambda result: isinstance(result, dict) and "id" in result)
def assemble_candidate(data: AssemblyInput) -> PersonaSpec:
    """Assemble a PersonaSpec candidate from component inputs.

    This is a stub - full implementation follows in core_assemble.core-assemble-implement.

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
        NotImplementedError: Stub - implementation pending

    Examples:
        >>> assemble_candidate({"id": "test"})  # doctest: +SKIP
        Traceback (most recent call last):
            ...
    """
    raise NotImplementedError(
        "assemble_candidate implementation pending core_assemble.core-assemble-implement"
    )
