"""Shared shell-test fixtures for canonical and historical non-canonical coverage."""

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
    """Return canonical PersonaSpec fixture with no forbidden legacy fields."""
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


def canonical_toolset_fixture(
    capabilities: dict[str, str] | None = None,
) -> dict[str, dict[str, str]]:
    """Return canonical toolset payload for success-path component tests."""
    resolved = capabilities or {"shell": "read_only"}
    return {"capabilities": dict(resolved)}


def historical_toolset_fixture_with_legacy_fields(
    capabilities: dict[str, str] | None = None,
) -> dict[str, dict[str, str]]:
    """Return historical non-canonical toolset payload for rejection-path tests."""
    resolved = capabilities or {"shell": "read_only"}
    return {"capabilities": dict(resolved), "tools": dict(resolved)}


def legacy_toolset_fixture(
    tools: dict[str, str] | None = None,
) -> dict[str, dict[str, str]]:
    """Return explicit non-canonical toolset payload for fail-closed tests."""
    resolved = tools or {"shell": "read_only"}
    return {"tools": dict(resolved)}


def historical_constraint_fixture_with_legacy_field(
    side_effect_policy: str = "read_only",
) -> dict[str, object]:
    """Return historical non-canonical constraint payload for rejection tests."""
    return {"side_effect_policy": side_effect_policy}


def canonical_constraint_fixture(
    *, can_spawn: bool = False, compaction_prompt: str = "Summarize facts."
) -> dict[str, object]:
    """Return canonical constraint payload for shell component fixtures."""
    return {
        "can_spawn": can_spawn,
        "compaction_prompt": compaction_prompt,
    }


def historical_persona_spec_with_legacy_fields(
    persona_id: str,
    digest: str = "sha256:historical-debt",
    model: str = "gpt-4o-mini",
    side_effect_policy: str = "read_only",
) -> dict[str, object]:
    """Return historical non-canonical PersonaSpec for rejection-path coverage.

    The payload deliberately carries forbidden legacy fields so tests can prove
    current hard-cut surfaces reject them instead of silently repairing them.
    """
    spec = dict(canonical_persona_spec(persona_id=persona_id, digest=digest, model=model))
    spec["tools"] = {"shell": "read_only"}
    spec["side_effect_policy"] = side_effect_policy
    return spec


@dataclass
class HistoricalComponentStoreDouble:
    """Shared store double carrying historical non-canonical component payloads."""

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
