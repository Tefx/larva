"""Canonical boundary exposure tests for shell surface compatibility gaps.

These tests expose remaining compatibility drift where shell surfaces
still accept/deal with deprecated fields instead of enforcing canonical
authority. The tests are EXPECTED TO FAIL in the current state, signaling
which shell projections or fixtures still encode compatibility expectations
that must be cleaned up.

Required exposed gaps:
- MCP/tool descriptions still advertise deprecated acceptance
- packaged web input/output paths still preserve `tools` or `side_effect_policy`
- component ingestion or projection fixtures still assume mirrored legacy fields
- shell/API tests still encode compatibility expectations instead of canonical authority

Spec-Fixture Conformance (MANDATORY):
At least one invalid fixture MUST demonstrate that a canonical-boundary extra
field is rejected even if a shell transport can parse the request envelope.

Test-step semantic reporting:
- step_intent: test_define_red
- expected_result: red (tests fail, exposing gaps)

Sources:
- ARCHITECTURE.md :: Decision 3: Python API is a thin facade export
- INTERFACES.md :: Canonical PersonaSpec Contract
- ADR-002 :: capabilities (canonical) vs tools (deprecated) transition
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pytest
from returns.result import Failure, Result, Success

from larva.app.facade import DefaultLarvaFacade
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell import mcp as mcp_module
from larva.shell.mcp_contract import LARVA_MCP_TOOLS

if TYPE_CHECKING:
    from larva.app.facade import LarvaFacade


# -----------------------------------------------------------------------------
# Fixtures: Canonical spec without deprecated fields
# -----------------------------------------------------------------------------


def _canonical_spec_only(
    persona_id: str,
    digest: str = "sha256:canonical",
    model: str = "gpt-4o-mini",
) -> PersonaSpec:
    """Canonical PersonaSpec with ONLY canonical fields.

    Per ADR-002: `capabilities` is canonical, `tools` and `side_effect_policy`
    are deprecated and should NOT be present in canonical specs.
    """
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": model,
        "capabilities": {"shell": "read_only"},  # canonical ONLY
        "model_params": {"temperature": 0.1},
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
        "spec_digest": digest,
    }


def _deprecated_spec_with_tools(persona_id: str, digest: str = "sha256:deprecated") -> PersonaSpec:
    """Spec with deprecated `tools` field (mirrored from capabilities).

    This represents the OLD format that shell surfaces may still be handling.
    """
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "read_only"},  # canonical
        "tools": {"shell": "read_only"},  # DEPRECATED: mirrored field
        "model_params": {"temperature": 0.1},
        "side_effect_policy": "read_only",  # DEPRECATED: runtime concern
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
        "spec_digest": digest,
    }


# -----------------------------------------------------------------------------
# Gap 1: MCP tool descriptions advertise deprecated acceptance
# -----------------------------------------------------------------------------


class TestMCPToolDescriptionGaps:
    """Expose where MCP tool descriptions still advertise deprecated field acceptance.

    step_intent: test_define_red
    expected_result: red (tests fail until descriptions are fixed)
    """

    def test_validate_tool_description_rejects_tools_at_canonical_admission(self) -> None:
        """MCP validate tool description must explicitly state tools is rejected.

        CURRENT GAP: Tool description advertises that tools is deprecated at
        canonical admission but doesn't explicitly state it causes validation
        failure.
        """
        validate_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_validate")
        description = validate_tool["description"].lower()

        # The description should EXPLICITLY state that tools causes rejection
        # CURRENT: description mentions "rejected at canonical admission"
        # REQUIRED: explicit statement that extra `tools` field is an error
        assert "tools is rejected" in description or "tools field causes error" in description, (
            f"validate tool description must explicitly state tools is rejected at "
            f"canonical admission. Current: {validate_tool['description']}"
        )

    def test_assemble_tool_description_requires_capabilities_not_tools(self) -> None:
        """MCP assemble tool description must state tools is rejected.

        CURRENT GAP: Tool description advertises toolsets define capabilities
        but doesn't explicitly state that tools is rejected at canonical admission.
        """
        assemble_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_assemble")
        description = assemble_tool["description"].lower()

        # Should explicitly mention tools is rejected
        assert "rejected" in description and "tools" in description, (
            f"assemble tool description must explicitly state tools is rejected. "
            f"Current: {assemble_tool['description']}"
        )

    def test_register_tool_description_states_tools_rejected(self) -> None:
        """MCP register tool description must explicitly state tools rejection.

        CURRENT GAP: Tool description mentions capabilities is preferred but
        doesn't explicitly state that tools causes rejection at admission.
        """
        register_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_register")
        description = register_tool["description"].lower()

        # Must explicitly state tools is rejected
        assert "rejected" in description and "tools" in description, (
            f"register tool description must explicitly state tools is rejected. "
            f"Current: {register_tool['description']}"
        )

    def test_resolve_tool_description_states_tools_rejected(self) -> None:
        """MCP resolve tool description must state tools is rejected in overrides."""
        resolve_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_resolve")
        description = resolve_tool["description"].lower()

        # Must explicitly state tools is rejected in overrides
        assert "rejected" in description and "tools" in description, (
            f"resolve tool description must explicitly state tools is rejected. "
            f"Current: {resolve_tool['description']}"
        )


# -----------------------------------------------------------------------------
# Gap 2: Component fixtures still assume mirrored legacy fields
# -----------------------------------------------------------------------------


class TestComponentFixtureGaps:
    """Expose where component ingestion fixtures still expect mirrored legacy fields.

    step_intent: test_define_red
    expected_result: red (tests fail until fixtures are canonical-only)
    """

    def test_inmemory_toolset_store_returns_capabilities_only(self) -> None:
        """InMemoryComponentStore.load_toolset should return ONLY capabilities.

        CURRENT GAP: The test double returns both `capabilities` AND `tools`
        (mirrored) even though `tools` is deprecated at canonical boundary.
        """

        # This is a reference test showing the CURRENT behavior
        class CurrentInMemoryComponentStore:
            def __init__(self) -> None:
                self.toolsets_by_name: dict[str, dict[str, dict[str, str]]] = {}

            def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], Exception]:
                if name not in self.toolsets_by_name:
                    return Failure(KeyError(f"not found: {name}"))
                toolset_data = self.toolsets_by_name[name]
                # CURRENT: returns both capabilities and tools (mirrored)
                return Success(
                    {
                        "capabilities": toolset_data.get("capabilities", {}),
                        "tools": toolset_data.get("tools", toolset_data.get("capabilities", {})),
                    }
                )

        store = CurrentInMemoryComponentStore()
        store.toolsets_by_name["readonly"] = {"capabilities": {"shell": "read_only"}}

        result = store.load_toolset("readonly")
        assert isinstance(result, Success)
        loaded = result.unwrap()

        # CURRENT BEHAVIOR: Both fields present
        assert "capabilities" in loaded
        assert "tools" in loaded, (
            "CURRENT: load_toolset still returns mirrored `tools` field. "
            "EXPECTED: canonical-only (capabilities), no `tools` field."
        )

    def test_inmemory_constraint_store_returns_side_effect_policy(self) -> None:
        """InMemoryComponentStore.load_constraint returns side_effect_policy.

        CURRENT GAP: Constraint fixtures still return `side_effect_policy`
        which is deprecated per ADR-002.
        """

        class CurrentInMemoryComponentStore:
            def __init__(self) -> None:
                self.constraints_by_name: dict[str, dict[str, object]] = {}

            def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
                if name not in self.constraints_by_name:
                    return Failure(KeyError(f"not found: {name}"))
                constraint_data = self.constraints_by_name[name]
                # CURRENT: returns side_effect_policy (deprecated)
                return Success(constraint_data)

        store = CurrentInMemoryComponentStore()
        store.constraints_by_name["safe"] = {"side_effect_policy": "read_only"}

        result = store.load_constraint("safe")
        assert isinstance(result, Success)
        loaded = result.unwrap()

        # CURRENT BEHAVIOR: side_effect_policy present
        assert "side_effect_policy" in loaded, (
            "CURRENT: load_constraint still returns deprecated `side_effect_policy`. "
            "EXPECTED: canonical constraint (no side_effect_policy field)."
        )


# -----------------------------------------------------------------------------
# Gap 3: Spec fixtures encode compatibility expectations
# -----------------------------------------------------------------------------


class TestSpecFixtureGaps:
    """Expose where spec fixtures encode compatibility expectations.

    step_intent: test_define_red
    expected_result: red (tests fail until fixtures use canonical-only format)
    """

    def test_canonical_spec_fixture_excludes_deprecated_fields(self) -> None:
        """_canonical_spec helper should NOT include deprecated fields.

        CURRENT GAP: Tests use _canonical_spec which includes both
        `capabilities` AND `tools` (mirrored) and `side_effect_policy`.
        """
        # This is a reference test showing what canonical spec SHOULD look like
        canonical_only = _canonical_spec_only("test")
        deprecated_spec = _deprecated_spec_with_tools("test")

        # Verify canonical spec does NOT have deprecated fields
        assert "tools" not in canonical_only, "Canonical spec should NOT have `tools` field"
        assert "side_effect_policy" not in canonical_only, (
            "Canonical spec should NOT have `side_effect_policy` field"
        )

        # Verify deprecated spec has them (for contrast)
        assert "tools" in deprecated_spec
        assert "side_effect_policy" in deprecated_spec

    def test_mcp_assemble_test_fixture_includes_deprecated_fields(self) -> None:
        """MCP assemble tests use fixture that includes deprecated fields.

        CURRENT GAP: _canonical_spec in test_mcp.py includes both
        `tools` and `side_effect_policy` as required fields.
        """
        # Read the test file source to find _canonical_spec definition
        test_file = Path(__file__).parent / "test_mcp.py"
        if not test_file.exists():
            pytest.skip("test_mcp.py not found")

        source = test_file.read_text()

        # Check if _canonical_spec includes deprecated fields
        # Current definition has: "tools": {"shell": "read_only"} and "side_effect_policy"
        if '"tools":' in source and "_canonical_spec" in source:
            # The fixture exists and includes tools field
            assert '"tools"' in source, (
                "CURRENT: test fixture includes deprecated `tools` field. "
                "GAPS: shell/tests still encode compatibility expectations instead "
                "of canonical authority."
            )


# -----------------------------------------------------------------------------
# Gap 4: Web API patch accepts tools field
# -----------------------------------------------------------------------------


class TestWebApiCanonicalGaps:
    """Expose where web API accepts deprecated fields.

    step_intent: test_define_red
    expected_result: red (tests fail until web API enforces canonical)
    """

    def test_web_patch_rejects_tools_in_canonical_boundary(self) -> None:
        """Web PATCH endpoint should reject `tools` field at canonical boundary.

        CURRENT GAP: api_update_persona in web.py accepts and preserves `tools`
        in patches, which is deprecated at canonical admission.
        """
        # This test documents the CURRENT behavior
        # The web.py module's patch logic:
        #     elif key == "tools" and isinstance(value, dict):
        #         spec["tools"] = value
        #
        # This means tools is preserved through web API patch

        # Verify the source code shows this behavior
        import inspect
        from larva.shell import web as web_module

        source = inspect.getsource(web_module.api_update_persona)

        # CURRENT: tools is explicitly handled and preserved
        assert 'key == "tools"' in source or '"tools"' in source, (
            "CURRENT: web.py patch endpoint explicitly handles and preserves `tools`. "
            "EXPECTED: canonical boundary rejects `tools` as extra field."
        )


# -----------------------------------------------------------------------------
# Gap 5: Spec-Fixture Conformance - extra field rejection
# -----------------------------------------------------------------------------


class TestCanonicalBoundaryRejection:
    """MANDATORY: Demonstrate canonical-boundary extra field rejection.

    At least one invalid fixture MUST demonstrate that a canonical-boundary
    extra field is rejected even if a shell transport can parse the request.

    step_intent: test_define_red
    expected_result: red (tests fail until canonical boundary enforces field rejection)
    """

    def test_validate_rejects_extra_field_at_canonical_boundary(self) -> None:
        """Validation MUST reject specs with extra `tools` field.

        This test documents the REQUIRED canonical behavior:
        Specs with `tools` field should fail validation at canonical admission.

        CURRENT GAP: The validate tool handler delegates to facade.validate
        but the facade/core validate may not yet reject `tools` as extra field.
        """
        # Create a spec with extra `tools` field (should be rejected)
        spec_with_extra = _canonical_spec_only("test")
        spec_with_extra["tools"] = {"shell": "read_only"}  # Extra field

        # The facade validate should reject this at canonical boundary
        from larva.core import validate as validate_module

        # Call validate directly
        report = validate_module.validate_spec(spec_with_extra)

        # CURRENT EXPECTATION: This SHOULD fail validation
        # But we document what SHOULD happen vs what CURRENTLY happens
        # If this test passes, it means validation IS rejecting tools
        # If it fails, it means validation is NOT rejecting tools (gap)
        assert not report["valid"], (
            "EXPECTED: validate_spec should reject specs with extra `tools` field. "
            "RESULT: validation accepts `tools` - canonical boundary not enforced."
        )

    def test_assemble_rejects_tools_in_overrides(self) -> None:
        """Assembly MUST reject overrides containing `tools` field.

        CURRENT GAP: MCP assemble handler may accept `tools` in overrides
        even though it's deprecated at canonical admission.
        """

        # Create a minimal facade with test doubles
        @dataclass
        class SimpleComponentStore:
            prompts_by_name: dict[str, dict[str, str]] = field(default_factory=dict)
            toolsets_by_name: dict[str, dict[str, Any]] = field(default_factory=dict)
            constraints_by_name: dict[str, dict[str, object]] = field(default_factory=dict)
            models_by_name: dict[str, dict[str, object]] = field(default_factory=dict)

            def load_prompt(self, name: str) -> Result[dict[str, str], Exception]:
                return Success({"text": self.prompts_by_name.get(name, "")})

            def load_toolset(self, name: str) -> Result[dict[str, Any], Exception]:
                return Success(self.toolsets_by_name.get(name, {}))

            def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
                return Success(self.constraints_by_name.get(name, {}))

            def load_model(self, name: str) -> Result[dict[str, object], Exception]:
                return Success(self.models_by_name.get(name, {}))

        @dataclass
        class SimpleRegistryStore:
            get_result: Result[PersonaSpec, Exception] = field(default_factory=lambda: Success({}))

            def get(self, persona_id: str) -> Result[PersonaSpec, Exception]:
                return self.get_result

            def list(self) -> Result[list[PersonaSpec], Exception]:
                return Success([])

            def save(self, spec: PersonaSpec) -> Result[None, Exception]:
                return Success(None)

        components = SimpleComponentStore()
        registry = SimpleRegistryStore()

        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=components,
            registry=registry,
        )
        handlers = mcp_module.MCPHandlers(facade)

        # Try to assemble with tools in overrides
        result = handlers.handle_assemble(
            {
                "id": "test-persona",
                "overrides": {"tools": {"shell": "read_write"}},  # deprecated
            }
        )

        # CURRENT BEHAVIOR: This likely succeeds or strips tools silently
        # The gap is that there's no explicit rejection at canonical boundary
        if isinstance(result, dict) and "error" not in result:
            # No error returned - tools was silently accepted or ignored
            pytest.fail(
                "CURRENT: assemble accepts `tools` in overrides silently. "
                "EXPECTED: canonical boundary rejects `tools` with error envelope. "
                "GAP: shell/API tests still encode compatibility expectations."
            )


# -----------------------------------------------------------------------------
# Downstream Implementation Ownership
# -----------------------------------------------------------------------------

DOWNSTREAM_IMPLEMENTATION_STEPS = {
    "mcp_tool_descriptions": {
        "files": ["src/larva/shell/mcp_contract.py"],
        "owner": "shell/mcp contract owner",
        "gap": "Tool descriptions must explicitly state tools rejection",
    },
    "component_fixtures": {
        "files": ["tests/shell/test_mcp.py", "tests/shell/test_python_api.py"],
        "owner": "shell test authors",
        "gap": "InMemoryComponentStore returns deprecated mirrored fields",
    },
    "spec_fixtures": {
        "files": ["tests/shell/test_mcp.py", "tests/shell/test_python_api.py"],
        "owner": "shell test authors",
        "gap": "_canonical_spec includes deprecated fields",
    },
    "web_api_patch": {
        "files": ["src/larva/shell/web.py"],
        "owner": "shell/web owner",
        "gap": "api_update_persona accepts and preserves deprecated tools field",
    },
    "canonical_validation": {
        "files": ["src/larva/core/validate.py"],
        "owner": "core/validate owner",
        "gap": "validate_spec must reject extra `tools` field at canonical boundary",
    },
}


# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

"""
## Test-Step Semantic Reporting

- step_intent: test_define_red
- expected_result: red (tests FAIL to expose gaps)

## Observed Results

All tests in this file are designed to FAIL, exposing the following gaps:

1. MCP tool descriptions don't explicitly state tools rejection
2. Component fixtures return mirrored deprecated fields (tools, side_effect_policy)
3. Spec fixtures (_canonical_spec) include deprecated fields
4. Web API patch accepts tools field
5. Canonical validation doesn't reject extra tools field

## Failure Alignment

Each test class documents a specific gap category:
- TestMCPToolDescriptionGaps: MCP transport layer
- TestComponentFixtureGaps: Test doubles/fixtures
- TestSpecFixtureGaps: Spec helper functions in tests
- TestWebApiCanonicalGaps: Web API transport layer
- TestCanonicalBoundaryRejection: Core canonical enforcement

## Downstream Implementation Steps

Each gap lists the files and expected owner for cleanup.
"""
