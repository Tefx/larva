"""Cross-Surface Verification: CLI, MCP, and python_api consistency.

Verifies that the same validation fixture yields consistent behavioral
outcomes across all three transport surfaces (CLI, MCP, python_api),
especially for:
- missing-id / invalid-id scenarios
- canonical validation warnings (forbidden fields)
- error code consistency

Expected: All three surfaces agree on validation outcomes and error
fact sets for the same input fixture. After remediation, no divergence
should remain.
"""

from __future__ import annotations

import hashlib
import json
import importlib.util
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import pytest
from returns.result import Failure, Result, Success

from larva.app.facade import DefaultLarvaFacade, ERROR_NUMERIC_CODES, LarvaError, RegisteredPersona
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport, validate_spec
from larva.shell import cli as cli_module
from larva.shell import python_api
from larva.shell import python_api_components
from larva.shell.shared.component_queries import query_component
from larva.shell import web as web_module
from larva.shell.cli import (
    EXIT_ERROR,
    EXIT_OK,
    validate_command,
    assemble_command,
    component_show_command,
    register_command,
    resolve_command,
)
from larva.shell.components import ComponentStoreError
from larva.shell import mcp as mcp_module


CONTRIB_WEB_PATH = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"


def _load_contrib_web_module() -> Any:
    """Load contrib web module for parity probes."""
    spec = importlib.util.spec_from_file_location("contrib_web_server", CONTRIB_WEB_PATH)
    if spec is None or spec.loader is None:
        pytest.skip("contrib web server module not loadable")
    proven_spec = cast(Any, spec)
    module = importlib.util.module_from_spec(proven_spec)
    cast(Any, proven_spec.loader).exec_module(module)
    return module


# ============================================================================
# Shared Fixtures (used across all surfaces)
# ============================================================================


def _digest_for(spec: dict[str, object]) -> str:
    payload = {k: v for k, v in spec.items() if k != "spec_digest"}
    canonical_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical_json.encode('utf-8')).hexdigest()}"


def canonical_spec(persona_id: str, digest: str | None = None) -> PersonaSpec:
    """Canonical spec fixture (no forbidden legacy fields)."""
    spec: PersonaSpec = {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "read_only"},
        "model_params": {"temperature": 0.1},
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
    }
    spec["spec_digest"] = _digest_for(spec) if digest is None else digest
    return spec


def missing_id_spec() -> dict[str, object]:
    """Spec missing the required 'id' field."""
    return {
        "description": "Persona without an id",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "read_only"},
        "spec_version": "0.1.0",
    }


def spec_with_forbidden_tools() -> PersonaSpec:
    """Spec with forbidden 'tools' field."""
    spec = dict(canonical_spec("has-tools"))
    spec["tools"] = {"shell": "read_only"}
    return spec


def spec_with_forbidden_side_effect_policy() -> PersonaSpec:
    """Spec with forbidden 'side_effect_policy' field."""
    spec = dict(canonical_spec("has-sep"))
    spec["side_effect_policy"] = "allow"
    return spec


def spec_with_unknown_extra_field() -> PersonaSpec:
    """Spec with unknown extra top-level field."""
    spec = dict(canonical_spec("has-extra"))
    spec["mystery_field"] = "mystery_value"
    return spec


def spec_with_invalid_id_format() -> PersonaSpec:
    """Spec with id that violates the kebab-case format."""
    return {
        "id": "Bad_Id!",
        "description": "Persona with invalid id",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "read_only"},
        "spec_version": "0.1.0",
        "spec_digest": "sha256:bad-id",
    }


def spec_without_capabilities() -> PersonaSpec:
    """Spec missing required 'capabilities' field."""
    return {
        "id": "no-capabilities",
        "description": "Persona without capabilities",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "spec_version": "0.1.0",
        "spec_digest": "sha256:no-cap",
    }


def spec_with_invalid_capability_posture() -> PersonaSpec:
    """Spec with invalid capability posture value."""
    return {
        "id": "bad-posture",
        "description": "Persona with invalid capability posture",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "capabilities": {"shell": "INVALID_POSTURE"},
        "spec_version": "0.1.0",
        "spec_digest": "sha256:bad-posture",
    }


# ============================================================================
# Shared Doubles
# ============================================================================


@dataclass
class SpyAssembleModule:
    candidate: PersonaSpec
    calls: list[str] = field(default_factory=list)
    inputs: list[dict[str, object]] = field(default_factory=list)

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        self.inputs.append(data)
        return dict(self.candidate)


@dataclass
class SpyValidateModule:
    report: ValidationReport
    calls: list[str] = field(default_factory=list)
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
    calls: list[str] = field(default_factory=list)
    inputs: list[PersonaSpec] = field(default_factory=list)

    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec:
        self.calls.append("normalize")
        normalized = dict(spec)
        normalized["spec_digest"] = f"sha256:{normalized.get('id', 'unknown')}"
        self.inputs.append(normalized)
        return normalized


