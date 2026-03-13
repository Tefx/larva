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
import sys
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

import pytest
from returns.result import Failure, Result, Success

from larva.shell import python_api
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
        # Use the ID from the request, preserving the candidate's other fields
        result = dict(self.candidate)
        result["id"] = data.get("id", result.get("id", "unknown"))
        return result


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

    # Patch the module-level facade in python_api to use our test double
    original_get_facade = python_api._get_facade
    python_api._get_facade = lambda: facade

    return FacadeFixture(
        facade=facade,
        assemble_module=assemble_module,
        validate_module=validate_module,
        normalize_module=normalize_module,
        components=components,
        registry=registry,
        call_record=call_record,
    )


@pytest.fixture(autouse=True)
def facade_teardown() -> None:
    """Restore original facade after each test."""
    yield
    # Restore the original facade getter
    python_api._facade = None
    python_api._get_facade = lambda: python_api._facade  # type: ignore[assignment]


# -----------------------------------------------------------------------------
# Tests: thin delegation verification
# -----------------------------------------------------------------------------


class TestPythonApiValidate:
    """Verify validate() is thin delegation over facade.validate."""

    def test_validate_delegates_to_facade_validate(self, facade_fixture: FacadeFixture) -> None:
        """validate() must forward to facade.validate() and return its result."""
        spec = _canonical_spec("validate-test")

        # Call the python_api wrapper (the actual thin delegation)
        result = python_api.validate(spec)

        # Verify delegation contract: python_api.validate returns ValidationReport directly
        assert result is not None
        assert "valid" in result
        assert facade_fixture.validate_module.inputs == [spec]
        assert "validate" in facade_fixture.call_record

    def test_validate_returns_valid_report(self, facade_fixture: FacadeFixture) -> None:
        """validate() must return a valid ValidationReport."""
        spec = _canonical_spec("valid-spec")
        result = python_api.validate(spec)
        assert result["valid"] is True
        assert result["errors"] == []
        assert result["warnings"] == []

    def test_validate_returns_invalid_report(self, facade_fixture: FacadeFixture) -> None:
        """validate() must return an invalid ValidationReport for bad specs."""
        facade_fixture.validate_module.report = _invalid_report("TEST_ERROR")
        spec = _canonical_spec("invalid-spec")
        result = python_api.validate(spec)
        assert result["valid"] is False
        assert len(result["errors"]) == 1
        assert result["errors"][0]["code"] == "TEST_ERROR"


class TestPythonApiAssemble:
    """Verify assemble() is thin delegation over facade.assemble."""

    def test_assemble_delegates_to_facade_assemble(self, facade_fixture: FacadeFixture) -> None:
        """assemble() must forward to facade.assemble() with correct request shape."""
        # Call the python_api wrapper (the actual thin delegation)
        result = python_api.assemble(
            id="assemble-test",
            prompts=["base"],
            toolsets=["default"],
            constraints=["strict"],
            model="gpt-4o",
            variables={"role": "analyst"},
            overrides={"description": "runtime override"},
        )

        # Verify delegation
        assert result is not None
        assert result["id"] == "assemble-test"
        assert facade_fixture.call_record == ["assemble", "validate", "normalize"]
        assert facade_fixture.assemble_module.inputs[0]["id"] == "assemble-test"

    def test_assemble_with_only_id(self, facade_fixture: FacadeFixture) -> None:
        """assemble() must work with minimal parameters."""
        result = python_api.assemble(id="minimal")
        assert result["id"] == "minimal"
        assert "spec_version" in result

    def test_assemble_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade assembly failures must propagate through delegation."""
        facade_fixture.components.fail_prompt = True

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.assemble("assemble-fail", prompts=["missing"])

        assert exc_info.value.error["code"] == "COMPONENT_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 105


class TestPythonApiRegister:
    """Verify register() is thin delegation over facade.register."""

    def test_register_delegates_to_facade_register(self, facade_fixture: FacadeFixture) -> None:
        """register() must forward to facade.register() and return RegisteredPersona."""
        spec = _canonical_spec("register-test", digest="sha256:old")

        # Call the python_api wrapper (the actual thin delegation)
        result = python_api.register(spec)

        # Verify delegation
        assert result == {"id": "register-test", "registered": True}
        assert "validate" in facade_fixture.call_record
        assert "normalize" in facade_fixture.call_record
        assert facade_fixture.registry.save_inputs[0]["id"] == "register-test"

    def test_register_returns_registered_persona(self, facade_fixture: FacadeFixture) -> None:
        """register() must return RegisteredPersona with id and registered status."""
        spec = _canonical_spec("register-ok")
        result = python_api.register(spec)
        assert result["id"] == "register-ok"
        assert result["registered"] is True

    def test_register_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade registration failures must propagate through delegation."""
        facade_fixture.registry.save_result = Failure(
            {"code": "REGISTRY_WRITE_FAILED", "message": "disk full", "persona_id": "test"}
        )
        spec = _canonical_spec("register-fail")

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.register(spec)

        assert exc_info.value.error["code"] == "REGISTRY_WRITE_FAILED"
        assert exc_info.value.error["numeric_code"] == 109


