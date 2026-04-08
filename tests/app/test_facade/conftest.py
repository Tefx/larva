"""Shared fixtures and helpers for facade tests.

Sources:
- ARCHITECTURE.md section 7 (Assembly -> Validation -> Normalization)
- ARCHITECTURE.md section 7 (Registry read -> override -> revalidation)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, cast

import pytest
from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.assemble import _assembly_error
from larva.shell.components import ComponentStoreError, FilesystemComponentStore
from larva.shell.registry import RegistryError

if TYPE_CHECKING:
    from pathlib import Path

    from larva.core.spec import PersonaSpec
    from larva.core.validate import ValidationReport


def _canonical_spec(persona_id: str, digest: str = "sha256:canonical") -> PersonaSpec:
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "read_only"},  # ADR-002: canonical capability field
        "model_params": {"temperature": 0.1},
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
        "spec_digest": digest,
    }


def _transition_spec_with_deprecated_fields(
    persona_id: str,
    digest: str = "sha256:transition",
) -> PersonaSpec:
    """Return transition-only fixture with deprecated mirrored fields."""
    spec = dict(_canonical_spec(persona_id, digest=digest))
    spec["tools"] = {"shell": "read_only"}
    spec["side_effect_policy"] = "read_only"
    return spec


def _valid_report() -> ValidationReport:
    return {"valid": True, "errors": [], "warnings": []}


def _invalid_report(code: str = "PERSONA_INVALID") -> ValidationReport:
    return {
        "valid": False,
        "errors": [{"code": code, "message": "invalid", "details": {}}],
        "warnings": [],
    }


def _digest_for(spec: PersonaSpec) -> str:
    payload = {k: v for k, v in spec.items() if k != "spec_digest"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


@dataclass
class SpyAssembleModule:
    candidate: PersonaSpec
    calls: list[str]
    inputs: list[dict[str, object]] = field(default_factory=list)

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        self.inputs.append(data)
        return dict(self.candidate)


@dataclass
class SpyValidateModule:
    report: ValidationReport
    calls: list[str]
    inputs: list[PersonaSpec] = field(default_factory=list)

    def validate_spec(self, spec: PersonaSpec) -> ValidationReport:
        self.calls.append("validate")
        self.inputs.append(dict(spec))
        return self.report


@dataclass
class SpyNormalizeModule:
    calls: list[str]
    inputs: list[PersonaSpec] = field(default_factory=list)

    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec:
        self.calls.append("normalize")
        normalized = dict(spec)
        normalized["spec_digest"] = _digest_for(normalized)
        self.inputs.append(normalized)
        return normalized


@dataclass
class RaisingAssembleModule:
    calls: list[str]

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        raise _assembly_error(
            code="COMPONENT_CONFLICT",
            message="Multiple sources provide different values for 'side_effect_policy'",
            details={"field": "side_effect_policy"},
        )


@dataclass
class RaisingUnknownCodeAssembleModule:
    calls: list[str]

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        raise _assembly_error(
            code="UNMAPPED_ASSEMBLY_ERROR",
            message="unmapped assembly failure",
            details={"field": "model"},
        )


@dataclass
class InMemoryComponentStore:
    prompt_text: str = "Prompt body"
    toolset: dict[str, str] = field(default_factory=lambda: {"shell": "read_only"})
    constraint: dict[str, object] = field(
        default_factory=lambda: {"side_effect_policy": "read_only"}
    )
    model: dict[str, object] = field(default_factory=lambda: {"model": "gpt-4o-mini"})
    prompts_by_name: dict[str, str] = field(default_factory=dict)
    toolsets_by_name: dict[str, dict[str, str]] = field(default_factory=dict)
    constraints_by_name: dict[str, dict[str, object]] = field(default_factory=dict)
    models_by_name: dict[str, dict[str, object]] = field(default_factory=dict)
    fail_prompt: bool = False

    def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
        if self.fail_prompt:
            return Failure(
                ComponentStoreError(
                    f"Prompt not found: {name}",
                    component_type="prompt",
                    component_name=name,
                )
            )
        return Success({"text": self.prompts_by_name.get(name, self.prompt_text)})

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
        # Per ADR-002: return both capabilities (canonical) and tools (mirrored)
        capabilities = self.toolsets_by_name.get(name, self.toolset)
        return Success({"capabilities": capabilities, "tools": capabilities})

    def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
        return Success(self.constraints_by_name.get(name, self.constraint))

    def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
        return Success(self.models_by_name.get(name, self.model))

    def list_components(self) -> Result[dict[str, list[str]], ComponentStoreError]:
        return Success({"prompts": [], "toolsets": [], "constraints": [], "models": []})


@dataclass
class InMemoryRegistryStore:
    get_result: Result[PersonaSpec, RegistryError] = field(
        default_factory=lambda: Success(_canonical_spec("default"))
    )
    list_result: Result[list[PersonaSpec], RegistryError] = field(
        default_factory=lambda: Success([])
    )
    save_result: Result[None, RegistryError] = field(default_factory=lambda: Success(None))
    delete_result: Result[None, RegistryError] = field(default_factory=lambda: Success(None))
    clear_result: Result[int, RegistryError] = field(default_factory=lambda: Success(0))
    clear_count: int = 0
    save_inputs: list[PersonaSpec] = field(default_factory=list)
    get_inputs: list[str] = field(default_factory=list)

    def save(self, spec: PersonaSpec) -> Result[None, RegistryError]:
        self.save_inputs.append(dict(spec))
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, RegistryError]:
        self.get_inputs.append(persona_id)
        return self.get_result

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        return self.list_result

    def delete(self, persona_id: str) -> Result[None, RegistryError]:
        """In-memory delete for facade testing."""
        return self.delete_result

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[int, RegistryError]:
        """In-memory clear for facade testing."""
        return self.clear_result


def _facade(
    *,
    report: ValidationReport | None = None,
    candidate: PersonaSpec | None = None,
    components: InMemoryComponentStore | None = None,
    registry: InMemoryRegistryStore | None = None,
    calls: list[str] | None = None,
) -> tuple[
    "DefaultLarvaFacade",
    SpyAssembleModule,
    SpyValidateModule,
    SpyNormalizeModule,
]:
    from larva.app.facade import DefaultLarvaFacade

    order = [] if calls is None else calls
    assemble_module = SpyAssembleModule(candidate or _canonical_spec("assembled"), order)
    validate_module = SpyValidateModule(report or _valid_report(), order)
    normalize_module = SpyNormalizeModule(order)
    facade = DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module,
        validate=validate_module,
        normalize=normalize_module,
        components=components or InMemoryComponentStore(),
        registry=registry or InMemoryRegistryStore(),
    )
    return facade, assemble_module, validate_module, normalize_module


def _failure(result: Result[object, LarvaError]) -> LarvaError:
    assert isinstance(result, Failure)
    return cast("LarvaError", result.failure())
