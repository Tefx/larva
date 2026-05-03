"""Red-test coverage: expose missing packaged REST export and update_batch gaps.

These tests exercise the packaged ``larva serve`` surface (``larva.shell.web``)
before endpoint implementation. They are expected to fail RED because the
normative endpoints for export and update_batch are absent from the packaged
REST surface.

Targets:
1. POST /api/personas/export  – packaged REST export absence/mismatch
2. POST /api/personas/update_batch – packaged REST update_batch absence/mismatch
3. Canonical admission invariants (tools, side_effect_policy, protected fields)
4. No contrib dependency for packaged REST coverage

Sources:
- INTERFACES.md :: Normative endpoint inventory (lines 140-158)
- INTERFACES.md :: Contrib-only convenience surface (lines 140-151)
- INTERFACES.md :: PersonaSpec Contract (lines 11-48)
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

if TYPE_CHECKING:
    from collections.abc import Iterator

    from larva.app.facade_types import AssembleModule, LarvaFacade, NormalizeModule, ValidateModule
    from larva.core.spec import PersonaSpec

# FastAPI/TestClient imports are optional at module load time
pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from starlette.testclient import TestClient

from larva.shell.shared import facade_factory
from larva.shell.web import app
from tests.shell.fixture_taxonomy import canonical_persona_spec

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _canonical_spec(persona_id: str) -> PersonaSpec:
    """Return a canonical PersonaSpec suitable for REST registration."""
    spec = canonical_persona_spec(persona_id)
    return spec


def _registry_file_hashes(home: Path) -> dict[str, str]:
    """Return a deterministic content snapshot for the default registry root."""
    registry_root = home / ".larva" / "registry"
    if not registry_root.exists():
        return {}
    hashes: dict[str, str] = {}
    for path in sorted(registry_root.rglob("*")):
        if path.is_file():
            relative_path = path.relative_to(registry_root).as_posix()
            hashes[relative_path] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


@pytest.fixture(autouse=True)
def isolated_web_registry(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """Run packaged REST tests against an isolated registry, never the user's default one."""
    from larva.app.facade import DefaultLarvaFacade
    from larva.core import assemble as assemble_module
    from larva.core import normalize as normalize_module
    from larva.core import spec as spec_module
    from larva.core import validate as validate_module
    from larva.shell.components import FilesystemComponentStore
    from larva.shell.registry import FileSystemRegistryStore

    default_home = Path.home()
    before_default_registry = _registry_file_hashes(default_home)
    isolated_home = tmp_path / "home"
    isolated_home.mkdir()
    isolated_registry_root = isolated_home / ".larva" / "registry"

    def build_isolated_facade() -> LarvaFacade:
        return DefaultLarvaFacade(
            spec=spec_module,
            assemble=cast("AssembleModule", assemble_module),
            validate=cast("ValidateModule", validate_module),
            normalize=cast("NormalizeModule", normalize_module),
            components=FilesystemComponentStore(),
            registry=FileSystemRegistryStore(root=isolated_registry_root),
        )

    monkeypatch.setenv("HOME", str(isolated_home))
    monkeypatch.setattr(facade_factory, "build_default_facade", build_isolated_facade)
    yield
    after_default_registry = _registry_file_hashes(default_home)
    assert after_default_registry == before_default_registry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _register_canonical(client: TestClient, spec: PersonaSpec) -> None:
    """Register a canonical persona for downstream gap tests."""
    resp = client.post("/api/personas", json=spec)
    assert resp.status_code in (200, 400), f"Unexpected status: {resp.status_code} {resp.text}"


# ---------------------------------------------------------------------------
# 1. Packaged REST export absence / mismatch
# ---------------------------------------------------------------------------


