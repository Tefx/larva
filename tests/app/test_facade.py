"""Boundary tests for ``larva.app.facade`` use-case orchestration.

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

from returns.result import Failure, Result, Success

from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core import spec as spec_module
from larva.shell.components import ComponentStoreError

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec
    from larva.core.validate import ValidationReport
    from larva.shell.registry import RegistryError


def _canonical_spec(persona_id: str, digest: str = "sha256:canonical") -> PersonaSpec:
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "tools": {"shell": "read_only"},
        "model_params": {"temperature": 0.1},
        "side_effect_policy": "read_only",
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
        "spec_digest": digest,
    }


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
class InMemoryComponentStore:
    prompt_text: str = "Prompt body"
    toolset: dict[str, str] = field(default_factory=lambda: {"shell": "read_only"})
    constraint: dict[str, object] = field(
        default_factory=lambda: {"side_effect_policy": "read_only"}
    )
    model: dict[str, object] = field(default_factory=lambda: {"model": "gpt-4o-mini"})
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
        return Success({"text": self.prompt_text})

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
        return Success({"tools": self.toolset})

    def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
        return Success(self.constraint)

    def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
        return Success(self.model)

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


def _facade(
    *,
    report: ValidationReport | None = None,
    candidate: PersonaSpec | None = None,
    components: InMemoryComponentStore | None = None,
    registry: InMemoryRegistryStore | None = None,
    calls: list[str] | None = None,
) -> tuple[DefaultLarvaFacade, SpyAssembleModule, SpyValidateModule, SpyNormalizeModule]:
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


class TestFacadeValidate:
    def test_validate_returns_core_report_unchanged(self) -> None:
        report = {
            "valid": True,
            "errors": [],
            "warnings": ["model is unknown"],
        }
        facade, _, validate_module, _ = _facade(report=cast("ValidationReport", report))

        spec = _canonical_spec("validate-me")
        result = facade.validate(spec)

        assert result is report
        assert validate_module.inputs == [spec]


class TestFacadeAssemble:
    def test_assemble_runs_assemble_then_validate_then_normalize(self) -> None:
        calls: list[str] = []
        facade, assemble_module, validate_module, normalize_module = _facade(calls=calls)

        result = facade.assemble(
            {
                "id": "persona-a",
                "prompts": ["base"],
                "toolsets": ["default-tools"],
                "constraints": ["strict"],
                "model": "default-model",
                "variables": {"role": "analyst"},
                "overrides": {"description": "runtime description"},
            }
        )

        assert isinstance(result, Success)
        assert calls == ["assemble", "validate", "normalize"]
        assemble_input = assemble_module.inputs[0]
        assert assemble_input["id"] == "persona-a"
        assert assemble_input["prompts"] == [{"text": "Prompt body"}]
        assert assemble_input["toolsets"] == [{"tools": {"shell": "read_only"}}]
        assert assemble_input["constraints"] == [{"side_effect_policy": "read_only"}]
        assert assemble_input["model"] == {"model": "gpt-4o-mini"}
        assert assemble_input["variables"] == {"role": "analyst"}
        assert assemble_input["overrides"] == {"description": "runtime description"}
        assert validate_module.inputs[0] == assemble_module.candidate
        assert normalize_module.inputs[0]["id"] == "assembled"

    def test_assemble_component_miss_maps_to_app_error(self) -> None:
        components = InMemoryComponentStore(fail_prompt=True)
        facade, assemble_module, validate_module, normalize_module = _facade(components=components)

        result = facade.assemble({"id": "persona-a", "prompts": ["missing-prompt"]})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "COMPONENT_NOT_FOUND"
        assert error["numeric_code"] == 105
        assert "missing-prompt" in error["message"]
        assert error["details"]["component_type"] == "prompt"
        assert error["details"]["component_name"] == "missing-prompt"
        assert assemble_module.inputs == []
        assert validate_module.inputs == []
        assert normalize_module.inputs == []


class TestFacadeRegister:
    def test_register_validation_failure_blocks_persistence(self) -> None:
        registry = InMemoryRegistryStore()
        facade, _, _, _ = _facade(report=_invalid_report(), registry=registry)

        result = facade.register(_canonical_spec("bad-register"))

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert registry.save_inputs == []

    def test_register_maps_registry_save_failures_to_app_error(self) -> None:
        registry = InMemoryRegistryStore(
            save_result=Failure(
                {
                    "code": "REGISTRY_WRITE_FAILED",
                    "message": "disk full",
                    "persona_id": "writer",
                    "path": "/tmp/writer.json",
                }
            )
        )
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.register(_canonical_spec("writer"))

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_WRITE_FAILED"
        assert error["numeric_code"] == 109
        assert error["details"]["persona_id"] == "writer"
        assert error["details"]["path"] == "/tmp/writer.json"


class TestFacadeResolve:
    def test_resolve_override_preserves_null_and_recomputes_digest(self) -> None:
        canonical = _canonical_spec("resolve-me", digest="sha256:old")
        registry = InMemoryRegistryStore(get_result=Success(canonical))
        calls: list[str] = []
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(), registry=registry, calls=calls
        )

        result = facade.resolve("resolve-me", overrides={"description": None})

        assert isinstance(result, Success)
        resolved = result.unwrap()
        assert registry.get_inputs == ["resolve-me"]
        assert calls == ["validate", "normalize"]
        assert validate_module.inputs[0]["description"] is None
        assert normalize_module.inputs[0]["description"] is None
        assert resolved["description"] is None
        assert resolved["spec_digest"] != "sha256:old"

    def test_resolve_registry_miss_maps_to_app_error(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona missing",
                    "persona_id": "ghost",
                }
            )
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.resolve("ghost")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "ghost"

    def test_resolve_validation_failure_prevents_success_response(self) -> None:
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("resolve-bad")))
        calls: list[str] = []
        facade, _, _, normalize_module = _facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve("resolve-bad", overrides={"spec_version": "0.2.0"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert normalize_module.inputs == []
        assert calls == ["validate"]


class TestFacadeList:
    def test_list_returns_facade_summaries_only(self) -> None:
        specs = [
            _canonical_spec("alpha", digest="sha256:a"),
            _canonical_spec("beta", digest="sha256:b"),
        ]
        registry = InMemoryRegistryStore(list_result=Success(specs))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        assert isinstance(result, Success)
        assert result.unwrap() == [
            {"id": "alpha", "spec_digest": "sha256:a", "model": "gpt-4o-mini"},
            {"id": "beta", "spec_digest": "sha256:b", "model": "gpt-4o-mini"},
        ]
