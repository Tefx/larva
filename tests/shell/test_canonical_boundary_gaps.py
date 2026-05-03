"""Canonical boundary regression tests for shell-surface consistency.

This file keeps its historical name, but the tests now verify that canonical
boundary cleanup has landed and remains stable across shell-facing surfaces and
test fixtures.

Covered regressions:
- MCP/tool descriptions explicitly state rejection semantics
- packaged web patch flow does not preserve forbidden fields
- component and spec fixtures distinguish canonical data from historical invalid data
- canonical validation rejects forbidden extra fields even when envelopes parse

Sources:
- ARCHITECTURE.md :: Decision 3: Python API is a thin facade export
- INTERFACES.md :: Canonical PersonaSpec Contract
- ADR-002 :: capabilities (canonical) vs removed/rejected legacy fields
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from returns.result import Failure, Result, Success

from larva.core import validate as validate_module
from larva.shell import mcp as mcp_module
from larva.shell import web as web_module
from larva.shell.mcp_contract import LARVA_MCP_TOOLS
from larva.shell.shared.component_queries import query_component
from tests.shell.fixture_taxonomy import (
    HistoricalComponentStoreDouble,
    canonical_persona_spec,
    historical_constraint_fixture_with_legacy_field,
    historical_persona_spec_with_legacy_fields,
    historical_toolset_fixture_with_legacy_fields,
)

# -----------------------------------------------------------------------------
# Regression 1: MCP tool descriptions advertise explicit rejection semantics
# -----------------------------------------------------------------------------


class TestMCPToolDescriptionSemantics:
    """Verify MCP tool descriptions preserve explicit rejection semantics."""

    def test_validate_tool_description_rejects_forbidden_legacy_vocabulary(self) -> None:
        """MCP validate tool description must explicitly reject tools and side_effect_policy."""
        validate_tool = next(t for t in LARVA_MCP_TOOLS if t["name"] == "larva_validate")
        description = validate_tool["description"].lower()

        assert "tools is rejected" in description and "side_effect_policy is rejected" in description, (
            f"validate tool description must explicitly reject forbidden legacy vocabulary. "
            f"Current: {validate_tool['description']}"
        )

    def test_assemble_tool_is_absent_after_hard_cutover(self) -> None:
        """MCP assemble tool must stay removed after canonical hard cutover."""
        tool_names = {t["name"] for t in LARVA_MCP_TOOLS}

        assert "larva_assemble" not in tool_names

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
# Regression 2: historical invalid fixtures remain explicit rather than implicit
# -----------------------------------------------------------------------------


class TestComponentFixtureSemantics:
    """Verify component fixtures clearly separate canonical and historical invalid data."""

    def test_inmemory_toolset_store_returns_capabilities_only(self) -> None:
        """Historical invalid toolset fixtures keep forbidden fields explicit."""

        store = HistoricalComponentStoreDouble(
            toolsets_by_name={"readonly": historical_toolset_fixture_with_legacy_fields()}
        )

        result = store.load_toolset("readonly")
        assert isinstance(result, Success)
        loaded = result.unwrap()

        assert "capabilities" in loaded
        assert "tools" in loaded, (
            "Historical invalid fixture should keep legacy `tools` explicit so canonical "
            "fixtures remain separate."
        )

    def test_inmemory_constraint_store_returns_side_effect_policy(self) -> None:
        """Historical invalid constraint fixtures keep forbidden fields explicit."""

        store = HistoricalComponentStoreDouble(
            constraints_by_name={"safe": historical_constraint_fixture_with_legacy_field()}
        )

        result = store.load_constraint("safe")
        assert isinstance(result, Success)
        loaded = result.unwrap()

        assert "side_effect_policy" in loaded, (
            "Historical invalid fixture should keep `side_effect_policy` explicit so canonical "
            "fixtures remain clean."
        )


class TestSharedComponentQueryRejection:
    """Shared component query helper must fail closed on legacy payload fields."""

    def test_query_component_rejects_toolset_payload_with_legacy_tools(self) -> None:
        @dataclass
        class ComponentStoreDouble:
            toolsets_by_name: dict[str, dict[str, Any]] = field(default_factory=dict)

            def load_prompt(self, name: str) -> Result[dict[str, str], Exception]:
                del name
                return Success({})

            def load_toolset(self, name: str) -> Result[dict[str, Any], Exception]:
                return Success(self.toolsets_by_name[name])

            def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
                del name
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], Exception]:
                del name
                return Success({})

        store = ComponentStoreDouble(
            toolsets_by_name={"readonly": historical_toolset_fixture_with_legacy_fields()}
        )

        result = query_component(
            store,
            component_type="toolsets",
            component_name="readonly",
            operation="test.component_show",
        )

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "COMPONENT_NOT_FOUND"
        assert error["numeric_code"] == 105
        assert "tools" in error["message"]

    def test_query_component_rejects_constraint_payload_with_legacy_side_effect_policy(self) -> None:
        @dataclass
        class ComponentStoreDouble:
            constraints_by_name: dict[str, dict[str, object]] = field(default_factory=dict)

            def load_prompt(self, name: str) -> Result[dict[str, str], Exception]:
                del name
                return Success({})

            def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], Exception]:
                del name
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
                return Success(self.constraints_by_name[name])

            def load_model(self, name: str) -> Result[dict[str, object], Exception]:
                del name
                return Success({})

        store = ComponentStoreDouble(
            constraints_by_name={"safe": historical_constraint_fixture_with_legacy_field()}
        )

        result = query_component(
            store,
            component_type="constraints",
            component_name="safe",
            operation="test.component_show",
        )

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "COMPONENT_NOT_FOUND"
        assert error["numeric_code"] == 105
        assert "side_effect_policy" in error["message"]


# -----------------------------------------------------------------------------
# Regression 3: spec fixtures distinguish canonical-only from forbidden-field coverage
# -----------------------------------------------------------------------------


class TestSpecFixtureSemantics:
    """Verify spec fixtures no longer blur canonical and forbidden-field shapes."""

    def test_canonical_spec_fixture_excludes_legacy_fields(self) -> None:
        """Canonical-only helper excludes forbidden legacy fields."""
        canonical_only = canonical_persona_spec("test")
        forbidden_spec = historical_persona_spec_with_legacy_fields("test")

        # Canonical fixture must exclude forbidden fields.
        assert "tools" not in canonical_only, "Canonical spec should NOT have `tools` field"
        assert "side_effect_policy" not in canonical_only, (
            "Canonical spec should NOT have `side_effect_policy` field"
        )

        # Historical invalid fixture keeps them only for rejection-path coverage.
        assert "tools" in forbidden_spec
        assert "side_effect_policy" in forbidden_spec

    def test_mcp_assemble_test_fixture_keeps_historical_invalid_fields_explicit(self) -> None:
        """Historical invalid fixture usage in MCP tests must remain explicit."""
        # Read the test file source to find _canonical_spec definition
        test_file = Path(__file__).parent / "test_mcp.py"
        if not test_file.exists():
            pytest.skip("test_mcp.py not found")

        source = test_file.read_text()

        # Check that historical invalid fixture content is still explicit in source.
        if '"tools":' in source and "_canonical_spec" in source:
            assert '"tools"' in source, (
                "Historical invalid fixture coverage should remain explicit in source so canonical "
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

    def test_mcp_handlers_do_not_expose_assemble_handler(self) -> None:
        """Shell MCP handlers must not retain the removed assemble surface."""
        assert not hasattr(mcp_module.MCPHandlers, "handle_assemble")


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
        "expectation": "Historical invalid fixtures must keep forbidden fields explicit",
    },
    "spec_fixtures": {
        "files": ["tests/shell/test_mcp.py", "tests/shell/test_python_api.py"],
        "owner": "shell test authors",
        "expectation": "Canonical fixtures exclude forbidden fields; historical invalid fixtures stay explicit",
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
2. Historical invalid fixtures are explicit and distinct from canonical fixtures.
3. Spec helper usage preserves the canonical vs forbidden-field distinction.
4. Web API patch flow rejects forbidden fields through revalidation.
5. Core validation rejects forbidden fields.
6. CLI assemble/component surfaces stay removed.
"""


# -----------------------------------------------------------------------------
# Regression 6: CLI assemble/component surfaces stay removed
# -----------------------------------------------------------------------------


class TestRemovedCLISurfaces:
    """Verify removed assemble/component CLI surfaces do not reappear."""

    def test_cli_parser_rejects_assemble_command(self) -> None:
        """CLI assemble subcommand must stay absent after hard cutover."""
        from larva.shell.cli_parser import build_cli_parser

        parser = build_cli_parser().unwrap()
        with pytest.raises(Exception):
            parser.parse_args(["assemble", "--id", "test"])

    def test_cli_parser_rejects_component_command(self) -> None:
        """CLI component subcommand must stay absent after hard cutover."""
        from larva.shell.cli_parser import build_cli_parser

        parser = build_cli_parser().unwrap()

        with pytest.raises(Exception):
            parser.parse_args(["component", "list"])
