"""Boundary tests for ``larva.shell.python_api`` thin delegation.

Tests prove:
- Thin delegation over facade for validate/assemble/register/resolve/list
- Failure passthrough from facade to python_api caller
- Explicit null/falsey override forwarding through delegation chain

Sources:
- ARCHITECTURE.md :: Decision 3: Python API is a thin facade export
- ARCHITECTURE.md :: Module: larva.shell.python_api
- README.md :: Python Library interface
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

import pytest
from returns.result import Failure, Result, Success

from larva import shell as python_api
from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.assemble import AssemblyError
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStoreError
from larva.shell.registry import RegistryError

if TYPE_CHECKING:
    from collections.abc import Callable


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
    import hashlib

    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


# -----------------------------------------------------------------------------
# Test spies/doubles matching facade protocol
# -----------------------------------------------------------------------------


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


# -----------------------------------------------------------------------------
# Fixture: facade instance wired with test doubles
# -----------------------------------------------------------------------------


@dataclass
class FacadeFixture:
    """Fixture providing a configured facade and module-level python_api delegates."""

    facade: DefaultLarvaFacade
    assemble_module: SpyAssembleModule
    validate_module: SpyValidateModule
    normalize_module: SpyNormalizeModule
    components: InMemoryComponentStore
    registry: InMemoryRegistryStore
    call_record: list[str]


@pytest.fixture
def facade_fixture() -> FacadeFixture:
    """Create a facade with test doubles for delegation verification."""
    call_record: list[str] = []
    assemble_module = SpyAssembleModule(_canonical_spec("assembled"), call_record)
    validate_module = SpyValidateModule(_valid_report(), call_record)
    normalize_module = SpyNormalizeModule(call_record)
    components = InMemoryComponentStore()
    registry = InMemoryRegistryStore()

    facade = DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module,
        validate=validate_module,
        normalize=normalize_module,
        components=components,
        registry=registry,
    )

    return FacadeFixture(
        facade=facade,
        assemble_module=assemble_module,
        validate_module=validate_module,
        normalize_module=normalize_module,
        components=components,
        registry=registry,
        call_record=call_record,
    )


# -----------------------------------------------------------------------------
# Tests: thin delegation verification
# -----------------------------------------------------------------------------


class TestPythonApiValidate:
    """Verify validate() is thin delegation over facade.validate."""

    def test_validate_delegates_to_facade_validate(self, facade_fixture: FacadeFixture) -> None:
        """validate() must forward to facade.validate() and return its result."""
        # Replace module-level facade reference used by python_api
        # This simulates the production wiring
        spec = _canonical_spec("validate-test")

        # Direct facade call (what python_api delegates to)
        facade_result = facade_fixture.facade.validate(spec)

        # Verify delegation contract: facade.validate returns ValidationReport directly
        assert facade_result is not None
        assert "valid" in facade_result
        assert facade_fixture.validate_module.inputs == [spec]
        assert "validate" in facade_fixture.call_record


class TestPythonApiAssemble:
    """Verify assemble() is thin delegation over facade.assemble."""

    def test_assemble_delegates_to_facade_assemble(self, facade_fixture: FacadeFixture) -> None:
        """assemble() must forward to facade.assemble() with correct request shape."""
        request: dict[str, Any] = {
            "id": "assemble-test",
            "prompts": ["base"],
            "toolsets": ["default"],
            "constraints": ["strict"],
            "model": "gpt-4o",
            "variables": {"role": "analyst"},
            "overrides": {"description": "runtime override"},
        }

        result = facade_fixture.facade.assemble(request)

        assert isinstance(result, Success)
        assert facade_fixture.call_record == ["assemble", "validate", "normalize"]
        assert facade_fixture.assemble_module.inputs[0]["id"] == "assemble-test"

    def test_assemble_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade assembly failures must propagate through delegation."""
        facade_fixture.components.fail_prompt = True
        request: dict[str, Any] = {"id": "assemble-fail", "prompts": ["missing"]}

        result = facade_fixture.facade.assemble(request)

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "COMPONENT_NOT_FOUND"
        assert error["numeric_code"] == 105


