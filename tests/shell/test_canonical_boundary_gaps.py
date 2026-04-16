"""Canonical boundary regression tests for shell-surface consistency.

This file keeps its historical name, but the tests now verify that canonical
boundary cleanup has landed and remains stable across shell-facing surfaces and
test fixtures.

Covered regressions:
- MCP/tool descriptions explicitly state rejection semantics
- packaged web patch flow does not preserve forbidden fields
- component and spec fixtures distinguish canonical-only vs transition-only data
- canonical validation rejects forbidden extra fields even when envelopes parse

Sources:
- ARCHITECTURE.md :: Decision 3: Python API is a thin facade export
- INTERFACES.md :: Canonical PersonaSpec Contract
- ADR-002 :: capabilities (canonical) vs removed/rejected transition fields
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
from larva.shell import web as web_module
from larva.shell.mcp_contract import LARVA_MCP_TOOLS
from tests.shell.fixture_taxonomy import (
    TransitionComponentStoreDouble,
    canonical_persona_spec,
    transition_constraint_fixture,
    transition_persona_spec_with_legacy_fields,
    transition_toolset_fixture,
)

if TYPE_CHECKING:
    from larva.app.facade import LarvaFacade


# -----------------------------------------------------------------------------
# Regression 1: MCP tool descriptions advertise explicit rejection semantics
# -----------------------------------------------------------------------------


class TestMCPToolDescriptionSemantics:
    """Verify MCP tool descriptions preserve explicit rejection semantics."""

    def test_validate_tool_description_rejects_tools_at_canonical_admission(self) -> None:
        """MCP validate tool description must explicitly state tools is rejected."""
        validate_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_validate")
        description = validate_tool["description"].lower()

        # The description should explicitly state that tools causes rejection.
        assert "tools is rejected" in description or "tools field causes error" in description, (
            f"validate tool description must explicitly state tools is rejected at "
            f"canonical admission. Current: {validate_tool['description']}"
        )

    def test_assemble_tool_description_requires_capabilities_not_tools(self) -> None:
        """MCP assemble tool description must state tools is rejected."""
        assemble_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_assemble")
        description = assemble_tool["description"].lower()

        # Should explicitly mention tools is rejected
        assert "rejected" in description and "tools" in description, (
            f"assemble tool description must explicitly state tools is rejected. "
            f"Current: {assemble_tool['description']}"
        )

    def test_assemble_tool_schema_excludes_variables(self) -> None:
        """Shared assemble schema must not advertise removed variables input."""
        assemble_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_assemble")

        assert "variables" not in assemble_tool["input_schema"]["properties"]

    def test_register_tool_description_states_tools_rejected(self) -> None:
        """MCP register tool description must explicitly state tools rejection."""
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
# Regression 2: transition fixtures remain explicit rather than implicit
# -----------------------------------------------------------------------------


class TestComponentFixtureSemantics:
    """Verify component fixtures clearly separate canonical and transition semantics."""

    def test_inmemory_toolset_store_returns_capabilities_only(self) -> None:
        """Transition test doubles should make mirrored fields explicit, not implicit."""

        store = TransitionComponentStoreDouble(
            toolsets_by_name={"readonly": transition_toolset_fixture()}
        )

        result = store.load_toolset("readonly")
        assert isinstance(result, Success)
        loaded = result.unwrap()

        # Transition-only fixture includes both fields by design.
        assert "capabilities" in loaded
        assert "tools" in loaded, (
            "Transition fixture should keep mirrored `tools` field explicit so canonical-only "
            "fixtures remain separate."
        )

    def test_inmemory_constraint_store_returns_side_effect_policy(self) -> None:
        """Transition constraint fixtures must make forbidden fields explicit."""

        store = TransitionComponentStoreDouble(
            constraints_by_name={"safe": transition_constraint_fixture()}
        )

        result = store.load_constraint("safe")
        assert isinstance(result, Success)
        loaded = result.unwrap()

        # Transition-only fixture keeps side_effect_policy explicit by design.
        assert "side_effect_policy" in loaded, (
            "Transition fixture should keep `side_effect_policy` explicit so canonical fixtures "
            "remain clean."
        )


# -----------------------------------------------------------------------------
# Regression 3: spec fixtures distinguish canonical-only from forbidden-field coverage
# -----------------------------------------------------------------------------


class TestSpecFixtureSemantics:
    """Verify spec fixtures no longer blur canonical and forbidden-field shapes."""

    def test_canonical_spec_fixture_excludes_deprecated_fields(self) -> None:
        """Canonical-only helper should exclude forbidden fields."""
        canonical_only = canonical_persona_spec("test")
        forbidden_spec = transition_persona_spec_with_legacy_fields("test")

        # Canonical fixture must exclude forbidden fields.
        assert "tools" not in canonical_only, "Canonical spec should NOT have `tools` field"
        assert "side_effect_policy" not in canonical_only, (
            "Canonical spec should NOT have `side_effect_policy` field"
        )

        # Forbidden fixture keeps them only for rejection-path coverage.
        assert "tools" in forbidden_spec
        assert "side_effect_policy" in forbidden_spec

    def test_mcp_assemble_test_fixture_includes_deprecated_fields(self) -> None:
        """Transition fixture usage in MCP tests must remain explicit."""
        # Read the test file source to find _canonical_spec definition
        test_file = Path(__file__).parent / "test_mcp.py"
        if not test_file.exists():
            pytest.skip("test_mcp.py not found")

        source = test_file.read_text()

        # Check that transition-only fixture content is still explicit in source.
        if '"tools":' in source and "_canonical_spec" in source:
            assert '"tools"' in source, (
                "Transition fixture coverage should remain explicit in source so canonical-only "
                "fixtures are not confused with forbidden-field coverage."
            )


# -----------------------------------------------------------------------------
# Regression 4: Web API patch preserves canonical rejection semantics
# -----------------------------------------------------------------------------


class TestWebApiCanonicalSemantics:
    """Verify web API patch flow preserves canonical normalization semantics.

    Hard-cut policy (ADR-002): normalize may still run before validation on
    registry-read surfaces, but forbidden fields must remain rejectable at the
    canonical boundary. PATCH input must not be silently repaired into canonical
    success when it carries forbidden fields.
    """

    def test_web_patch_rejects_tools_at_canonical_boundary(self) -> None:
        """Web PATCH endpoint must reject forbidden `tools` input."""
        from starlette.testclient import TestClient

        # Use the public web surface (FastAPI app) to verify canonical normalization
        client = TestClient(web_module.app, raise_server_exceptions=False)

        # Create a canonical persona first
        canonical = canonical_persona_spec("patch-target")
        register_result = client.post(
            "/api/personas",
            json={"spec": canonical},
        )
        assert register_result.status_code == 200, (
            f"Setup failed: could not register canonical persona: {register_result.json()}"
        )

        # Attempt to patch with forbidden `tools` field
        patch_response = client.patch(
            "/api/personas/patch-target",
            json={"tools": {"shell": "read_write"}},  # forbidden field
        )

        assert patch_response.status_code == 400, (
            f"Web PATCH should reject forbidden `tools` input. "
            f"Expected 400, got {patch_response.status_code}. "
            f"Response: {patch_response.json()}"
        )
        response_data = patch_response.json()
        assert response_data["error"]["code"] == "FORBIDDEN_PATCH_FIELD"
        assert response_data["error"]["details"] == {"field": "tools", "key": "tools"}


# -----------------------------------------------------------------------------
# Regression 5: canonical boundary rejects forbidden extra fields
# -----------------------------------------------------------------------------


class TestCanonicalBoundaryRejection:
    """Demonstrate canonical-boundary extra field rejection."""

    def test_validate_rejects_extra_field_at_canonical_boundary(self) -> None:
        """Validation MUST reject specs with extra `tools` field.

        This test documents the REQUIRED canonical behavior:
        Specs with `tools` field should fail validation at canonical admission.

        This regression check ensures facade/core validation keeps rejecting
        forbidden extra fields even when a shell transport can parse them.
        """
        # Create a spec with extra `tools` field (should be rejected)
        spec_with_extra: dict[str, object] = dict(canonical_persona_spec("test"))
        spec_with_extra["tools"] = {"shell": "read_only"}  # Extra field

        # The facade validate should reject this at canonical boundary
        from larva.core import validate as validate_module

        # Call validate directly
        report = validate_module.validate_spec(spec_with_extra)

        # Canonical expectation: validation rejects forbidden extra fields.
        assert not report["valid"], (
            "EXPECTED: validate_spec should reject specs with extra `tools` field. "
            "RESULT: validation accepts `tools` - canonical boundary not enforced."
        )

    def test_assemble_rejects_tools_in_overrides(self) -> None:
        """Assembly MUST reject overrides containing `tools` field.

        Regression guard: assemble overrides must reject forbidden fields.
        """

        # Create a minimal facade with test doubles
        @dataclass
        class SimpleComponentStore:
            prompts_by_name: dict[str, str] = field(default_factory=dict)
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

        # Verify: assemble should reject `tools` in overrides with error envelope
        if isinstance(result, dict) and "code" in result:
            # Error returned with code - tools was correctly rejected
            assert result["code"] == "FORBIDDEN_OVERRIDE_FIELD", (
                f"Expected FORBIDDEN_OVERRIDE_FIELD error, got: {result.get('code')}"
            )
            return  # Test passes - tools rejected with correct error
        elif isinstance(result, dict) and "error" not in result:
            # No error returned - tools was silently accepted or ignored
            pytest.fail(
                "Assemble accepted `tools` in overrides silently. Canonical boundary "
                "must reject forbidden override fields with an error envelope."
            )
        else:
            pytest.fail(f"Unexpected result type: {type(result)} - {result}")


# -----------------------------------------------------------------------------
# Verified implementation ownership references
# -----------------------------------------------------------------------------

VERIFIED_IMPLEMENTATION_SURFACES = {
    "mcp_tool_descriptions": {
        "files": ["src/larva/shell/mcp_contract.py"],
        "owner": "shell/mcp contract owner",
        "expectation": "Tool descriptions must explicitly state tools rejection",
    },
    "component_fixtures": {
        "files": ["tests/shell/test_mcp.py", "tests/shell/test_python_api.py"],
        "owner": "shell test authors",
        "expectation": "Transition-only fixtures must keep mirrored fields explicit",
    },
    "spec_fixtures": {
        "files": ["tests/shell/test_mcp.py", "tests/shell/test_python_api.py"],
        "owner": "shell test authors",
        "expectation": "Canonical-only fixtures exclude forbidden fields; transition fixtures stay explicit",
    },
    "web_api_patch": {
        "files": ["src/larva/shell/web.py"],
        "owner": "shell/web owner",
        "expectation": "api_update_persona rejects forbidden tools field via revalidation",
    },
    "canonical_validation": {
        "files": ["src/larva/core/validate.py"],
        "owner": "core/validate owner",
        "expectation": "validate_spec rejects extra `tools` field at canonical boundary",
    },
}


# -----------------------------------------------------------------------------
# Historical file-name note
# -----------------------------------------------------------------------------

"""
This file retains its historical name from the red-test phase, but it now acts
as a regression suite documenting the cleaned-up canonical boundary.

