"""Shared shell-test fixture taxonomy for canonical vs transition coverage."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from returns.result import Failure, Result, Success

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec


def canonical_persona_spec(
    persona_id: str,
    digest: str = "sha256:canonical",
    model: str = "gpt-4o-mini",
) -> PersonaSpec:
    """Return canonical-only PersonaSpec fixture (no deprecated fields)."""
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": model,
        "capabilities": {"shell": "read_only"},
        "model_params": {"temperature": 0.1},
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
        "spec_digest": digest,
    }


def transition_toolset_fixture(
    capabilities: dict[str, str] | None = None,
) -> dict[str, dict[str, str]]:
    """Return explicit transition-only toolset payload (canonical + mirrored)."""
    resolved = capabilities or {"shell": "read_only"}
    return {"capabilities": dict(resolved), "tools": dict(resolved)}


def transition_constraint_fixture(
    side_effect_policy: str = "read_only",
) -> dict[str, object]:
    """Return explicit transition-only constraint payload."""
    return {"side_effect_policy": side_effect_policy}


def transition_persona_spec_with_legacy_fields(
    persona_id: str,
    digest: str = "sha256:transition",
    model: str = "gpt-4o-mini",
    side_effect_policy: str = "read_only",
) -> PersonaSpec:
    """Return transition-only PersonaSpec fixture with deprecated fields."""
    spec = dict(canonical_persona_spec(persona_id=persona_id, digest=digest, model=model))
    spec["tools"] = {"shell": "read_only"}
    spec["side_effect_policy"] = side_effect_policy
    return spec


@dataclass
class TransitionComponentStoreDouble:
    """Shared transition-path component store double for shell tests."""

    toolsets_by_name: dict[str, dict[str, dict[str, str]]] = field(default_factory=dict)
    constraints_by_name: dict[str, dict[str, object]] = field(default_factory=dict)

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], Exception]:
        if name not in self.toolsets_by_name:
            return Failure(KeyError(f"not found: {name}"))
        return Success(self.toolsets_by_name[name])

    def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
        if name not in self.constraints_by_name:
            return Failure(KeyError(f"not found: {name}"))
        return Success(self.constraints_by_name[name])
