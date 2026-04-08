"""Boundary tests for ``larva.shell.web`` packaged web surface.

Tests prove:
- Normative REST endpoint inventory matches INTERFACES.md contract
- Startup contract honors port and no-open flags
- Served HTML contains documented UI affordances
- Preserved runnable liveness proof lives in tests/shell/artifacts/web_runtime_liveness.md

Sources:
- INTERFACES.md :: Web Runtime Surface (lines 82-151)
- USER_GUIDE.md :: §14 Web UI and plugin (lines 391-422)
- README.md :: serve and web UI startup examples (lines 221-238)
- tests/shell/artifacts/web_runtime_liveness.md :: packaged runtime probe and captured startup log
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from returns.result import Failure, Result, Success

if TYPE_CHECKING:
    from collections.abc import Callable

# FastAPI/TestClient imports are optional at module load time
# to allow tests to run without web dependencies installed
pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from httpx import AsyncClient
from starlette.testclient import TestClient

from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell import web as web_module
from larva.shell.web import app
from larva.shell.python_api_components import LarvaApiError


# -----------------------------------------------------------------------------
# Spec-Fixture Conformance: authoritative minimal PersonaSpec
# Source: INTERFACES.md :: PersonaSpec Contract (lines 11-48)
# -----------------------------------------------------------------------------

_MINIMAL_SPEC: PersonaSpec = {
    "id": "test-persona",
    "prompt": "You are a test assistant.",
    "model": "test-model",
    "capabilities": {},
    "spec_version": "0.1.0",
}


def _valid_report() -> ValidationReport:
    return {"valid": True, "errors": [], "warnings": []}


def _invalid_report(code: str = "PERSONA_INVALID") -> ValidationReport:
    return {
        "valid": False,
        "errors": [{"code": code, "message": "invalid", "details": {}}],
        "warnings": [],
    }


# -----------------------------------------------------------------------------
# Shared spy doubles for web surface testing
# -----------------------------------------------------------------------------


class CallRecordingRegistry:
    """In-memory registry that records calls for test assertions."""

    def __init__(self) -> None:
        self.save_inputs: list[PersonaSpec] = []
        self.load_outputs: dict[str, PersonaSpec] = {}
        self.list_result: list[PersonaSpec] = []

    def list(self) -> list[PersonaSpec]:
        return list(self.list_result)

    def load(self, persona_id: str) -> PersonaSpec | None:
        return self.load_outputs.get(persona_id)

    def save(self, spec: PersonaSpec) -> None:
        self.save_inputs.append(spec)
        self.load_outputs[spec["id"]] = spec

    def delete(self, persona_id: str) -> bool:
        if persona_id in self.load_outputs:
            del self.load_outputs[persona_id]
            return True
        return False

    def clear(self) -> int:
        count = len(self.load_outputs)
        self.load_outputs.clear()
        return count


@dataclass
class MockFacade:
    """Facade double that delegates to in-memory registry."""

    _registry: CallRecordingRegistry
    _report_map: dict[str, ValidationReport] = field(default_factory=dict)

    def validate(self, spec: PersonaSpec) -> ValidationReport:
        return self._report_map.get(str(spec.get("id", "")), _valid_report())

    def register(self, spec: PersonaSpec) -> dict[str, Any]:
        self._registry.save(spec)
        return {"id": spec["id"], "registered": True}

    def resolve(
        self, persona_id: str, overrides: dict[str, Any] | None = None
    ) -> PersonaSpec | None:
        return self._registry.load(persona_id)

    def list(self) -> list[dict[str, Any]]:
        return [
            {"id": s["id"], "model": s.get("model", ""), "spec_digest": s.get("spec_digest", "")}
            for s in self._registry.list()
        ]

    def update(self, persona_id: str, patches: dict[str, Any]) -> PersonaSpec | None:
        spec = self._registry.load(persona_id)
        if spec is None:
            raise LarvaError(
                error={"code": "PERSONA_NOT_FOUND", "message": f"Persona {persona_id} not found"}
            )
        for key, value in patches.items():
            if key not in ("spec_digest", "spec_version"):
                spec[key] = value  # type: ignore[misc]
        self._registry.save(spec)
        return spec

    def delete(self, persona_id: str) -> dict[str, Any]:
        deleted = self._registry.delete(persona_id)
        return {"id": persona_id, "deleted": deleted}

    def clear(self, confirm: str) -> int:
        if confirm != "CLEAR REGISTRY":
            raise LarvaApiError(
                error={"code": "CLEAR_CONFIRMATION_MISMATCH", "message": "Confirmation required"}
            )
        return self._registry.clear()

    def assemble(
        self,
        id: str,
        prompts: list[str] | None = None,
        toolsets: list[str] | None = None,
        constraints: list[str] | None = None,
        model: str | None = None,
        overrides: dict[str, Any] | None = None,
        variables: dict[str, str] | None = None,
    ) -> PersonaSpec:
        spec: PersonaSpec = {
            "id": id,
            "prompt": "\n\n".join(prompts) if prompts else "",
            "model": model or "default-model",
            "capabilities": {},
            "spec_version": "0.1.0",
        }
        return spec


class MockApiError(Exception):
    """Simulates LarvaApiError for error path tests."""

    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(str(error))
        self.error = error


# -----------------------------------------------------------------------------
# Fixture setup
# -----------------------------------------------------------------------------


@pytest.fixture
def mock_registry() -> CallRecordingRegistry:
    return CallRecordingRegistry()


@pytest.fixture
def mock_facade(mock_registry: CallRecordingRegistry) -> MockFacade:
    return MockFacade(_registry=mock_registry)


# -----------------------------------------------------------------------------
# Tests: Normative endpoint inventory (INTERFACES.md lines 111-123)
# -----------------------------------------------------------------------------


class TestWebSurfaceEndpoints:
    """Tests for packaged web endpoint contract.

    Source: INTERFACES.md :: Normative endpoint inventory (lines 106-129)

    Each test verifies the documented contract:
    - Method and path match the table
    - Response envelope matches envelope rules
    - Error mapping respects LarvaApiError -> HTTP 400
    """

    def test_get_root_returns_html_ui(self) -> None:
        """GET / returns packaged HTML UI artifact.

        Contract: INTERFACES.md line 113
        """
        client = TestClient(app)

        resp = client.get("/")

        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")
        assert "LARVA" in resp.text or "larva" in resp.text.lower()
        # Verify HTML is served, not JSON
        assert resp.text.strip().startswith("<!DOCTYPE") or resp.text.strip().startswith("<html")

    def test_get_api_personas_returns_data_envelope(
        self, mock_facade: MockFacade, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GET /api/personas returns {data: PersonaSummary[]}.

        Contract: INTERFACES.md line 113
        """
        client = TestClient(app)
        monkeypatch.setattr(web_module, "list_personas", lambda: mock_facade.list())

        resp = client.get("/api/personas")

        assert resp.status_code == 200
        data = resp.json()
        assert "data" in data
        assert isinstance(data["data"], list)

    def test_get_api_personas_by_id_returns_spec(
        self,
        mock_facade: MockFacade,
        mock_registry: CallRecordingRegistry,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """GET /api/personas/{persona_id} returns resolved spec.

        Contract: INTERFACES.md line 115
        """
        spec: PersonaSpec = {
            "id": "web-test-id",
            "prompt": "You are web test.",
            "model": "test-model",
            "capabilities": {},
            "spec_version": "0.1.0",
        }
        mock_registry.save(spec)
        monkeypatch.setattr(
            web_module,
            "resolve",
            lambda pid: (
                mock_facade.resolve(pid)
                or (_ for _ in ()).throw(
                    LarvaError(
                        error={"code": "PERSONA_NOT_FOUND", "message": f"Persona {pid} not found"}
                    )
                )
            ),
        )

        client = TestClient(app)
        resp = client.get("/api/personas/web-test-id")

        assert resp.status_code == 200
        assert resp.json()["data"]["id"] == "web-test-id"

    def test_post_api_personas_validates_and_registers(
        self,
        mock_facade: MockFacade,
        mock_registry: CallRecordingRegistry,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """POST /api/personas validates then registers spec.

        Contract: INTERFACES.md line 116
        """
        monkeypatch.setattr(web_module, "validate", lambda s: _valid_report())
        monkeypatch.setattr(web_module, "register", lambda s: mock_facade.register(s))

        client = TestClient(app)
        payload = {"spec": _MINIMAL_SPEC}

        resp = client.post("/api/personas", json=payload)

        assert resp.status_code == 200
        assert resp.json()["data"]["id"] == "test-persona"
        assert len(mock_registry.save_inputs) == 1

    def test_post_api_personas_rejects_invalid_spec(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """POST /api/personas returns PERSONA_INVALID on validation failure.

        Contract: INTERFACES.md line 116
        Source: USER_GUIDE.md :: VALID_SPEC_VERSION requirement (lines 422-425)
        """
        monkeypatch.setattr(web_module, "validate", lambda s: _invalid_report())

        client = TestClient(app)
        resp = client.post("/api/personas", json={"id": "bad-id"})

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "PERSONA_INVALID"

    def test_patch_api_personas_updates_and_revalidates(
        self,
        mock_facade: MockFacade,
        mock_registry: CallRecordingRegistry,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """PATCH /api/personas/{id} ignores protected fields and revalidates.

        Contract: INTERFACES.md line 117
        """
        spec: PersonaSpec = {
            "id": "update-target",
            "prompt": "Original",
            "model": "old-model",
            "capabilities": {},
            "spec_version": "0.1.0",
            "spec_digest": "sha256:original",
        }
        mock_registry.save(spec)

        def fake_resolve(pid: str) -> PersonaSpec:
            result = mock_facade.resolve(pid)
            if result is None:
                raise LarvaError(
                    error={"code": "PERSONA_NOT_FOUND", "message": f"Persona {pid} not found"}
                )
            return result

        def fake_register(s: PersonaSpec) -> dict[str, Any]:
            return mock_facade.register(s)

        monkeypatch.setattr(web_module, "resolve", fake_resolve)
        monkeypatch.setattr(web_module, "validate", lambda s: _valid_report())
        monkeypatch.setattr(web_module, "register", fake_register)

        client = TestClient(app)

        # Attempt to patch protected fields should be ignored
        resp = client.patch(
            "/api/personas/update-target",
            json={
                "model": "new-model",
                "spec_digest": "sha256:malicious",
                "spec_version": "0.2.0",
            },
        )

        assert resp.status_code == 200
        data = resp.json()["data"]
        # Protected fields should NOT change
        assert data["spec_digest"] != "sha256:malicious"
        assert data["spec_version"] == "0.1.0"

    def test_delete_api_personas_returns_deletion_result(
        self,
        mock_facade: MockFacade,
        mock_registry: CallRecordingRegistry,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """DELETE /api/personas/{id} returns {data: {id, deleted}}.

        Contract: INTERFACES.md line 118
        """
        spec: PersonaSpec = {
            "id": "delete-me",
            "prompt": "Delete me",
            "model": "test-model",
            "capabilities": {},
            "spec_version": "0.1.0",
        }
        mock_registry.save(spec)

        def fake_delete(pid: str) -> dict[str, Any]:
            return mock_facade.delete(pid)

        monkeypatch.setattr(web_module, "delete", fake_delete)

        client = TestClient(app)
        resp = client.delete("/api/personas/delete-me")

        assert resp.status_code == 200
        assert resp.json()["data"]["id"] == "delete-me"
        assert resp.json()["data"]["deleted"] is True

    def test_post_api_personas_clear_requires_confirmation(
        self,
        mock_facade: MockFacade,
        mock_registry: CallRecordingRegistry,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """POST /api/personas/clear only clears on valid confirmation.

        Contract: INTERFACES.md line 119
        Source: USER_GUIDE.md :: larva clear requires confirmation string (lines 270-274)
        """

        def fake_clear(confirm: str = "") -> int:
            return mock_facade.clear(confirm)

        monkeypatch.setattr(web_module, "clear", fake_clear)

        client = TestClient(app)

        # Add a persona to the registry first
        spec: PersonaSpec = {
            "id": "to-clear",
            "prompt": "Clear me",
            "model": "test",
            "capabilities": {},
            "spec_version": "0.1.0",
        }
        mock_registry.save(spec)

        # Wrong confirmation should return error
        resp = client.post("/api/personas/clear", json={"confirm": "WRONG"})
        assert resp.status_code == 400
        assert "error" in resp.json()

        # Correct confirmation should clear
        resp = client.post("/api/personas/clear", json={"confirm": "CLEAR REGISTRY"})
        assert resp.status_code == 200
        assert "cleared" in resp.json()["data"]

    def test_post_api_personas_validate_returns_report(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """POST /api/personas/validate returns validation report.

        Contract: INTERFACES.md line 120
        """
        monkeypatch.setattr(web_module, "validate", lambda s: _valid_report())

        client = TestClient(app)
        resp = client.post("/api/personas/validate", json=_MINIMAL_SPEC)

        assert resp.status_code == 200
        assert resp.json()["data"]["valid"] is True

    def test_post_api_personas_assemble_returns_spec(
        self, mock_facade: MockFacade, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """POST /api/personas/assemble returns assembled PersonaSpec.

        Contract: INTERFACES.md line 121
        """
        monkeypatch.setattr(web_module, "assemble", lambda **kw: mock_facade.assemble(**kw))

        client = TestClient(app)
        resp = client.post(
            "/api/personas/assemble",
            json={
                "id": "assembled-persona",
                "prompts": ["You are X.", "Be careful."],
            },
        )

        assert resp.status_code == 200
        assert resp.json()["data"]["id"] == "assembled-persona"

    def test_get_api_components_lists_names(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """GET /api/components returns component names.

        Contract: INTERFACES.md line 122
        """
        client = TestClient(app)
        resp = client.get("/api/components")

        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "prompts" in data
        assert "toolsets" in data
        assert "constraints" in data
        assert "models" in data

    def test_get_api_components_by_type_name_raises_400_on_invalid_type(self) -> None:
        """GET /api/components/{type}/{name} returns 400 for invalid type.

        Contract: INTERFACES.md line 123
        """
        client = TestClient(app)
        resp = client.get("/api/components/invalid-type/test")

        assert resp.status_code == 400
        assert "Invalid component type" in resp.text
        assert "prompts | toolsets | constraints | models" in resp.text

    def test_get_api_components_by_type_name_accepts_singular_alias(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GET /api/components/{type}/{name} accepts singular type aliases."""

        class _Store:
            def load_prompt(self, name: str) -> Result[dict[str, str], object]:
                return Success({"text": f"Prompt {name}"})

            def load_toolset(self, name: str) -> Result[dict[str, object], object]:
                return Success({})

            def load_constraint(self, name: str) -> Result[dict[str, object], object]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], object]:
                return Success({})

        monkeypatch.setattr(web_module, "_component_store", _Store())
        client = TestClient(app)
        resp = client.get("/api/components/prompt/test")

        assert resp.status_code == 200
        assert "data" in resp.json()


# -----------------------------------------------------------------------------
# Tests: Convenience-only UI behavior documentation
# Source: INTERFACES.md lines 131-138
# -----------------------------------------------------------------------------


class TestWebUiHtmlContent:
    """Tests verifying HTML UI contains documented affordances.

    Source: INTERFACES.md :: Convenience-only UI behavior (lines 131-138)
    Source: INTERFACES.md web runtime contract (line 97: serves HTML)
    """

    def test_served_html_contains_prompt_copy_button(self) -> None:
        """HTML contains copy prompt affordance for operator convenience.

        Contract: INTERFACES.md lines 136-137
        Source: src/larva/shell/web_ui.html copy button implementation
        """
        html_path = Path(__file__).parent.parent.parent / "src" / "larva" / "shell" / "web_ui.html"
        assert html_path.exists(), "web_ui.html should exist"

        content = html_path.read_text()
        # Verify copy prompt affordance exists
        assert "copyPrompt" in content, "HTML should contain copyPrompt function"
        assert "navigator.clipboard" in content, "Copy should use browser clipboard API"
        assert 'title="Copy prompt"' in content, "Copy button should have accessible title"

    def test_served_html_contains_staged_state_visual_indicators(self) -> None:
        """HTML UI displays staged changes visual feedback.

        Source: UI contract for edit-then-save workflow
        """
        html_path = Path(__file__).parent.parent.parent / "src" / "larva" / "shell" / "web_ui.html"
        content = html_path.read_text()

        # Verify staged state indicators exist
        assert "staged" in content, "HTML should track staged changes"
        assert "warning" in content or "border-left" in content, (
            "Staged items should have visual indicator"
        )

    def test_html_contains_api_endpoint_references(self) -> None:
        """HTML UI references normative REST endpoints from contract.

        Source: INTERFACES.md endpoint inventory (lines 111-123)
        """
        html_path = Path(__file__).parent.parent.parent / "src" / "larva" / "shell" / "web_ui.html"
        content = html_path.read_text()

        # Verify normative API paths are referenced in JS fetch calls
        assert "/api/personas" in content, "HTML should reference /api/personas endpoint"
        assert "/api/components" in content, "HTML should reference /api/components endpoint"


# -----------------------------------------------------------------------------
# Tests: Startup contract
# Source: INTERFACES.md :: Startup contract (lines 90-104)
# -----------------------------------------------------------------------------


class TestWebStartupContract:
    """Tests for larva serve startup behavior.

    Source: INTERFACES.md :: Startup contract (lines 90-104)
    Source: USER_GUIDE.md §14 (lines 393-405)
    """

    def test_main_default_port_is_7400(self) -> None:
        """Server defaults to port 7400.

        Contract: INTERFACES.md lines 94-96
        """
        # Use function signature to verify defaults
        import inspect

        sig = inspect.signature(web_module.main)
        port_param = sig.parameters.get("port")
        assert port_param is not None
        assert port_param.default == 7400

    def test_main_accepts_port_and_no_open_arguments(self) -> None:
        """main() accepts port and no_open arguments.

        Contract: INTERFACES.md lines 96-97
        """
        import inspect

        sig = inspect.signature(web_module.main)
        assert "port" in sig.parameters
        assert "no_open" in sig.parameters
        no_open_param = sig.parameters.get("no_open")
        assert no_open_param is not None
        assert no_open_param.default is False

    def test_app_serves_packaged_web_ui_html_at_root(self) -> None:
        """Root path serves web_ui.html from static dir.

        Contract: INTERFACES.md line 97
        Source: src/larva/shell/web.py serve_index function
        """
        # Static file served at root
        client = TestClient(app)
        resp = client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")

    def test_uvicorn_binding_host_is_localhost(self) -> None:
        """Server binds to 127.0.0.1 by default.

        Contract: INTERFACES.md line 94
        """
        # The uvicorn.run call uses 127.0.0.1
        # Verify via source inspection
        source = Path(__file__).parent.parent.parent / "src" / "larva" / "shell" / "web.py"
        content = source.read_text()
        assert 'host="127.0.0.1"' in content or "host='127.0.0.1'" in content, (
            "Should bind to 127.0.0.1"
        )


# -----------------------------------------------------------------------------
# Tests: Error envelope conformance
# Source: INTERFACES.md lines 125-129
# -----------------------------------------------------------------------------


class TestWebErrorEnvelope:
    """Tests for response envelope rules.

    Source: INTERFACES.md :: Shared response envelope rules (lines 125-129)
    """

    def test_success_responses_use_data_envelope(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Successful responses return {"data": ...} envelope.

        Contract: INTERFACES.md line 127
        """
        monkeypatch.setattr(web_module, "validate", lambda s: _valid_report())

        client = TestClient(app)
        resp = client.post("/api/personas/validate", json=_MINIMAL_SPEC)

        assert "data" in resp.json()
        assert resp.status_code == 200

    def test_larva_api_error_maps_to_400_with_error_envelope(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """LarvaApiError maps to HTTP 400 with {"error": ...} envelope.

        Contract: INTERFACES.md lines 127-128
        """

        def raise_api_error() -> None:
            raise LarvaApiError(error={"code": "PERSONA_NOT_FOUND", "message": "Persona not found"})

        def list_with_error() -> list[dict[str, Any]]:
            raise_api_error()
            raise AssertionError("unreachable")  # type: ignore[unreachable]

        monkeypatch.setattr(web_module, "list_personas", list_with_error)

        client = TestClient(app)
        resp = client.get("/api/personas")

        assert resp.status_code == 400
        assert "error" in resp.json()