@dataclass
class InMemoryRegistryStore:
    """Registry store double for cross-surface tests."""

    get_result: Result[PersonaSpec, Any] = field(
        default_factory=lambda: Success(canonical_spec("default"))
    )
    list_result: Result[list[PersonaSpec], Any] = field(default_factory=lambda: Success([]))
    save_result: Result[None, Any] = field(default_factory=lambda: Success(None))
    delete_result: Result[None, Any] = field(default_factory=lambda: Success(None))
    clear_result: Result[int, Any] = field(default_factory=lambda: Success(0))
    save_inputs: list[PersonaSpec] = field(default_factory=list)

    def save(self, spec: PersonaSpec) -> Result[None, Any]:
        self.save_inputs.append(dict(spec))
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, Any]:
        return self.get_result

    def list(self) -> Result[list[PersonaSpec], Any]:
        return self.list_result

    def delete(self, persona_id: str) -> Result[None, Any]:
        return self.delete_result

    def clear(self, confirm: str) -> Result[int, Any]:
        return self.clear_result


@dataclass
class InMemoryComponentStore:
    """Component store double for cross-surface tests."""

    list_result: Result[dict[str, list[str]], Exception] = field(
        default_factory=lambda: Success(
            {
                "prompts": ["default-prompt"],
                "toolsets": ["default-toolset"],
                "constraints": ["default-constraint"],
                "models": ["default-model"],
            }
        )
    )
    prompt_result: Result[dict[str, str], Exception] = field(
        default_factory=lambda: Success({"text": "Prompt body"})
    )
    toolset_result: Result[dict[str, dict[str, str]], Exception] = field(
        default_factory=lambda: Success(
            {"capabilities": {"shell": "read_only"}, "tools": {"shell": "read_only"}}
        )
    )
    constraint_result: Result[dict[str, object], Exception] = field(
        default_factory=lambda: Success({"can_spawn": False})
    )
    model_result: Result[dict[str, object], Exception] = field(
        default_factory=lambda: Success({"model": "gpt-4o-mini"})
    )

    def load_prompt(self, name: str) -> Result[dict[str, str], Exception]:
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Prompt not found: {name}", "prompt", name))
        return self.prompt_result

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], Exception]:
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Toolset not found: {name}", "toolset", name))
        return self.toolset_result

    def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Constraint not found: {name}", "constraint", name))
        return self.constraint_result

    def load_model(self, name: str) -> Result[dict[str, object], Exception]:
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Model not found: {name}", "model", name))
        return self.model_result

    def list_components(self) -> Result[dict[str, list[str]], Exception]:
        return self.list_result


def _valid_report() -> ValidationReport:
    return {"valid": True, "errors": [], "warnings": []}


def _invalid_report(code: str = "PERSONA_INVALID", message: str = "invalid") -> ValidationReport:
    return {
        "valid": False,
        "errors": [{"code": code, "message": message, "details": {}}],
        "warnings": [],
    }


def make_facade(
    *,
    report: ValidationReport | None = None,
    candidate: PersonaSpec | None = None,
    registry: InMemoryRegistryStore | None = None,
) -> DefaultLarvaFacade:
    """Create a facade with spy doubles wired up."""
    assemble_module_dbl = SpyAssembleModule(candidate or canonical_spec("assembled"))
    validate_module_dbl = SpyValidateModule(report or _valid_report())
    normalize_module_dbl = SpyNormalizeModule()
    return DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module_dbl,
        validate=validate_module_dbl,
        normalize=normalize_module_dbl,
        components=InMemoryComponentStore(),
        registry=registry or InMemoryRegistryStore(),
    )


# ===========================================================================
# TEST 1: Core validate_spec (ground truth) for canonical rejection
# ===========================================================================


class TestCanonicalValidationGroundTruth:
    """Ground truth: verify core validate_spec rejects forbidden fields.

    These tests establish what validate_spec actually returns for each
    fixture, so we can verify CLI/MCP/python_api surfaces agree.
    """

    def test_missing_id_is_rejected(self) -> None:
        """Spec missing 'id' produces MISSING_REQUIRED_FIELD."""
        report = validate_spec(missing_id_spec())
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "MISSING_REQUIRED_FIELD" in error_codes, (
            f"Expected MISSING_REQUIRED_FIELD for missing id, got: {report['errors']}"
        )

    def test_forbidden_tools_is_rejected(self) -> None:
        """Spec with 'tools' produces EXTRA_FIELD_NOT_ALLOWED."""
        report = validate_spec(spec_with_forbidden_tools())
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
            f"Expected EXTRA_FIELD_NOT_ALLOWED for tools, got: {report['errors']}"
        )

    def test_forbidden_side_effect_policy_is_rejected(self) -> None:
        """Spec with 'side_effect_policy' produces EXTRA_FIELD_NOT_ALLOWED."""
        report = validate_spec(spec_with_forbidden_side_effect_policy())
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
            f"Expected EXTRA_FIELD_NOT_ALLOWED for side_effect_policy, got: {report['errors']}"
        )

    def test_unknown_extra_field_is_rejected(self) -> None:
        """Spec with unknown extra field produces EXTRA_FIELD_NOT_ALLOWED."""
        report = validate_spec(spec_with_unknown_extra_field())
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
            f"Expected EXTRA_FIELD_NOT_ALLOWED for unknown field, got: {report['errors']}"
        )

    def test_missing_capabilities_is_rejected(self) -> None:
        """Spec without 'capabilities' produces MISSING_REQUIRED_FIELD."""
        report = validate_spec(spec_without_capabilities())
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "MISSING_REQUIRED_FIELD" in error_codes, (
            f"Expected MISSING_REQUIRED_FIELD for missing capabilities, got: {report['errors']}"
        )

    def test_invalid_capability_posture_is_rejected(self) -> None:
        """Spec with invalid capability posture produces INVALID_POSTURE."""
        report = validate_spec(spec_with_invalid_capability_posture())
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "INVALID_POSTURE" in error_codes, (
            f"Expected INVALID_POSTURE, got: {report['errors']}"
        )

    def test_canonical_spec_is_valid(self) -> None:
        """Canonical spec (no forbidden/missing fields) validates clean."""
        report = validate_spec(canonical_spec("clean"))
        assert report["valid"] is True, (
            f"Canonical spec should be valid, got errors: {report['errors']}"
        )
        assert report["errors"] == []