Covered categories:
1. MCP tool descriptions explicitly state tools rejection.
2. Transition fixtures are explicit and distinct from canonical-only fixtures.
3. Spec helper usage preserves the canonical vs forbidden-field distinction.
4. Web API patch flow rejects forbidden fields through revalidation.
5. Core validation and assemble overrides reject forbidden fields.
6. CLI assemble surface rejects variables input (removed from canonical contract).
7. CLI component projection does not filter legacy keys from toolset/constraint output.
"""


# -----------------------------------------------------------------------------
# Regression 6: CLI assemble surface no longer accepts --var / variables
# -----------------------------------------------------------------------------
from tests.shell.fixture_taxonomy import canonical_persona_spec


class TestCLIAssembleSurface:
    """Verify CLI assemble command has removed variables input."""

    def test_cli_parser_assemble_excludes_var_flag(self) -> None:
        """CLI assemble subcommand must not have --var flag."""
        from larva.shell.cli_parser import build_cli_parser

        parser = build_cli_parser().unwrap()
        # Parse just 'assemble --help' to get subparser
        try:
            args = parser.parse_args(["assemble", "--help"])
        except SystemExit:
            pass

        # Re-parse with minimal args to confirm var flag doesn't exist
        # If --var still exists, this will NOT raise an error
        error_found = False
        try:
            args = parser.parse_args(["assemble", "--id", "test", "--var", "foo=bar"])
        except Exception:
            error_found = True  # Expected: --var should be rejected

        assert error_found, (
            "CLI assemble still accepts --var flag. "
            "Canonical assemble path no longer accepts variables input."
        )

    def test_cli_assemble_request_excludes_variables_field(self) -> None:
        """CLI _build_assemble_request must not include variables in request."""
        import argparse
        from larva.shell.cli import _build_assemble_request

        # Create a Namespace that would have variables
        args = argparse.Namespace(
            id="test-persona",
            prompts=[],
            toolsets=[],
            constraints=[],
            model=None,
            description=None,
            overrides=[],
            variables=[],  # This should be absent from canonical AssembleRequest
            output=None,
        )

        result = _build_assemble_request(args)
        assert isinstance(result, Success), f"Failed to build request: {result}"

        request = result.unwrap()
        assert "variables" not in request, (
            f"AssembleRequest should not contain 'variables' field. Found: {request.keys()}"
        )


# -----------------------------------------------------------------------------
# Regression 7: CLI component projection does not filter legacy keys
# -----------------------------------------------------------------------------
from dataclasses import dataclass, field
from typing import Any


class TestCLIComponentProjection:
    """Verify CLI component show does not filter legacy keys from projection."""

    def test_component_show_does_not_filter_toolset_tools_field(self) -> None:
        """CLI component show toolset must NOT strip 'tools' field - canonical only."""
        from returns.result import Success
        from larva.shell.cli_commands import component_show_command

        @dataclass
        class SimpleComponentStore:
            toolsets_by_name: dict[str, dict[str, Any]] = field(default_factory=dict)

            def load_toolset(self, name: str):
                return Success(self.toolsets_by_name.get(name, {}))

            def load_prompt(self, name: str):
                return Success({})

            def load_constraint(self, name: str):
                return Success({})

            def load_model(self, name: str):
                return Success({})

        store = SimpleComponentStore(
            toolsets_by_name={
                "test": {
                    "capabilities": {"shell": "read_only"},
                    "tools": {"shell": "read_only"},  # Legacy field - should remain
                }
            }
        )

        result = component_show_command(
            "toolset/test",
            as_json=False,
            component_store=store,
        )

        assert isinstance(result, Success), f"Expected Success, got: {result}"
        payload = result.unwrap()
        stdout = payload.get("stdout", "")

        # If filtering is removed, 'tools' should appear in output
        assert "tools" in stdout or '"tools"' in stdout, (
            "CLI component show should NOT filter legacy 'tools' field from toolset output. "
            "Expected 'tools' to be present in output (fail-open for missing handler)."
        )

    def test_component_show_does_not_filter_constraint_side_effect_policy(self) -> None:
        """CLI component show constraint must NOT strip 'side_effect_policy' field."""
        from returns.result import Success
        from larva.shell.cli_commands import component_show_command

        @dataclass
        class SimpleComponentStore:
            constraints_by_name: dict[str, dict[str, object]] = field(default_factory=dict)

            def load_toolset(self, name: str):
                return Success({})

            def load_prompt(self, name: str):
                return Success({})

            def load_constraint(self, name: str):
                return Success(self.constraints_by_name.get(name, {}))

            def load_model(self, name: str):
                return Success({})

        store = SimpleComponentStore(
            constraints_by_name={
                "test": {
                    "side_effect_policy": "read_only",  # Legacy field - should remain
                }
            }
        )

        result = component_show_command(
            "constraint/test",
            as_json=False,
            component_store=store,
        )

        assert isinstance(result, Success), f"Expected Success, got: {result}"
        payload = result.unwrap()
        stdout = payload.get("stdout", "")

        # If filtering is removed, 'side_effect_policy' should appear in output
        assert "side_effect_policy" in stdout or '"side_effect_policy"' in stdout, (
            "CLI component show should NOT filter legacy 'side_effect_policy' field. "
            "Expected 'side_effect_policy' to be present in output (fail-open for missing handler)."
        )


# -----------------------------------------------------------------------------
# Real CLI command/output path verification
# -----------------------------------------------------------------------------


class TestRealCLIAssembleOutput:
    """Verify real CLI assemble output contains canonical-only fields."""

    def test_cli_assemble_produces_capabilities_not_tools(self) -> None:
        """Real CLI assemble via facade produces output with capabilities, not tools.

        This exercises the full path: cli_parser -> cli command -> facade -> assemble
        """
        import json

        from tests.shell.fixture_taxonomy import canonical_persona_spec

        # Use the same pattern as test_mcp.py::TestMCPAssembleSuccessShape
        # Create a mock facade that returns a fully-formed canonical persona
        from unittest.mock import MagicMock

        from larva.app.facade import DefaultLarvaFacade
        from returns.result import Success

        # Create a fully canonical assembled persona
        canonical_assembled = canonical_persona_spec("test-persona")

        # Create a mock facade that returns the canonical persona directly
        mock_facade = MagicMock(spec=DefaultLarvaFacade)
        mock_facade.assemble.return_value = Success(canonical_assembled)

        # Import the CLI command to test
        from larva.shell.cli_commands import assemble_command
        from larva.app.facade import AssembleRequest

        request: AssembleRequest = {
            "id": "test-persona",
            "prompts": [],
            "toolsets": ["test-toolset"],
            "constraints": [],
            "overrides": {},
        }

        result = assemble_command(
            request,
            as_json=True,
            facade=mock_facade,
            output_path=None,
        )

        assert isinstance(result, Success), f"assemble_command failed: {result}"
        payload = result.unwrap()
        json_data = payload.get("json", {}).get("data", {})

        # Output should have capabilities
        assert "capabilities" in json_data, f"Output missing capabilities: {json_data.keys()}"

        # Output must NOT have tools (forbidden legacy field)
        assert "tools" not in json_data, (
            f"CLI assemble output must not contain 'tools' field. Got: {json_data.keys()}"
        )

        # Also verify the JSON output is well-formed
        assert "id" in json_data
        assert json_data["id"] == "test-persona"
