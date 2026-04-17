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
import importlib
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pytest
from returns.result import Failure, Result, Success

from larva.shell import python_api
from larva.shell import python_api_components
from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.assemble import AssemblyError
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStoreError, FilesystemComponentStore
from larva.shell.registry import RegistryError
from tests.shell.fixture_taxonomy import (
    canonical_constraint_fixture,
    canonical_persona_spec,
    canonical_toolset_fixture,
    historical_constraint_fixture_with_legacy_field,
    historical_toolset_fixture_with_legacy_fields,
)

if TYPE_CHECKING:
    from collections.abc import Callable


def _canonical_spec(persona_id: str, digest: str = "sha256:canonical") -> PersonaSpec:
    return canonical_persona_spec(persona_id=persona_id, digest=digest)


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
        normalized = dict(spec)
        normalized["spec_digest"] = _digest_for(normalized)
        self.inputs.append(normalized)
        return normalized


@dataclass
class InMemoryComponentStore:
    prompt_text: str = "Prompt body"
    toolset: dict[str, str] = field(default_factory=lambda: {"shell": "read_only"})
    constraint: dict[str, object] = field(default_factory=canonical_constraint_fixture)
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
        return Success(canonical_toolset_fixture(capabilities))

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
    save_inputs: list[PersonaSpec] = field(default_factory=list)
    get_inputs: list[str] = field(default_factory=list)
    delete_inputs: list[str] = field(default_factory=list)
    clear_inputs: list[str] = field(default_factory=list)

    def save(self, spec: PersonaSpec) -> Result[None, RegistryError]:
        self.save_inputs.append(dict(spec))
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, RegistryError]:
        self.get_inputs.append(persona_id)
        return self.get_result

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        return self.list_result

    def delete(self, persona_id: str) -> Result[None, RegistryError]:
        self.delete_inputs.append(persona_id)
        return self.delete_result

    def clear(self, confirm: str) -> Result[int, RegistryError]:
        self.clear_inputs.append(confirm)
        return self.clear_result


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
def facade_fixture(monkeypatch: pytest.MonkeyPatch) -> FacadeFixture:
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

    # Patch the module-level facade getter for this test only.
    monkeypatch.setattr(python_api, "_get_facade", lambda: facade)

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

    def test_validate_real_facade_surfaces_registry_snapshot_warning(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Real python_api.validate must preserve canonical warning facts from the runtime path."""
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=SpyAssembleModule(_canonical_spec("assembled-unused"), []),
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(
                list_result=Success([_canonical_spec("known-child")]),
            ),
        )
        monkeypatch.setattr(python_api, "_get_facade", lambda: facade)
        spec = _canonical_spec("warning-runtime")
        spec["can_spawn"] = ["known-child", "missing-child"]

        result = python_api.validate(spec)

        assert result["valid"] is True
        assert result["errors"] == []
        assert (
            "can_spawn references ids outside the current registry snapshot: missing-child"
            in result["warnings"]
        )


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
            overrides={"description": "runtime override"},
        )

        # Verify delegation
        assert result is not None
        assert result["id"] == "assemble-test"
        assert facade_fixture.call_record == ["assemble", "validate", "normalize", "validate"]
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
        assert exc_info.value.error["details"]["component_type"] == "prompt"
        assert exc_info.value.error["details"]["component_name"] == "missing"

    def test_assemble_rejects_variables_in_overrides(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Assemble must reject variables in overrides at canonical boundary.

        Hard-cut policy: variables are not permitted at canonical assembly boundary.
        This test verifies the actual facade rejects variables in overrides.
        """
        # Use real facade to get actual validation behavior
        from larva.shell.shared import facade_factory

        # Clear any cached facade and get fresh one
        facade_factory._default_facade = None
        facade = facade_factory.build_default_facade()
        monkeypatch.setattr(python_api, "_get_facade", lambda: facade)

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.assemble(
                id="test-vars",
                overrides={"variables": {"role": "assistant"}},
            )

        assert exc_info.value.error["code"] == "FORBIDDEN_OVERRIDE_FIELD"
        assert exc_info.value.error["numeric_code"] == 113
        assert exc_info.value.error["details"]["field"] == "variables"


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
        """list() must forward to facade.list() and return summaries.

        Hard-cut policy: list normalizes specs before building summaries,
        so spec_digest values are recomputed by normalization.
        """
        specs = [
            _canonical_spec("alpha", digest="sha256:a"),
            _canonical_spec("beta", digest="sha256:b"),
        ]
        facade_fixture.registry.list_result = Success(specs)

        # Call the python_api wrapper (the actual thin delegation)
        result = python_api.list()

        # Verify delegation: spec_digests are recomputed by normalization
        assert len(result) == 2
        assert result[0]["id"] == "alpha"
        assert result[0]["description"] == "Persona alpha"
        assert result[0]["spec_digest"].startswith("sha256:")
        assert result[0]["model"] == "gpt-4o-mini"
        assert result[1]["id"] == "beta"
        assert result[1]["description"] == "Persona beta"
        assert result[1]["spec_digest"].startswith("sha256:")
        assert result[1]["model"] == "gpt-4o-mini"

    def test_list_returns_summaries(self, facade_fixture: FacadeFixture) -> None:
        """list() must return list of PersonaSummary with id, description, spec_digest, model.

        Hard-cut policy: spec_digest values are recomputed by normalization.
        """
        specs = [
            _canonical_spec("test1", digest="sha256:abc"),
            _canonical_spec("test2", digest="sha256:def"),
        ]
        facade_fixture.registry.list_result = Success(specs)
        result = python_api.list()
        assert len(result) == 2
        assert result[0]["id"] == "test1"
        assert result[0]["description"] == "Persona test1"
        assert result[0]["spec_digest"].startswith("sha256:")
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

    def test_module_singleton_uses_shared_default_factory(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """python_api should build its singleton through the shared default factory."""
        sentinel = object()
        calls: list[str] = []

        def fake_build_default_facade() -> object:
            calls.append("build")
            return sentinel

        monkeypatch.setattr(
            "larva.shell.shared.facade_factory.build_default_facade",
            fake_build_default_facade,
        )

        reloaded = importlib.reload(python_api)
        try:
            assert calls == ["build"]
            assert reloaded._get_facade() is sentinel
            assert reloaded._get_facade() is sentinel
        finally:
            importlib.reload(reloaded)

    def test_python_api_source_has_no_direct_default_facade_constructor(self) -> None:
        """python_api should no longer construct DefaultLarvaFacade directly."""
        assert python_api.__file__ is not None
        source = Path(python_api.__file__).read_text(encoding="utf-8")

        assert "DefaultLarvaFacade(" not in source


class TestPythonApiComponentList:
    """Verify component_list() is thin delegation over FilesystemComponentStore.list_components."""

    def test_component_list_delegates_to_component_store(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_list() must forward to FilesystemComponentStore.list_components()."""
        call_record: list[str] = []

        class MockComponentStore:
            def list_components(self) -> Result[dict[str, list[str]], ComponentStoreError]:
                call_record.append("list_components")
                return Success(
                    {
                        "prompts": ["code-reviewer", "analyst"],
                        "toolsets": ["default"],
                        "constraints": ["strict"],
                        "models": ["gpt-4o-mini"],
                    }
                )

        mock_store = MockComponentStore()
        monkeypatch.setattr(python_api_components, "_component_store", mock_store)

        result = python_api.component_list()

        assert call_record == ["list_components"]
        assert "prompts" in result
        assert result["prompts"] == ["code-reviewer", "analyst"]

    def test_component_list_returns_dict_with_all_keys(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_list() must return dict with all component type keys."""

        class MockComponentStore:
            def list_components(self) -> Result[dict[str, list[str]], ComponentStoreError]:
                return Success(
                    {
                        "prompts": [],
                        "toolsets": [],
                        "constraints": [],
                        "models": [],
                    }
                )

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())
        result = python_api.component_list()
        assert result == {"prompts": [], "toolsets": [], "constraints": [], "models": []}

    def test_component_list_failure_raises_larva_api_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_list() failures must raise LarvaApiError."""

        class MockComponentStore:
            def list_components(self) -> Result[dict[str, list[str]], ComponentStoreError]:
                return Failure(
                    ComponentStoreError(
                        "Components directory not found",
                        component_type=None,
                        component_name=None,
                    )
                )

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.component_list()

        assert exc_info.value.error["code"] == "INTERNAL"
        assert exc_info.value.error["numeric_code"] == 10
        assert exc_info.value.error["details"]["reason"] == "store_unavailable"


class TestPythonApiComponentShow:
    """Verify component_show() is thin delegation over FilesystemComponentStore loaders."""

    def test_component_show_uses_shared_component_query_service(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show() must delegate shared kind normalization and projection."""
        recorded: dict[str, object] = {}

        def _fake_query_component(
            component_store: object,
            *,
            component_type: str,
            component_name: str,
            operation: str,
        ) -> Result[dict[str, object], LarvaError]:
            recorded.update(
                {
                    "component_store": component_store,
                    "component_type": component_type,
                    "component_name": component_name,
                    "operation": operation,
                }
            )
            return Success({"text": "Shared query payload"})

        store = InMemoryComponentStore()
        monkeypatch.setattr(python_api_components, "_component_store", store)
        monkeypatch.setattr(python_api_components, "query_component", _fake_query_component)

        result = python_api.component_show("prompts", "test-prompt")

        assert result == {"text": "Shared query payload"}
        assert recorded == {
            "component_store": store,
            "component_type": "prompts",
            "component_name": "test-prompt",
            "operation": "python_api.component_show",
        }

    def test_component_show_prompt_delegates_to_load_prompt(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show('prompts', name) must forward to load_prompt()."""
        call_record: list[str] = []

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                call_record.append(f"load_prompt:{name}")
                return Success({"text": f"Prompt {name} content"})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())
        result = python_api.component_show("prompts", "test-prompt")

        assert call_record == ["load_prompt:test-prompt"]
        assert result == {"text": "Prompt test-prompt content"}

    def test_component_show_plural_alias_delegates_to_load_prompt(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show('prompts', name) must normalize to load_prompt()."""
        call_record: list[str] = []

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                call_record.append(f"load_prompt:{name}")
                return Success({"text": f"Prompt {name} content"})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())
        result = python_api.component_show("prompts", "test-prompt")

        assert call_record == ["load_prompt:test-prompt"]
        assert result == {"text": "Prompt test-prompt content"}

    def test_component_show_toolsets_delegates_to_load_toolset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show('toolsets', name) must forward to load_toolset()."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Success({})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({"capabilities": {"shell": "read_write"}})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())
        result = python_api.component_show("toolsets", "default")
        # Canonical cutover: component output stays capabilities-only.
        assert result == {"capabilities": {"shell": "read_write"}}

    def test_component_show_constraints_delegates_to_load_constraint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show('constraints', name) must forward to load_constraint()."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Success({})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())
        result = python_api.component_show("constraints", "strict")
        # Canonical cutover: constraint output omits forbidden runtime-policy fields.
        assert result == {}

    def test_component_show_models_delegates_to_load_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show('models', name) must forward to load_model()."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Success({})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({"model": "gpt-4o-mini"})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())
        result = python_api.component_show("models", "gpt-4")
        assert result == {"model": "gpt-4o-mini"}

    @pytest.mark.parametrize("component_type", ["prompt", "toolset", "constraint", "model"])
    def test_component_show_singular_alias_rejected_as_invalid_input(
        self, monkeypatch: pytest.MonkeyPatch, component_type: str
    ) -> None:
        """component_show() must reject singular component type aliases at public ingress."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Success({"text": name})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({"capabilities": {"shell": "read_only"}})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({"can_spawn": False})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({"model": name})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.component_show(component_type, "legacy-alias")

        assert exc_info.value.error["code"] == "INVALID_INPUT"
        assert exc_info.value.error["numeric_code"] == 1
        assert exc_info.value.error["details"]["reason"] == "invalid_kind"

    def test_component_show_toolsets_rejects_legacy_tools_field(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show() must fail closed on toolsets that still expose legacy tools."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Success({})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                del name
                return Success(historical_toolset_fixture_with_legacy_fields())

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.component_show("toolsets", "readonly")

        assert exc_info.value.error["code"] == "COMPONENT_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 105
        assert "tools" in exc_info.value.error["message"]

    def test_component_show_constraints_rejects_legacy_side_effect_policy(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show() must fail closed on constraints that still expose side_effect_policy."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Success({})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                del name
                return Success(historical_constraint_fixture_with_legacy_field())

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.component_show("constraints", "safe")

        assert exc_info.value.error["code"] == "COMPONENT_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 105
        assert "side_effect_policy" in exc_info.value.error["message"]

    def test_component_show_invalid_type_raises_invalid_input(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show() with invalid type must raise LarvaApiError with code INVALID_INPUT/1."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Success({})

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.component_show("invalid_type", "some-name")

        assert exc_info.value.error["code"] == "INVALID_INPUT"
        assert exc_info.value.error["numeric_code"] == 1
        assert "Invalid component type" in exc_info.value.error["message"]
        assert "prompts | toolsets | constraints | models" in exc_info.value.error["message"]
        assert exc_info.value.error["details"]["reason"] == "invalid_kind"

    def test_component_show_not_found_raises_component_not_found(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """component_show() for missing component must raise LarvaApiError with code COMPONENT_NOT_FOUND/105."""

        class MockComponentStore:
            def load_prompt(self, name: str) -> Result[dict[str, str], ComponentStoreError]:
                return Failure(
                    ComponentStoreError(
                        f"Prompt not found: {name}",
                        component_type="prompt",
                        component_name=name,
                    )
                )

            def load_toolset(
                self, name: str
            ) -> Result[dict[str, dict[str, str]], ComponentStoreError]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], ComponentStoreError]:
                return Success({})

        monkeypatch.setattr(python_api_components, "_component_store", MockComponentStore())

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.component_show("prompt", "missing-prompt")

        assert exc_info.value.error["code"] == "COMPONENT_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 105
        assert exc_info.value.error["details"]["component_type"] == "prompt"
        assert exc_info.value.error["details"]["component_name"] == "missing-prompt"


class TestPythonApiClone:
    """Verify clone() is thin delegation over facade.clone."""

    def test_clone_delegates_to_facade_clone(self, facade_fixture: FacadeFixture) -> None:
        """clone() must forward to facade.clone() and return PersonaSpec."""
        source_spec = _canonical_spec("source-to-clone", digest="sha256:original")
        facade_fixture.registry.get_result = Success(source_spec)

        result = python_api.clone("source-to-clone", "cloned-persona")

        assert result["id"] == "cloned-persona"
        assert facade_fixture.registry.get_inputs == ["source-to-clone"]
        assert len(facade_fixture.registry.save_inputs) == 1
        assert facade_fixture.registry.save_inputs[0]["id"] == "cloned-persona"

    def test_clone_returns_cloned_persona_with_new_id(self, facade_fixture: FacadeFixture) -> None:
        """clone() must return PersonaSpec with new_id and recomputed spec_digest."""
        source_spec = _canonical_spec("original-persona", digest="sha256:old")
        facade_fixture.registry.get_result = Success(source_spec)

        result = python_api.clone("original-persona", "new-persona")

        assert result["id"] == "new-persona"
        assert result["description"] == "Persona original-persona"
        # Digest should differ from source because content changed
        assert result["spec_digest"] != "sha256:old"

    def test_clone_preserves_canonical_fields_without_id_and_digest(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """clone() must preserve canonical source fields except id and spec_digest."""
        source_spec: PersonaSpec = {
            "id": "source-preserves",
            "description": "Original description",
            "prompt": "You are careful.",
            "model": "gpt-4",
            "capabilities": {"shell": "full_access"},  # canonical field
            "model_params": {"temperature": 0.5, "max_tokens": 2000},
            "can_spawn": True,
            "compaction_prompt": "Summarize everything.",
            "spec_version": "0.1.0",
            "spec_digest": "sha256:source-digest",
        }
        facade_fixture.registry.get_result = Success(source_spec)

        result = python_api.clone("source-preserves", "target-preserves")

        assert result["description"] == "Original description"
        assert result["prompt"] == "You are careful."
        assert result["model"] == "gpt-4"
        assert result["capabilities"] == {"shell": "full_access"}
        assert "tools" not in result
        assert result["model_params"] == {"temperature": 0.5, "max_tokens": 2000}
        assert "side_effect_policy" not in result
        assert result["can_spawn"] is True
        assert result["compaction_prompt"] == "Summarize everything."
        assert result["spec_version"] == "0.1.0"
        assert result["id"] == "target-preserves"
        # spec_digest is recomputed, not copied from source
        assert result["spec_digest"] != "sha256:source-digest"

    def test_clone_not_found_raises_larva_api_error(self, facade_fixture: FacadeFixture) -> None:
        """clone() with non-existent source_id must raise LarvaApiError."""
        facade_fixture.registry.get_result = Failure(
            {"code": "PERSONA_NOT_FOUND", "message": "not found", "persona_id": "missing"}
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.clone("missing", "cloned")

        assert exc_info.value.error["code"] == "PERSONA_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 100

    def test_clone_validation_failure_raises_larva_api_error(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """clone() with validation failure on cloned spec must raise LarvaApiError."""
        source_spec = _canonical_spec("valid-source", digest="sha256:valid")
        facade_fixture.registry.get_result = Success(source_spec)
        facade_fixture.validate_module.report = _invalid_report("PERSONA_INVALID")

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.clone("valid-source", "Invalid_Clone_Id")

        assert exc_info.value.error["code"] == "PERSONA_INVALID"
        assert exc_info.value.error["numeric_code"] == 101

    def test_clone_write_failure_raises_larva_api_error(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """clone() with registry save failure must raise LarvaApiError."""
        source_spec = _canonical_spec("source-write-fail", digest="sha256:source")
        facade_fixture.registry.get_result = Success(source_spec)
        facade_fixture.registry.save_result = Failure(
            {
                "code": "REGISTRY_WRITE_FAILED",
                "message": "disk full",
                "persona_id": "cloned-write-fail",
                "path": "/tmp/cloned-write-fail.json",
            }
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.clone("source-write-fail", "cloned-write-fail")

        assert exc_info.value.error["code"] == "REGISTRY_WRITE_FAILED"
        assert exc_info.value.error["numeric_code"] == 109


class TestPythonApiDelete:
    """Verify delete() is thin delegation over facade.delete."""

    def test_delete_delegates_to_facade_delete(self, facade_fixture: FacadeFixture) -> None:
        """delete() must forward to facade.delete() and return DeletedPersona."""
        facade_fixture.registry.delete_result = Success(None)  # type: ignore

        result = python_api.delete("test-persona")

        assert result == {"id": "test-persona", "deleted": True}
        assert facade_fixture.registry.delete_inputs == ["test-persona"]  # type: ignore

    def test_delete_returns_deleted_persona(self, facade_fixture: FacadeFixture) -> None:
        """delete() must return DeletedPersona with id and deleted status."""
        facade_fixture.registry.delete_result = Success(None)  # type: ignore

        result = python_api.delete("old-persona")
        assert result["id"] == "old-persona"
        assert result["deleted"] is True

    def test_delete_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade delete failures must propagate through delegation."""
        facade_fixture.registry.delete_result = Failure(
            {"code": "PERSONA_NOT_FOUND", "message": "persona not found", "persona_id": "missing"}
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.delete("missing")

        assert exc_info.value.error["code"] == "PERSONA_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 100


class TestPythonApiClear:
    """Verify clear() is thin delegation over facade.clear."""

    def test_clear_delegates_to_facade_clear(self, facade_fixture: FacadeFixture) -> None:
        """clear() must forward to facade.clear() and return count."""
        facade_fixture.registry.clear_result = Success(5)  # type: ignore

        result = python_api.clear(confirm="CLEAR REGISTRY")

        assert result == 5
        assert facade_fixture.registry.clear_inputs == ["CLEAR REGISTRY"]  # type: ignore

    def test_clear_returns_count(self, facade_fixture: FacadeFixture) -> None:
        """clear() must return the count of personas removed."""
        facade_fixture.registry.clear_result = Success(3)  # type: ignore

        result = python_api.clear(confirm="CLEAR REGISTRY")
        assert result == 3

    def test_clear_wrong_confirm_raises_error(self, facade_fixture: FacadeFixture) -> None:
        """clear() with wrong confirm token must raise LarvaApiError."""
        facade_fixture.registry.clear_result = Failure(
            {"code": "INVALID_CONFIRMATION_TOKEN", "message": "wrong confirm token"}
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.clear(confirm="WRONG TOKEN")

        assert exc_info.value.error["code"] == "INVALID_CONFIRMATION_TOKEN"
        assert exc_info.value.error["numeric_code"] == 112

    def test_clear_positional_arg_raises_typeerror(self, facade_fixture: FacadeFixture) -> None:
        """clear() must be keyword-only - positional arg must raise TypeError."""
        with pytest.raises(TypeError):
            python_api.clear("CLEAR REGISTRY")  # type: ignore


class TestPythonApiUpdate:
    """Verify update() is thin delegation over facade.update."""

    def test_update_delegates_to_facade_update(self, facade_fixture: FacadeFixture) -> None:
        """update() must forward to facade.update() and return PersonaSpec."""
        existing = _canonical_spec("update-test")
        facade_fixture.registry.get_result = Success(existing)

        result = python_api.update("update-test", patches={"description": "Updated"})

        assert result["id"] == "update-test"
        assert "validate" in facade_fixture.call_record
        assert "normalize" in facade_fixture.call_record

    def test_update_returns_updated_spec(self, facade_fixture: FacadeFixture) -> None:
        """update() must return the updated PersonaSpec."""
        existing = _canonical_spec("update-ok")
        existing["description"] = "Original description"
        facade_fixture.registry.get_result = Success(existing)

        result = python_api.update("update-ok", patches={"description": "New description"})

        assert "spec_digest" in result
        assert result["spec_digest"].startswith("sha256:")

    def test_update_failure_passthrough_from_facade(self, facade_fixture: FacadeFixture) -> None:
        """Facade update failures must propagate through delegation."""
        facade_fixture.registry.get_result = Failure(
            {"code": "PERSONA_NOT_FOUND", "message": "persona not found", "persona_id": "missing"}
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.update("missing", patches={"description": "x"})

        assert exc_info.value.error["code"] == "PERSONA_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 100

    def test_update_validation_failure_propagates(self, facade_fixture: FacadeFixture) -> None:
        """update() validation failures must propagate through delegation."""
        existing = _canonical_spec("update-invalid")
        facade_fixture.registry.get_result = Success(existing)
        facade_fixture.validate_module.report = _invalid_report("INVALID_SPEC_VERSION")

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.update("update-invalid", patches={"description": None})

        assert exc_info.value.error["code"] == "PERSONA_INVALID"
        assert exc_info.value.error["numeric_code"] == 101

    def test_update_forbidden_patch_field_propagates_structured_error(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """update() must surface forbidden patch fields as structured domain errors."""
        existing = _canonical_spec("update-tools")
        facade_fixture.registry.get_result = Success(existing)

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.update("update-tools", patches={"tools": {"shell": "read_write"}})

        assert exc_info.value.error["code"] == "FORBIDDEN_PATCH_FIELD"
        assert exc_info.value.error["numeric_code"] == 114
        assert exc_info.value.error["details"] == {"field": "tools", "key": "tools"}

    def test_update_in_all(self) -> None:
        """update must be in __all__."""
        assert "update" in python_api.__all__

    def test_update_preserves_falsey_values(self, facade_fixture: FacadeFixture) -> None:
        """update() must preserve explicit falsey values in patches."""
        existing = _canonical_spec("update-falsey")
        existing["description"] = "Original"
        existing["can_spawn"] = True
        facade_fixture.registry.get_result = Success(existing)

        result = python_api.update(
            "update-falsey",
            patches={"description": None, "can_spawn": False},
        )

        assert "validate" in facade_fixture.call_record
        assert "normalize" in facade_fixture.call_record


class TestPythonApiExports:
    """Verify Python API exports include new functions."""

    def test_validate_in_all(self) -> None:
        """validate must be in __all__."""
        assert "validate" in python_api.__all__

    def test_assemble_in_all(self) -> None:
        """assemble must be in __all__."""
        assert "assemble" in python_api.__all__

    def test_register_in_all(self) -> None:
        """register must be in __all__."""
        assert "register" in python_api.__all__

    def test_resolve_in_all(self) -> None:
        """resolve must be in __all__."""
        assert "resolve" in python_api.__all__

    def test_list_in_all(self) -> None:
        """list must be in __all__."""
        assert "list" in python_api.__all__

    def test_clone_in_all(self) -> None:
        """clone must be in __all__."""
        assert "clone" in python_api.__all__

    def test_component_list_in_all(self) -> None:
        """component_list must be in __all__."""
        assert "component_list" in python_api.__all__

    def test_component_show_in_all(self) -> None:
        """component_show must be in __all__."""
        assert "component_show" in python_api.__all__

    def test_delete_in_all(self) -> None:
        """delete must be in __all__."""
        assert "delete" in python_api.__all__

    def test_clear_in_all(self) -> None:
        """clear must be in __all__."""
        assert "clear" in python_api.__all__

    def test_deleted_persona_in_all(self) -> None:
        """DeletedPersona must be in __all__."""
        assert "DeletedPersona" in python_api.__all__

    def test_cleared_registry_in_all(self) -> None:
        """ClearedRegistry must be in __all__."""
        assert "ClearedRegistry" in python_api.__all__

    def test_export_all_in_all(self) -> None:
        """export_all must be in __all__."""
        assert "export_all" in python_api.__all__

    def test_export_ids_in_all(self) -> None:
        """export_ids must be in __all__."""
        assert "export_ids" in python_api.__all__


class TestPythonApiExportAll:
    """Verify export_all() is thin delegation over facade.export_all."""

    def test_export_all_delegates_to_facade_export_all(self, facade_fixture: FacadeFixture) -> None:
        """export_all() must forward to facade.export_all()."""
        spec_alpha = _canonical_spec("export-alpha", digest="sha256:alpha")
        spec_beta = _canonical_spec("export-beta", digest="sha256:beta")
        facade_fixture.registry.list_result = Success([spec_alpha, spec_beta])

        result = python_api.export_all()

        assert len(result) == 2
        assert result[0]["id"] == "export-alpha"
        assert result[1]["id"] == "export-beta"

    def test_export_all_returns_empty_list_for_empty_registry(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """export_all() must return empty list when no personas registered."""
        facade_fixture.registry.list_result = Success([])
        result = python_api.export_all()
        assert result == []

    def test_export_all_returns_full_specs_not_summaries(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """export_all() returns complete PersonaSpec objects, not summaries.

        Hard-cut policy: export normalizes each spec before returning,
        so spec_digest values are recomputed.
        """
        spec = _canonical_spec("full-spec", digest="sha256:full")
        spec["description"] = "Full description"
        spec["prompt"] = "Full prompt"
        facade_fixture.registry.list_result = Success([spec])

        result = python_api.export_all()

        assert len(result) == 1
        exported_spec = result[0]
        assert exported_spec["id"] == "full-spec"
        assert exported_spec["description"] == "Full description"
        assert exported_spec["prompt"] == "Full prompt"
        assert exported_spec["model"] == "gpt-4o-mini"
        # Hard-cut: spec_digest is recomputed by normalization
        assert exported_spec["spec_digest"].startswith("sha256:")
        assert "tools" not in exported_spec
        assert "side_effect_policy" not in exported_spec

    def test_export_all_failure_raises_larva_api_error(self, facade_fixture: FacadeFixture) -> None:
        """Facade export_all failures must raise LarvaApiError."""
        facade_fixture.registry.list_result = Failure(
            {
                "code": "REGISTRY_INDEX_READ_FAILED",
                "message": "index corrupt",
                "path": "/tmp/index.json",
            }
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.export_all()

        assert exc_info.value.error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert exc_info.value.error["numeric_code"] == 107


class TestPythonApiExportIds:
    """Verify export_ids() is thin delegation over facade.export_ids."""

    def test_export_ids_delegates_to_facade_export_ids(self, facade_fixture: FacadeFixture) -> None:
        """export_ids() must forward to facade.export_ids()."""
        spec_one = _canonical_spec("export-one", digest="sha256:one")
        spec_two = _canonical_spec("export-two", digest="sha256:two")

        def get_by_id(persona_id: str) -> Result[PersonaSpec, RegistryError]:
            if persona_id == "export-one":
                return Success(spec_one)
            if persona_id == "export-two":
                return Success(spec_two)
            return Failure({"code": "PERSONA_NOT_FOUND", "message": "not found"})

        facade_fixture.registry.get_result = Success(spec_one)
        facade_fixture.registry.get = get_by_id  # type: ignore[method-assign]

        result = python_api.export_ids(["export-one", "export-two"])

        assert len(result) == 2
        assert result[0]["id"] == "export-one"
        assert result[1]["id"] == "export-two"

    def test_export_ids_preserves_input_order(self, facade_fixture: FacadeFixture) -> None:
        """export_ids() must return specs in same order as input ids."""
        spec_a = _canonical_spec("export-a", digest="sha256:a")
        spec_b = _canonical_spec("export-b", digest="sha256:b")
        spec_c = _canonical_spec("export-c", digest="sha256:c")

        def get_by_id(persona_id: str) -> Result[PersonaSpec, RegistryError]:
            if persona_id == "export-a":
                return Success(spec_a)
            if persona_id == "export-b":
                return Success(spec_b)
            if persona_id == "export-c":
                return Success(spec_c)
            return Failure({"code": "PERSONA_NOT_FOUND", "message": "not found"})

        facade_fixture.registry.get_result = Success(spec_a)
        facade_fixture.registry.get = get_by_id  # type: ignore[method-assign]

        # Request in order b, a, c
        result = python_api.export_ids(["export-b", "export-a", "export-c"])

        assert len(result) == 3
        assert result[0]["id"] == "export-b"
        assert result[1]["id"] == "export-a"
        assert result[2]["id"] == "export-c"

    def test_export_ids_empty_list_returns_empty_list(self, facade_fixture: FacadeFixture) -> None:
        """export_ids() with empty ids returns empty list immediately."""
        result = python_api.export_ids([])
        assert result == []

    def test_export_ids_single_id_returns_single_element_list(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Single id returns list with one spec, not the spec directly."""
        spec_single = _canonical_spec("export-single", digest="sha256:single")
        facade_fixture.registry.get_result = Success(spec_single)

        result = python_api.export_ids(["export-single"])

        assert isinstance(result, list)
        assert len(result) == 1
        assert result[0]["id"] == "export-single"

    def test_export_ids_not_found_raises_larva_api_error(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Facade PERSONA_NOT_FOUND failures must raise LarvaApiError."""
        facade_fixture.registry.get_result = Failure(
            {"code": "PERSONA_NOT_FOUND", "message": "not found", "persona_id": "missing"}
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.export_ids(["missing"])

        assert exc_info.value.error["code"] == "PERSONA_NOT_FOUND"
        assert exc_info.value.error["numeric_code"] == 100

    def test_export_ids_returns_full_specs_not_summaries(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """export_ids() returns complete PersonaSpec objects, not summaries.

        Hard-cut policy: export normalizes each spec before returning,
        so spec_digest values are recomputed.
        """
        spec = _canonical_spec("full-spec", digest="sha256:full")
        spec["description"] = "Full description"
        spec["prompt"] = "Full prompt"
        facade_fixture.registry.get_result = Success(spec)

        result = python_api.export_ids(["full-spec"])

        assert len(result) == 1
        exported_spec = result[0]
        assert exported_spec["id"] == "full-spec"
        assert exported_spec["description"] == "Full description"
        assert exported_spec["prompt"] == "Full prompt"
        assert exported_spec["model"] == "gpt-4o-mini"
        # Hard-cut: spec_digest is recomputed by normalization
        assert exported_spec["spec_digest"].startswith("sha256:")
        assert "tools" not in exported_spec
        assert "side_effect_policy" not in exported_spec

    def test_export_ids_registry_failure_raises_larva_api_error(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Facade REGISTRY_SPEC_READ_FAILED failures must raise LarvaApiError."""
        facade_fixture.registry.get_result = Failure(
            {
                "code": "REGISTRY_SPEC_READ_FAILED",
                "message": "failed to read spec",
                "persona_id": "broken",
                "path": "/tmp/broken.json",
            }
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.export_ids(["broken"])

        assert exc_info.value.error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert exc_info.value.error["numeric_code"] == 108

    def test_update_batch_in_all(self) -> None:
        """update_batch must be in __all__."""
        assert "update_batch" in python_api.__all__


class TestPythonApiUpdateBatch:
    """Verify update_batch() is thin delegation over facade.update_batch."""

    def test_update_batch_delegates_to_facade_update_batch(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """update_batch() must forward to facade.update_batch() and return BatchUpdateResult."""
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        facade_fixture.registry.list_result = Success([spec_alpha, spec_beta])

        result = python_api.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"description": "Updated"},
        )

        assert result["matched"] == 2
        assert result["updated"] == 2
        assert len(result["items"]) == 2
        assert result["items"][0]["id"] == "alpha"
        assert result["items"][0]["updated"] is True
        assert result["items"][1]["id"] == "beta"
        assert result["items"][1]["updated"] is True

    def test_update_batch_returns_matched_and_updated_counts(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """update_batch() returns BatchUpdateResult with matched, updated, items."""
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        facade_fixture.registry.list_result = Success([spec_alpha, spec_beta])

        result = python_api.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"description": "Updated"},
        )

        assert "matched" in result
        assert "updated" in result
        assert "items" in result
        assert isinstance(result["matched"], int)
        assert isinstance(result["updated"], int)
        assert isinstance(result["items"], list)

    def test_update_batch_dry_run_returns_preview_without_writes(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """update_batch() with dry_run=True returns preview without updating."""
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        facade_fixture.registry.list_result = Success([spec_alpha, spec_beta])

        result = python_api.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"description": "Should not persist"},
            dry_run=True,
        )

        assert result["matched"] == 2
        assert result["updated"] == 0
        assert result["items"][0]["updated"] is False
        assert result["items"][1]["updated"] is False
        # No saves should have occurred
        assert facade_fixture.registry.save_inputs == []

    def test_update_batch_where_uses_and_semantics(self, facade_fixture: FacadeFixture) -> None:
        """update_batch() multiple where clauses use AND semantics."""
        spec_match = _canonical_spec("match")
        spec_match["model"] = "gpt-4o"
        spec_match["model_params"] = {"temperature": 0.7}

        spec_wrong_model = _canonical_spec("wrong-model")
        spec_wrong_temp = _canonical_spec("wrong-temp")
        spec_wrong_temp["model"] = "gpt-4o"

        facade_fixture.registry.list_result = Success(
            [spec_match, spec_wrong_model, spec_wrong_temp]
        )

        result = python_api.update_batch(
            where={"model": "gpt-4o", "model_params.temperature": 0.7},
            patches={"description": "Matched"},
        )

        assert result["matched"] == 1
        assert result["updated"] == 1
        assert result["items"][0]["id"] == "match"

    def test_update_batch_no_matches_returns_zero_counts(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """update_batch() with no matches returns matched=0, updated=0, items=[]."""
        spec_alpha = _canonical_spec("alpha")
        spec_alpha["model"] = "gpt-4"  # Different model
        facade_fixture.registry.list_result = Success([spec_alpha])

        result = python_api.update_batch(
            where={"model": "nonexistent-model"},
            patches={"description": "Test"},
        )

        assert result["matched"] == 0
        assert result["updated"] == 0
        assert result["items"] == []

    @pytest.mark.parametrize(
        ("where_key", "expected_field", "expected_value"),
        [
            ("tools.shell", "tools", "read_only"),
            ("side_effect_policy", "side_effect_policy", "read_only"),
        ],
    )
    def test_update_batch_rejects_legacy_where_fields(
        self,
        facade_fixture: FacadeFixture,
        where_key: str,
        expected_field: str,
        expected_value: object,
    ) -> None:
        """update_batch() must fail closed on non-canonical where vocabulary."""
        facade_fixture.registry.list_result = Success([_canonical_spec("alpha")])

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.update_batch(
                where={where_key: expected_value},
                patches={"description": "Updated"},
            )

        assert exc_info.value.error["code"] == "INVALID_INPUT"
        assert exc_info.value.error["numeric_code"] == 1
        assert expected_field in exc_info.value.error["message"]
        assert exc_info.value.error["details"]["field"] == expected_field
        assert exc_info.value.error["details"]["where_key"] == where_key
        assert facade_fixture.registry.save_inputs == []

    def test_update_batch_empty_where_matches_all(self, facade_fixture: FacadeFixture) -> None:
        """update_batch() with empty where clause matches all personas."""
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        facade_fixture.registry.list_result = Success([spec_alpha, spec_beta])

        result = python_api.update_batch(
            where={},
            patches={"description": "All updated"},
        )

        assert result["matched"] == 2
        assert result["updated"] == 2

    def test_update_batch_failure_raises_larva_api_error(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """Facade update_batch failures must raise LarvaApiError."""
        facade_fixture.registry.list_result = Failure(
            {
                "code": "REGISTRY_INDEX_READ_FAILED",
                "message": "cannot read registry index",
                "path": "/tmp/registry/index.json",
            }
        )

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.update_batch(
                where={"model": "gpt-4o-mini"},
                patches={"description": "Test"},
            )

        assert exc_info.value.error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert exc_info.value.error["numeric_code"] == 107

    def test_update_batch_validation_failure_propagates(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """update_batch() validation failures must propagate."""
        spec_alpha = _canonical_spec("alpha")
        facade_fixture.registry.list_result = Success([spec_alpha])
        facade_fixture.validate_module.report = _invalid_report("PERSONA_INVALID")

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.update_batch(
                where={"model": "gpt-4o-mini"},
                patches={"description": "Updated"},
            )

        assert exc_info.value.error["code"] == "PERSONA_INVALID"
        assert exc_info.value.error["numeric_code"] == 101

    def test_update_batch_stops_on_first_error(self, facade_fixture: FacadeFixture) -> None:
        """update_batch() stops processing on first update failure."""
        spec_first = _canonical_spec("first")
        spec_second = _canonical_spec("second")
        spec_third = _canonical_spec("third")
        facade_fixture.registry.list_result = Success([spec_first, spec_second, spec_third])
        # First update succeeds, second fails
        save_count = 0

        original_save = facade_fixture.registry.save

        def save_with_failure(spec: PersonaSpec) -> Result[None, RegistryError]:
            nonlocal save_count
            save_count += 1
            if save_count == 2:
                return Failure(
                    {
                        "code": "REGISTRY_WRITE_FAILED",
                        "message": "disk full",
                        "persona_id": "second",
                        "path": "/tmp/second.json",
                    }
                )
            return original_save(spec)

        facade_fixture.registry.save = save_with_failure  # type: ignore[method-assign]

        with pytest.raises(python_api.LarvaApiError) as exc_info:
            python_api.update_batch(
                where={"model": "gpt-4o-mini"},
                patches={"description": "Updated"},
            )

        assert exc_info.value.error["code"] == "REGISTRY_WRITE_FAILED"
        assert save_count == 2  # First succeeded, second failed

    def test_update_batch_dotted_where_matches_nested_fields(
        self, facade_fixture: FacadeFixture
    ) -> None:
        """update_batch() dotted where clause matches nested fields."""
        spec_nested = _canonical_spec("nested-match")
        spec_nested["model_params"] = {"temperature": 0.7, "nested": {"deep": "value"}}

        spec_missing = _canonical_spec("missing-path")
        spec_missing["model_params"] = {"temperature": 0.7}

        facade_fixture.registry.list_result = Success([spec_nested, spec_missing])

        result = python_api.update_batch(
            where={"model_params.nested.deep": "value"},
            patches={"description": "Nested updated"},
        )

        assert result["matched"] == 1
        assert result["updated"] == 1
        assert result["items"][0]["id"] == "nested-match"