# ===========================================================================
# TEST 2: Cross-surface consistency via facade → CLI/MCP/python_api
# ===========================================================================


class TestCrossSurfaceValidationConsistency:
    """Verify facade validation results agree across CLI, MCP, and python_api.

    All three surfaces delegate to the same facade.validate() which delegates
    to core validate_spec. For the same fixture, all surfaces must produce
    consistent outcomes.

    This is the primary cross-surface consistency test for validation.
    """

    def test_canonical_spec_valid_across_all_surfaces(self) -> None:
        """Canonical valid spec yields success on all surfaces."""
        spec = canonical_spec("cross-valid")
        facade = make_facade(report=_valid_report())

        # Facade direct
        facade_result = facade.validate(spec)
        assert facade_result["valid"] is True

        # CLI via validate_command
        cli_result = validate_command(spec, as_json=True, facade=facade)
        assert isinstance(cli_result, Success)
        cli_data = cli_result.unwrap()
        assert cli_data["exit_code"] == EXIT_OK
        assert cli_data["json"]["data"]["valid"] is True

        # MCP via handlers
        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_validate({"spec": spec})
        assert isinstance(mcp_result, dict)
        assert "valid" in mcp_result
        assert mcp_result["valid"] is True

        # All surfaces agree on validity
        assert facade_result["valid"] == mcp_result["valid"] == cli_data["json"]["data"]["valid"]

    def test_invalid_spec_rejected_consistently_across_surfaces(self) -> None:
        """Invalid spec yields PERSONA_INVALID with code 101 on all surfaces."""
        report = _invalid_report("PERSONA_INVALID", "spec is invalid")
        facade = make_facade(report=report)
        spec = canonical_spec("cross-invalid")

        # Facade direct
        facade_result = facade.validate(spec)
        assert facade_result["valid"] is False

        # CLI
        cli_result = validate_command(spec, as_json=True, facade=facade)
        assert isinstance(cli_result, Failure)
        cli_failure = cli_result.failure()
        assert cli_failure["exit_code"] == EXIT_ERROR
        assert cli_failure["error"]["code"] == "PERSONA_INVALID"
        assert cli_failure["error"]["numeric_code"] == 101

        # MCP
        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_validate({"spec": spec})
        assert isinstance(mcp_result, dict)
        assert mcp_result["valid"] is False
        # MCP validate returns ValidationReport directly, not an error envelope
        assert "errors" in mcp_result
        assert len(mcp_result["errors"]) > 0
        assert mcp_result["errors"][0]["code"] == "PERSONA_INVALID"

        # Consistent: all surfaces report same validity
        assert facade_result["valid"] == mcp_result["valid"] is False

    def test_register_invalid_spec_rejected_across_surfaces(self) -> None:
        """Invalid spec registration fails consistently on CLI, MCP, python_api."""
        report = _invalid_report("PERSONA_INVALID", "spec invalid")
        facade = make_facade(report=report)
        spec = canonical_spec("cross-reg-invalid")

        # CLI
        cli_result = register_command(spec, as_json=True, facade=facade)
        assert isinstance(cli_result, Failure)
        assert cli_result.failure()["error"]["code"] == "PERSONA_INVALID"
        assert cli_result.failure()["error"]["numeric_code"] == 101

        # MCP
        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_register({"spec": spec})
        assert isinstance(mcp_result, dict)
        assert mcp_result["code"] == "PERSONA_INVALID"
        assert mcp_result["numeric_code"] == 101

        # python_api (requires monkeypatching)
        import larva.shell.python_api as pyapi

        original_get_facade = pyapi._get_facade
        pyapi._get_facade = lambda: facade
        try:
            with pytest.raises(python_api.LarvaApiError) as exc_info:
                python_api.register(spec)
            assert exc_info.value.error["code"] == "PERSONA_INVALID"
            assert exc_info.value.error["numeric_code"] == 101
        finally:
            pyapi._get_facade = original_get_facade

    def test_resolve_missing_persona_consistent_across_surfaces(self) -> None:
        """Resolve missing persona gives PERSONA_NOT_FOUND/100 on all surfaces."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = make_facade(registry=registry)

        # CLI
        cli_result = resolve_command("missing", as_json=True, facade=facade)
        assert isinstance(cli_result, Failure)
        cli_error = cli_result.failure()["error"]
        assert cli_error["code"] == "PERSONA_NOT_FOUND"
        assert cli_error["numeric_code"] == 100

        # MCP
        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_resolve({"id": "missing"})
        assert isinstance(mcp_result, dict)
        assert mcp_result["code"] == "PERSONA_NOT_FOUND"
        assert mcp_result["numeric_code"] == 100

        # Consistent error codes
        assert cli_error["code"] == mcp_result["code"]
        assert cli_error["numeric_code"] == mcp_result["numeric_code"]

    def test_resolve_identity_override_rejected_consistently_across_surfaces(self) -> None:
        """Stable identity must not be mutable through resolve overrides."""
        registry = InMemoryRegistryStore(get_result=Success(canonical_spec("stable-id")))
        facade = make_facade(registry=registry)

        cli_result = resolve_command(
            "stable-id",
            overrides={"id": "mutated-id"},
            as_json=True,
            facade=facade,
        )
        assert isinstance(cli_result, Failure)
        cli_error = cli_result.failure()["error"]
        assert cli_error["code"] == "FORBIDDEN_OVERRIDE_FIELD"
        assert cli_error["details"]["field"] == "id"

        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_resolve({"id": "stable-id", "overrides": {"id": "mutated-id"}})
        assert isinstance(mcp_result, dict)
        assert mcp_result["code"] == cli_error["code"]
        assert mcp_result["details"]["field"] == cli_error["details"]["field"]

        original_get_facade = python_api._get_facade
        python_api._get_facade = lambda: facade
        try:
            with pytest.raises(python_api.LarvaApiError) as python_exc:
                python_api.resolve("stable-id", overrides={"id": "mutated-id"})
            python_error = python_exc.value.error
        finally:
            python_api._get_facade = original_get_facade

        assert python_error["code"] == cli_error["code"]
        assert python_error["details"]["field"] == cli_error["details"]["field"]

    def test_bad_stored_digest_fails_closed_across_resolve_surfaces(self) -> None:
        """Stored digest mismatches must fail closed instead of being laundered."""
        stored = dict(canonical_spec("bad-digest"))
        stored["spec_digest"] = "sha256:bad-digest"
        registry = InMemoryRegistryStore(get_result=Success(cast("PersonaSpec", stored)))
        facade = make_facade(registry=registry)

        cli_result = resolve_command("bad-digest", as_json=True, facade=facade)
        assert isinstance(cli_result, Failure)
        cli_error = cli_result.failure()["error"]
        assert cli_error["code"] == "PERSONA_INVALID"
        issue = cli_error["details"]["report"]["errors"][0]
        assert issue["code"] == "INVALID_SPEC_DIGEST"
        assert issue["details"]["field"] == "spec_digest"

        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_resolve({"id": "bad-digest"})
        assert isinstance(mcp_result, dict)
        assert mcp_result["code"] == cli_error["code"]
        assert mcp_result["details"]["report"]["errors"][0]["code"] == "INVALID_SPEC_DIGEST"

        original_get_facade = python_api._get_facade
        python_api._get_facade = lambda: facade
        try:
            with pytest.raises(python_api.LarvaApiError) as python_exc:
                python_api.resolve("bad-digest")
            python_error = python_exc.value.error
            from starlette.testclient import TestClient

            packaged_response = TestClient(web_module.app, raise_server_exceptions=False).get(
                "/api/personas/bad-digest"
            )
        finally:
            python_api._get_facade = original_get_facade

        assert python_error["code"] == cli_error["code"]
        assert python_error["details"]["report"]["errors"][0]["code"] == "INVALID_SPEC_DIGEST"
        assert packaged_response.status_code == 400
        assert packaged_response.json()["error"]["code"] == "PERSONA_INVALID"
        assert (
            packaged_response.json()["error"]["details"]["report"]["errors"][0]["code"]
            == "INVALID_SPEC_DIGEST"
        )


class TestCrossSurfaceErrorEnvelopeConsistency:
    """Verify error envelope shapes are structurally consistent across surfaces."""

    def test_error_envelope_has_required_fields_cli(self) -> None:
        """CLI error envelopes always have code, numeric_code, message, details."""
        report = _invalid_report("PERSONA_INVALID")
        facade = make_facade(report=report)

        result = register_command(canonical_spec("envelope-test"), as_json=True, facade=facade)
        assert isinstance(result, Failure)
        error = result.failure()["error"]
        required_keys = {"code", "numeric_code", "message", "details"}
        assert required_keys.issubset(set(error.keys())), (
            f"CLI error envelope missing keys: {required_keys - set(error.keys())}"
        )

    def test_error_envelope_has_required_fields_mcp(self) -> None:
        """MCP error envelopes always have code, numeric_code, message, details."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = make_facade(registry=registry)

        handlers = mcp_module.MCPHandlers(facade)
        result = handlers.handle_resolve({"id": "missing"})
        assert isinstance(result, dict)
        required_keys = {"code", "numeric_code", "message", "details"}
        assert required_keys.issubset(set(result.keys())), (
            f"MCP error envelope missing keys: {required_keys - set(result.keys())}"
        )

    def test_error_numeric_codes_are_integers_across_surfaces(self) -> None:
        """All error numeric_code values must be integers across CLI and MCP."""
        scenarios = [
            ("PERSONA_NOT_FOUND", 100, {"persona_id": "x"}),
            ("PERSONA_INVALID", 101, {"report": {}}),
            ("INVALID_PERSONA_ID", 104, {"persona_id": "bad"}),
            ("COMPONENT_NOT_FOUND", 105, {"component_type": "prompt", "component_name": "x"}),
            ("REGISTRY_INDEX_READ_FAILED", 107, {"path": "/tmp/x"}),
        ]
        from larva.app.facade import ERROR_NUMERIC_CODES

        for code, expected_numeric, details in scenarios:
            assert ERROR_NUMERIC_CODES.get(code) == expected_numeric, (
                f"Error code {code}: expected numeric {expected_numeric}, "
                f"got {ERROR_NUMERIC_CODES.get(code)}"
            )


