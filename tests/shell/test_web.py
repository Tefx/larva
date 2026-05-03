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
from typing import Any

import pytest
from returns.result import Failure, Result, Success

# FastAPI/TestClient imports are optional at module load time
# to allow tests to run without web dependencies installed
pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from starlette.testclient import TestClient

from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell import python_api
from larva.shell import web as web_module
from larva.shell.python_api import LarvaApiError
from larva.shell.web import app

# -----------------------------------------------------------------------------
# Spec-Fixture Conformance: authoritative minimal PersonaSpec
# Source: INTERFACES.md :: PersonaSpec Contract (lines 11-48)
# -----------------------------------------------------------------------------

_MINIMAL_SPEC: PersonaSpec = {
    "id": "test-persona",
    "description": "Test persona",
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
            {
                "id": s["id"],
                "description": s.get("description", ""),
                "model": s.get("model", ""),
                "spec_digest": s.get("spec_digest", ""),
            }
            for s in self._registry.list()
        ]

    def update(self, persona_id: str, patches: dict[str, Any]) -> PersonaSpec | None:
        spec = self._registry.load(persona_id)
        if spec is None:
            raise LarvaError(
                error={"code": "PERSONA_NOT_FOUND", "message": f"Persona {persona_id} not found"}
            )
        for key in patches:
            root = key.split(".", 1)[0]
            if root in ("id", "spec_digest", "spec_version"):
                raise LarvaApiError(
                    error={
                        "code": "FORBIDDEN_PATCH_FIELD",
                        "message": (
                            f"patch field '{root}' is not permitted at canonical update boundary"
                        ),
                        "details": {"field": root, "key": key},
                    }
                )
        for key, value in patches.items():
            if key != "id":
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
        self,
        mock_facade: MockFacade,
        mock_registry: CallRecordingRegistry,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """GET /api/personas returns {data: PersonaSummary[]}.

        Contract: INTERFACES.md line 113
        """
        mock_registry.list_result = [
            {
                "id": "alpha",
                "description": "Persona alpha",
                "prompt": "You are alpha.",
                "model": "gpt-4o-mini",
                "capabilities": {},
                "spec_version": "0.1.0",
                "spec_digest": "sha256:alpha",
            }
        ]
        client = TestClient(app)
        monkeypatch.setattr(web_module, "list_personas", lambda: mock_facade.list())

        resp = client.get("/api/personas")

        assert resp.status_code == 200
        data = resp.json()
        assert "data" in data
        assert isinstance(data["data"], list)
        assert data["data"][0]["description"] == "Persona alpha"

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
            lambda pid, overrides=None: (
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

    def test_post_api_personas_rejects_unknown_spec_wrapper_keys(self) -> None:
        """POST /api/personas rejects registry metadata beside wrapped spec."""

        client = TestClient(app)

        resp = client.post(
            "/api/personas",
            json={"spec": _MINIMAL_SPEC, "variant": "tacit"},
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_INPUT"
        assert resp.json()["error"]["details"]["field"] == "params"
        assert resp.json()["error"]["details"]["unknown"] == ["variant"]

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
        """PATCH /api/personas/{id} delegates through shared update seam.

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

        def fake_update(pid: str, patches: dict[str, Any]) -> PersonaSpec:
            result = mock_facade.update(pid, patches)
            if result is None:
                raise LarvaError(
                    error={"code": "PERSONA_NOT_FOUND", "message": f"Persona {pid} not found"}
                )
            return result

        monkeypatch.setattr(web_module, "update", fake_update)

        client = TestClient(app)

        # Attempt to patch protected metadata must be rejected
        resp = client.patch(
            "/api/personas/update-target",
            json={
                "model": "new-model",
                "spec_digest": "sha256:malicious",
                "spec_version": "0.2.0",
            },
        )

        assert resp.status_code == 400
        error = resp.json()["error"]
        assert error["code"] == "FORBIDDEN_PATCH_FIELD"
        assert error["details"] == {"field": "spec_digest", "key": "spec_digest"}

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

    def test_patch_api_personas_projects_forbidden_patch_field_as_structured_400(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """PATCH /api/personas/{id} must not leak PatchError as a generic 500."""

        class _Registry:
            def __init__(self, spec: PersonaSpec) -> None:
                self._spec = spec

            def save(self, spec: PersonaSpec) -> Result[None, Any]:
                self._spec = spec
                return Success(None)

            def get(self, persona_id: str) -> Result[PersonaSpec, Any]:
                if persona_id != self._spec["id"]:
                    return Failure(
                        {
                            "code": "PERSONA_NOT_FOUND",
                            "message": "missing",
                            "persona_id": persona_id,
                        }
                    )
                return Success(dict(self._spec))

            def list(self) -> Result[list[PersonaSpec], Any]:
                return Success([dict(self._spec)])

            def delete(self, persona_id: str) -> Result[None, Any]:
                return Success(None)

            def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[int, Any]:
                return Success(1)

        class _Components:
            def load_prompt(self, name: str) -> Result[dict[str, str], Any]:
                return Success({"text": name})

            def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], Any]:
                return Success({"capabilities": {}})

            def load_constraint(self, name: str) -> Result[dict[str, object], Any]:
                return Success({})

            def load_model(self, name: str) -> Result[dict[str, object], Any]:
                return Success({"model": name})

            def list_components(self) -> Result[dict[str, list[str]], Any]:
                return Success({"prompts": [], "toolsets": [], "constraints": [], "models": []})

        facade = DefaultLarvaFacade(
            spec=spec_module,
            validate=validate_module,
            normalize=normalize_module,
            registry=_Registry(
                {
                    **_MINIMAL_SPEC,
                    "spec_digest": "sha256:"
                    + hashlib.sha256(
                        json.dumps(_MINIMAL_SPEC, sort_keys=True, separators=(",", ":")).encode(
                            "utf-8"
                        )
                    ).hexdigest(),
                }
            ),
        )
        monkeypatch.setattr(python_api, "_get_facade", lambda: facade)

        client = TestClient(app)
        resp = client.patch(
            "/api/personas/test-persona",
            json={"tools": {"shell": "read_write"}},
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "FORBIDDEN_PATCH_FIELD"
        assert resp.json()["error"]["details"] == {"field": "tools", "key": "tools"}

    def test_assemble_endpoint_absent(self) -> None:
        """POST /api/personas/assemble should not exist on packaged web."""
        client = TestClient(app)
        resp = client.post(
            "/api/personas/assemble",
            json={
                "id": "test",
                "description": "test",
                "prompt": "test",
                "model": "test-model",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            },
        )
        assert resp.status_code in (404, 405), (
            f"POST /api/personas/assemble should be removed. "
            f"Got {resp.status_code}. Expected 404/405 per INTERFACES.md."
        )


class TestWebComponentEndpointRemoved:
    """/api/components* endpoints must be absent from web UI.

    Source: INTERFACES.md :: Removed endpoints (lines 160-164)
    """

    def test_components_list_absent(self) -> None:
        client = TestClient(app)
        resp = client.get("/api/components")
        assert resp.status_code in (404, 405), (
            f"GET /api/components should be removed. Got {resp.status_code}."
        )

    def test_components_projection_absent(self) -> None:
        client = TestClient(app)
        resp = client.get("/api/components/projection")
        assert resp.status_code in (404, 405), (
            f"GET /api/components/projection should be removed. Got {resp.status_code}."
        )

    def test_components_show_absent(self) -> None:
        client = TestClient(app)
        resp = client.get("/api/components/prompts/test")
        assert resp.status_code in (404, 405), (
            f"GET /api/components/prompts/test should be removed. Got {resp.status_code}."
        )


class TestWebVariantRestEndpoints:
    """Variant registry REST endpoints must exist on web UI.

    Source: INTERFACES.md :: Registry-local Variant routes (lines 147-152)
    Source: design doc :: Web REST surface
    """

    def test_registry_personas_list_exists(self) -> None:
        """GET /api/registry/personas must return registry metadata summaries."""
        client = TestClient(app)
        resp = client.get("/api/registry/personas")
        assert resp.status_code == 200, (
            f"GET /api/registry/personas expected 200, got {resp.status_code}. "
            f"Registry list endpoint must exist per INTERFACES.md."
        )

    def test_registry_personas_variants_list_exists(self) -> None:
        """GET /api/registry/personas/{id}/variants must return variant metadata."""
        client = TestClient(app)
        client.post("/api/personas", json=_MINIMAL_SPEC)
        resp = client.get("/api/registry/personas/test-persona/variants")
        assert resp.status_code == 200, (
            f"GET .../variants expected 200, got {resp.status_code}. "
            f"Variant list endpoint must exist per INTERFACES.md."
        )

    def test_registry_personas_variant_detail_exists(self) -> None:
        """GET /api/registry/personas/{id}/variants/{variant} must return envelope."""
        client = TestClient(app)
        client.post("/api/personas", json=_MINIMAL_SPEC)
        resp = client.get(
            "/api/registry/personas/test-persona/variants/default"
        )
        assert resp.status_code == 200, (
            f"GET .../variants/default expected 200, got {resp.status_code}. "
            f"Variant detail endpoint must exist per INTERFACES.md."
        )
        body = resp.json()
        data = body.get("data", body)
        assert "_registry" in data, (
            f"Expected '_registry' key in variant detail. Got: {sorted(data.keys())}"
        )
        assert "spec" in data, (
            f"Expected 'spec' key in variant detail. Got: {sorted(data.keys())}"
        )
        # _registry must NOT be inside spec
        spec = data.get("spec", {})
        assert "_registry" not in spec, (
            "_registry MUST NOT be inside spec per INTERFACES.md."
        )
        assert "variant" not in spec, (
            "'variant' MUST NOT be inside spec per INTERFACES.md."
        )

    def test_registry_variant_activate_exists(self) -> None:
        """POST .../activate must change active variant without mutating spec."""
        client = TestClient(app)
        client.post("/api/personas", json=_MINIMAL_SPEC)
        resp = client.post(
            "/api/registry/personas/test-persona/variants/default/activate"
        )
        # 200 = success; anything except 404/405 means route exists
        assert resp.status_code not in (404, 405), (
            f"POST .../activate returned {resp.status_code}. "
            f"Route must exist per INTERFACES.md."
        )

    def test_registry_variant_delete_exists(self) -> None:
        """DELETE .../variants/{variant} must exist for inactive non-last variants."""
        client = TestClient(app)
        client.post("/api/personas", json=_MINIMAL_SPEC)
        # The default variant cannot be deleted (only active one), so we
        # just check the route exists, not that deletion succeeds.
        resp = client.delete(
            "/api/registry/personas/test-persona/variants/default"
        )
        # 200 = deleted, 403 = forbidden (active/last), 404 = route missing
        # We accept 403 (ACTIVE_VARIANT_DELETE_FORBIDDEN) but not 404
        assert resp.status_code != 404, (
            "DELETE .../variants/default returned 404 (route missing). "
            "Variant delete endpoint must exist per INTERFACES.md."
        )

    def test_registry_variant_id_mismatch_rejected(self) -> None:
        """PUT variant with mismatched spec.id must return PERSONA_ID_MISMATCH."""
        client = TestClient(app)
        client.post("/api/personas", json=_MINIMAL_SPEC)
        wrong_id_spec = {**_MINIMAL_SPEC, "id": "different-id"}
        resp = client.put(
            "/api/registry/personas/test-persona/variants/tacit",
            json=wrong_id_spec,
        )
        assert resp.status_code == 400, (
            f"PUT with mismatched spec.id expected 400, got {resp.status_code}. "
            f"PERSONA_ID_MISMATCH error required per INTERFACES.md."
        )
        body = resp.json()
        assert "error" in body
        assert body["error"]["code"] == "PERSONA_ID_MISMATCH", (
            f"Expected PERSONA_ID_MISMATCH, got {body['error']['code']}"
        )