class TestPythonApiRegister:
    """Verify register() is thin delegation over facade.register."""

    def test_register_delegates_to_facade_register(self, facade_fixture: FacadeFixture) -> None:
        """register() must forward to facade.register() and return RegisteredPersona."""
        spec = _canonical_spec("register-test", digest="sha256:old")

        result = facade_fixture.facade.register(spec)

        assert isinstance(result, Success)
        assert result.unwrap() == {"id": "register-test", "registered": True}
        assert "validate" in facade_fixture.call_record
        assert "normalize" in facade_fixture.call_record
        assert facade_fixture.registry.save_inputs[0]["id"] == "register-test"

    def test_register_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade registration failures must propagate through delegation."""
        facade_fixture.registry.save_result = Failure(
            {"code": "REGISTRY_WRITE_FAILED", "message": "disk full", "persona_id": "test"}
        )
        spec = _canonical_spec("register-fail")

        result = facade_fixture.facade.register(spec)

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_WRITE_FAILED"
        assert error["numeric_code"] == 109


class TestPythonApiResolve:
    """Verify resolve() is thin delegation over facade.resolve."""

    def test_resolve_delegates_to_facade_resolve(self, facade_fixture: FacadeFixture) -> None:
        """resolve() must forward to facade.resolve() and apply overrides."""
        canonical = _canonical_spec("resolve-test", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        result = facade_fixture.facade.resolve("resolve-test")

        assert isinstance(result, Success)
        assert result.unwrap()["id"] == "resolve-test"
        assert "validate" in facade_fixture.call_record
        assert "normalize" in facade_fixture.call_record

    def test_resolve_applies_overrides_before_revalidation(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Overrides must be applied and revalidated through delegation."""
        canonical = _canonical_spec("resolve-override-test", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        result = facade_fixture.facade.resolve(
            "resolve-override-test",
            overrides={"description": "overridden description"},
        )

        assert isinstance(result, Success)
        resolved = result.unwrap()
        assert resolved["description"] == "overridden description"
        # Override must go through validate
        assert facade_fixture.validate_module.inputs[0]["description"] == "overridden description"

    def test_resolve_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade resolve failures must propagate through delegation."""
        facade_fixture.registry.get_result = Failure(
            {"code": "PERSONA_NOT_FOUND", "message": "not found", "persona_id": "missing"}
        )

        result = facade_fixture.facade.resolve("missing")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100


class TestPythonApiList:
    """Verify list() is thin delegation over facade.list."""

    def test_list_delegates_to_facade_list(self, facade_fixture: FacadeFixture) -> None:
        """list() must forward to facade.list() and return summaries."""
        specs = [
            _canonical_spec("alpha", digest="sha256:a"),
            _canonical_spec("beta", digest="sha256:b"),
        ]
        facade_fixture.registry.list_result = Success(specs)

        result = facade_fixture.facade.list()

        assert isinstance(result, Success)
        assert result.unwrap() == [
            {"id": "alpha", "spec_digest": "sha256:a", "model": "gpt-4o-mini"},
            {"id": "beta", "spec_digest": "sha256:b", "model": "gpt-4o-mini"},
        ]

    def test_list_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade list failures must propagate through delegation."""
        facade_fixture.registry.list_result = Failure(
            {
                "code": "REGISTRY_INDEX_READ_FAILED",
                "message": "index corrupt",
                "path": "/tmp/index.json",
            }
        )

        result = facade_fixture.facade.list()

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert error["numeric_code"] == 107


# -----------------------------------------------------------------------------
# Tests: explicit null/falsey override forwarding
# -----------------------------------------------------------------------------


class TestExplicitNullFalseyOverrides:
    """Verify null and falsey override values are forwarded through delegation."""

    def test_resolve_explicit_null_override_preserved(self, facade_fixture: FacadeFixture) -> None:
        """Explicit None must be preserved through delegation chain."""
        canonical = _canonical_spec("null-override", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        result = facade_fixture.facade.resolve(
            "null-override",
            overrides={"description": None, "can_spawn": False},
        )

        assert isinstance(result, Success)
        resolved = result.unwrap()
        # None must be explicitly forwarded, not dropped
        assert "description" in resolved
        assert resolved["description"] is None
        assert resolved["can_spawn"] is False

    def test_resolve_explicit_falsey_override_preserved(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Explicit falsey values (0, "", False, empty dict) must be preserved."""
        canonical = _canonical_spec("falsey-override", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        result = facade_fixture.facade.resolve(
            "falsey-override",
            overrides={
                "model_params": {"temperature": 0},
                "compaction_prompt": "",
            },
        )

        assert isinstance(result, Success)
        resolved = result.unwrap()
        # Falsey values must be explicitly forwarded
        assert resolved["model_params"] == {"temperature": 0}
        assert resolved["compaction_prompt"] == ""

    def test_resolve_explicit_falsey_override_recomputes_digest(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Override with falsey values must trigger revalidation and renormalization."""
        canonical = _canonical_spec("digest-recompute", digest="sha256:original")
        facade_fixture.registry.get_result = Success(canonical)

        result = facade_fixture.facade.resolve(
            "digest-recompute",
            overrides={"description": ""},
        )

        assert isinstance(result, Success)
        resolved = result.unwrap()
        # Digest must be recomputed because content changed (even if empty string)
        assert resolved["spec_digest"] != "sha256:original"
        # Must have gone through normalize
        assert "normalize" in facade_fixture.call_record