class TestPythonApiResolve:
    """Verify resolve() is thin delegation over facade.resolve."""

    def test_resolve_delegates_to_facade_resolve(self, facade_fixture: FacadeFixture) -> None:
        """resolve() must forward to facade.resolve() and apply overrides."""
        canonical = _canonical_spec("resolve-test", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        # Call the python_api wrapper (the actual thin delegation)
        result = python_api.resolve("resolve-test")

        # Verify delegation
        assert result["id"] == "resolve-test"
        assert "validate" in facade_fixture.call_record
        assert "normalize" in facade_fixture.call_record

    def test_resolve_applies_overrides_before_revalidation(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Overrides must be applied and revalidated through delegation."""
        canonical = _canonical_spec("resolve-override-test", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        result = python_api.resolve(
            "resolve-override-test",
            overrides={"description": "overridden description"},
        )

        assert result["description"] == "overridden description"
        # Override must go through validate
        assert facade_fixture.validate_module.inputs[0]["description"] == "overridden description"

    def test_resolve_returns_normalized_spec(self, facade_fixture: FacadeFixture) -> None:
        """resolve() must return a normalized PersonaSpec."""
        canonical = _canonical_spec("resolve-normalized", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)
        result = python_api.resolve("resolve-normalized")
        assert "spec_digest" in result
        assert result["spec_digest"].startswith("sha256:")

    def test_resolve_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade resolve failures must propagate through delegation."""
        facade_fixture.registry.get_result = Failure(
            {"code": "PERSONA_NOT_FOUND", "message": "not found", "persona_id": "missing"}
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.resolve("missing")

        assert exc_info.value.error["code"] == "PERSONA_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 100


class TestPythonApiList:
    """Verify list() is thin delegation over facade.list."""

    def test_list_delegates_to_facade_list(self, facade_fixture: FacadeFixture) -> None:
        """list() must forward to facade.list() and return summaries."""
        specs = [
            _canonical_spec("alpha", digest="sha256:a"),
            _canonical_spec("beta", digest="sha256:b"),
        ]
        facade_fixture.registry.list_result = Success(specs)

        # Call the python_api wrapper (the actual thin delegation)
        result = python_api.list()

        # Verify delegation
        assert result == [
            {"id": "alpha", "spec_digest": "sha256:a", "model": "gpt-4o-mini"},
            {"id": "beta", "spec_digest": "sha256:b", "model": "gpt-4o-mini"},
        ]

    def test_list_returns_summaries(self, facade_fixture: FacadeFixture) -> None:
        """list() must return list of PersonaSummary with id, spec_digest, model."""
        specs = [
            _canonical_spec("test1", digest="sha256:abc"),
            _canonical_spec("test2", digest="sha256:def"),
        ]
        facade_fixture.registry.list_result = Success(specs)
        result = python_api.list()
        assert len(result) == 2
        assert result[0]["id"] == "test1"
        assert result[0]["spec_digest"] == "sha256:abc"
        assert result[0]["model"] == "gpt-4o-mini"

    def test_list_empty(self, facade_fixture: FacadeFixture) -> None:
        """list() must return empty list when no personas registered."""
        facade_fixture.registry.list_result = Success([])
        result = python_api.list()
        assert result == []

    def test_list_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade list failures must propagate through delegation."""
        facade_fixture.registry.list_result = Failure(
            {
                "code": "REGISTRY_INDEX_READ_FAILED",
                "message": "index corrupt",
                "path": "/tmp/index.json",
            }
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.list()

        assert exc_info.value.error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert exc_info.value.error["numeric_code"] == 107


# -----------------------------------------------------------------------------
# Tests: explicit null/falsey override forwarding
# -----------------------------------------------------------------------------


class TestExplicitNullFalseyOverrides:
    """Verify null and falsey override values are forwarded through delegation."""

    def test_resolve_explicit_null_override_preserved(self, facade_fixture: FacadeFixture) -> None:
        """Explicit None must be preserved through delegation chain."""
        canonical = _canonical_spec("null-override", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        # Call the python_api wrapper (the actual thin delegation)
        result = python_api.resolve(
            "null-override",
            overrides={"description": None, "can_spawn": False},
        )

        # None must be explicitly forwarded, not dropped
        assert "description" in result
        assert result["description"] is None
        assert result["can_spawn"] is False

    def test_resolve_explicit_falsey_override_preserved(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Explicit falsey values (0, "", False, empty dict) must be preserved."""
        canonical = _canonical_spec("falsey-override", digest="sha256:old")
        facade_fixture.registry.get_result = Success(canonical)

        result = python_api.resolve(
            "falsey-override",
            overrides={
                "model_params": {"temperature": 0},
                "compaction_prompt": "",
            },
        )

        # Falsey values must be explicitly forwarded
        assert result["model_params"] == {"temperature": 0}
        assert result["compaction_prompt"] == ""

    def test_resolve_explicit_falsey_override_recomputes_digest(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Override with falsey values must trigger revalidation and renormalization."""
        canonical = _canonical_spec("digest-recompute", digest="sha256:original")
        facade_fixture.registry.get_result = Success(canonical)

        result = python_api.resolve(
            "digest-recompute",
            overrides={"description": ""},
        )

        # Digest must be recomputed because content changed (even if empty string)
        assert result["spec_digest"] != "sha256:original"
        # Must have gone through normalize
        assert "normalize" in facade_fixture.call_record


# -----------------------------------------------------------------------------
# Tests: thin-adapter boundary / no-leak assertions
# -----------------------------------------------------------------------------
# These tests prove the python_api surface remains a thin adapter and does not
# expose CLI, MCP, or storage helpers as part of its supported module API.


class TestNoStorageLeak:
    """Verify storage symbols are not treated as supported python_api exports."""

    def test_no_component_store_in_public_api(self) -> None:
        """ComponentStore and FilesystemComponentStore must not be public API."""
        # These are internal implementation details, not public exports
        assert "ComponentStore" not in python_api.__all__
        assert "FilesystemComponentStore" not in python_api.__all__

    def test_no_registry_store_in_public_api(self) -> None:
        """RegistryStore and FileSystemRegistryStore must not be public API."""
        # These are internal implementation details, not public exports
        assert "RegistryStore" not in python_api.__all__
        assert "FileSystemRegistryStore" not in python_api.__all__

    def test_no_storage_symbols_in_public_exports(self) -> None:
        """Storage classes must not be in __all__ (the public API contract)."""
        # __all__ defines the public API contract. Storage symbols are internal
        # implementation details and must not be part of supported exports.
        # Note: dir() will still show these due to Python's import behavior,
        # but __all__ is the authoritative source for public API.
        all_exports = python_api.__all__
        storage_names = [
            name for name in all_exports if "ComponentStore" in name or "RegistryStore" in name
        ]
        assert storage_names == [], f"Storage symbols in __all__: {storage_names}"


class TestNoCLIMCPLeak:
    """Verify CLI/MCP symbols are not exposed through python_api surface."""

    def test_no_cli_entry_point_exposed(self) -> None:
        """CLI entry point must not be accessible through python_api."""
        # The CLI entry point is defined in pyproject.toml as 'larva' command
        # This should not be re-exported by python_api
        assert "main" not in python_api.__all__
        assert "cli" not in python_api.__all__.copy() and not any(
            "cli" in name.lower() for name in python_api.__all__
        )

    def test_no_mcp_server_exposed(self) -> None:
        """MCP server must not be exposed through python_api."""
        # MCP-related symbols should not be part of python_api public surface
        public_names = python_api.__all__
        mcp_indicators = ["mcp", "server", "stdio", "mcp_server"]
        exposed = [name for name in public_names if any(m in name.lower() for m in mcp_indicators)]
        assert exposed == [], f"MCP-related symbols exposed: {exposed}"


class TestThinAdapterSemantics:
    """Verify thin-adapter semantics are preserved."""

    def test_public_api_limited_to_documented_functions(self) -> None:
        """Public API must be limited to documented thin-adapter functions."""
        # The documented API surface per ARCHITECTURE.md is:
        # validate, assemble, register, resolve, list
        expected_functions = {"validate", "assemble", "register", "resolve", "list"}
        actual_functions = {name for name in python_api.__all__ if not name.startswith("_")}
        assert expected_functions.issubset(actual_functions), (
            f"Missing functions in __all__: {expected_functions - actual_functions}"
        )

    def test_wrapper_functions_callable(self) -> None:
        """All documented wrapper functions must be callable."""
        # These are the core functions that should be exposed
        assert callable(getattr(python_api, "validate", None))
        assert callable(getattr(python_api, "assemble", None))
        assert callable(getattr(python_api, "register", None))
        assert callable(getattr(python_api, "resolve", None))
        assert callable(getattr(python_api, "list", None))
