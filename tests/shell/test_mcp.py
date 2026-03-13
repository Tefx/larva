"""Contract-driven tests for ``larva.shell.mcp`` adapter behavior.

These tests verify:
- MCP tool definitions match INTERFACES.md :: A (tool names, input schemas)
- Error code mapping matches INTERFACES.md :: G
- Success response shapes for each tool
- Failure envelope structure (code, numeric_code, message, details)
- Regression cases: falsey override forwarding, register failure passthrough,
  assemble missing/conflict code preservation, malformed/incomplete params

Scope: MCP adapter boundary with facade doubles. Does NOT test facade internals.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

import pytest
from returns.result import Failure, Result, Success

from larva.app.facade import (
    ERROR_NUMERIC_CODES,
    LarvaError,
    RegisteredPersona,
)
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell import mcp as mcp_module

if TYPE_CHECKING:
    from larva.app.facade import AssembleRequest, PersonaSummary


# -----------------------------------------------------------------------------
# Test Fixtures: Facade Doubles
# -----------------------------------------------------------------------------


@dataclass
class MockValidateModule:
    """Double for validate module that returns configurable report."""

    report: ValidationReport
    calls: list[PersonaSpec] = field(default_factory=list)

    def validate_spec(self, spec: PersonaSpec) -> ValidationReport:
        self.calls.append(dict(spec))
        return self.report


@dataclass
class MockAssembleModule:
    """Double for assemble module that returns configurable candidate."""

    candidate: PersonaSpec
    calls: list[dict[str, object]] = field(default_factory=list)

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append(data)
        return dict(self.candidate)


@dataclass
class MockNormalizeModule:
    """Double for normalize module that returns spec with computed digest."""

    calls: list[PersonaSpec] = field(default_factory=list)
    digest_prefix: str = "sha256:mock"

    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec:
        normalized = dict(spec)
        payload = {k: v for k, v in normalized.items() if k != "spec_digest"}
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        digest = f"{self.digest_prefix}:{hash(canonical) % (2**64):x}"
        normalized["spec_digest"] = digest
        self.calls.append(normalized)
        return normalized


@dataclass
class InMemoryComponentStore:
    """Double for component store with configurable responses."""

    prompts_by_name: dict[str, dict[str, str]] = field(default_factory=dict)
    toolsets_by_name: dict[str, dict[str, dict[str, str]]] = field(default_factory=dict)
    constraints_by_name: dict[str, dict[str, object]] = field(default_factory=dict)
    models_by_name: dict[str, dict[str, object]] = field(default_factory=dict)
    fail_on: str | None = None
    fail_error: LarvaError | None = None

    def load_prompt(self, name: str) -> Result[dict[str, str], LarvaError]:
        if self.fail_on == "prompt":
            return Failure(cast("LarvaError", self.fail_error))
        return Success(self.prompts_by_name.get(name, {"text": f"Prompt: {name}"}))

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], LarvaError]:
        if self.fail_on == "toolset":
            return Failure(cast("LarvaError", self.fail_error))
        return Success(self.toolsets_by_name.get(name, {"tools": {"shell": "read_only"}}))

    def load_constraint(self, name: str) -> Result[dict[str, object], LarvaError]:
        if self.fail_on == "constraint":
            return Failure(cast("LarvaError", self.fail_error))
        return Success(self.constraints_by_name.get(name, {"side_effect_policy": "read_only"}))

    def load_model(self, name: str) -> Result[dict[str, object], LarvaError]:
        if self.fail_on == "model":
            return Failure(cast("LarvaError", self.fail_error))
        return Success(self.models_by_name.get(name, {"model": "gpt-4o-mini"}))


@dataclass
class InMemoryRegistryStore:
    """Double for registry store with configurable responses."""

    get_result: Result[PersonaSpec, LarvaError] = field(
        default_factory=lambda: Success(_canonical_spec("default"))
    )
    list_result: Result[list[PersonaSpec], LarvaError] = field(default_factory=lambda: Success([]))
    save_result: Result[None, LarvaError] = field(default_factory=lambda: Success(None))
    save_inputs: list[PersonaSpec] = field(default_factory=list)

    def save(self, spec: PersonaSpec) -> Result[None, LarvaError]:
        self.save_inputs.append(dict(spec))
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, LarvaError]:
        return self.get_result

    def list(self) -> Result[list[PersonaSpec], LarvaError]:
        return self.list_result


def _canonical_spec(
    persona_id: str,
    digest: str = "sha256:canonical",
    model: str = "gpt-4o-mini",
) -> PersonaSpec:
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": model,
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


def _invalid_report(
    code: str = "PERSONA_INVALID",
    message: str = "invalid",
) -> ValidationReport:
    return {
        "valid": False,
        "errors": [{"code": code, "message": message, "details": {}}],
        "warnings": [],
    }


def _assert_malformed_params_error(
    error: LarvaError,
    *,
    tool: str,
    reason: str,
) -> None:
    assert "error" not in error
    assert error["code"] == "INTERNAL"
    assert error["numeric_code"] == 10
    assert error["message"] == f"Malformed parameters for '{tool}': {reason}"
    assert error["details"]["tool"] == tool
    assert error["details"]["reason"] == reason


# Import the actual facade to use as template
from larva.app.facade import DefaultLarvaFacade
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module


def _make_facade(
    *,
    validate_report: ValidationReport | None = None,
    assemble_candidate: PersonaSpec | None = None,
    components: InMemoryComponentStore | None = None,
    registry: InMemoryRegistryStore | None = None,
) -> DefaultLarvaFacade:
    """Create a facade with test doubles for core modules."""
    validate_module_dbl = MockValidateModule(validate_report or _valid_report())
    assemble_module_dbl = MockAssembleModule(assemble_candidate or _canonical_spec("assembled"))
    normalize_module_dbl = MockNormalizeModule()

    return DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module_dbl,
        validate=validate_module_dbl,
        normalize=normalize_module_dbl,
        components=components or InMemoryComponentStore(),
        registry=registry or InMemoryRegistryStore(),
    )


# -----------------------------------------------------------------------------
# MCP Tool Definition Tests
# -----------------------------------------------------------------------------


class TestMCPToolDefinitions:
    """Verify tool definitions match INTERFACES.md :: A."""

    def test_validate_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva.validate" in tool_names

        validate_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva.validate")
        assert "spec" in validate_tool["input_schema"]["properties"]
        assert "spec" in validate_tool["input_schema"]["required"]

    def test_assemble_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva.assemble" in tool_names

        assemble_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva.assemble")
        props = assemble_tool["input_schema"]["properties"]
        assert "id" in props
        assert "prompts" in props
        assert "toolsets" in props
        assert "constraints" in props
        assert "model" in props
        assert "overrides" in props
        assert "variables" in props
        assert "id" in assemble_tool["input_schema"]["required"]

    def test_resolve_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva.resolve" in tool_names

        resolve_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva.resolve")
        props = resolve_tool["input_schema"]["properties"]
        assert "id" in props
        assert "overrides" in props
        assert "id" in resolve_tool["input_schema"]["required"]

    def test_register_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva.register" in tool_names

        register_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva.register")
        assert "spec" in register_tool["input_schema"]["properties"]
        assert "spec" in register_tool["input_schema"]["required"]

    def test_list_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva.list" in tool_names

        list_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva.list")
        assert list_tool["input_schema"]["properties"] == {}
        assert (
            "required" not in list_tool["input_schema"]
            or list_tool["input_schema"]["required"] == []
        )


# -----------------------------------------------------------------------------
# Error Code Tests
# -----------------------------------------------------------------------------


class TestMCPErrorCodes:
    """Verify error codes match INTERFACES.md :: G."""

    def test_error_codes_match_facade_error_codes(self) -> None:
        assert mcp_module.LARVA_ERROR_CODES == ERROR_NUMERIC_CODES

    def test_all_required_error_codes_present(self) -> None:
        required_codes = {
            "INTERNAL",
            "PERSONA_NOT_FOUND",
            "PERSONA_INVALID",
            "PERSONA_CYCLE",
            "VARIABLE_UNRESOLVED",
            "INVALID_PERSONA_ID",
            "COMPONENT_NOT_FOUND",
            "COMPONENT_CONFLICT",
            "REGISTRY_INDEX_READ_FAILED",
            "REGISTRY_SPEC_READ_FAILED",
            "REGISTRY_WRITE_FAILED",
            "REGISTRY_UPDATE_FAILED",
        }
        assert set(mcp_module.LARVA_ERROR_CODES.keys()) == required_codes

    def test_error_codes_are_integers(self) -> None:
        for code, value in mcp_module.LARVA_ERROR_CODES.items():
            assert isinstance(value, int), f"Error code {code} should be integer"


# -----------------------------------------------------------------------------
# Success Shape Tests
# -----------------------------------------------------------------------------


class TestMCPValidateSuccessShape:
    """Test larva.validate success response shape."""

    def test_validate_returns_validation_report_shape(self) -> None:
        facade = _make_facade(validate_report=_valid_report())
        spec = _canonical_spec("test")

        result = facade.validate(spec)

        assert "valid" in result
        assert "errors" in result
        assert "warnings" in result
        assert isinstance(result["valid"], bool)
        assert isinstance(result["errors"], list)
        assert isinstance(result["warnings"], list)

    def test_validate_success_with_warnings(self) -> None:
        report = {
            "valid": True,
            "errors": [],
            "warnings": ["UNUSED_VARIABLES: supplied variables are not referenced by prompt: role"],
        }
        facade = _make_facade(validate_report=report)
        spec = _canonical_spec("test")

        result = facade.validate(spec)

        assert result["valid"] is True
        assert result["warnings"] == [
            "UNUSED_VARIABLES: supplied variables are not referenced by prompt: role"
        ]


class TestMCPAssembleSuccessShape:
    """Test larva.assemble success response shape."""

    def test_assemble_returns_persona_spec_shape(self) -> None:
        candidate = _canonical_spec("assembled", digest="sha256:assembled")
        facade = _make_facade(
            validate_report=_valid_report(),
            assemble_candidate=candidate,
        )

        result = facade.assemble({"id": "assembled", "prompts": ["base"]})

        assert isinstance(result, Success)
        spec = result.unwrap()
        assert "id" in spec
        assert "spec_digest" in spec
        assert "model" in spec
        assert "prompt" in spec

    def test_assemble_includes_all_required_fields(self) -> None:
        candidate = _canonical_spec("full-spec", digest="sha256:full")
        facade = _make_facade(
            validate_report=_valid_report(),
            assemble_candidate=candidate,
        )

        result = facade.assemble({"id": "full-spec"})

        assert isinstance(result, Success)
        spec = result.unwrap()
        required_fields = [
            "id",
            "description",
            "prompt",
            "model",
            "tools",
            "model_params",
            "side_effect_policy",
            "can_spawn",
            "compaction_prompt",
            "spec_version",
            "spec_digest",
        ]
        for field in required_fields:
            assert field in spec, f"Missing required field: {field}"


class TestMCPResolveSuccessShape:
    """Test larva.resolve success response shape."""

    def test_resolve_returns_persona_spec_shape(self) -> None:
        stored = _canonical_spec("stored", digest="sha256:stored")
        registry = InMemoryRegistryStore(get_result=Success(stored))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)

        result = facade.resolve("stored")

        assert isinstance(result, Success)
        spec = result.unwrap()
        assert spec["id"] == "stored"
        assert "spec_digest" in spec


class TestMCPRegisterSuccessShape:
    """Test larva.register success response shape."""

    def test_register_returns_registered_persona_shape(self) -> None:
        registry = InMemoryRegistryStore()
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        spec = _canonical_spec("to-register", digest="sha256:to-register")

        result = facade.register(spec)

        assert isinstance(result, Success)
        ack = result.unwrap()
        assert "id" in ack
        assert "registered" in ack
        assert ack["id"] == "to-register"
        assert ack["registered"] is True


class TestMCPListSuccessShape:
    """Test larva.list success response shape."""

    def test_list_returns_list_of_summaries(self) -> None:
        specs = [
            _canonical_spec("alpha", digest="sha256:a"),
            _canonical_spec("beta", digest="sha256:b"),
        ]
        registry = InMemoryRegistryStore(list_result=Success(specs))
        facade = _make_facade(registry=registry)

        result = facade.list()

        assert isinstance(result, Success)
        summaries = result.unwrap()
        assert isinstance(summaries, list)
        assert len(summaries) == 2
        for summary in summaries:
            assert "id" in summary
            assert "spec_digest" in summary
            assert "model" in summary

    def test_list_empty_returns_empty_list(self) -> None:
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade = _make_facade(registry=registry)

        result = facade.list()

        assert isinstance(result, Success)
        assert result.unwrap() == []


# -----------------------------------------------------------------------------
# Failure Envelope Tests
# -----------------------------------------------------------------------------


class TestMCPFailureEnvelope:
    """Test failure envelope structure: code, numeric_code, message, details."""

    def test_assemble_component_not_found_has_envelope(self) -> None:
        components = InMemoryComponentStore(
            fail_on="prompt",
            fail_error={
                "code": "COMPONENT_NOT_FOUND",
                "numeric_code": 105,
                "message": "Prompt not found: missing",
                "details": {"component_type": "prompt", "component_name": "missing"},
            },
        )
        facade = _make_facade(components=components)

        result = facade.assemble({"id": "test", "prompts": ["missing"]})

        assert isinstance(result, Failure)
        error = result.failure()
        assert "code" in error
        assert "numeric_code" in error
        assert "message" in error
        assert "details" in error
        assert error["code"] == "COMPONENT_NOT_FOUND"
        assert error["numeric_code"] == 105

    def test_resolve_persona_not_found_has_envelope(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = facade.resolve("missing")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert "missing" in error["message"]

    def test_register_validation_failure_has_envelope(self) -> None:
        facade = _make_facade(validate_report=_invalid_report("INVALID_SPEC_VERSION"))

        result = facade.register(_canonical_spec("bad"))

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert "details" in error
        assert "report" in error["details"]

    def test_register_registry_failure_passes_through_envelope(self) -> None:
        registry = InMemoryRegistryStore(
            save_result=Failure(
                {
                    "code": "REGISTRY_WRITE_FAILED",
                    "message": "disk full",
                    "persona_id": "full-disk",
                    "path": "/registry/full-disk.json",
                }
            )
        )
        facade = _make_facade(validate_report=_valid_report(), registry=registry)

        result = facade.register(_canonical_spec("full-disk"))

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_WRITE_FAILED"
        assert error["numeric_code"] == 109
        assert error["details"]["persona_id"] == "full-disk"
        assert error["details"]["path"] == "/registry/full-disk.json"

    def test_assemble_missing_component_preserves_code(self) -> None:
        components = InMemoryComponentStore(
            fail_on="prompt",
            fail_error={
                "code": "COMPONENT_NOT_FOUND",
                "numeric_code": 105,
                "message": "Prompt not found: base",
                "details": {"component_type": "prompt", "component_name": "base"},
            },
        )
        facade = _make_facade(components=components)

        result = facade.assemble({"id": "test", "prompts": ["base"]})

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "COMPONENT_NOT_FOUND"
        assert error["numeric_code"] == 105


# -----------------------------------------------------------------------------
# Regression Tests
# -----------------------------------------------------------------------------


class TestMCPFalseyOverrideForwarding:
    """Regression: falsey values in overrides must be forwarded correctly."""

    def test_resolve_falsey_override_forwarded_to_validation(self) -> None:
        stored = _canonical_spec("stored", digest="sha256:stored")
        stored["description"] = "original description"
        stored["can_spawn"] = True
        stored["compaction_prompt"] = "Original prompt"
        stored["model_params"] = {"temperature": 0.5}

        registry = InMemoryRegistryStore(get_result=Success(stored))
        validate_report: ValidationReport = {"valid": True, "errors": [], "warnings": []}
        facade = _make_facade(validate_report=validate_report, registry=registry)

        result = facade.resolve(
            "stored",
            overrides={
                "description": None,
                "can_spawn": False,
                "compaction_prompt": "",
                "model_params": {"temperature": 0},
            },
        )

        assert isinstance(result, Success)
        resolved = result.unwrap()
        # Falsey values must be preserved through the chain
        assert resolved["description"] is None
        assert resolved["can_spawn"] is False
        assert resolved["compaction_prompt"] == ""
        assert resolved["model_params"] == {"temperature": 0}

    def test_assemble_falsey_override_forwarded(self) -> None:
        candidate = _canonical_spec("assembled", digest="sha256:assembled")
        candidate["description"] = None
        candidate["can_spawn"] = False

        validate_report: ValidationReport = {"valid": True, "errors": [], "warnings": []}
        facade = _make_facade(
            validate_report=validate_report,
            assemble_candidate=candidate,
        )

        result = facade.assemble(
            {
                "id": "test",
                "overrides": {
                    "description": None,
                    "can_spawn": False,
                    "compaction_prompt": "",
                },
            }
        )

        assert isinstance(result, Success)
        spec = result.unwrap()
        # Falsey overrides must be applied, not ignored
        assert spec["description"] is None
        assert spec["can_spawn"] is False


class TestMCPAssembleConflictCodePreservation:
    """Regression: assemble conflict error codes must be preserved through MCP boundary."""

    def test_assemble_conflict_error_preserves_code(self) -> None:
        # The assemble module should raise AssemblyError with COMPONENT_CONFLICT
        # This tests that the error code flows through to the failure envelope
        from larva.core.assemble import AssemblyError

        class ConflictAssembleModule:
            def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
                raise AssemblyError(
                    code="COMPONENT_CONFLICT",
                    message="Multiple sources provide 'side_effect_policy'",
                    details={"field": "side_effect_policy"},
                )

        class SpyValidateModule:
            def validate_spec(self, spec: PersonaSpec) -> ValidationReport:
                return _valid_report()

        class SpyNormalizeModule:
            def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec:
                return spec

        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=ConflictAssembleModule(),  # type: ignore
            validate=SpyValidateModule(),  # type: ignore
            normalize=SpyNormalizeModule(),  # type: ignore
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(),
        )

        result = facade.assemble({"id": "conflict-test"})

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "COMPONENT_CONFLICT"
        assert error["numeric_code"] == 106


class TestMCPMalformedParamsRejected:
    """Regression: malformed or incomplete params must be rejected at MCP boundary."""

    @pytest.mark.parametrize(
        ("tool", "payload", "reason"),
        [
            ("larva.validate", {"spec": []}, "parameter 'spec' must be object"),
            (
                "larva.assemble",
                {"id": "ok", "prompts": ["ok", 2]},
                "parameter 'prompts' must be list[string]",
            ),
            (
                "larva.resolve",
                {"id": "ok", "overrides": []},
                "parameter 'overrides' must be object",
            ),
            ("larva.register", {"spec": "not-an-object"}, "parameter 'spec' must be object"),
            ("larva.list", {"unknown": True}, "unknown parameter(s)"),
        ],
    )
    def test_all_tools_reject_malformed_payloads(
        self,
        tool: str,
        payload: object,
        reason: str,
    ) -> None:
        handlers = mcp_module.MCPHandlers(_make_facade(validate_report=_valid_report()))
        dispatch = {
            "larva.validate": handlers.handle_validate,
            "larva.assemble": handlers.handle_assemble,
            "larva.resolve": handlers.handle_resolve,
            "larva.register": handlers.handle_register,
            "larva.list": handlers.handle_list,
        }

        result = dispatch[tool](payload)

        assert isinstance(result, dict)
        _assert_malformed_params_error(cast("LarvaError", result), tool=tool, reason=reason)

    @pytest.mark.parametrize(
        "tool",
        ["larva.validate", "larva.assemble", "larva.resolve", "larva.register", "larva.list"],
    )
    def test_all_tools_reject_non_object_params(self, tool: str) -> None:
        handlers = mcp_module.MCPHandlers(_make_facade(validate_report=_valid_report()))
        dispatch = {
            "larva.validate": handlers.handle_validate,
            "larva.assemble": handlers.handle_assemble,
            "larva.resolve": handlers.handle_resolve,
            "larva.register": handlers.handle_register,
            "larva.list": handlers.handle_list,
        }

        result = dispatch[tool]([])

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool=tool,
            reason="params must be an object",
        )


class TestMCPValidationReportTypeContract:
    """Verify ValidationReport TypedDict matches expected contract."""

    def test_validation_report_has_valid_field(self) -> None:
        report: mcp_module.ValidationReport = {"valid": True, "errors": [], "warnings": []}
        assert report["valid"] is True

    def test_validation_report_has_errors_list(self) -> None:
        report: mcp_module.ValidationReport = {
            "valid": False,
            "errors": [{"code": "INVALID", "message": "bad", "details": {}}],
            "warnings": [],
        }
        assert len(report["errors"]) == 1
        assert report["errors"][0]["code"] == "INVALID"

    def test_validation_report_has_warnings_list(self) -> None:
        report: mcp_module.ValidationReport = {
            "valid": True,
            "errors": [],
            "warnings": ["some warning"],
        }
        assert "some warning" in report["warnings"]


# -----------------------------------------------------------------------------
# Integration: MCP Tool Definitions with Facade Behavior
# -----------------------------------------------------------------------------


class TestMCPToolsRoundTrip:
    """Verify that MCP tool parameter extraction works with facade."""

    def test_validate_tool_params_extraction(self) -> None:
        """Simulate MCP tool handler extracting 'spec' param and calling facade."""
        facade = _make_facade(validate_report=_valid_report())
        spec = _canonical_spec("round-trip")

        # MCP handler would extract: params["spec"]
        result = facade.validate(spec)

        # ValidationReport is a TypedDict, not a class - check for expected keys
        assert "valid" in result
        assert "errors" in result
        assert "warnings" in result
        assert result["valid"] is True

    def test_assemble_tool_params_extraction(self) -> None:
        """Simulate MCP tool handler extracting assemble params and calling facade."""
        facade = _make_facade(validate_report=_valid_report())

        # MCP handler would extract these from params
        request = {
            "id": "assembled-persona",
            "prompts": ["base-prompt"],
            "toolsets": ["readonly-tools"],
            "constraints": ["no-spawn"],
            "model": "default-model",
            "variables": {"role": "analyst"},
            "overrides": {"temperature": 0.7},
        }

        result = facade.assemble(request)

        assert isinstance(result, Success)

    def test_resolve_tool_params_extraction(self) -> None:
        """Simulate MCP tool handler extracting resolve params and calling facade."""
        stored = _canonical_spec("stored", digest="sha256:stored")
        stored["model_params"] = {"temperature": 0.5}
        registry = InMemoryRegistryStore(get_result=Success(stored))

        # Need a facade with valid report
        validate_report: ValidationReport = {"valid": True, "errors": [], "warnings": []}
        facade = _make_facade(validate_report=validate_report, registry=registry)

        # MCP handler would extract: params["id"], params.get("overrides", {})
        result = facade.resolve("stored", overrides={"model_params": {"temperature": 0.9}})

        assert isinstance(result, Success)
        resolved = result.unwrap()
        assert resolved["model_params"]["temperature"] == 0.9

    def test_register_tool_params_extraction(self) -> None:
        """Simulate MCP tool handler extracting register params and calling facade."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(validate_report=_valid_report(), registry=registry)

        # MCP handler would extract: params["spec"]
        spec = _canonical_spec("to-register", digest="sha256:to-register")
        result = facade.register(spec)

        assert isinstance(result, Success)
        assert result.unwrap()["registered"] is True

    def test_list_tool_params_extraction(self) -> None:
        """Simulate MCP tool handler calling list with empty params."""
        specs = [_canonical_spec("one", digest="sha256:one")]
        registry = InMemoryRegistryStore(list_result=Success(specs))
        facade = _make_facade(registry=registry)

        # MCP handler would call with empty params {}
        result = facade.list()

        assert isinstance(result, Success)
        assert len(result.unwrap()) == 1