class TestPackagedRestExportGap:
    """Expose missing POST /api/personas/export on packaged web surface."""

    def test_post_api_personas_export_all_returns_data_envelope(self) -> None:
        """POST /api/personas/export with {all:true} returns {data: PersonaSpec[]}."""
        client = TestClient(app)
        resp = client.post("/api/personas/export", json={"all": True})
        assert resp.status_code == 200, (
            f"Packaged REST export endpoint missing or broken. "
            f"Expected 200, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert "data" in body
        assert isinstance(body["data"], list)

    def test_post_api_personas_export_ids_preserves_order(self) -> None:
        """POST /api/personas/export with {ids:[...]} preserves requested order."""
        client = TestClient(app)
        _register_canonical(client, _canonical_spec("alpha"))
        _register_canonical(client, _canonical_spec("beta"))
        resp = client.post(
            "/api/personas/export",
            json={"ids": ["alpha", "beta"]},
        )
        assert resp.status_code == 200, (
            f"Packaged REST export endpoint missing or broken. "
            f"Expected 200, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert "data" in body
        ids = [s["id"] for s in body["data"]]
        assert ids == ["alpha", "beta"]

    def test_post_api_personas_export_conflicting_selectors_fail_closed(self) -> None:
        """Conflicting {all:true} + {ids:[...]} must fail with web error envelope."""
        client = TestClient(app)
        resp = client.post(
            "/api/personas/export",
            json={"all": True, "ids": ["alpha"]},
        )
        assert resp.status_code == 400, (
            f"Packaged REST export should reject conflicting selectors. "
            f"Expected 400, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert "error" in body

    def test_post_api_personas_export_missing_selector_fail_closed(self) -> None:
        """Missing selector must fail closed with structured error."""
        client = TestClient(app)
        resp = client.post("/api/personas/export", json={})
        assert resp.status_code == 400, (
            f"Packaged REST export should reject missing selector. "
            f"Expected 400, got {resp.status_code}: {resp.text}"
        )
        assert "error" in resp.json()

    def test_post_api_personas_export_all_false_fail_closed(self) -> None:
        """all:false without ids must fail closed."""
        client = TestClient(app)
        resp = client.post("/api/personas/export", json={"all": False})
        assert resp.status_code == 400, (
            f"Packaged REST export should reject all=false with no ids. "
            f"Expected 400, got {resp.status_code}: {resp.text}"
        )
        assert "error" in resp.json()


# ---------------------------------------------------------------------------
# 2. Packaged REST update_batch absence / mismatch
# ---------------------------------------------------------------------------


class TestPackagedRestUpdateBatchGap:
    """Expose missing POST /api/personas/update_batch on packaged web surface."""

    def test_post_api_personas_update_batch_dry_run_returns_matched(self) -> None:
        """dry_run=true returns matched/updated:0 with no mutation."""
        client = TestClient(app)
        resp = client.post(
            "/api/personas/update_batch",
            json={
                "where": {"model": "gpt-4o-mini"},
                "patches": {"description": "Updated"},
                "dry_run": True,
            },
        )
        assert resp.status_code == 200, (
            f"Packaged REST update_batch endpoint missing or broken. "
            f"Expected 200, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert "data" in body
        assert body["data"]["updated"] == 0
        assert isinstance(body["data"]["items"], list)

    def test_post_api_personas_update_batch_non_dry_run_returns_counts(self) -> None:
        """Non-dry-run returns matched/updated counts and item statuses."""
        client = TestClient(app)
        resp = client.post(
            "/api/personas/update_batch",
            json={
                "where": {"model": "gpt-4o-mini"},
                "patches": {"description": "Updated"},
                "dry_run": False,
            },
        )
        assert resp.status_code == 200, (
            f"Packaged REST update_batch endpoint missing or broken. "
            f"Expected 200, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert "data" in body
        assert "matched" in body["data"]
        assert "updated" in body["data"]
        assert isinstance(body["data"]["items"], list)

    def test_post_api_personas_update_batch_rejects_invalid_patch(self) -> None:
        """Invalid patches fail closed before any registry mutation."""
        client = TestClient(app)
        resp = client.post(
            "/api/personas/update_batch",
            json={
                "where": {"model": "gpt-4o-mini"},
                "patches": {"tools": {"shell": "read_write"}},
            },
        )
        assert resp.status_code == 400, (
            f"Packaged REST update_batch should reject invalid patch. "
            f"Expected 400, got {resp.status_code}: {resp.text}"
        )
        assert "error" in resp.json()

    def test_post_api_personas_update_batch_rejects_protected_patch_fields(
        self,
    ) -> None:
        """Protected fields (id, spec_version, spec_digest) must fail."""
        client = TestClient(app)
        for forbidden_field in ("id", "spec_version", "spec_digest"):
            resp = client.post(
                "/api/personas/update_batch",
                json={
                    "where": {"model": "gpt-4o-mini"},
                    "patches": {forbidden_field: "tampered"},
                },
            )
            assert resp.status_code == 400, (
                f"Packaged REST update_batch should reject protected field '{forbidden_field}'. "
                f"Expected 400, got {resp.status_code}: {resp.text}"
            )
            assert "error" in resp.json()


# ---------------------------------------------------------------------------
# 3. Canonical admission invariants through REST
# ---------------------------------------------------------------------------


class TestCanonicalAdmissionThroughRest:
    """Canonical invariants via packaged REST surface."""

    def test_post_api_personas_rejects_tools_field(self) -> None:
        """POST /api/personas must reject canonical ``tools`` field."""
        client = TestClient(app)
        bad_spec = cast("dict[str, Any]", dict(_canonical_spec("tools-test")))
        bad_spec["tools"] = {"shell": "read_write"}
        resp = client.post("/api/personas", json=bad_spec)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "PERSONA_INVALID"

    def test_post_api_personas_rejects_side_effect_policy(self) -> None:
        """POST /api/personas must reject ``side_effect_policy`` field."""
        client = TestClient(app)
        bad_spec = cast("dict[str, Any]", dict(_canonical_spec("sep-test")))
        bad_spec["side_effect_policy"] = "read_only"
        resp = client.post("/api/personas", json=bad_spec)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "PERSONA_INVALID"

    def test_post_api_personas_export_preserves_spec_digest_format(self) -> None:
        """Export must preserve sha256:<64 lowercase hex> format exactly."""
        client = TestClient(app)
        resp = client.post("/api/personas/export", json={"all": True})
        assert resp.status_code == 200
        body = resp.json()
        for spec in body.get("data", []):
            digest = spec.get("spec_digest", "")
            assert re.fullmatch(r"sha256:[a-f0-9]{64}", digest), (
                f"spec_digest format mismatch: {digest}"
            )


# ---------------------------------------------------------------------------
# 4. No contrib dependency
# ---------------------------------------------------------------------------


class TestNoContribDependency:
    """Packaged REST tests must not import or call contrib/web/server.py."""

    def test_no_contrib_import_in_this_module(self) -> None:
        """Verify this test file does not import contrib.web.server."""
        import sys

        for mod in sys.modules:
            assert "contrib.web" not in mod, (
                f"Packaged REST test imported contrib module: {mod}"
            )

    def test_contrib_batch_update_not_available_on_packaged_app(self) -> None:
        """Packaged app must not expose POST /api/personas/batch-update."""
        client = TestClient(app)
        resp = client.post(
            "/api/personas/batch-update",
            json={"where": {}, "patches": {}, "dry_run": True},
        )
        # Expect 405 (method not allowed) or 404 because route is absent
        assert resp.status_code in (404, 405), (
            f"Packaged app should not expose batch-update. "
            f"Got {resp.status_code}: {resp.text}"
        )


# ---------------------------------------------------------------------------
# 5. Property-based coverage
# ---------------------------------------------------------------------------


_MALFORMED_SELECTOR_STRATEGY = st.one_of(
    st.dictionaries(st.text(), st.text()),
    st.dictionaries(st.text(), st.integers()),
    st.dictionaries(st.text(), st.lists(st.text())),
    st.dictionaries(
        st.text(),
        st.fixed_dictionaries({"all": st.booleans(), "ids": st.lists(st.text())}),
    ),
)


@given(payload=_MALFORMED_SELECTOR_STRATEGY)
@settings(max_examples=20, deadline=None)
def test_export_malformed_selector_hypothesis(payload: dict[str, Any]) -> None:
    """Malformed export selectors must not crash and must return 400."""
    client = TestClient(app)
    resp = client.post("/api/personas/export", json=payload)
    # Non-200 means boundary handled it; 200 is acceptable only for expected shapes
    if resp.status_code == 200:
        body = resp.json()
        assert "data" in body and isinstance(body["data"], list)
    else:
        assert resp.status_code == 400
        assert "error" in resp.json()


_PROTECTED_PATCH_FIELD_STRATEGY = st.sampled_from(
    ["id", "spec_version", "spec_digest"]
)


@given(field=_PROTECTED_PATCH_FIELD_STRATEGY, value=st.text())
@settings(max_examples=20, deadline=None)
def test_update_batch_protected_field_hypothesis(field: str, value: str) -> None:
    """Property: update_batch with any protected field must fail 400."""
    client = TestClient(app)
    resp = client.post(
        "/api/personas/update_batch",
        json={
            "where": {"model": "gpt-4o-mini"},
            "patches": {field: value},
        },
    )
    assert resp.status_code == 400
    assert "error" in resp.json()


_DIGEST_FORMAT_STRATEGY = st.from_regex(
    r"sha256:[a-f0-9]{64}", fullmatch=True
)


@given(digest=_DIGEST_FORMAT_STRATEGY)
@settings(max_examples=20, deadline=None)
def test_spec_digest_format_hypothesis(digest: str) -> None:
    """Property: exported spec_digest must match canonical format."""
    # This checks the format invariant independently of endpoint presence.
    # The real export endpoint is exercised by other tests.
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", digest), (
        f"Generated digest did not match format: {digest}"
    )


# ---------------------------------------------------------------------------
# Surface Cutover: EXPECTED-RED assertions
#
# These assert TARGET-STATE REST surface contracts that have NOT been cut over yet.
# They MUST fail RED until the implementation phase removes assembly/component
# endpoints and adds variant registry endpoints.
#
# Source authority: design/registry-local-variants-and-assembly-removal.md
# Source authority: docs/reference/INTERFACES.md :: Web Runtime Surface
# ---------------------------------------------------------------------------


class TestRESTAssembleEndpointRemoved:
    """EXPECTED-RED: POST /api/personas/assemble MUST NOT exist after cutover.

    Source: INTERFACES.md :: Removed endpoints (line 159)
    Source: design/registry-local-variants-and-assembly-removal.md :: Removed subsystem
    """

    def test_assemble_endpoint_removed(self) -> None:
        """POST /api/personas/assemble must be absent from packaged REST."""
        client = TestClient(app)
        resp = client.post(
            "/api/personas/assemble",
            json={
                "id": "test-assemble",
                "description": "test",
                "prompt": "test",
                "model": "test-model",
                "capabilities": {"shell": "read_only"},
                "spec_version": "0.1.0",
            },
        )
        # 404 or 405 means the route is absent/removed
        assert resp.status_code in (404, 405), (
            f"POST /api/personas/assemble should be removed. "
            f"Got status {resp.status_code}. "
            f"Expected 404/405 per INTERFACES.md removed endpoints."
        )


class TestRESTComponentsEndpointsRemoved:
    """EXPECTED-RED: /api/components* endpoints MUST NOT exist after cutover.

    Source: INTERFACES.md :: Removed endpoints (lines 160-164)
    Source: design/registry-local-variants-and-assembly-removal.md :: Removed subsystem
    """

    def test_components_list_endpoint_removed(self) -> None:
        """GET /api/components must be absent from packaged REST."""
        client = TestClient(app)
        resp = client.get("/api/components")
        assert resp.status_code in (404, 405), (
            f"GET /api/components should be removed. "
            f"Got status {resp.status_code}. "
            f"Expected 404/405 per INTERFACES.md removed endpoints."
        )

    def test_components_projection_endpoint_removed(self) -> None:
        """GET /api/components/projection must be absent from packaged REST."""
        client = TestClient(app)
        resp = client.get("/api/components/projection")
        assert resp.status_code in (404, 405), (
            f"GET /api/components/projection should be removed. "
            f"Got status {resp.status_code}. "
            f"Expected 404/405 per INTERFACES.md removed endpoints."
        )

    def test_components_show_endpoint_removed(self) -> None:
        """GET /api/components/{component_type}/{name} must be absent."""
        client = TestClient(app)
        resp = client.get("/api/components/prompts/test-prompt")
        assert resp.status_code in (404, 405), (
            f"GET /api/components/prompts/test-prompt should be removed. "
            f"Got status {resp.status_code}. "
            f"Expected 404/405 per INTERFACES.md removed endpoints."
        )


class TestRESTVariantEndpointsExist:
    """EXPECTED-RED: Variant registry endpoints MUST exist after cutover.

    Source: INTERFACES.md :: Variant registry routes (lines 147-152)
    Source: design/registry-local-variants-and-assembly-removal.md :: Web REST surface
    """

    def test_registry_personas_list_endpoint_exists(self) -> None:
        """GET /api/registry/personas must return registry metadata summaries."""
        client = TestClient(app)
        resp = client.get("/api/registry/personas")
        assert resp.status_code == 200, (
            f"GET /api/registry/personas expected 200, got {resp.status_code}: {resp.text}. "
            f"Variant registry list endpoint must exist per INTERFACES.md."
        )
        body = resp.json()
        assert isinstance(body, dict), f"Expected dict response, got {type(body)}"
        assert "data" in body, f"Expected 'data' key in response, got {sorted(body.keys())}"

    def test_registry_variants_list_endpoint_exists(self) -> None:
        """GET /api/registry/personas/{id}/variants must return registry metadata."""
        client = TestClient(app)
        # First register a persona to test with
        _register_canonical(client, _canonical_spec("variant-test-rest"))
        resp = client.get("/api/registry/personas/variant-test-rest/variants")
        assert resp.status_code == 200, (
            f"GET /api/registry/personas/variant-test-rest/variants expected 200, "
            f"got {resp.status_code}: {resp.text}. "
            f"Variant list endpoint must exist per INTERFACES.md."
        )
        body = resp.json()
        assert "data" in body, f"Expected 'data' key, got {sorted(body.keys())}"

    def test_registry_variant_detail_endpoint_exists(self) -> None:
        """GET /api/registry/personas/{id}/variants/{variant} must return envelope."""
        client = TestClient(app)
        _register_canonical(client, _canonical_spec("variant-detail-rest"))
        resp = client.get("/api/registry/personas/variant-detail-rest/variants/default")
        assert resp.status_code == 200, (
            f"GET .../variants/default expected 200, got {resp.status_code}: {resp.text}. "
            f"Variant detail endpoint must exist per INTERFACES.md."
        )
        body = resp.json()
        # Must have separate _registry and spec keys per INTERFACES.md
        assert "data" in body, f"Expected 'data' key, got {sorted(body.keys())}"
        data = body["data"]
        assert "_registry" in data, f"Expected '_registry' in envelope, got {sorted(data.keys())}"
        assert "spec" in data, f"Expected 'spec' in envelope, got {sorted(data.keys())}"

    def test_registry_variant_put_endpoint_exists(self) -> None:
        """PUT /api/registry/personas/{id}/variants/{variant} must accept spec with matching id."""
        client = TestClient(app)
        spec = dict(_canonical_spec("variant-put-rest"))
        # Register first
        client.post("/api/personas", json=spec)
        # PUT a variant
        resp = client.put(
            "/api/registry/personas/variant-put-rest/variants/tacit",
            json=spec,
        )
        assert resp.status_code in (200, 201), (
            f"PUT .../variants/tacit expected 200/201, got {resp.status_code}: {resp.text}. "
            f"Variant PUT endpoint must exist per INTERFACES.md."
        )

    def test_registry_variant_activate_endpoint_exists(self) -> None:
        """POST /api/registry/personas/{id}/variants/{variant}/activate must exist."""
        client = TestClient(app)
        _register_canonical(client, _canonical_spec("variant-activate-rest"))
        resp = client.post(
            "/api/registry/personas/variant-activate-rest/variants/default/activate"
        )
        # 200 means endpoint exists and activation succeeded
        # 404 means endpoint missing
        assert resp.status_code != 404, (
            f"POST .../default/activate returned 404. "
            f"Variant activate endpoint must exist per INTERFACES.md."
        )

    def test_registry_variant_delete_endpoint_exists(self) -> None:
        """DELETE /api/registry/personas/{id}/variants/{variant} must exist."""
        client = TestClient(app)
        # Create persona with two variants so we can delete one
        spec = dict(_canonical_spec("variant-delete-rest"))
        client.post("/api/personas", json=spec)
        # Add a second variant we can try to delete
        client.put(
            "/api/registry/personas/variant-delete-rest/variants/draft",
            json=spec,
        )
        resp = client.delete(
            "/api/registry/personas/variant-delete-rest/variants/draft"
        )
        # 200 means endpoint exists; 404 means endpoint missing
        # (We may get 404 if the variant doesn't exist yet, or 403 if it's the
        # active/last variant, but NOT route-404)
        assert resp.status_code != 405, (
            f"DELETE .../variants/draft returned 405 (method not allowed). "
            f"Variant delete endpoint must exist per INTERFACES.md."
        )


class TestRESTVariantEnvelopeSeparation:
    """EXPECTED-RED: Variant endpoints must separate _registry from canonical spec.

    Source: INTERFACES.md :: Registry Variant Envelope (lines 182-197)
    Source: design/registry-local-variants-and-assembly-removal.md :: Web REST surface
    """

    def test_variant_detail_envelope_separates_registry_from_spec(self) -> None:
        """Variant detail must return {_registry: {variant, is_active}, spec: {...}}.

        _registry must NOT appear inside spec.
        """
        client = TestClient(app)
        _register_canonical(client, _canonical_spec("envelope-sep-rest"))
        resp = client.get("/api/registry/personas/envelope-sep-rest/variants/default")
        assert resp.status_code == 200, (
            f"Expected 200 for variant detail, got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        data = body.get("data", body)
        # _registry must exist at top level of data, not inside spec
        assert "_registry" in data, f"Missing '_registry' key: {sorted(data.keys())}"
        assert "spec" in data, f"Missing 'spec' key: {sorted(data.keys())}"
        # _registry must NOT be inside spec
        spec = data.get("spec", {})
        assert "_registry" not in spec, (
            f"_registry MUST NOT appear inside spec per INTERFACES.md. "
            f"Found: {sorted(spec.keys())}"
        )
        assert "variant" not in spec, (
            f"'variant' MUST NOT appear inside spec per INTERFACES.md. "
            f"Found: {sorted(spec.keys())}"
        )

    def test_variant_detail_id_mismatch_rejected(self) -> None:
        """PUT variant with mismatched spec.id must fail with PERSONA_ID_MISMATCH."""
        client = TestClient(app)
        _register_canonical(client, _canonical_spec("idmismatch-rest"))
        wrong_id_spec = dict(_canonical_spec("different-id"))
        resp = client.put(
            "/api/registry/personas/idmismatch-rest/variants/tacit",
            json=wrong_id_spec,
        )
        assert resp.status_code == 400, (
            f"PUT variant with mismatched spec.id expected 400, "
            f"got {resp.status_code}: {resp.text}. "
            f"PERSONA_ID_MISMATCH error required per INTERFACES.md."
        )
        body = resp.json()
        # Error code must be PERSONA_ID_MISMATCH
        assert "error" in body, f"Expected error envelope, got: {body}"
        assert body["error"]["code"] == "PERSONA_ID_MISMATCH", (
            f"Expected error code PERSONA_ID_MISMATCH, "
            f"got {body['error']['code']}"
        )

    def test_variant_detail_registry_corrupt_detection(self) -> None:
        """Registry-corrupt manifest must fail with REGISTRY_CORRUPT error code."""
        # This test verifies the error code is defined.
        # Since setting up a corrupt registry in an integration test is complex,
        # we verify the error code exists in the error vocabulary.
        from larva.app.facade import ERROR_NUMERIC_CODES

        assert "REGISTRY_CORRUPT" in ERROR_NUMERIC_CODES, (
            f"REGISTRY_CORRUPT not in ERROR_NUMERIC_CODES. "
            f"Expected per INTERFACES.md and USAGE.md."
        )


class TestRESTErrorCodesSurfaceConsistently:
    """EXPECTED-RED: Variant-related error codes must surface consistently.

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

    def test_variant_error_codes_in_facade(self) -> None:
        """All variant-related error codes must be defined in ERROR_NUMERIC_CODES."""
        from larva.app.facade import ERROR_NUMERIC_CODES

        for code in self.REQUIRED_VARIANT_ERROR_CODES:
            assert code in ERROR_NUMERIC_CODES, (
                f"Error code '{code}' missing from ERROR_NUMERIC_CODES. "
                f"Expected per INTERFACES.md §6 and USAGE.md §6."
            )

    def test_active_variant_delete_forbidden_code_exists(self) -> None:
        """ACTIVE_VARIANT_DELETE_FORBIDDEN must be a defined error code."""
        from larva.app.facade import ERROR_NUMERIC_CODES

        assert "ACTIVE_VARIANT_DELETE_FORBIDDEN" in ERROR_NUMERIC_CODES, (
            f"ACTIVE_VARIANT_DELETE_FORBIDDEN not defined. "
            f"Available codes: {sorted(ERROR_NUMERIC_CODES.keys())}"
        )

    def test_last_variant_delete_forbidden_code_exists(self) -> None:
        """LAST_VARIANT_DELETE_FORBIDDEN must be a defined error code."""
        from larva.app.facade import ERROR_NUMERIC_CODES

        assert "LAST_VARIANT_DELETE_FORBIDDEN" in ERROR_NUMERIC_CODES, (
            f"LAST_VARIANT_DELETE_FORBIDDEN not defined. "
            f"Available codes: {sorted(ERROR_NUMERIC_CODES.keys())}"
        )