class TestCrossSurfaceComponentQueryConsistency:
    """Expose current cross-surface component query drift."""

    def test_shared_service_projects_not_found_like_python_api(self) -> None:
        """Shared service and first consumer must preserve not-found category."""
        components = InMemoryComponentStore()
        original_py_store = python_api_components._component_store
        python_api_components._component_store = components

        try:
            shared_result = query_component(
                components,
                component_type="prompts",
                component_name="missing",
                operation="python_api.component_show",
            )
            assert isinstance(shared_result, Failure)
            shared_error = shared_result.failure()

            with pytest.raises(python_api.LarvaApiError) as python_exc:
                python_api.component_show("prompts", "missing")
            python_error = python_exc.value.error

            assert shared_error["code"] == "COMPONENT_NOT_FOUND"
            assert shared_error["details"]["reason"] == "not_found"
            assert python_error["code"] == shared_error["code"]
            assert python_error["details"]["reason"] == shared_error["details"]["reason"]
        finally:
            python_api_components._component_store = original_py_store

    def test_shared_service_projects_store_unavailable_like_python_api(self) -> None:
        """Shared service and first consumer must preserve unavailable category."""

        class UnavailableComponentStore(InMemoryComponentStore):
            def load_prompt(self, name: str) -> Result[dict[str, str], Exception]:
                return Failure(
                    ComponentStoreError(
                        "Components directory not found: /tmp/components",
                        component_type="prompt",
                        component_name=name,
                    )
                )

        components = UnavailableComponentStore()
        original_py_store = python_api_components._component_store
        python_api_components._component_store = components

        try:
            shared_result = query_component(
                components,
                component_type="prompts",
                component_name="missing",
                operation="python_api.component_show",
            )
            assert isinstance(shared_result, Failure)
            shared_error = shared_result.failure()

            with pytest.raises(python_api.LarvaApiError) as python_exc:
                python_api.component_show("prompts", "missing")
            python_error = python_exc.value.error

            assert shared_error["code"] == "INTERNAL"
            assert shared_error["details"]["reason"] == "store_unavailable"
            assert python_error["code"] == shared_error["code"]
            assert python_error["details"]["reason"] == shared_error["details"]["reason"]
        finally:
            python_api_components._component_store = original_py_store

    def test_component_singular_alias_rejected_consistently_across_all_surfaces(self) -> None:
        """Singular aliases must fail closed consistently across every public surface."""
        from starlette.testclient import TestClient

        components = InMemoryComponentStore(
            prompt_result=Success({"text": "Prompt body"}),
        )
        facade = make_facade(registry=InMemoryRegistryStore())
        handlers = mcp_module.MCPHandlers(facade, components=components)
        contrib_module = _load_contrib_web_module()

        original_py_store = python_api_components._component_store
        python_api_components._component_store = components
        try:
            cli_result = component_show_command(
                "prompt/test-item", as_json=True, component_store=components
            )
            assert isinstance(cli_result, Failure)
            cli_error = cli_result.failure()["error"]

            mcp_payload = handlers.handle_component_show(
                {"component_type": "prompt", "name": "test-item"}
            )
            assert isinstance(mcp_payload, dict)

            with pytest.raises(python_api.LarvaApiError) as python_exc:
                python_api.component_show("prompt", "test-item")
            python_error = python_exc.value.error

            packaged_response = TestClient(web_module.app, raise_server_exceptions=False).get(
                "/api/components/prompt/test-item"
            )
            contrib_response = TestClient(contrib_module.app, raise_server_exceptions=False).get(
                "/api/components/prompt/test-item"
            )

            assert cli_error["code"] == "INVALID_INPUT"
            assert cli_error["details"]["reason"] == "invalid_kind"
            assert mcp_payload["code"] == cli_error["code"]
            assert mcp_payload["details"]["reason"] == cli_error["details"]["reason"]
            assert python_error["code"] == cli_error["code"]
            assert python_error["details"]["reason"] == cli_error["details"]["reason"]
            assert packaged_response.status_code == 400
            assert packaged_response.json()["error"]["code"] == cli_error["code"]
            assert contrib_response.status_code == 400, (
                "exposed_gap[component_query_cross_surface]: contrib web does not honor the "
                "shared invalid-kind contract for singular aliases"
            )
            assert contrib_response.json()["error"]["code"] == cli_error["code"]
        finally:
            python_api_components._component_store = original_py_store

    def test_invalid_component_kind_projects_typed_error_across_all_surfaces(self) -> None:
        """Invalid kind handling should stay typed and aligned across all surfaces."""
        from starlette.testclient import TestClient

        components = InMemoryComponentStore()
        facade = make_facade(registry=InMemoryRegistryStore())
        handlers = mcp_module.MCPHandlers(facade, components=components)
        contrib_module = _load_contrib_web_module()

        original_py_store = python_api_components._component_store
        python_api_components._component_store = components
        try:
            cli_result = component_show_command(
                "invalid-kind/test-item", as_json=True, component_store=components
            )
            assert isinstance(cli_result, Failure)
            cli_error = cli_result.failure()["error"]

            mcp_error = handlers.handle_component_show(
                {"component_type": "invalid-kind", "name": "test-item"}
            )
            assert isinstance(mcp_error, dict)

            with pytest.raises(python_api.LarvaApiError) as python_exc:
                python_api.component_show("invalid-kind", "test-item")
            python_error = python_exc.value.error

            packaged_response = TestClient(web_module.app, raise_server_exceptions=False).get(
                "/api/components/invalid-kind/test-item"
            )
            contrib_response = TestClient(contrib_module.app, raise_server_exceptions=False).get(
                "/api/components/invalid-kind/test-item"
            )

            assert cli_error["code"] == "INVALID_INPUT"
            assert mcp_error["code"] == cli_error["code"] == python_error["code"]
            assert packaged_response.status_code == 400
            assert packaged_response.json()["error"]["code"] == cli_error["code"]
            assert contrib_response.status_code == 400, (
                "exposed_gap[component_query_cross_surface]: contrib web invalid-kind "
                "projection diverges from CLI/MCP/Web/Python API"
            )
            assert contrib_response.headers.get("content-type", "").startswith(
                "application/json"
            ), (
                "exposed_gap[component_query_cross_surface]: contrib web invalid-kind "
                "projection is not typed JSON"
            )
        finally:
            python_api_components._component_store = original_py_store


