"""Boundary tests for ``contrib.web.server`` contrib-only surface.

Tests prove:
- Batch-update endpoint is exposed on contrib server
- Contrib server mirrors packaged endpoint inventory
- Contrib server serves its HTML artifact
- Preserved runnable liveness proof lives in tests/shell/artifacts/web_runtime_liveness.md

Sources:
- INTERFACES.md :: Contrib-only convenience surface (lines 140-151)
- USER_GUIDE.md :: contrib script startup (lines 410-413)
- tests/shell/artifacts/web_runtime_liveness.md :: contrib runtime probe and captured startup log
"""

from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path
from typing import Any, cast

import pytest

# FastAPI/TestClient imports are optional at module load time
pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from starlette.testclient import TestClient

from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport

CONTRIB_WEB_PATH = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"


def _load_contrib_module() -> Any:
    """Load contrib web module for behavioral endpoint checks."""
    spec = importlib.util.spec_from_file_location("contrib_web_server", CONTRIB_WEB_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    loader = cast("Any", spec.loader)
    loader.exec_module(module)
    return module


def _route_inventory(app: Any) -> set[tuple[str, str]]:
    """Return explicit method/path pairs for application routes."""
    inventory: set[tuple[str, str]] = set()
    for route in app.routes:
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if methods is None or path is None:
            continue
        for method in methods:
            if method in {"HEAD", "OPTIONS"}:
                continue
            inventory.add((method, path))
    return inventory


# -----------------------------------------------------------------------------
# Spec-Fixture Conformance
# Source: INTERFACES.md :: PersonaSpec Contract (lines 11-48)
# -----------------------------------------------------------------------------

_MINIMAL_SPEC: PersonaSpec = {
    "id": "contrib-test-persona",
    "prompt": "You are a test assistant.",
    "model": "test-model",
    "capabilities": {},
    "spec_version": "0.1.0",
}


def _valid_report() -> ValidationReport:
    return {"valid": True, "errors": [], "warnings": []}


# -----------------------------------------------------------------------------
# Tests: Contrib HTML artifact
# Source: INTERFACES.md line 104
# -----------------------------------------------------------------------------


class TestContribHtmlArtifact:
    """Tests for contrib HTML artifact content.

    Source: INTERFACES.md :: contrib/web/index.html served at root (line 104)
    """

    def test_contrib_html_exists(self) -> None:
        """Contrib index.html exists.

        Source: INTERFACES.md line 104
        """
        html_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "index.html"
        assert html_path.exists(), "contrib/web/index.html should exist"

    def test_contrib_html_contains_batch_update_workflow(self) -> None:
        """Contrib HTML contains batch-update UI hooks.

        Source: INTERFACES.md lines 145-147
        Source: contrib/web/index.html should contain batch-update affordance
        """
        html_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "index.html"
        content = html_path.read_text()

        # Verify batch-update workflow exists in contrib HTML
        assert "batch" in content.lower(), "Contrib HTML should contain batch reference"
        assert "/api/personas/batch-update" in content, (
            "Contrib HTML should reference batch-update endpoint"
        )

    def test_contrib_html_contains_prompt_copy_button(self) -> None:
        """Contrib HTML contains prompt copy affordance.

        Source: INTERFACES.md lines 136-137
        """
        html_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "index.html"
        content = html_path.read_text()

        # Verify copy prompt affordance exists
        assert "copyPrompt" in content, "Contrib HTML should contain copyPrompt function"
        assert "navigator.clipboard" in content, "Copy should use browser clipboard API"


# -----------------------------------------------------------------------------
# Tests: Startup contract for contrib server
# Source: INTERFACES.md lines 99-104
# -----------------------------------------------------------------------------


class TestContribStartupContract:
    """Tests for contrib server startup behavior.

    Source: INTERFACES.md :: Startup contract for contrib script (lines 99-104)
    """

    def test_contrib_main_default_port_is_7400(self) -> None:
        """Contrib server defaults to port 7400.

        Contract: INTERFACES.md lines 101-102
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        # Verify --port default is 7400
        assert "default=7400" in content or "default = 7400" in content, (
            "Contrib server should default to port 7400"
        )

    def test_contrib_main_accepts_no_open_argument(self) -> None:
        """Contrib server accepts --no-open argument.

        Contract: INTERFACES.md line 103
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        # Verify --no-open exists
        assert "--no-open" in content or "no_open" in content, (
            "Contrib server should accept --no-open"
        )

    def test_contrib_serves_index_html_at_root(self) -> None:
        """Contrib server serves index.html at root.

        Contract: INTERFACES.md line 104
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '"index.html"' in content or "'index.html'" in content, (
            "Contrib server should serve index.html at root"
        )


# -----------------------------------------------------------------------------
# Tests: Batch-update endpoint in contrib server
# Source: INTERFACES.md lines 140-147
# -----------------------------------------------------------------------------


class TestContribBatchUpdateEndpoint:
    """Tests for contrib-only batch-update convenience surface.

    Source: INTERFACES.md :: Contrib-only convenience surface (lines 140-151)
    """

    def test_contrib_server_defines_batch_update_endpoint(self) -> None:
        """Contrib server defines POST /api/personas/batch-update.

        Contract: INTERFACES.md line 147
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        # Verify batch-update endpoint exists
        assert '@app.post("/api/personas/batch-update")' in content or (
            "@app.post('/api/personas/batch-update')" in content
        ), "Contrib server should define batch-update endpoint"

    def test_batch_update_calls_update_batch_from_python_api(self) -> None:
        """Batch-update endpoint calls update_batch from python_api.

        Source: INTERFACES.md line 147, batch-update uses python_api.update_batch
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        # Verify update_batch is imported and used
        assert "update_batch" in content, "Contrib server should use update_batch"

    def test_batch_update_accepts_where_patches_and_dry_run(self) -> None:
        """Batch-update endpoint accepts where, patches, and dry_run.

        Source: INTERFACES.md batch-update contract with where/patches/dry_run
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        # Verify body extracts where, patches, dry_run
        assert "where" in content, "Batch-update should accept 'where'"
        assert "patches" in content, "Batch-update should accept 'patches'"
        assert "dry_run" in content, "Batch-update should accept 'dry_run'"

    def test_batch_update_post_reaches_python_api_path(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Contrib POST runtime reaches the Python API batch-update path.

        Source: contrib/web/server.py :: contrib-only batch-update extension
        Source: INTERFACES.md :: contrib-only convenience surface
        """
        contrib_module = _load_contrib_module()
        client = TestClient(contrib_module.app)
        observed: dict[str, Any] = {}

        def _spy_update_batch(
            *, where: dict[str, Any], patches: dict[str, Any], dry_run: bool
        ) -> dict[str, Any]:
            observed["where"] = where
            observed["patches"] = patches
            observed["dry_run"] = dry_run
            return {
                "matched": 1,
                "updated": 1,
                "items": [{"id": "contrib-test-persona", "updated": True}],
            }

        monkeypatch.setattr(contrib_module, "update_batch", _spy_update_batch)

        response = client.post(
            "/api/personas/batch-update",
            json={
                "where": {"model": "test-model"},
                "patches": {"description": "Updated from contrib runtime"},
                "dry_run": False,
            },
        )

        assert response.status_code == 200
        assert observed == {
            "where": {"model": "test-model"},
            "patches": {"description": "Updated from contrib runtime"},
            "dry_run": False,
        }
        assert response.json() == {
            "data": {
                "matched": 1,
                "updated": 1,
                "items": [{"id": "contrib-test-persona", "updated": True}],
            }
        }


# -----------------------------------------------------------------------------
# Tests: Contrib server mirrors packaged endpoint inventory
# Source: INTERFACES.md lines 99-123
# -----------------------------------------------------------------------------


class TestContribMirrorEndpointInventory:
    """Tests verifying contrib server mirrors packaged endpoints.

    Source: INTERFACES.md :: Normative endpoint inventory (lines 111-123)
    Note: Contrib adds batch-update as extra convenience (line 147)
    """

    def test_contrib_route_inventory_matches_packaged_plus_batch_update(self) -> None:
        """Contrib app should reuse packaged inventory plus batch-update."""
        from larva.shell.web import app as packaged_app

        contrib_module = _load_contrib_module()
        packaged_routes = _route_inventory(packaged_app)
        contrib_routes = _route_inventory(contrib_module.app)

        assert contrib_routes - packaged_routes == {("POST", "/api/personas/batch-update")}
        assert packaged_routes - contrib_routes == set()

    def test_contrib_serves_html_at_root(self) -> None:
        """Contrib server serves HTML at GET /."""
        contrib_module = _load_contrib_module()
        client = TestClient(contrib_module.app)

        response = client.get("/")

        assert response.status_code == 200
        assert "text/html" in response.headers.get("content-type", "")

    def test_packaged_runtime_does_not_expose_batch_update(self) -> None:
        """Packaged runtime keeps batch-update out of the canonical POST surface.

        Source: INTERFACES.md :: packaged vs contrib route boundary
        Source: README.md :: packaged web remains canonical; contrib is extension-only
        """
        from larva.shell.web import app as packaged_app

        client = TestClient(packaged_app)

        response = client.post(
            "/api/personas/batch-update",
            json={"where": {}, "patches": {"description": "unused"}, "dry_run": True},
        )

        assert response.status_code == 405
        assert response.headers.get("allow") == "GET"

    def test_contrib_main_keeps_packaged_launch_signature(self) -> None:
        """Contrib launch path preserves packaged port/no_open entrypoint."""
        contrib_module = _load_contrib_module()
        signature = inspect.signature(contrib_module.main)

        assert signature.parameters["port"].default == 7400
        assert signature.parameters["no_open"].default is False


# ---------------------------------------------------------------------------
# Surface Cutover: EXPECTED-RED assertions for contrib web
#
# Source authority: docs/reference/INTERFACES.md :: "larva serve is the authoritative
# packaged runtime" (line 129). contrib/web/server.py is a convenience runtime,
# not the canonical entrypoint. However, it should also not expose removed
# assembly/component surfaces or omit variant surfaces.
# ---------------------------------------------------------------------------


class TestContribWebAssemblyRemoved:
    """EXPECTED-RED: contrib web must not expose /api/personas/assemble."""

    def test_contrib_assemble_endpoint_removed(self) -> None:
        """POST /api/personas/assemble should not exist on contrib server."""

        module = _load_contrib_module()
        app = module.app
        client = TestClient(app)
        resp = client.post(
            "/api/personas/assemble",
            json={
                "id": "test-assemble-removed",
                "description": "test",
                "prompt": "test",
                "model": "test-model",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            },
        )
        assert resp.status_code in (404, 405), (
            f"POST /api/personas/assemble should be removed from contrib. "
            f"Got {resp.status_code}. Assembly removed per INTERFACES.md."
        )


class TestContribWebComponentEndpointsRemoved:
    """EXPECTED-RED: contrib web must not expose /api/components* endpoints."""

    def test_contrib_components_list_removed(self) -> None:
        module = _load_contrib_module()
        client = TestClient(module.app)
        resp = client.get("/api/components")
        assert resp.status_code in (404, 405), (
            f"GET /api/components should be removed from contrib. Got {resp.status_code}."
        )

    def test_contrib_components_show_removed(self) -> None:
        module = _load_contrib_module()
        client = TestClient(module.app)
        resp = client.get("/api/components/prompts/test")
        assert resp.status_code in (404, 405), (
            f"GET /api/components/prompts/test should be removed from contrib. Got {resp.status_code}."
        )
