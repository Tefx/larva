"""Shared fixtures and helpers for facade tests.

Sources:
- ARCHITECTURE.md section 7 (Assembly -> Validation -> Normalization)
- ARCHITECTURE.md section 7 (Registry read -> override -> revalidation)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

import hashlib
import json
import re
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

_VARIANT_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

if TYPE_CHECKING:
    from pathlib import Path

    from larva.core.spec import PersonaSpec
    from larva.core.validate import ValidationReport


def _canonical_spec(persona_id: str, digest: str | None = None) -> PersonaSpec:
    spec: PersonaSpec = {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "read_only"},  # ADR-002: canonical capability field
        "model_params": {"temperature": 0.1},
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
    }
    spec["spec_digest"] = _digest_for(spec) if digest is None else digest
    return spec


def _historical_spec_with_legacy_fields(
    persona_id: str,
    digest: str = "sha256:historical-debt",
) -> PersonaSpec:
    """Return historical non-canonical fixture for rejection-path tests.

    The payload deliberately carries forbidden legacy fields so hard-cut tests
    can prove register/validate paths reject them explicitly.
    """
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

    def validate_spec(
        self,
        spec: PersonaSpec,
        registry_persona_ids: frozenset[str] | None = None,
    ) -> ValidationReport:
        self.calls.append("validate")
        self.inputs.append(dict(spec))
        return self.report


@dataclass
class SpyNormalizeModule:
    calls: list[str]
    inputs: list[PersonaSpec] = field(default_factory=list)

    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec:
        self.calls.append("normalize")
        # Hard-cut policy: delegate to real normalize_spec so tests observe the
        # production rejection/computation behavior, not a permissive spy.
        from larva.core.normalize import normalize_spec as real_normalize

        normalized = real_normalize(dict(spec))
        self.inputs.append(normalized)
        return normalized


@dataclass
class RaisingAssembleModule:
    calls: list[str]

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        raise _assembly_error(
            code="COMPONENT_CONFLICT",
            message="Multiple sources provide different values for 'can_spawn'",
            details={"field": "can_spawn"},
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
    constraint: dict[str, object] = field(default_factory=lambda: {"can_spawn": False})
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
        capabilities = self.toolsets_by_name.get(name, self.toolset)
        return Success({"capabilities": capabilities})

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
    variant_save_inputs: list[tuple[PersonaSpec, str | None]] = field(default_factory=list)
    variants: dict[str, dict[str, PersonaSpec]] = field(default_factory=dict)
    active_variants: dict[str, str] = field(default_factory=dict)

    def save(self, spec: PersonaSpec, variant: str | None = None) -> Result[None, RegistryError]:
        self.save_inputs.append(dict(spec))
        self.variant_save_inputs.append((dict(spec), variant))
        persona_id = cast("str", spec.get("id", ""))
        variant_name = "default" if variant is None else variant
        if persona_id:
            self.variants.setdefault(persona_id, {})[variant_name] = dict(spec)
            self.active_variants.setdefault(persona_id, variant_name)
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, RegistryError]:
        self.get_inputs.append(persona_id)
        active = self.active_variants.get(persona_id)
        if active is not None and persona_id in self.variants:
            return Success(dict(self.variants[persona_id][active]))
        return self.get_result

    def get_variant(self, persona_id: str, variant: str) -> Result[PersonaSpec, RegistryError]:
        self.get_inputs.append(f"{persona_id}:{variant}")
        if len(variant) > 64 or _VARIANT_PATTERN.fullmatch(variant) is None:
            return Failure(
                {
                    "code": "INVALID_VARIANT_NAME",
                    "message": "invalid variant name",
                    "variant": variant,
                }
            )
        if persona_id in self.variants and variant in self.variants[persona_id]:
            return Success(dict(self.variants[persona_id][variant]))
        return Failure(
            {
                "code": "VARIANT_NOT_FOUND",
                "message": f"variant '{variant}' not found",
                "persona_id": persona_id,
                "variant": variant,
            }
        )

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        return self.list_result

    def delete(self, persona_id: str) -> Result[None, RegistryError]:
        """In-memory delete for facade testing."""
        self.variants.pop(persona_id, None)
        self.active_variants.pop(persona_id, None)
        return self.delete_result

    def variant_list(self, persona_id: str) -> Result[dict[str, object], RegistryError]:
        if persona_id not in self.variants:
            return Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": f"persona '{persona_id}' not found",
                    "persona_id": persona_id,
                }
            )
        return Success(
            {
                "id": persona_id,
                "active": self.active_variants[persona_id],
                "variants": sorted(self.variants[persona_id]),
            }
        )

    def variant_activate(
        self, persona_id: str, variant: str
    ) -> Result[dict[str, object], RegistryError]:
        if len(variant) > 64 or _VARIANT_PATTERN.fullmatch(variant) is None:
            return Failure(
                {
                    "code": "INVALID_VARIANT_NAME",
                    "message": "invalid variant name",
                    "variant": variant,
                }
            )
        if persona_id not in self.variants or variant not in self.variants[persona_id]:
            return Failure(
                {
                    "code": "VARIANT_NOT_FOUND",
                    "message": f"variant '{variant}' not found",
                    "persona_id": persona_id,
                    "variant": variant,
                }
            )
        self.active_variants[persona_id] = variant
        return self.variant_list(persona_id)

    def variant_delete(self, persona_id: str, variant: str) -> Result[None, RegistryError]:
        if len(variant) > 64 or _VARIANT_PATTERN.fullmatch(variant) is None:
            return Failure(
                {
                    "code": "INVALID_VARIANT_NAME",
                    "message": "invalid variant name",
                    "variant": variant,
                }
            )
        metadata = self.variant_list(persona_id)
        if isinstance(metadata, Failure):
            return metadata
        payload = metadata.unwrap()
        variants = cast("list[str]", payload["variants"])
        if variant not in variants:
            return Failure(
                {
                    "code": "VARIANT_NOT_FOUND",
                    "message": f"variant '{variant}' not found",
                    "persona_id": persona_id,
                    "variant": variant,
                }
            )
        if len(variants) == 1:
            return Failure(
                {
                    "code": "LAST_VARIANT_DELETE_FORBIDDEN",
                    "message": "cannot delete last variant",
                    "persona_id": persona_id,
                    "variant": variant,
                }
            )
        if payload["active"] == variant:
            return Failure(
                {
                    "code": "ACTIVE_VARIANT_DELETE_FORBIDDEN",
                    "message": "cannot delete active variant",
                    "persona_id": persona_id,
                    "variant": variant,
                }
            )
        del self.variants[persona_id][variant]
        return Success(None)

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