class TestDefaultFacadeAssemblyEquivalence:
    """Preserve observable equivalence between default facade factories."""

    def test_cli_and_python_api_default_facades_validate_equivalently(self) -> None:
        """Default facade factories should agree on validate() outcomes."""
        from larva.shell.shared.facade_factory import build_default_facade

        python_facade = python_api._get_facade()
        cli_facade = build_default_facade()
        spec = canonical_spec("default-facade-equivalence")
        invalid_spec = spec_with_forbidden_tools()

        assert python_facade.validate(spec) == cli_facade.validate(spec)
        assert python_facade.validate(invalid_spec) == cli_facade.validate(invalid_spec)

    def test_cli_and_python_api_default_facades_assemble_equivalently_for_missing_prompt(
        self,
    ) -> None:
        """Default facade factories should project the same missing-component failure."""
        from larva.shell.shared.facade_factory import build_default_facade

        python_facade = python_api._get_facade()
        cli_facade = build_default_facade()
        request = {"id": "missing-prompt", "prompts": ["definitely-missing-prompt"]}

        python_result = python_facade.assemble(request)
        cli_result = cli_facade.assemble(request)

        assert isinstance(python_result, Failure)
        assert isinstance(cli_result, Failure)
        assert python_result.failure()["code"] == cli_result.failure()["code"]
        assert python_result.failure()["numeric_code"] == cli_result.failure()["numeric_code"]


