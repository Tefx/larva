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
from pathlib import Path
from typing import TYPE_CHECKING, cast

import pytest
from returns.result import Failure, Result, Success

from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core.assemble import AssemblyError
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.shell.components import ComponentStoreError, FilesystemComponentStore
from larva.shell.registry import FileSystemRegistryStore

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
class RaisingAssembleModule:
    calls: list[str]

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        raise AssemblyError(
            code="COMPONENT_CONFLICT",
            message="Multiple sources provide different values for 'side_effect_policy'",
            details={"field": "side_effect_policy"},
        )


@dataclass
class RaisingUnknownCodeAssembleModule:
    calls: list[str]

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        raise AssemblyError(
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
        return Success({"tools": self.toolsets_by_name.get(name, self.toolset)})

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

    def test_assemble_component_conflict_maps_to_app_error(self) -> None:
        calls: list[str] = []
        assemble_module = RaisingAssembleModule(calls)
        validate_module = SpyValidateModule(_valid_report(), calls)
        normalize_module = SpyNormalizeModule(calls)
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(),
        )

        result = facade.assemble(
            {
                "id": "persona-a",
                "constraints": ["strict", "autonomous"],
            }
        )

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "COMPONENT_CONFLICT"
        assert error["numeric_code"] == 106
        assert error["details"]["field"] == "side_effect_policy"
        assert validate_module.inputs == []
        assert normalize_module.inputs == []

    def test_assemble_unknown_error_code_falls_back_to_internal_numeric_code(self) -> None:
        calls: list[str] = []
        assemble_module = RaisingUnknownCodeAssembleModule(calls)
        validate_module = SpyValidateModule(_valid_report(), calls)
        normalize_module = SpyNormalizeModule(calls)
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(),
        )

        result = facade.assemble({"id": "persona-a"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "UNMAPPED_ASSEMBLY_ERROR"
        assert error["numeric_code"] == 10
        assert error["message"] == "unmapped assembly failure"
        assert calls == ["assemble"]

    def test_assemble_validation_failure_returns_persona_invalid(self) -> None:
        calls: list[str] = []
        facade, _, _, normalize_module = _facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            calls=calls,
        )

        result = facade.assemble({"id": "persona-a", "prompts": ["base"]})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_SPEC_VERSION"
        assert normalize_module.inputs == []
        assert calls == ["assemble", "validate"]


class TestFacadeRegister:
    def test_register_validates_normalizes_then_persists_and_returns_facade_shape(self) -> None:
        calls: list[str] = []
        registry = InMemoryRegistryStore()
        spec = _canonical_spec("register-ok", digest="sha256:old")
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.register(spec)

        assert isinstance(result, Success)
        assert result.unwrap() == {"id": "register-ok", "registered": True}
        assert calls == ["validate", "normalize"]
        assert validate_module.inputs == [spec]
        assert normalize_module.inputs[0]["id"] == "register-ok"
        assert registry.save_inputs[0]["id"] == "register-ok"
        assert registry.save_inputs[0]["spec_digest"] == _digest_for(spec)

    def test_register_preserves_explicit_falsey_values_through_delegation(self) -> None:
        calls: list[str] = []
        registry = InMemoryRegistryStore()
        spec = _canonical_spec("register-falsey")
        spec["can_spawn"] = False
        spec["description"] = ""
        spec["compaction_prompt"] = ""
        spec["description"] = cast("object", None)
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.register(spec)

        assert isinstance(result, Success)
        assert calls == ["validate", "normalize"]
        assert validate_module.inputs[0]["can_spawn"] is False
        assert validate_module.inputs[0]["description"] is None
        assert validate_module.inputs[0]["compaction_prompt"] == ""
        assert normalize_module.inputs[0]["can_spawn"] is False
        assert normalize_module.inputs[0]["description"] is None
        assert normalize_module.inputs[0]["compaction_prompt"] == ""
        assert registry.save_inputs[0]["can_spawn"] is False
        assert registry.save_inputs[0]["description"] is None
        assert registry.save_inputs[0]["compaction_prompt"] == ""

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
    def test_resolve_reads_registry_then_validates_then_normalizes(self) -> None:
        calls: list[str] = []
        canonical = _canonical_spec("resolve-me", digest="sha256:canonical-old")
        registry = InMemoryRegistryStore(get_result=Success(canonical))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve("resolve-me")

        assert isinstance(result, Success)
        assert registry.get_inputs == ["resolve-me"]
        assert calls == ["validate", "normalize"]
        assert validate_module.inputs[0]["id"] == "resolve-me"
        assert normalize_module.inputs[0]["id"] == "resolve-me"
        assert result.unwrap()["spec_digest"] == _digest_for(result.unwrap())
        assert result.unwrap()["spec_digest"] != "sha256:canonical-old"

    def test_resolve_applies_falsey_overrides_exactly_and_recomputes_digest(self) -> None:
        calls: list[str] = []
        canonical = _canonical_spec("resolve-overrides", digest="sha256:canonical-old")
        registry = InMemoryRegistryStore(get_result=Success(canonical))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve(
            "resolve-overrides",
            overrides={
                "description": None,
                "can_spawn": False,
                "compaction_prompt": "",
                "model_params": {"temperature": 0},
            },
        )

        assert isinstance(result, Success)
        resolved = result.unwrap()
        assert calls == ["validate", "normalize"]
        assert validate_module.inputs[0]["description"] is None
        assert validate_module.inputs[0]["can_spawn"] is False
        assert validate_module.inputs[0]["compaction_prompt"] == ""
        assert validate_module.inputs[0]["model_params"] == {"temperature": 0}
        assert normalize_module.inputs[0]["description"] is None
        assert normalize_module.inputs[0]["can_spawn"] is False
        assert normalize_module.inputs[0]["compaction_prompt"] == ""
        assert normalize_module.inputs[0]["model_params"] == {"temperature": 0}
        assert resolved["description"] is None
        assert resolved["can_spawn"] is False
        assert resolved["compaction_prompt"] == ""
        assert resolved["model_params"] == {"temperature": 0}
        assert resolved["spec_digest"] == _digest_for(resolved)
        assert resolved["spec_digest"] != "sha256:canonical-old"

    def test_resolve_validation_failure_returns_persona_invalid(self) -> None:
        calls: list[str] = []
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("resolve-invalid")))
        facade, _, _, normalize_module = _facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            registry=registry,
            calls=calls,
        )

        result = facade.resolve("resolve-invalid", overrides={"spec_version": "invalid"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_SPEC_VERSION"
        assert normalize_module.inputs == []
        assert calls == ["validate"]

    def test_resolve_maps_persona_not_found_to_app_error(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade, _, validate_module, normalize_module = _facade(registry=registry)

        result = facade.resolve("missing")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "missing"
        assert registry.get_inputs == ["missing"]
        assert validate_module.inputs == []
        assert normalize_module.inputs == []

    def test_resolve_maps_registry_read_failures_to_app_error(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "REGISTRY_SPEC_READ_FAILED",
                    "message": "failed to read spec json",
                    "persona_id": "broken",
                    "path": "/tmp/broken.json",
                }
            )
        )
        facade, _, validate_module, normalize_module = _facade(registry=registry)

        result = facade.resolve("broken")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert error["numeric_code"] == 108
        assert error["details"]["persona_id"] == "broken"
        assert error["details"]["path"] == "/tmp/broken.json"
        assert validate_module.inputs == []
        assert normalize_module.inputs == []


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

    def test_list_returns_exactly_empty_list_for_empty_registry(self) -> None:
        """Verify empty registry returns exactly [] not wrapped in transport envelope."""
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        assert isinstance(result, Success)
        # Explicit assertion: returns exactly [] (empty list, not None, not wrapped)
        assert result.unwrap() == []
        # Ensure it's a list type, not any other shape
        assert isinstance(result.unwrap(), list)
        assert len(result.unwrap()) == 0
        # No transport envelope leakage - plain Result with plain list
        assert result.unwrap() is not None
        # Verify no null/None values leak into the result structure
        assert result.unwrap() != [None]
        assert result.unwrap() != [{"error": None}]
        assert result.unwrap() != {"data": [], "error": None}
        assert result.unwrap() != {"items": [], "total": 0}

    def test_list_maps_registry_read_failures_to_app_error_without_success(self) -> None:
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "index unreadable",
                    "path": "/tmp/index.json",
                }
            )
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert error["numeric_code"] == 107
        assert error["details"]["path"] == "/tmp/index.json"

    def test_list_malformed_registry_record_returns_persona_invalid_without_keyerror(self) -> None:
        malformed = cast("PersonaSpec", {"id": "alpha", "model": "gpt-4o-mini"})
        registry = InMemoryRegistryStore(list_result=Success([malformed]))
        facade, _, _, _ = _facade(registry=registry)

        result = facade.list()

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert "malformed" in error["message"]
        assert "record" in error["details"]