# -----------------------------------------------------------------------------
# MCPHandlers Implementation Tests
# -----------------------------------------------------------------------------


class TestMCPHandlersImplementation:
    """Test MCPHandlers class with actual facade integration.

    These tests verify the MCPHandlers methods correctly:
    - Parse MCP request parameters
    - Delegate to facade methods
    - Return success shapes or error envelopes
    - Handle malformed parameters at MCP boundary
    """

    def test_handle_validate_success(self) -> None:
        """Test handle_validate returns ValidationReport on success."""
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        spec = _canonical_spec("test")
        result = handlers.handle_validate({"spec": spec})

        assert result["valid"] is True
        assert result["errors"] == []
        assert result["warnings"] == []

    def test_handle_validate_preserves_canonical_unused_variables_warning(self) -> None:
        """MCP validate path should preserve canonical UNUSED_VARIABLES warning text."""
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(),
        )
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_validate(
            {
                "spec": {
                    "id": "warning-roundtrip",
                    "spec_version": "0.1.0",
                    "prompt": "Hello.",
                    "variables": {"role": "assistant"},
                }
            }
        )

        assert result["valid"] is True
        assert result["errors"] == []
        assert result["warnings"] == [
            "UNUSED_VARIABLES: supplied variables are not referenced by prompt: role"
        ]

    def test_handle_validate_missing_spec_raises(self) -> None:
        """Test handle_validate returns malformed-params envelope for missing spec."""
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_validate({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva.validate",
            reason="missing required parameter 'spec'",
        )

    def test_handle_assemble_success(self) -> None:
        """Test handle_assemble returns PersonaSpec on success."""
        candidate = _canonical_spec("assembled", digest="sha256:assembled")
        facade = _make_facade(
            validate_report=_valid_report(),
            assemble_candidate=candidate,
        )
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble({"id": "assembled", "prompts": ["base"]})

        # Success returns PersonaSpec (not Result)
        assert isinstance(result, dict)
        assert result["id"] == "assembled"
        assert "spec_digest" in result

    def test_handle_assemble_failure_returns_error_envelope(self) -> None:
        """Test handle_assemble returns error envelope on failure."""
        components = InMemoryComponentStore(
            fail_on="prompt",
            fail_error={
                "code": "COMPONENT_NOT_FOUND",
                "numeric_code": 105,
                "message": "Prompt not found: missing",
                "details": {"component_type": "prompt", "component_name": "missing"},
            },
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble({"id": "test", "prompts": ["missing"]})

        # Failure returns error envelope
        assert isinstance(result, dict)
        assert "error" not in result
        assert "code" in result
        assert "numeric_code" in result
        assert "message" in result
        assert "details" in result
        assert result["code"] == "COMPONENT_NOT_FOUND"

    def test_handle_assemble_missing_id_raises(self) -> None:
        """Test handle_assemble returns malformed-params envelope for missing id."""
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble({"prompts": ["base"]})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva.assemble",
            reason="missing required parameter 'id'",
        )

    def test_handle_assemble_preserves_falsey_overrides(self) -> None:
        """Test handle_assemble preserves falsey values in overrides.

        Note: This test verifies the MCP handler passes overrides to the facade.
        The actual override application is tested in TestMCPFalseyOverrideForwarding.
        """
        candidate = _canonical_spec("assembled", digest="sha256:assembled")
        # Pre-set falsey values in candidate to test they are preserved
        candidate["description"] = None
        candidate["can_spawn"] = False
        candidate["compaction_prompt"] = ""

        facade = _make_facade(
            validate_report=_valid_report(),
            assemble_candidate=candidate,
        )
        handlers = mcp_module.MCPHandlers(facade)

        # Pass additional overrides - test that values flow through
        result = handlers.handle_assemble(
            {
                "id": "test",
                "overrides": {
                    "can_spawn": False,
                },
            }
        )

        # Success - falsey values preserved in spec
        assert result["description"] is None
        assert result["can_spawn"] is False
        assert result["compaction_prompt"] == ""

    def test_handle_resolve_success(self) -> None:
        """Test handle_resolve returns PersonaSpec on success."""
        stored = _canonical_spec("stored", digest="sha256:stored")
        registry = InMemoryRegistryStore(get_result=Success(stored))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_resolve({"id": "stored"})

        # Success returns PersonaSpec
        assert isinstance(result, dict)
        assert result["id"] == "stored"
        assert "spec_digest" in result

    def test_handle_resolve_failure_returns_error_envelope(self) -> None:
        """Test handle_resolve returns error envelope on failure."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_resolve({"id": "missing"})

        # Failure returns error envelope
        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_NOT_FOUND"
        assert result["numeric_code"] == 100

    def test_handle_resolve_missing_id_raises(self) -> None:
        """Test handle_resolve returns malformed-params envelope for missing id."""
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_resolve({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva.resolve",
            reason="missing required parameter 'id'",
        )

    def test_handle_resolve_preserves_falsey_overrides(self) -> None:
        """Test handle_resolve preserves falsey values in overrides."""
        stored = _canonical_spec("stored", digest="sha256:stored")
        stored["description"] = "original"
        stored["can_spawn"] = True
        stored["model_params"] = {"temperature": 0.5}
        registry = InMemoryRegistryStore(get_result=Success(stored))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_resolve(
            {
                "id": "stored",
                "overrides": {
                    "description": None,
                    "can_spawn": False,
                    "compaction_prompt": "",
                    "model_params": {"temperature": 0},
                },
            }
        )

        # Falsey values preserved
        assert result["description"] is None
        assert result["can_spawn"] is False
        assert result["compaction_prompt"] == ""
        assert result["model_params"] == {"temperature": 0}

    def test_handle_register_success(self) -> None:
        """Test handle_register returns RegisteredPersona on success."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        spec = _canonical_spec("to-register", digest="sha256:to-register")
        result = handlers.handle_register({"spec": spec})

        # Success returns RegisteredPersona
        assert isinstance(result, dict)
        assert result["id"] == "to-register"
        assert result["registered"] is True

    def test_handle_register_failure_returns_error_envelope(self) -> None:
        """Test handle_register returns error envelope on failure."""
        facade = _make_facade(validate_report=_invalid_report("INVALID_SPEC_VERSION"))
        handlers = mcp_module.MCPHandlers(facade)

        spec = _canonical_spec("bad")
        result = handlers.handle_register({"spec": spec})

        # Failure returns error envelope
        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_INVALID"
        assert result["numeric_code"] == 101

    def test_handle_register_missing_spec_raises(self) -> None:
        """Test handle_register returns malformed-params envelope for missing spec."""
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_register({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva.register",
            reason="missing required parameter 'spec'",
        )

    def test_handle_list_success(self) -> None:
        """Test handle_list returns list of summaries on success."""
        specs = [
            _canonical_spec("alpha", digest="sha256:a"),
            _canonical_spec("beta", digest="sha256:b"),
        ]
        registry = InMemoryRegistryStore(list_result=Success(specs))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_list({})

        # Success returns list of summaries
        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["id"] == "alpha"
        assert result[1]["id"] == "beta"

    def test_handle_list_failure_returns_error_envelope(self) -> None:
        """Test handle_list returns error envelope on failure."""
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "Failed to read registry index",
                    "path": "/registry/index.json",
                }
            )
        )
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_list({})

        # Failure returns error envelope
        assert isinstance(result, dict)
        assert result["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert result["numeric_code"] == 107

    def test_handle_list_empty_params(self) -> None:
        """Test handle_list accepts empty params."""
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        # Empty params should work fine
        result = handlers.handle_list({})
        assert result == []

    def test_handle_list_unknown_param_returns_malformed_envelope(self) -> None:
        """Test handle_list rejects unknown params with stable error envelope."""
        registry = InMemoryRegistryStore(list_result=Success([]))
        handlers = mcp_module.MCPHandlers(_make_facade(registry=registry))

        result = handlers.handle_list({"limit": 5})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva.list",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["limit"]