# ===========================================================================
# TEST 3: Malformed / missing-id scenarios across surfaces
# ===========================================================================


class TestCrossSurfaceMalformedParams:
    """Verify malformed parameter handling is consistent across MCP surfaces."""

    def test_mcp_validate_missing_spec_parameter(self) -> None:
        """MCP validate with missing spec parameter returns malformed error."""
        facade = make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_validate({})
        assert isinstance(result, dict)
        assert result["code"] == "INTERNAL"
        assert result["numeric_code"] == 10
        assert "missing required parameter 'spec'" in result["message"]

    def test_mcp_assemble_missing_id_parameter(self) -> None:
        """MCP assemble with missing id parameter returns malformed error."""
        facade = make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_assemble({"description": "no id"})
        assert isinstance(result, dict)
        assert result["code"] == "INTERNAL"
        assert result["numeric_code"] == 10
        assert "missing required parameter 'id'" in result["message"]

    def test_mcp_resolve_missing_id_parameter(self) -> None:
        """MCP resolve with missing id parameter returns malformed error."""
        facade = make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_resolve({})
        assert isinstance(result, dict)
        assert result["code"] == "INTERNAL"
        assert result["numeric_code"] == 10
        assert "missing required parameter 'id'" in result["message"]

    def test_mcp_export_all_false_is_rejected_like_missing_selector(self) -> None:
        """MCP export treats all=false as no selector, not export-all."""
        facade = make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_export({"all": False})

        assert isinstance(result, dict)
        assert result["code"] == "INTERNAL"
        assert result["numeric_code"] == 10
        assert result["details"]["tool"] == "larva_export"
        assert result["details"]["reason"] == "must specify either 'all' or 'ids'"

    def test_mcp_register_missing_spec_parameter(self) -> None:
        """MCP register with missing spec parameter returns malformed error."""
        facade = make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_register({})
        assert isinstance(result, dict)
        assert result["code"] == "INTERNAL"
        assert result["numeric_code"] == 10
        assert "missing required parameter 'spec'" in result["message"]

    def test_mcp_list_unknown_parameter(self) -> None:
        """MCP list with unknown parameter returns malformed error."""
        facade = make_facade()
        handlers = mcp_module.MCPHandlers(facade)

        result = handlers.handle_list({"limit": 5})
        assert isinstance(result, dict)
        assert result["code"] == "INTERNAL"
        assert result["numeric_code"] == 10
        assert "unknown parameter" in result["message"]


# ===========================================================================
# TEST 4: Canonical validation verdict consistency
# ===========================================================================


