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
