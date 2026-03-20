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

from pathlib import Path
from typing import Any

import pytest

# FastAPI/TestClient imports are optional at module load time
pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from starlette.testclient import TestClient

from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.app.facade import LarvaError


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


# -----------------------------------------------------------------------------
# Tests: Contrib server mirrors packaged endpoint inventory
# Source: INTERFACES.md lines 99-123
# -----------------------------------------------------------------------------


class TestContribMirrorEndpointInventory:
    """Tests verifying contrib server mirrors packaged endpoints.

    Source: INTERFACES.md :: Normative endpoint inventory (lines 111-123)
    Note: Contrib adds batch-update as extra convenience (line 147)
    """

    def test_contrib_has_get_api_personas_endpoint(self) -> None:
        """Contrib server has GET /api/personas.

        Contract: INTERFACES.md line 113
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.get("/api/personas")' in content, "Contrib should have GET /api/personas"

    def test_contrib_has_post_api_personas_endpoint(self) -> None:
        """Contrib server has POST /api/personas.

        Contract: INTERFACES.md line 116
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.post("/api/personas")' in content, "Contrib should have POST /api/personas"

    def test_contrib_has_patch_api_personas_endpoint(self) -> None:
        """Contrib server has PATCH /api/personas/{id}.

        Contract: INTERFACES.md line 117
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.patch("/api/personas/{persona_id}")' in content, (
            "Contrib should have PATCH /api/personas/{persona_id}"
        )

    def test_contrib_has_delete_api_personas_endpoint(self) -> None:
        """Contrib server has DELETE /api/personas/{id}.

        Contract: INTERFACES.md line 118
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.delete("/api/personas/{persona_id}")' in content, (
            "Contrib should have DELETE /api/personas/{persona_id}"
        )

    def test_contrib_has_post_clear_endpoint(self) -> None:
        """Contrib server has POST /api/personas/clear.

        Contract: INTERFACES.md line 119
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.post("/api/personas/clear")' in content, (
            "Contrib should have POST /api/personas/clear"
        )

    def test_contrib_has_validate_endpoint(self) -> None:
        """Contrib server has POST /api/personas/validate.

        Contract: INTERFACES.md line 120
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.post("/api/personas/validate")' in content, (
            "Contrib should have POST /api/personas/validate"
        )

    def test_contrib_has_assemble_endpoint(self) -> None:
        """Contrib server has POST /api/personas/assemble.

        Contract: INTERFACES.md line 121
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.post("/api/personas/assemble")' in content, (
            "Contrib should have POST /api/personas/assemble"
        )

    def test_contrib_has_components_endpoints(self) -> None:
        """Contrib server has GET /api/components endpoints.

        Contract: INTERFACES.md lines 122-123
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.get("/api/components")' in content, "Contrib should have GET /api/components"
        assert '@app.get("/api/components/{component_type}/{name}")' in content, (
            "Contrib should have GET /api/components/{type}/{name}"
        )

    def test_contrib_serves_html_at_root(self) -> None:
        """Contrib server serves HTML at GET /.

        Contract: INTERFACES.md line 104, 113
        """
        contrib_path = Path(__file__).parent.parent.parent / "contrib" / "web" / "server.py"
        content = contrib_path.read_text()

        assert '@app.get("/")' in content, "Contrib should serve HTML at root"