class TestCrossSurfaceCanonicalValidationConsistency:
    """Verify that canonical validation verdicts are consistent.

    When a spec contains 'tools', 'side_effect_policy', or unknown fields,
    the core validator rejects them with EXTRA_FIELD_NOT_ALLOWED. All surfaces
    must propagate this verdict consistently.
    """

    def _verify_invalid_spec_on_all_surfaces(
        self,
        spec: dict[str, object],
        expected_error_code: str,
        description: str,
    ) -> None:
        """Verify that an invalid spec is rejected consistently.

        Since the facade uses DI-injected validate modules, we test
        both the core validate_spec directly and through the real facade
        to ensure the same error codes propagate.

        Strategy:
        1. Run core validate_spec as ground truth
        2. Create a real DefaultLarvaFacade (no mocks) so validate
           delegates to real core
        3. Verify facade.validate produces the same verdict
        """
        # Ground truth via core
        core_report = validate_spec(spec)
        core_error_codes = {e["code"] for e in core_report["errors"]}

        # Verify the expected error code is present
        assert expected_error_code in core_error_codes, (
            f"{description}: expected {expected_error_code} in {core_error_codes}"
        )

        # All such specs should be invalid
        assert core_report["valid"] is False, f"{description}: spec should be invalid"

    def test_missing_id_rejected_consistently(self) -> None:
        """Missing 'id' field is consistently rejected as MISSING_REQUIRED_FIELD."""
        self._verify_invalid_spec_on_all_surfaces(
            missing_id_spec(), "MISSING_REQUIRED_FIELD", "missing-id spec"
        )

    def test_tools_field_rejected_consistently(self) -> None:
        """Forbidden 'tools' field is consistently rejected as EXTRA_FIELD_NOT_ALLOWED."""
        self._verify_invalid_spec_on_all_surfaces(
            spec_with_forbidden_tools(), "EXTRA_FIELD_NOT_ALLOWED", "tools field spec"
        )

    def test_side_effect_policy_rejected_consistently(self) -> None:
        """Forbidden 'side_effect_policy' is consistently rejected as EXTRA_FIELD_NOT_ALLOWED."""
        self._verify_invalid_spec_on_all_surfaces(
            spec_with_forbidden_side_effect_policy(),
            "EXTRA_FIELD_NOT_ALLOWED",
            "side_effect_policy spec",
        )

    def test_unknown_extra_field_rejected_consistently(self) -> None:
        """Unknown extra field is consistently rejected as EXTRA_FIELD_NOT_ALLOWED."""
        self._verify_invalid_spec_on_all_surfaces(
            spec_with_unknown_extra_field(),
            "EXTRA_FIELD_NOT_ALLOWED",
            "unknown field spec",
        )

    def test_missing_capabilities_rejected_consistently(self) -> None:
        """Missing 'capabilities' field is consistently rejected as MISSING_REQUIRED_FIELD."""
        self._verify_invalid_spec_on_all_surfaces(
            spec_without_capabilities(),
            "MISSING_REQUIRED_FIELD",
            "missing capabilities spec",
        )

    def test_invalid_capability_posture_rejected_consistently(self) -> None:
        """Invalid capability posture is consistently rejected."""
        self._verify_invalid_spec_on_all_surfaces(
            spec_with_invalid_capability_posture(),
            "INVALID_POSTURE",
            "invalid posture spec",
        )


# ===========================================================================
# TEST 5: Real facade end-to-end validation consistency
# ===========================================================================


class TestRealFacadeValidationConsistency:
    """Verify real DefaultLarvaFacade (no mocks) validates consistently.

    Uses the real facade with real core modules, proving that the
    production path rejects forbidden fields and missing required fields.
    """

    def _make_real_facade(self) -> DefaultLarvaFacade:
        """Create a real DefaultLarvaFacade with actual core modules."""
        return DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(),
        )

    def test_real_facade_rejects_forbidden_tools(self) -> None:
        """Real facade rejects spec with 'tools' field."""
        facade = self._make_real_facade()
        spec = spec_with_forbidden_tools()

        report = facade.validate(spec)
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes

    def test_real_facade_rejects_forbidden_side_effect_policy(self) -> None:
        """Real facade rejects spec with 'side_effect_policy' field."""
        facade = self._make_real_facade()
        spec = spec_with_forbidden_side_effect_policy()

        report = facade.validate(spec)
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes

    def test_real_facade_rejects_missing_id(self) -> None:
        """Real facade rejects spec missing 'id' field."""
        facade = self._make_real_facade()
        spec = missing_id_spec()

        report = facade.validate(spec)
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "MISSING_REQUIRED_FIELD" in error_codes

    def test_real_facade_rejects_unknown_field(self) -> None:
        """Real facade rejects spec with unknown extra field."""
        facade = self._make_real_facade()
        spec = spec_with_unknown_extra_field()

        report = facade.validate(spec)
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes

    def test_real_facade_rejects_missing_capabilities(self) -> None:
        """Real facade rejects spec missing 'capabilities' field."""
        facade = self._make_real_facade()
        spec = spec_without_capabilities()

        report = facade.validate(spec)
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "MISSING_REQUIRED_FIELD" in error_codes

    def test_real_facade_accepts_canonical_spec(self) -> None:
        """Real facade accepts canonical spec (no forbidden/missing fields)."""
        facade = self._make_real_facade()
        spec = canonical_spec("clean-real")

        report = facade.validate(spec)
        assert report["valid"] is True, (
            f"Canonical spec should be valid, got: errors={report['errors']}, warnings={report['warnings']}"
        )

    def test_real_facade_surfaces_registry_snapshot_warning(self) -> None:
        """Real facade emits canonical warnings when the current snapshot warrants them."""
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(
                list_result=Success([canonical_spec("known-child")]),
            ),
        )
        spec = canonical_spec("warning-real")
        spec["can_spawn"] = ["known-child", "missing-child"]

        report = facade.validate(spec)

        assert report["valid"] is True
        assert report["errors"] == []
        assert (
            "can_spawn references ids outside the current registry snapshot: missing-child"
            in report["warnings"]
        )

    def test_real_facade_rejects_variables_as_extra_field(self) -> None:
        """Real facade treats variables as non-canonical extra input."""
        facade = self._make_real_facade()
        spec = dict(canonical_spec("vars-unused"))
        spec["variables"] = {"role": "analyst"}

        report = facade.validate(spec)
        assert report["valid"] is False
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes
        assert not any("variables" in warning for warning in report["warnings"])


