"""Canonical component-kind vocabulary and alias normalization helpers.

>>> normalize_component_kind("prompt")
'prompts'
>>> normalize_component_kind("models")
'models'
>>> normalize_component_kind("invalid") is None
True
"""

from __future__ import annotations

from deal import post, pre

CANONICAL_COMPONENT_KINDS: tuple[str, ...] = (
    "prompts",
    "toolsets",
    "constraints",
    "models",
)

_COMPONENT_KIND_ALIASES: dict[str, str] = {
    "prompts": "prompts",
    "prompt": "prompts",
    "toolsets": "toolsets",
    "toolset": "toolsets",
    "constraints": "constraints",
    "constraint": "constraints",
    "models": "models",
    "model": "models",
}


@pre(lambda kind: "\x00" not in kind)
@post(lambda result: result is None or result in CANONICAL_COMPONENT_KINDS)
def normalize_component_kind(kind: str) -> str | None:
    """Normalize component kind aliases to canonical plural values.

    >>> normalize_component_kind("prompt")
    'prompts'
    >>> normalize_component_kind("constraints")
    'constraints'
    >>> normalize_component_kind("invalid") is None
    True
    """

    return _COMPONENT_KIND_ALIASES.get(kind)


@pre(lambda kind: "\x00" not in kind)
@post(lambda result: result.startswith("Invalid component type: "))
def invalid_component_kind_message(kind: str) -> str:
    """Return consistent invalid-kind message text for public surfaces.

    >>> invalid_component_kind_message("invalid")
    'Invalid component type: invalid. Supported values: prompts | toolsets | constraints | models'
    """

    supported = " | ".join(CANONICAL_COMPONENT_KINDS)
    return f"Invalid component type: {kind}. Supported values: {supported}"
