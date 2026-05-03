"""Contract-driven tests for ``larva.shell.mcp`` adapter behavior.

These tests verify:
- MCP tool definitions match INTERFACES.md :: A (tool names, input schemas)
- Error code mapping matches INTERFACES.md :: G
- Success response shapes for each tool
- Failure envelope structure (code, numeric_code, message, details)
- Regression cases: falsey override forwarding, register failure passthrough,
  assemble missing/conflict code preservation, malformed/incomplete params

Scope: MCP adapter boundary with facade doubles. Does NOT test facade internals.

SURFACE CUTOVER TARGET-STATE ASSERTIONS (expected-RED):

These assertions check the registry-local variants cutover surface.
They FAIL RED until the implementation phase cuts over the public surface:

- MCP tool list includes variant_list, variant_activate, variant_delete
- MCP tool list omits larva_assemble, larva_component_list, larva_component_show
- MCP register/resolve/update schemas accept optional variant parameter
- Variant handlers delegate to facade with correct parameter routing
- Error codes include PERSONA_ID_MISMATCH, INVALID_VARIANT_NAME,
  REGISTRY_CORRUPT, VARIANT_NOT_FOUND, ACTIVE_VARIANT_DELETE_FORBIDDEN,
  LAST_VARIANT_DELETE_FORBIDDEN
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
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
from larva.shell import mcp_params
from larva.shell.mcp_export import handle_export as handle_export_impl
from larva.shell.mcp_update_batch import handle_update_batch as handle_update_batch_impl
from larva.shell.shared import request_validation
from tests.shell.fixture_taxonomy import (
    canonical_persona_spec,
    historical_constraint_fixture_with_legacy_field,
    historical_toolset_fixture_with_legacy_fields,
)

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

    def validate_spec(
        self,
        spec: PersonaSpec,
        registry_persona_ids: frozenset[str] | None = None,
    ) -> ValidationReport:
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
    list_fail: bool = False

    def _make_not_found_error(self, component_type: str, name: str) -> LarvaError:
        return {
            "code": "COMPONENT_NOT_FOUND",
            "numeric_code": 105,
            "message": f"{component_type.capitalize()} not found: {name}",
            "details": {"component_type": component_type, "component_name": name},
        }

    def load_prompt(self, name: str) -> Result[dict[str, str], LarvaError]:
        if self.fail_on == "prompt":
            return Failure(cast("LarvaError", self.fail_error))
        if name not in self.prompts_by_name:
            return Failure(self._make_not_found_error("prompt", name))
        return Success(self.prompts_by_name[name])

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], LarvaError]:
        if self.fail_on == "toolset":
            return Failure(cast("LarvaError", self.fail_error))
        if name not in self.toolsets_by_name:
            return Failure(self._make_not_found_error("toolset", name))
        toolset_data = self.toolsets_by_name[name]
        return Success(toolset_data)

    def load_constraint(self, name: str) -> Result[dict[str, object], LarvaError]:
        if self.fail_on == "constraint":
            return Failure(cast("LarvaError", self.fail_error))
        if name not in self.constraints_by_name:
            return Failure(self._make_not_found_error("constraint", name))
        return Success(self.constraints_by_name[name])

    def load_model(self, name: str) -> Result[dict[str, object], LarvaError]:
        if self.fail_on == "model":
            return Failure(cast("LarvaError", self.fail_error))
        if name not in self.models_by_name:
            return Failure(self._make_not_found_error("model", name))
        return Success(self.models_by_name[name])

    def list_components(self) -> Result[dict[str, list[str]], LarvaError]:
        """List all available components by type."""
        if self.list_fail and self.fail_error:
            return Failure(cast("LarvaError", self.fail_error))
        return Success(
            {
                "prompts": sorted(self.prompts_by_name.keys()),
                "toolsets": sorted(self.toolsets_by_name.keys()),
                "constraints": sorted(self.constraints_by_name.keys()),
                "models": sorted(self.models_by_name.keys()),
            }
        )


@dataclass
class InMemoryRegistryStore:
    """Double for registry store with configurable responses."""

    get_result: Result[PersonaSpec, LarvaError] = field(
        default_factory=lambda: Success(_canonical_spec("default"))
    )
    list_result: Result[list[PersonaSpec], LarvaError] = field(default_factory=lambda: Success([]))
    save_result: Result[None, LarvaError] = field(default_factory=lambda: Success(None))
    save_inputs: list[PersonaSpec] = field(default_factory=list)
    delete_result: Result[None, LarvaError] = field(default_factory=lambda: Success(None))
    clear_result: Result[int, LarvaError] = field(default_factory=lambda: Success(0))
    get_calls: list[str] = field(default_factory=list)
    list_calls: int = 0

    def save(self, spec: PersonaSpec) -> Result[None, LarvaError]:
        self.save_inputs.append(dict(spec))
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, LarvaError]:
        self.get_calls.append(persona_id)
        return self.get_result

    def list(self) -> Result[list[PersonaSpec], LarvaError]:
        self.list_calls += 1
        return self.list_result

    def delete(self, persona_id: str) -> Result[None, LarvaError]:
        return self.delete_result

    def clear(self, confirm: str) -> Result[int, LarvaError]:
        return self.clear_result


@dataclass
class IsolatedMCPHandlerDeps:
    """Minimal deps double for isolated MCP handler modules."""

    facade: Any

    @property
    def _facade(self) -> Any:
        return self.facade

    def _malformed_params_error(
        self,
        tool_name: str,
        reason: str,
        details: dict[str, object],
    ) -> LarvaError:
        return {
            "code": "INTERNAL",
            "numeric_code": 10,
            "message": f"Malformed parameters for '{tool_name}': {reason}",
            "details": {"tool": tool_name, "reason": reason, **details},
        }


def _canonical_spec(
    persona_id: str,
    digest: str | None = None,
    model: str = "gpt-4o-mini",
) -> PersonaSpec:
    return canonical_persona_spec(persona_id=persona_id, digest=digest, model=model)


def _digest_for(spec: dict[str, object]) -> str:
    payload = {k: v for k, v in spec.items() if k != "spec_digest"}
    canonical_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical_json.encode('utf-8')).hexdigest()}"


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


_CANONICAL_SCHEMA_AUTHORITY = Path(
    "/Users/tefx/Projects/opifex/contracts/persona_spec.schema.json"
)


def _canonical_schema_properties() -> dict[str, object]:
    payload = json.loads(_CANONICAL_SCHEMA_AUTHORITY.read_text(encoding="utf-8"))
    return cast("dict[str, object]", payload["properties"])


# -----------------------------------------------------------------------------
# MCP Surface Cutover: EXPECTED-RED assertions
#
# These assert TARGET-STATE surface contracts that have NOT been cut over yet.
# They MUST fail RED until the implementation phase removes assembly/component
# tools and adds variant tools.
#
# Source authority: design/registry-local-variants-and-assembly-removal.md
# Source authority: docs/reference/INTERFACES.md :: MCP Surface
# Source authority: opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml
# -----------------------------------------------------------------------------


class TestMCPVariantToolsExist:
    """EXPECTED-RED: MCP tool list must include variant_list, variant_activate, variant_delete.

    Source: INTERFACES.md :: MCP Surface (lines 40-56)
    Source: design/registry-local-variants-and-assembly-removal.md :: MCP surface (lines 117-143)
    Source: opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml
    """

    def test_variant_list_tool_is_defined(self) -> None:
        """larva_variant_list MUST be in LARVA_MCP_TOOLS after cutover.

        Source: INTERFACES.md line 51; case_matrix larva.mcp_server_naming.yaml line 19.
        """
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_variant_list" in tool_names, (
            f"larva_variant_list missing from MCP tools. "
            f"Current tools: {sorted(tool_names)}. "
            f"Expected: larva_variant_list present per INTERFACES.md."
        )

    def test_variant_activate_tool_is_defined(self) -> None:
        """larva_variant_activate MUST be in LARVA_MCP_TOOLS after cutover.

        Source: INTERFACES.md line 52; case_matrix larva.mcp_server_naming.yaml line 19.
        """
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_variant_activate" in tool_names, (
            f"larva_variant_activate missing from MCP tools. "
            f"Current tools: {sorted(tool_names)}. "
            f"Expected: larva_variant_activate present per INTERFACES.md."
        )

    def test_variant_delete_tool_is_defined(self) -> None:
        """larva_variant_delete MUST be in LARVA_MCP_TOOLS after cutover.

        Source: INTERFACES.md line 53; case_matrix larva.mcp_server_naming.yaml line 19.
        """
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_variant_delete" in tool_names, (
            f"larva_variant_delete missing from MCP tools. "
            f"Current tools: {sorted(tool_names)}. "
            f"Expected: larva_variant_delete present per INTERFACES.md."
        )


class TestMCPAssemblyComponentToolsRemoved:
    """EXPECTED-RED: MCP tool list must NOT include assemble/component tools.

    Source: INTERFACES.md :: Removed MCP tools (lines 56-59)
    Source: design/registry-local-variants-and-assembly-removal.md :: Removed tools (lines 125-129)
    Source: opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml
    """

    def test_assemble_tool_is_removed(self) -> None:
        """larva_assemble MUST NOT be in LARVA_MCP_TOOLS after cutover.

        Source: INTERFACES.md line 57; case_matrix larva.mcp_server_naming.yaml line 34.
        """
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_assemble" not in tool_names, (
            f"larva_assemble still present in MCP tools: {sorted(tool_names)}. "
            f"Assembly removed per INTERFACES.md and design doc."
        )

    def test_component_list_tool_is_removed(self) -> None:
        """larva_component_list MUST NOT be in LARVA_MCP_TOOLS after cutover.

        Source: INTERFACES.md line 58; case_matrix larva.mcp_server_naming.yaml line 35.
        """
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_component_list" not in tool_names, (
            f"larva_component_list still present in MCP tools: {sorted(tool_names)}. "
            f"Component subsystem removed per INTERFACES.md and design doc."
        )

    def test_component_show_tool_is_removed(self) -> None:
        """larva_component_show MUST NOT be in LARVA_MCP_TOOLS after cutover.

        Source: INTERFACES.md line 59; case_matrix larva.mcp_server_naming.yaml line 36.
        """
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_component_show" not in tool_names, (
            f"larva_component_show still present in MCP tools: {sorted(tool_names)}. "
            f"Component subsystem removed per INTERFACES.md and design doc."
        )


class TestMCPRegisterAcceptsVariant:
    """EXPECTED-RED: larva_register MCP tool schema must accept optional variant parameter.

    Source: INTERFACES.md line 42; design doc lines 105-109;
    Source: opifex/conformance/case_matrix/larva/larva.register.yaml
    """

    def test_register_tool_accepts_variant_parameter(self) -> None:
        """larva_register input schema must include optional variant parameter."""
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_register" in tool_names

        register_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_register")
        props = register_tool["input_schema"]["properties"]
        assert "variant" in props, (
            f"larva_register missing 'variant' parameter. "
            f"Current properties: {sorted(props.keys())}. "
            f"Expected: variant parameter per INTERFACES.md and case_matrix."
        )


class TestMCPResolveAcceptsVariant:
    """EXPECTED-RED: larva_resolve MCP tool schema must accept optional variant parameter.

    Source: INTERFACES.md line 43; design doc lines 110-111;
    Source: opifex/conformance/case_matrix/larva/larva.resolve.yaml
    """

    def test_resolve_tool_accepts_variant_parameter(self) -> None:
        """larva_resolve input schema must include optional variant parameter."""
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_resolve" in tool_names

        resolve_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_resolve")
        props = resolve_tool["input_schema"]["properties"]
        assert "variant" in props, (
            f"larva_resolve missing 'variant' parameter. "
            f"Current properties: {sorted(props.keys())}. "
            f"Expected: variant parameter per INTERFACES.md and case_matrix."
        )


class TestMCPUpdateAcceptsVariant:
    """EXPECTED-RED: larva_update MCP tool schema must accept optional variant parameter.

    Source: INTERFACES.md line 45; design doc lines 112;
    Source: opifex/conformance/case_matrix/larva/larva.update.yaml
    """

    def test_update_tool_accepts_variant_parameter(self) -> None:
        """larva_update input schema must include optional variant parameter."""
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_update" in tool_names

        update_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_update")
        props = update_tool["input_schema"]["properties"]
        assert "variant" in props, (
            f"larva_update missing 'variant' parameter. "
            f"Current properties: {sorted(props.keys())}. "
            f"Expected: variant parameter per INTERFACES.md and case_matrix."
        )


class TestMCPVariantErrorCodes:
    """EXPECTED-RED: MCP error codes must include variant-related codes.

    Source: INTERFACES.md :: Error Handling (lines 258-268)
    Source: USAGE.md :: §6 Error Handling
    """

    REQUIRED_VARIANT_ERROR_CODES = {
        "PERSONA_ID_MISMATCH",
        "INVALID_VARIANT_NAME",
        "REGISTRY_CORRUPT",
        "VARIANT_NOT_FOUND",
        "ACTIVE_VARIANT_DELETE_FORBIDDEN",
        "LAST_VARIANT_DELETE_FORBIDDEN",
    }

    def test_variant_error_codes_present(self) -> None:
        """MCP error codes must include all variant-related error codes.

        Source: USAGE.md §6; INTERFACES.md lines 258-268.
        """
        for code in self.REQUIRED_VARIANT_ERROR_CODES:
            assert code in ERROR_NUMERIC_CODES, (
                f"Error code '{code}' missing from ERROR_NUMERIC_CODES. "
                f"Current codes: {sorted(ERROR_NUMERIC_CODES.keys())}. "
                f"Expected: variant-related codes per INTERFACES.md §6."
            )


# -----------------------------------------------------------------------------
# MCP Tool Definition Tests (pre-existing)
# -----------------------------------------------------------------------------


class TestMCPToolDefinitions:
    """Verify tool definitions match INTERFACES.md :: A."""

    def test_validate_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_validate" in tool_names

        validate_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_validate")
        assert "spec" in validate_tool["input_schema"]["properties"]
        assert "spec" in validate_tool["input_schema"]["required"]
        spec_schema = validate_tool["input_schema"]["properties"]["spec"]
        assert spec_schema["additionalProperties"] is False
        assert "tools" not in spec_schema["properties"]
        assert "side_effect_policy" not in spec_schema["properties"]
        assert set(spec_schema["required"]) == {
            "id",
            "description",
            "prompt",
            "model",
            "capabilities",
            "spec_version",
        }

    def test_assemble_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_assemble" in tool_names

        assemble_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_assemble")
        props = assemble_tool["input_schema"]["properties"]
        assert "id" in props
        assert "description" in props
        assert "prompts" in props
        assert "toolsets" in props
        assert "constraints" in props
        assert "model" in props
        assert "overrides" in props
        assert "variables" not in props
        assert "id" in assemble_tool["input_schema"]["required"]
        overrides_schema = cast("dict[str, object]", props["overrides"])
        assert overrides_schema["additionalProperties"] is False
        override_props = cast("dict[str, object]", overrides_schema["properties"])
        assert "id" not in override_props
        assert "spec_version" not in override_props
        assert "spec_digest" not in override_props
        assert "tools" not in override_props
        assert "side_effect_policy" not in override_props

    def test_resolve_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_resolve" in tool_names

        resolve_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_resolve")
        props = resolve_tool["input_schema"]["properties"]
        assert "id" in props
        assert "overrides" in props
        assert "id" in resolve_tool["input_schema"]["required"]
        overrides_schema = cast("dict[str, object]", props["overrides"])
        assert overrides_schema["additionalProperties"] is False
        override_props = cast("dict[str, object]", overrides_schema["properties"])
        assert "id" not in override_props
        assert "spec_version" not in override_props
        assert "spec_digest" not in override_props
        assert "tools" not in override_props
        assert "side_effect_policy" not in override_props

    def test_register_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_register" in tool_names

        register_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_register")
        assert "spec" in register_tool["input_schema"]["properties"]
        assert "spec" in register_tool["input_schema"]["required"]
        spec_schema = register_tool["input_schema"]["properties"]["spec"]
        assert spec_schema["additionalProperties"] is False
        assert "tools" not in spec_schema["properties"]
        assert "side_effect_policy" not in spec_schema["properties"]

    @pytest.mark.parametrize("tool_name", ["larva_validate", "larva_register"])
    def test_persona_spec_targeted_fields_match_canonical_schema_authority(
        self, tool_name: str
    ) -> None:
        tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == tool_name)
        spec_schema = tool["input_schema"]["properties"]["spec"]
        properties = cast("dict[str, object]", spec_schema["properties"])
        canonical_properties = _canonical_schema_properties()

        assert properties["capabilities"] == canonical_properties["capabilities"]
        assert properties["can_spawn"] == canonical_properties["can_spawn"]
        assert properties["spec_version"] == canonical_properties["spec_version"]
        assert properties["spec_digest"] == canonical_properties["spec_digest"]
        assert "capabilities" in spec_schema["required"]
        assert "spec_version" in spec_schema["required"]
        assert "can_spawn" not in spec_schema["required"]
        assert "spec_digest" not in spec_schema["required"]

    def test_list_tool_is_defined(self) -> None:
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_list" in tool_names

        list_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_list")
        assert list_tool["input_schema"]["properties"] == {}
        assert (
            "required" not in list_tool["input_schema"]
            or list_tool["input_schema"]["required"] == []
        )

    def test_component_list_tool_is_defined(self) -> None:
        """Verify larva_component_list is defined in LARVA_MCP_TOOLS."""
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_component_list" in tool_names

        component_list_tool = next(
            t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_component_list"
        )
        # component_list takes no required params
        assert component_list_tool["input_schema"]["properties"] == {}
        assert (
            "required" not in component_list_tool["input_schema"]
            or component_list_tool["input_schema"]["required"] == []
        )

    def test_component_show_tool_is_defined(self) -> None:
        """Verify larva_component_show is defined in LARVA_MCP_TOOLS."""
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_component_show" in tool_names

        component_show_tool = next(
            t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_component_show"
        )
        props = component_show_tool["input_schema"]["properties"]
        assert "component_type" in props
        assert "name" in props
        assert "component_type" in component_show_tool["input_schema"]["required"]
        assert "name" in component_show_tool["input_schema"]["required"]
        assert props["component_type"]["enum"] == ["prompts", "toolsets", "constraints", "models"]

    def test_delete_tool_is_defined(self) -> None:
        """Verify larva_delete is defined in LARVA_MCP_TOOLS."""
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_delete" in tool_names

        delete_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_delete")
        props = delete_tool["input_schema"]["properties"]
        assert "id" in props
        assert "id" in delete_tool["input_schema"]["required"]

    def test_clear_tool_is_defined(self) -> None:
        """Verify larva_clear is defined in LARVA_MCP_TOOLS."""
        tool_names = [t["name"] for t in mcp_module.LARVA_MCP_TOOLS]
        assert "larva_clear" in tool_names

        clear_tool = next(t for t in mcp_module.LARVA_MCP_TOOLS if t["name"] == "larva_clear")
        props = clear_tool["input_schema"]["properties"]
        assert "confirm" in props
        assert "confirm" in clear_tool["input_schema"]["required"]


# -----------------------------------------------------------------------------
# Error Code Tests
# -----------------------------------------------------------------------------


class TestMCPErrorCodes:
    """Verify error codes match INTERFACES.md :: G."""

    def test_error_codes_match_facade_error_codes(self) -> None:
        assert mcp_module.LARVA_ERROR_CODES == ERROR_NUMERIC_CODES

    def test_all_required_error_codes_present(self) -> None:
        # Core error codes that must always be present
        required_codes = {
            "INTERNAL",
            "INVALID_INPUT",
            "PERSONA_NOT_FOUND",
            "PERSONA_INVALID",
            "PERSONA_CYCLE",
            "INVALID_PERSONA_ID",
            "REGISTRY_INDEX_READ_FAILED",
            "REGISTRY_SPEC_READ_FAILED",
            "REGISTRY_WRITE_FAILED",
            "REGISTRY_UPDATE_FAILED",
            "REGISTRY_DELETE_FAILED",
            "INVALID_CONFIRMATION_TOKEN",
            "FORBIDDEN_OVERRIDE_FIELD",
            "FORBIDDEN_PATCH_FIELD",
            "FORBIDDEN_FIELD",
            "MISSING_SPEC_VERSION",
        }
        # Variant-related error codes that must be present after cutover
        # EXPECTED-RED: some may already exist, but PERSONA_ID_MISMATCH is missing
        variant_required_codes = {
            "PERSONA_ID_MISMATCH",
            "INVALID_VARIANT_NAME",
            "REGISTRY_CORRUPT",
            "VARIANT_NOT_FOUND",
            "ACTIVE_VARIANT_DELETE_FORBIDDEN",
            "LAST_VARIANT_DELETE_FORBIDDEN",
        }
        all_required = required_codes | variant_required_codes
        actual_codes = set(mcp_module.LARVA_ERROR_CODES.keys())
        missing = all_required - actual_codes
        extra = actual_codes - all_required
        assert not missing, f"Missing error codes: {sorted(missing)}"
        # Assembly/component codes should be removed after cutover
        # EXPECTED-RED: COMPONENT_NOT_FOUND and COMPONENT_CONFLICT still exist
        # These are expected to be present before cutover, removed after
        # For now, we just verify all required codes are present

    def test_error_codes_are_integers(self) -> None:
        for code, value in mcp_module.LARVA_ERROR_CODES.items():
            assert isinstance(value, int), f"Error code {code} should be integer"

    def test_component_error_codes_are_removed(self) -> None:
        """EXPECTED-RED: COMPONENT_NOT_FOUND and COMPONENT_CONFLICT must NOT be in error codes.

        Source: design/registry-local-variants-and-assembly-removal.md
        Assembly/component subsystem is removed.
        """
        assert "COMPONENT_NOT_FOUND" not in mcp_module.LARVA_ERROR_CODES, (
            f"COMPONENT_NOT_FOUND still in error codes. "
            f"Component subsystem removed per design doc."
        )
        assert "COMPONENT_CONFLICT" not in mcp_module.LARVA_ERROR_CODES, (
            f"COMPONENT_CONFLICT still in error codes. "
            f"Component subsystem removed per design doc."
        )

    def test_persona_id_mismatch_error_code_present(self) -> None:
        """EXPECTED-RED: PERSONA_ID_MISMATCH must be in error codes.

        Source: USAGE.md §6; INTERFACES.md lines 258-268.
        """
        assert "PERSONA_ID_MISMATCH" in mcp_module.LARVA_ERROR_CODES, (
            f"PERSONA_ID_MISMATCH missing from error codes. "
            f"Current codes: {sorted(mcp_module.LARVA_ERROR_CODES.keys())}. "
            f"Expected per INTERFACES.md."
        )


# -----------------------------------------------------------------------------
# Success Shape Tests
# -----------------------------------------------------------------------------


class TestMCPValidateSuccessShape:
    """Test larva_validate success response shape."""

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
            "warnings": [
                "unknown model identifier 'custom-model-x' is outside the known-model snapshot"
            ],
        }
        facade = _make_facade(validate_report=report)
        spec = _canonical_spec("test")

        result = facade.validate(spec)

        assert result["valid"] is True
        assert result["warnings"] == [
            "unknown model identifier 'custom-model-x' is outside the known-model snapshot"
        ]


class TestMCPAssembleSuccessShape:
    """Test larva_assemble success response shape."""

    def test_assemble_returns_persona_spec_shape(self) -> None:
        candidate = _canonical_spec("assembled", digest="sha256:assembled")
        facade = _make_facade(
            validate_report=_valid_report(),
            assemble_candidate=candidate,
        )

        result = facade.assemble({"id": "assembled"})

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
            "capabilities",
            "model_params",
            "can_spawn",
            "compaction_prompt",
            "spec_version",
            "spec_digest",
        ]
        for field_name in required_fields:
            assert field_name in spec, f"Missing required field: {field_name}"
        assert "tools" not in spec
        assert "side_effect_policy" not in spec


class TestMCPResolveSuccessShape:
    """Test larva_resolve success response shape."""

    def test_resolve_returns_persona_spec_shape(self) -> None:
        stored = _canonical_spec("stored")
        registry = InMemoryRegistryStore(get_result=Success(stored))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)

        result = facade.resolve("stored")

        assert isinstance(result, Success)
        spec = result.unwrap()
        assert spec["id"] == "stored"
        assert "spec_digest" in spec


class TestMCPRegisterSuccessShape:
    """Test larva_register success response shape."""

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
    """Test larva_list success response shape."""

    def test_list_returns_list_of_summaries(self) -> None:
        specs = [
            _canonical_spec("alpha"),
            _canonical_spec("beta"),
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
            assert "description" in summary
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
        stored = _canonical_spec("stored")
        stored["description"] = "original description"
        stored["can_spawn"] = True
        stored["compaction_prompt"] = "Original prompt"
        stored["model_params"] = {"temperature": 0.5}
        stored["spec_digest"] = _digest_for(stored)

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
        assert resolved["model_params"]["temperature"] == 0

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
        from larva.core.assemble import AssemblyError

        class ConflictAssembleModule:
            def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
                error = AssemblyError(
                    "COMPONENT_CONFLICT: Multiple sources provide 'side_effect_policy'"
                )
                error.code = "COMPONENT_CONFLICT"
                error.message = "Multiple sources provide 'side_effect_policy'"
                error.details = {"field": "side_effect_policy"}
                raise error

        class SpyValidateModule:
            def validate_spec(
                self,
                spec: PersonaSpec,
                registry_persona_ids: frozenset[str] | None = None,
            ) -> ValidationReport:
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
            ("larva_validate", {"spec": []}, "parameter 'spec' must be object"),
            (
                "larva_assemble",
                {"id": "ok", "prompts": ["ok", 2]},
                "parameter 'prompts' must be list[string]",
            ),
            (
                "larva_resolve",
                {"id": "ok", "overrides": []},
                "parameter 'overrides' must be object",
            ),
            ("larva_register", {"spec": "not-an-object"}, "parameter 'spec' must be object"),
            ("larva_list", {"unknown": True}, "unknown parameter(s)"),
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
            "larva_validate": handlers.handle_validate,
            "larva_assemble": handlers.handle_assemble,
            "larva_resolve": handlers.handle_resolve,
            "larva_register": handlers.handle_register,
            "larva_list": handlers.handle_list,
        }

        result = dispatch[tool](payload)

        assert isinstance(result, dict)
        _assert_malformed_params_error(cast("LarvaError", result), tool=tool, reason=reason)

    @pytest.mark.parametrize(
        "tool",
        ["larva_validate", "larva_assemble", "larva_resolve", "larva_register", "larva_list"],
    )
    def test_all_tools_reject_non_object_params(self, tool: str) -> None:
        handlers = mcp_module.MCPHandlers(_make_facade(validate_report=_valid_report()))
        dispatch = {
            "larva_validate": handlers.handle_validate,
            "larva_assemble": handlers.handle_assemble,
            "larva_resolve": handlers.handle_resolve,
            "larva_register": handlers.handle_register,
            "larva_list": handlers.handle_list,
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
        facade = _make_facade(validate_report=_valid_report())
        spec = _canonical_spec("round-trip")

        result = facade.validate(spec)

        assert "valid" in result
        assert "errors" in result
        assert "warnings" in result
        assert result["valid"] is True

    def test_assemble_tool_params_extraction(self) -> None:
        components = InMemoryComponentStore(
            prompts_by_name={"base-prompt": {"text": "You are helpful."}},
            toolsets_by_name={
                "readonly-tools": {
                    "capabilities": {"shell": "read_only"},
                }
            },
            constraints_by_name={"no-spawn": {"can_spawn": False}},
            models_by_name={"default-model": {"model": "gpt-4o-mini"}},
        )
        facade = _make_facade(validate_report=_valid_report(), components=components)

        request = {
            "id": "assembled-persona",
            "description": "assembled description",
            "prompts": ["base-prompt"],
            "toolsets": ["readonly-tools"],
            "constraints": ["no-spawn"],
            "model": "default-model",
            "overrides": {"temperature": 0.7},
        }

        result = facade.assemble(request)

        assert isinstance(result, Success)

    def test_resolve_tool_params_extraction(self) -> None:
        stored = _canonical_spec("stored")
        stored["model_params"] = {"temperature": 0.5}
        stored["spec_digest"] = _digest_for(stored)
        registry = InMemoryRegistryStore(get_result=Success(stored))

        validate_report: ValidationReport = {"valid": True, "errors": [], "warnings": []}
        facade = _make_facade(validate_report=validate_report, registry=registry)

        result = facade.resolve("stored", overrides={"model_params": {"temperature": 0.9}})

        assert isinstance(result, Success)
        resolved = result.unwrap()
        assert resolved["model_params"]["temperature"] == 0.9

    def test_register_tool_params_extraction(self) -> None:
        registry = InMemoryRegistryStore()
        facade = _make_facade(validate_report=_valid_report(), registry=registry)

        spec = _canonical_spec("to-register", digest="sha256:to-register")
        result = facade.register(spec)

        assert isinstance(result, Success)
        assert result.unwrap()["registered"] is True

    def test_list_tool_params_extraction(self) -> None:
        specs = [_canonical_spec("one")]
        registry = InMemoryRegistryStore(list_result=Success(specs))
        facade = _make_facade(registry=registry)

        result = facade.list()

        assert isinstance(result, Success)
        assert len(result.unwrap()) == 1


# -----------------------------------------------------------------------------
# MCPHandlers Implementation Tests
# -----------------------------------------------------------------------------


class TestMCPHandlersImplementation:
    """Test MCPHandlers methods correctly parse params and delegate to facade."""

    def test_handle_validate_success(self) -> None:
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        spec = _canonical_spec("test")
        result = handlers.handle_validate({"spec": spec})

        assert result["valid"] is True
        assert result["errors"] == []
        assert result["warnings"] == []

    def test_handle_validate_real_facade_surfaces_registry_snapshot_warning(self) -> None:
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=cast("AssembleRequest", assemble_module),
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(
                list_result=Success([_canonical_spec("known-child")]),
            ),
        )
        handlers = mcp_module.MCPHandlers(facade)
        spec = _canonical_spec("warning-runtime")
        spec["can_spawn"] = ["known-child", "missing-child"]

        result = handlers.handle_validate({"spec": spec})

        assert result["valid"] is True
        assert result["errors"] == []
        assert (
            "can_spawn references ids outside the current registry snapshot: missing-child"
            in result["warnings"]
        )

    def test_handle_validate_rejects_variables_as_extra_field(self) -> None:
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=cast("AssembleRequest", assemble_module),
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
                    "description": "Roundtrip warning coverage",
                    "spec_version": "0.1.0",
                    "prompt": "Hello.",
                    "model": "gpt-4o-mini",
                    "capabilities": {"shell": "read_only"},
                    "variables": {"role": "assistant"},
                }
            }
        )

        assert result["valid"] is False
        assert result["warnings"] == []
        assert any(issue["code"] == "EXTRA_FIELD_NOT_ALLOWED" for issue in result["errors"])

    def test_handle_validate_missing_spec_raises(self) -> None:
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_validate({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_validate",
            reason="missing required parameter 'spec'",
        )

    def test_handle_assemble_success(self) -> None:
        candidate = _canonical_spec("assembled", digest="sha256:assembled")
        facade = _make_facade(
            validate_report=_valid_report(),
            assemble_candidate=candidate,
        )
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble({"id": "assembled"})

        assert isinstance(result, dict)
        assert result["id"] == "assembled"
        assert "spec_digest" in result

    def test_handle_assemble_failure_returns_error_envelope(self) -> None:
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

        assert isinstance(result, dict)
        assert "error" not in result
        assert "code" in result
        assert "numeric_code" in result
        assert "message" in result
        assert "details" in result
        assert result["code"] == "COMPONENT_NOT_FOUND"

    def test_handle_assemble_rejects_variables_at_mcp_boundary(self) -> None:
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble({"id": "assembled", "variables": {"role": "analyst"}})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_assemble",
            reason="unknown parameter(s)",
        )

    def test_handle_assemble_missing_id_raises(self) -> None:
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble({"prompts": ["base"]})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_assemble",
            reason="missing required parameter 'id'",
        )

    def test_handle_assemble_preserves_falsey_overrides(self) -> None:
        candidate = _canonical_spec("assembled", digest="sha256:assembled")
        candidate["description"] = None
        candidate["can_spawn"] = False
        candidate["compaction_prompt"] = ""

        facade = _make_facade(
            validate_report=_valid_report(),
            assemble_candidate=candidate,
        )
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble(
            {
                "id": "test",
                "overrides": {
                    "can_spawn": False,
                },
            }
        )

        assert result["description"] is None
        assert result["can_spawn"] is False
        assert result["compaction_prompt"] == ""

    def test_handle_resolve_success(self) -> None:
        stored = _canonical_spec("stored")
        registry = InMemoryRegistryStore(get_result=Success(stored))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_resolve({"id": "stored"})

        assert isinstance(result, dict)
        assert result["id"] == "stored"
        assert "spec_digest" in result

    def test_handle_resolve_failure_returns_error_envelope(self) -> None:
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

        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_NOT_FOUND"
        assert result["numeric_code"] == 100

    def test_handle_resolve_missing_id_raises(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_resolve({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_resolve",
            reason="missing required parameter 'id'",
        )

    def test_handle_resolve_preserves_falsey_overrides(self) -> None:
        stored = _canonical_spec("stored")
        stored["description"] = "original"
        stored["can_spawn"] = True
        stored["model_params"] = {"temperature": 0.5}
        stored["spec_digest"] = _digest_for(stored)
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

        assert result["description"] is None
        assert result["can_spawn"] is False
        assert result["compaction_prompt"] == ""
        assert result["model_params"]["temperature"] == 0

    def test_handle_register_success(self) -> None:
        registry = InMemoryRegistryStore()
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        spec = _canonical_spec("to-register", digest="sha256:to-register")
        result = handlers.handle_register({"spec": spec})

        assert isinstance(result, dict)
        assert result["id"] == "to-register"
        assert result["registered"] is True

    def test_handle_register_failure_returns_error_envelope(self) -> None:
        facade = _make_facade(validate_report=_invalid_report("INVALID_SPEC_VERSION"))
        handlers = mcp_module.MCPHandlers(facade)

        spec = _canonical_spec("bad")
        result = handlers.handle_register({"spec": spec})

        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_INVALID"
        assert result["numeric_code"] == 101

    def test_handle_register_missing_spec_raises(self) -> None:
        facade = _make_facade(validate_report=_valid_report())
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_register({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_register",
            reason="missing required parameter 'spec'",
        )

    def test_handle_list_success(self) -> None:
        specs = [
            _canonical_spec("alpha"),
            _canonical_spec("beta"),
        ]
        registry = InMemoryRegistryStore(list_result=Success(specs))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_list({})

        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["id"] == "alpha"
        assert result[0]["description"] == "Persona alpha"
        assert result[1]["id"] == "beta"
        assert result[1]["description"] == "Persona beta"

    def test_handle_list_failure_returns_error_envelope(self) -> None:
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

        assert isinstance(result, dict)
        assert result["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert result["numeric_code"] == 107

    def test_handle_list_empty_params(self) -> None:
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_list({})
        assert result == []

    def test_handle_list_unknown_param_returns_malformed_envelope(self) -> None:
        registry = InMemoryRegistryStore(list_result=Success([]))
        handlers = mcp_module.MCPHandlers(_make_facade(registry=registry))

        result = handlers.handle_list({"limit": 5})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_list",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["limit"]


# -----------------------------------------------------------------------------
# MCP Component Tools: Acceptance Tests (to be removed during cutover)
# These tests assert the OLD surface exists. They must be removed when the
# cutover replaces them. The EXPECTED-RED cutover tests assert the opposite.
# -----------------------------------------------------------------------------


class TestMCPComponentListAcceptance:
    """Acceptance tests for larva_component_list MCP tool.

    NOTE: These tests verify the AS-IS surface. The variant cutover will
    REMOVE this tool. See TestMCPAssemblyComponentToolsRemoved for the
    expected-RED assertions that check for removal.
    """

    def test_handle_component_list_accepts_empty_params(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_list({})

        assert isinstance(result, dict)
        for key in ["prompts", "toolsets", "constraints", "models"]:
            assert key in result
            assert isinstance(result[key], list)

    def test_handle_component_list_unknown_param_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_list({"unexpected": "param"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_list",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["unexpected"]

    def test_handle_component_list_non_object_params_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_list([])

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_list",
            reason="params must be an object",
        )


class TestMCPComponentShowAcceptance:
    """Acceptance tests for larva_component_show MCP tool.

    NOTE: These tests verify the AS-IS surface. The variant cutover will
    REMOVE this tool. See TestMCPAssemblyComponentToolsRemoved for the
    expected-RED assertions that check for removal.
    """

    def test_handle_component_show_unknown_param_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show(
            {"component_type": "prompts", "name": "test", "extra": "param"}
        )

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_show",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["extra"]

    def test_handle_component_show_non_string_type_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": 123, "name": "test"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_show",
            reason="parameter 'component_type' must be string",
        )

    def test_handle_component_show_non_string_name_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": "prompts", "name": ["test"]})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_show",
            reason="parameter 'name' must be string",
        )

    def test_handle_component_show_missing_component_type_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"name": "test"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_show",
            reason="missing required parameter 'component_type'",
        )

    def test_handle_component_show_missing_name_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": "prompts"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_show",
            reason="missing required parameter 'name'",
        )

    def test_handle_component_show_non_object_params_returns_malformed_envelope(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show("not-an-object")

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_component_show",
            reason="params must be an object",
        )

    def test_handle_component_show_unsupported_type_returns_invalid_input(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": "invalid_type", "name": "test"})

        assert isinstance(result, dict)
        assert result["code"] == "INVALID_INPUT"
        assert result["numeric_code"] == 1
        assert result["details"]["reason"] == "invalid_kind"
        assert "prompts | toolsets | constraints | models" in result["message"]

    def test_handle_component_show_singular_alias_returns_invalid_input(self) -> None:
        components = InMemoryComponentStore(
            prompts_by_name={"test-prompt": {"text": "You are a helpful assistant."}}
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": "prompt", "name": "test-prompt"})

        assert isinstance(result, dict)
        assert result["code"] == "INVALID_INPUT"
        assert result["numeric_code"] == 1
        assert result["details"]["reason"] == "invalid_kind"

    def test_handle_component_show_missing_component_returns_component_not_found(self) -> None:
        components = InMemoryComponentStore()
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show(
            {"component_type": "prompts", "name": "nonexistent"}
        )

        assert isinstance(result, dict)
        assert result["code"] == "COMPONENT_NOT_FOUND"
        assert result["numeric_code"] == 105

    def test_handle_component_show_success_pins_loader_routing(self) -> None:
        components = InMemoryComponentStore(
            prompts_by_name={"test-prompt": {"text": "You are a helpful assistant."}}
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show(
            {"component_type": "prompts", "name": "test-prompt"}
        )

        assert isinstance(result, dict)
        assert "error" not in result
        assert result["text"] == "You are a helpful assistant."

    def test_handle_component_show_success_for_toolset(self) -> None:
        components = InMemoryComponentStore(
            toolsets_by_name={
                "readonly": {
                    "capabilities": {"shell": "read_only"},
                }
            }
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": "toolsets", "name": "readonly"})

        assert isinstance(result, dict)
        assert "error" not in result
        assert "capabilities" in result
        assert "tools" not in result

    def test_handle_component_show_rejects_toolset_payload_with_legacy_tools(self) -> None:
        components = InMemoryComponentStore(
            toolsets_by_name={"readonly": historical_toolset_fixture_with_legacy_fields()}
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": "toolsets", "name": "readonly"})

        assert isinstance(result, dict)
        assert result["code"] == "COMPONENT_NOT_FOUND"
        assert result["numeric_code"] == 105
        assert "tools" in result["message"]

    def test_handle_component_show_success_for_constraint(self) -> None:
        components = InMemoryComponentStore(
            constraints_by_name={"safe-default": {"can_spawn": False}}
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show(
            {"component_type": "constraints", "name": "safe-default"}
        )

        assert isinstance(result, dict)
        assert "error" not in result
        assert result["can_spawn"] is False
        assert "side_effect_policy" not in result

    def test_handle_component_show_rejects_constraint_payload_with_legacy_side_effect_policy(
        self,
    ) -> None:
        components = InMemoryComponentStore(
            constraints_by_name={"safe-default": historical_constraint_fixture_with_legacy_field()}
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show(
            {"component_type": "constraints", "name": "safe-default"}
        )

        assert isinstance(result, dict)
        assert result["code"] == "COMPONENT_NOT_FOUND"
        assert result["numeric_code"] == 105
        assert "side_effect_policy" in result["message"]

    @pytest.mark.parametrize(
        ("component_type", "payload"),
        [
            ("toolsets", {"capabilities": {"shell": "read_only"}, "notes": "unexpected"}),
            ("constraints", {"can_spawn": False, "notes": "unexpected"}),
            ("models", {"model": "gpt-4o-mini", "notes": "unexpected"}),
        ],
    )
    def test_handle_component_show_rejects_payload_with_unknown_metadata(
        self,
        component_type: str,
        payload: dict[str, object],
    ) -> None:
        components = InMemoryComponentStore(
            toolsets_by_name={"bad": cast("dict[str, dict[str, str]]", payload)}
            if component_type == "toolsets"
            else {},
            constraints_by_name={"bad": payload} if component_type == "constraints" else {},
            models_by_name={"bad": payload} if component_type == "models" else {},
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": component_type, "name": "bad"})

        assert isinstance(result, dict)
        assert result["code"] == "COMPONENT_NOT_FOUND"
        assert result["numeric_code"] == 105
        assert "unsupported field" in result["message"].lower()

    def test_handle_component_show_success_for_model(self) -> None:
        components = InMemoryComponentStore(
            models_by_name={
                "default": {"model": "gpt-4o-mini", "model_params": {"temperature": 0.1}}
            }
        )
        facade = _make_facade(components=components)
        handlers = mcp_module.MCPHandlers(facade, components=components)

        result = handlers.handle_component_show({"component_type": "models", "name": "default"})

        assert isinstance(result, dict)
        assert "error" not in result
        assert "model" in result


# -----------------------------------------------------------------------------
# MCP Delete/Clear Handler Tests (preserving pre-existing tests)
# -----------------------------------------------------------------------------


class TestMCPHandleDelete:
    """Test MCPHandlers.handle_delete parameter validation and delegation."""

    def test_handle_delete_success(self) -> None:
        registry = InMemoryRegistryStore()
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_delete({"id": "test-persona"})

        assert isinstance(result, dict)
        assert result["id"] == "test-persona"
        assert result["deleted"] is True

    def test_handle_delete_failure_returns_error_envelope(self) -> None:
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_delete({"id": "missing"})

        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_NOT_FOUND"
        assert result["numeric_code"] == 100
        assert "missing" in result["message"]

    def test_handle_delete_missing_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_delete({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_delete",
            reason="missing required parameter 'id'",
        )

    def test_handle_delete_non_string_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_delete({"id": 123})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_delete",
            reason="parameter 'id' must be string",
        )

    def test_handle_delete_unknown_param_returns_malformed_envelope(self) -> None:
        registry = InMemoryRegistryStore()
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_delete({"id": "test", "extra": "param"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_delete",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["extra"]

    def test_handle_delete_non_object_params_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_delete("not-an-object")

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_delete",
            reason="params must be an object",
        )


class TestMCPHandleClone:
    """Test MCPHandlers.handle_clone parameter validation and delegation."""

    def test_handle_clone_success(self) -> None:
        source_spec = _canonical_spec("source-persona")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone({"source_id": "source-persona", "new_id": "cloned-persona"})

        assert isinstance(result, dict)
        assert result["id"] == "cloned-persona"
        assert result["description"] == "Persona source-persona"
        assert result["spec_digest"] != "sha256:source"

    def test_handle_clone_failure_returns_error_envelope(self) -> None:
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone({"source_id": "missing", "new_id": "cloned-persona"})

        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_NOT_FOUND"
        assert result["numeric_code"] == 100
        assert "missing" in result["message"]

    def test_handle_clone_missing_source_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone({"new_id": "cloned-persona"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clone",
            reason="missing required parameter 'source_id'",
        )

    def test_handle_clone_missing_new_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone({"source_id": "source-persona"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clone",
            reason="missing required parameter 'new_id'",
        )

    def test_handle_clone_unknown_params_returns_malformed_envelope(self) -> None:
        source_spec = _canonical_spec("source-persona")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone(
            {
                "source_id": "source-persona",
                "new_id": "cloned-persona",
                "extra": "param",
            }
        )

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clone",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["extra"]

    def test_handle_clone_non_string_source_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone({"source_id": 123, "new_id": "cloned-persona"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clone",
            reason="parameter 'source_id' must be string",
        )

    def test_handle_clone_non_string_new_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone({"source_id": "source-persona", "new_id": 456})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clone",
            reason="parameter 'new_id' must be string",
        )

    def test_handle_clone_non_object_params_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clone("not-an-object")

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clone",
            reason="params must be an object",
        )


class TestMCPHandleUpdateBatch:
    """Test MCPHandlers.handle_update_batch parameter validation and delegation."""

    def test_handle_update_batch_success(self) -> None:
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {"where": {"model": "gpt-4o-mini"}, "patches": {"description": "Updated"}}
        )

        assert isinstance(result, dict)
        assert result["matched"] == 2
        assert result["updated"] == 2
        assert len(result["items"]) == 2
        assert result["items"][0]["id"] == "alpha"
        assert result["items"][0]["updated"] is True
        assert result["items"][1]["id"] == "beta"
        assert result["items"][1]["updated"] is True

    def test_handle_update_batch_dry_run_returns_matched_without_writes(self) -> None:
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {
                "where": {"model": "gpt-4o-mini"},
                "patches": {"description": "Should not persist"},
                "dry_run": True,
            }
        )

        assert isinstance(result, dict)
        assert result["matched"] == 2
        assert result["updated"] == 0
        assert len(result["items"]) == 2
        assert result["items"][0]["id"] == "alpha"
        assert result["items"][0]["updated"] is False
        assert result["items"][1]["id"] == "beta"
        assert result["items"][1]["updated"] is False
        assert registry.save_inputs == []

    def test_handle_update_batch_missing_where_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch({"patches": {"description": "Test"}})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update_batch",
            reason="missing required parameter 'where'",
        )

    def test_handle_update_batch_missing_patches_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch({"where": {"model": "gpt-4o-mini"}})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update_batch",
            reason="missing required parameter 'patches'",
        )

    def test_handle_update_batch_unknown_params_returns_malformed_envelope(self) -> None:
        spec_alpha = _canonical_spec("alpha")
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {
                "where": {"model": "gpt-4o-mini"},
                "patches": {"description": "Test"},
                "extra": "unknown_param",
            }
        )

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update_batch",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["extra"]

    def test_handle_update_batch_non_object_where_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {"where": "not-an-object", "patches": {"description": "Test"}}
        )

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update_batch",
            reason="parameter 'where' must be object",
        )

    def test_handle_update_batch_non_object_patches_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {"where": {"model": "gpt-4o-mini"}, "patches": ["not", "an", "object"]}
        )

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update_batch",
            reason="parameter 'patches' must be object",
        )

    def test_handle_update_batch_non_boolean_dry_run_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {
                "where": {"model": "gpt-4o-mini"},
                "patches": {"description": "Test"},
                "dry_run": "true",
            }
        )

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update_batch",
            reason="parameter 'dry_run' must be boolean",
        )

    def test_handle_update_batch_non_object_params_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch("not-an-object")

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update_batch",
            reason="params must be an object",
        )

    @pytest.mark.parametrize(
        ("where_key", "expected_field", "expected_value"),
        [
            ("tools.shell", "tools", "read_only"),
            ("side_effect_policy", "side_effect_policy", "read_only"),
        ],
    )
    def test_handle_update_batch_rejects_legacy_where_fields(
        self,
        where_key: str,
        expected_field: str,
        expected_value: object,
    ) -> None:
        registry = InMemoryRegistryStore(list_result=Success([_canonical_spec("alpha")]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {"where": {where_key: expected_value}, "patches": {"description": "Updated"}}
        )

        assert isinstance(result, dict)
        assert result["code"] == "INVALID_INPUT"
        assert result["numeric_code"] == 1
        assert expected_field in result["message"]
        assert result["details"]["field"] == expected_field
        assert result["details"]["where_key"] == where_key

    def test_handle_update_batch_failure_returns_error_envelope(self) -> None:
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "cannot read registry index",
                    "path": "/tmp/registry/index.json",
                }
            )
        )
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {"where": {"model": "gpt-4o-mini"}, "patches": {"description": "Test"}}
        )

        assert isinstance(result, dict)
        assert result["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert result["numeric_code"] == 107

    def test_handle_update_batch_with_empty_where_matches_all(self) -> None:
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update_batch(
            {"where": {}, "patches": {"description": "All updated"}}
        )

        assert isinstance(result, dict)
        assert result["matched"] == 2
        assert result["updated"] == 2


class TestMCPHandleClear:
    """Test MCPHandlers.handle_clear parameter validation and delegation."""

    def test_handle_clear_success(self) -> None:
        registry = InMemoryRegistryStore(clear_result=Success(3))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clear({"confirm": "CLEAR REGISTRY"})

        assert isinstance(result, dict)
        assert result["cleared"] is True
        assert result["count"] == 3

    def test_handle_clear_failure_returns_error_envelope(self) -> None:
        registry = InMemoryRegistryStore(
            clear_result=Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to delete specs",
                    "operation": "clear",
                    "path": "/registry",
                }
            )
        )
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clear({"confirm": "CLEAR REGISTRY"})

        assert isinstance(result, dict)
        assert result["code"] == "REGISTRY_DELETE_FAILED"
        assert result["numeric_code"] == 111

    def test_handle_clear_wrong_confirm_returns_error_envelope(self) -> None:
        registry = InMemoryRegistryStore(
            clear_result=Failure(
                {
                    "code": "INVALID_CONFIRMATION_TOKEN",
                    "message": "clear requires exact confirmation token 'CLEAR REGISTRY'",
                }
            )
        )
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clear({"confirm": "WRONG TOKEN"})

        assert isinstance(result, dict)
        assert result["code"] == "INVALID_CONFIRMATION_TOKEN"
        assert result["numeric_code"] == 112

    def test_handle_clear_missing_confirm_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clear({})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clear",
            reason="missing required parameter 'confirm'",
        )

    def test_handle_clear_non_string_confirm_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clear({"confirm": 123})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clear",
            reason="parameter 'confirm' must be string",
        )

    def test_handle_clear_unknown_param_returns_malformed_envelope(self) -> None:
        registry = InMemoryRegistryStore()
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clear({"confirm": "CLEAR REGISTRY", "extra": "param"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clear",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["extra"]

    def test_handle_clear_non_object_params_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_clear(["not", "an", "object"])

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_clear",
            reason="params must be an object",
        )


# -----------------------------------------------------------------------------
# MCP Update Handler Tests
# -----------------------------------------------------------------------------


class TestMCPHandleUpdate:
    """Test MCPHandlers.handle_update parameter validation and delegation."""

    def test_handle_update_success(self) -> None:
        existing = _canonical_spec("update-test")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update(
            {"id": "update-test", "patches": {"description": "Updated"}}
        )

        assert isinstance(result, dict)
        assert "error" not in result
        assert result["id"] == "update-test"
        assert "spec_digest" in result

    def test_handle_update_failure_returns_error_envelope(self) -> None:
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

        result = handlers.handle_update({"id": "missing", "patches": {"description": "x"}})

        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_NOT_FOUND"
        assert result["numeric_code"] == 100

    def test_handle_update_validation_failure_returns_error_envelope(self) -> None:
        existing = _canonical_spec("update-invalid")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(
            validate_report=_invalid_report("INVALID_SPEC_VERSION"), registry=registry
        )
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update({"id": "update-invalid", "patches": {"description": None}})

        assert isinstance(result, dict)
        assert result["code"] == "PERSONA_INVALID"
        assert result["numeric_code"] == 101

    def test_handle_update_missing_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update({"patches": {"description": "x"}})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update",
            reason="missing required parameter 'id'",
        )

    def test_handle_update_missing_patches_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update({"id": "test"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update",
            reason="missing required parameter 'patches'",
        )

    def test_handle_update_non_string_id_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update({"id": 123, "patches": {"description": "x"}})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update",
            reason="parameter 'id' must be string",
        )

    def test_handle_update_non_object_patches_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update({"id": "test", "patches": "not-an-object"})

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update",
            reason="parameter 'patches' must be object",
        )

    def test_handle_update_unknown_param_returns_malformed_envelope(self) -> None:
        existing = _canonical_spec("update-unknown")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update(
            {"id": "update-unknown", "patches": {"description": "x"}, "extra": "param"}
        )

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update",
            reason="unknown parameter(s)",
        )
        assert result["details"]["unknown"] == ["extra"]

    def test_handle_update_non_object_params_returns_malformed_envelope(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update("not-an-object")

        assert isinstance(result, dict)
        _assert_malformed_params_error(
            cast("LarvaError", result),
            tool="larva_update",
            reason="params must be an object",
        )

    def test_handle_update_preserves_falsey_patches(self) -> None:
        existing = _canonical_spec("update-falsey")
        existing["description"] = "Original"
        existing["can_spawn"] = True
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(validate_report=_valid_report(), registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_update(
            {"id": "update-falsey", "patches": {"description": None, "can_spawn": False}}
        )

        assert isinstance(result, dict)
        assert "error" not in result


# -----------------------------------------------------------------------------
# MCP Export Handler Tests
# -----------------------------------------------------------------------------


class TestMCPHandleExport:
    """Test MCPHandlers.handle_export parameter validation and delegation."""

    def test_handle_export_all_success(self) -> None:
        spec_alpha = _canonical_spec("export-alpha")
        spec_beta = _canonical_spec("export-beta")
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_export({"all": True})

        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["id"] == "export-alpha"
        assert result[1]["id"] == "export-beta"

    def test_handle_export_ids_success(self) -> None:
        spec_one = _canonical_spec("export-one")
        spec_two = _canonical_spec("export-two")

        def get_by_id(persona_id: str) -> Result[PersonaSpec, LarvaError]:
            if persona_id == "export-one":
                return Success(spec_one)
            if persona_id == "export-two":
                return Success(spec_two)
            return Failure({"code": "PERSONA_NOT_FOUND", "message": f"not found: {persona_id}"})

        registry = InMemoryRegistryStore(get_result=Success(spec_one))
        registry.get = get_by_id  # type: ignore[method-assign]
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_export({"ids": ["export-two", "export-one"]})

        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["id"] == "export-two"
        assert result[1]["id"] == "export-one"

    def test_handle_export_ids_single_returns_list_with_one(self) -> None:
        spec_single = _canonical_spec("export-single")
        registry = InMemoryRegistryStore(get_result=Success(spec_single))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_export({"ids": ["export-single"]})

        assert isinstance(result, list)
        assert len(result) == 1
        assert result[0]["id"] == "export-single"

    def test_handle_export_ids_empty_list_returns_empty_list(self) -> None:
        facade = _make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_export({"ids": []})

        assert isinstance(result, list)
        assert result == []

    def test_handle_export_all_empty_registry_returns_empty_list(self) -> None:
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade = _make_facade(registry=registry)
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_export({"all": True})

        assert isinstance(result, list)
        assert result == []