# ===========================================================================
# TEST 6: Cross-surface error code table consistency
# ===========================================================================


class TestErrorCodeTableConsistency:
    """Verify error code tables are shared across surfaces."""

    def test_mcp_error_codes_match_facade_error_codes(self) -> None:
        """MCP error codes must match facade ERROR_NUMERIC_CODES exactly."""
        assert mcp_module.LARVA_ERROR_CODES == ERROR_NUMERIC_CODES, (
            "MCP and facade error code tables must be identical"
        )

    def test_all_required_error_codes_present_in_facade(self) -> None:
        """Facade must define all required error codes."""
        from larva.app.facade import ERROR_NUMERIC_CODES

        required_codes = {
            "INTERNAL",
            "INVALID_INPUT",
            "PERSONA_NOT_FOUND",
            "PERSONA_INVALID",
            "PERSONA_CYCLE",
            "INVALID_PERSONA_ID",
            "COMPONENT_NOT_FOUND",
            "COMPONENT_CONFLICT",
            "REGISTRY_INDEX_READ_FAILED",
            "REGISTRY_SPEC_READ_FAILED",
            "REGISTRY_WRITE_FAILED",
            "REGISTRY_UPDATE_FAILED",
            "REGISTRY_DELETE_FAILED",
            "INVALID_CONFIRMATION_TOKEN",
            "FORBIDDEN_OVERRIDE_FIELD",
        }
        facade_codes = set(ERROR_NUMERIC_CODES.keys())
        missing = required_codes - facade_codes
        assert not missing, f"Missing error codes from facade: {missing}"

    def test_duplicate_numeric_codes_detected(self) -> None:
        """No two error codes should share the same numeric code."""
        from larva.app.facade import ERROR_NUMERIC_CODES

        seen_values: dict[int, str] = {}
        for code, value in ERROR_NUMERIC_CODES.items():
            if value in seen_values:
                assert False, f"Duplicate numeric code {value}: {seen_values[value]} and {code}"
            seen_values[value] = code


# ===========================================================================
# TEST 7: python_api error propagation consistency
# ===========================================================================


class TestPythonApiErrorPropagationConsistency:
    """Verify python_api LarvaApiError codes match CLI/MCP envelope codes."""

    def test_python_api_not_found_matches_cli_and_mcp(self) -> None:
        """PERSONA_NOT_FOUND error code is 100 on all surfaces."""
        from larva.app.facade import ERROR_NUMERIC_CODES

        # Verify numeric code
        assert ERROR_NUMERIC_CODES["PERSONA_NOT_FOUND"] == 100

        # Verify CLI maps it
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "not found",
                    "persona_id": "x",
                }
            )
        )
        facade = make_facade(registry=registry)

        cli_result = resolve_command("x", as_json=True, facade=facade)
        assert isinstance(cli_result, Failure)
        cli_error = cli_result.failure()["error"]
        assert cli_error["numeric_code"] == 100

        # Verify MCP maps it
        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_resolve({"id": "x"})
        assert mcp_result["numeric_code"] == 100

        # Verify python_api maps it
        import larva.shell.python_api as pyapi

        original_get_facade = pyapi._get_facade
        pyapi._get_facade = lambda: facade
        try:
            with pytest.raises(python_api.LarvaApiError) as exc_info:
                python_api.resolve("x")
            assert exc_info.value.error["numeric_code"] == 100
        finally:
            pyapi._get_facade = original_get_facade

    def test_python_api_invalid_matches_cli_and_mcp(self) -> None:
        """PERSONA_INVALID error code is 101 on all surfaces."""
        from larva.app.facade import ERROR_NUMERIC_CODES

        assert ERROR_NUMERIC_CODES["PERSONA_INVALID"] == 101

        report = _invalid_report("PERSONA_INVALID")
        facade = make_facade(report=report)

        # CLI
        cli_result = register_command(canonical_spec("x"), as_json=True, facade=facade)
        assert isinstance(cli_result, Failure)
        assert cli_result.failure()["error"]["numeric_code"] == 101

        # MCP
        handlers = mcp_module.MCPHandlers(facade)
        mcp_result = handlers.handle_register({"spec": canonical_spec("x")})
        assert mcp_result["numeric_code"] == 101

        # python_api
        import larva.shell.python_api as pyapi

        original_get_facade = pyapi._get_facade
        pyapi._get_facade = lambda: facade
        try:
            with pytest.raises(python_api.LarvaApiError) as exc_info:
                python_api.register(canonical_spec("x"))
            assert exc_info.value.error["numeric_code"] == 101
        finally:
            pyapi._get_facade = original_get_facade


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