class TestFacadeDelete:
    """Pinned acceptance tests for facade delete operation.

    These tests pin the contract between shell/registry and app/facade
    before implementation. Tests xfail until facade.delete() is implemented.
    """

    def test_delete_returns_deleted_persona_payload(self) -> None:
        """Success delete returns exactly {id, deleted: True}."""
        registry = InMemoryRegistryStore(
            delete_result=Success(None),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("persona-to-delete")

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload == {"id": "persona-to-delete", "deleted": True}
        # Pin: only these two keys allowed in success shape
        assert set(payload.keys()) == {"id", "deleted"}

    def test_delete_maps_persona_not_found_to_app_error_envelope(self) -> None:
        """PERSONA_NOT_FOUND from registry maps to LarvaError preserving code/message."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("missing")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert error["details"]["persona_id"] == "missing"

    def test_delete_maps_invalid_persona_id_to_app_error_envelope(self) -> None:
        """INVALID_PERSONA_ID from registry maps to LarvaError preserving code/message."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "INVALID_PERSONA_ID",
                    "message": "invalid persona id 'Bad_Id': expected flat kebab-case",
                    "persona_id": "Bad_Id",
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("Bad_Id")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_PERSONA_ID"
        assert error["numeric_code"] == 104
        assert error["details"]["persona_id"] == "Bad_Id"

    def test_delete_maps_registry_delete_failure_to_app_error_details(self) -> None:
        """DeleteFailureError from registry maps to REGISTRY_DELETE_FAILED with details."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to unlink spec file: OSError",
                    "operation": "delete",
                    "persona_id": "stuck-persona",
                    "path": "/home/.larva/registry/stuck-persona.json",
                    "failed_spec_paths": ["/home/.larva/registry/stuck-persona.json"],
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.delete("stuck-persona")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_DELETE_FAILED"
        assert error["numeric_code"] == 111
        # Registry code/message preserved at facade level
        assert "failed to unlink" in error["message"]
        # Extra registry fields moved to details
        assert error["details"]["operation"] == "delete"
        assert error["details"]["persona_id"] == "stuck-persona"
        assert error["details"]["path"] == "/home/.larva/registry/stuck-persona.json"
        assert error["details"]["failed_spec_paths"] == ["/home/.larva/registry/stuck-persona.json"]


class TestFacadeClear:
    """Pinned acceptance tests for facade clear operation.

    These tests pin the contract between shell/registry and app/facade
    before implementation. Tests xfail until facade.clear() is implemented.
    """

    def test_clear_returns_cleared_registry_payload_with_count(self) -> None:
        """Success clear returns exactly {cleared: True, count: <int>}."""
        registry = InMemoryRegistryStore(
            clear_result=Success(3),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.clear(confirm="CLEAR REGISTRY")

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload == {"cleared": True, "count": 3}
        # Pin: only these two keys allowed in success shape
        assert set(payload.keys()) == {"cleared", "count"}
        # Pin: count is an int equal to registry-reported deleted count
        assert isinstance(payload["count"], int)

    def test_clear_maps_wrong_confirm_to_error_envelope_without_success_payload(self) -> None:
        """Wrong confirm token returns LarvaError with INVALID_CONFIRMATION_TOKEN."""
        registry = InMemoryRegistryStore(
            clear_result=Failure(
                {
                    "code": "INVALID_CONFIRMATION_TOKEN",
                    "message": "clear requires exact confirmation token 'CLEAR REGISTRY'",
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.clear(confirm="WRONG TOKEN")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_CONFIRMATION_TOKEN"
        # INTERNAL numeric code fallback for unmapped code
        assert error["numeric_code"] == 10
        assert error["message"] == "clear requires exact confirmation token 'CLEAR REGISTRY'"
        # No extra fields leak into details for this error type
        assert error["details"] == {}

    def test_clear_maps_registry_delete_failure_to_app_error_details(self) -> None:
        """DeleteFailureError during clear maps to REGISTRY_DELETE_FAILED with details."""
        registry = InMemoryRegistryStore(
            clear_result=Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to remove one or more persona specs during clear",
                    "operation": "clear",
                    "persona_id": None,
                    "path": "/home/.larva/registry/index.json",
                    "failed_spec_paths": [
                        "/home/.larva/registry/broken-one.json",
                        "/home/.larva/registry/broken-two.json",
                    ],
                }
            ),
        )
        facade, _, _, _ = _facade(registry=registry)

        result = facade.clear(confirm="CLEAR REGISTRY")

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_DELETE_FAILED"
        assert error["numeric_code"] == 111
        # Registry code/message preserved at facade level
        assert "failed to remove one or more persona specs" in error["message"]
        # Extra registry fields moved to details
        assert error["details"]["operation"] == "clear"
        assert error["details"]["persona_id"] is None
        assert error["details"]["path"] == "/home/.larva/registry/index.json"
        assert error["details"]["failed_spec_paths"] == [
            "/home/.larva/registry/broken-one.json",
            "/home/.larva/registry/broken-two.json",
        ]


class TestFacadeSeamProof:
    def test_replayable_seam_proof_command_writes_artifact_with_actual_outputs(
        self, tmp_path: Path
    ) -> None:
        registry_root = tmp_path / "registry"
        artifact_path = tmp_path / "facade-seam-proof-artifact.json"
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=SpyAssembleModule(_canonical_spec("unused"), []),
            validate=validate_module,
            normalize=normalize_module,
            components=FilesystemComponentStore(components_dir=tmp_path / "components"),
            registry=FileSystemRegistryStore(root=registry_root),
        )

        register_result = facade.register(_canonical_spec("facade-live", digest="sha256:stale"))
        list_result = facade.list()
        resolve_result = facade.resolve(
            "facade-live", overrides={"model_params": {"temperature": 0}}
        )

        assert isinstance(register_result, Success)
        assert isinstance(list_result, Success)
        assert isinstance(resolve_result, Success)

        artifact = {
            "command": (
                "uv run pytest -q tests/app/test_facade.py "
                "-k replayable_seam_proof_command_writes_artifact_with_actual_outputs"
            ),
            "register": register_result.unwrap(),
            "list": list_result.unwrap(),
            "resolve": resolve_result.unwrap(),
        }
        artifact_path.write_text(json.dumps(artifact, indent=2, sort_keys=True), encoding="utf-8")

        persisted_artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        assert persisted_artifact["command"].startswith("uv run pytest -q tests/app/test_facade.py")
        assert persisted_artifact["register"] == {"id": "facade-live", "registered": True}
        assert persisted_artifact["list"] == [
            {
                "id": "facade-live",
                "model": "gpt-4o-mini",
                "spec_digest": persisted_artifact["list"][0]["spec_digest"],
            }
        ]
        assert persisted_artifact["resolve"]["id"] == "facade-live"
        assert persisted_artifact["resolve"]["model_params"] == {"temperature": 0}
        assert (
            persisted_artifact["list"][0]["spec_digest"]
            != persisted_artifact["resolve"]["spec_digest"]
        )
        assert persisted_artifact["list"][0]["spec_digest"].startswith("sha256:")
        assert persisted_artifact["resolve"]["spec_digest"].startswith("sha256:")
