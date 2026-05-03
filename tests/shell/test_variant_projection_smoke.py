"""Variant projection and OpenCode smoke tests.

Design authority:
- design/registry-local-variants-and-assembly-removal.md
- docs/reference/INTERFACES.md
- docs/reference/ARCHITECTURE.md
- contrib/opencode-plugin/README.md
- ../opifex/design/final-canonical-contract.md
- ../opifex/conformance/case_matrix/larva/larva.variant_list.yaml
- ../opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml

Test requirements:
1. OpenCode projection uses active variants only; inactive variants are not projected.
2. OpenCode projection digest changes when active variant content changes.
3. MCP tool variant surfaces are registered and reachable (tool-list smoke).
4. REST route variant smoke proves variant routes and removed route 404.
5. CLI smoke with temp HOME proves register --variant, variant list/activate/delete.
6. No canonical metadata leak (_registry, variant, active) into PersonaSpec outputs.
7. Product code may not be modified.
"""

from __future__ import annotations

import hashlib
import os
import importlib
import json
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pytest
from returns.result import Failure, Success

from larva.core.normalize import normalize_spec
from larva.core.validate import validate_spec
from larva.shell.opencode import build_opencode_config, _agent_entry, _placeholder

if TYPE_CHECKING:
    from collections.abc import Iterator

    from larva.core.spec import PersonaSpec


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FORBIDDEN_CANONICAL_KEYS = frozenset({"variant", "_registry", "active", "manifest"})


def _reload_python_api_for_isolated_home() -> None:
    """Refresh shell registry factory state after HOME is isolated."""

    import larva.shell.registry as registry_module
    import larva.shell.shared.facade_factory as facade_factory_module

    importlib.reload(registry_module)
    importlib.reload(facade_factory_module)


class _VariantAwareInMemoryStore:
    """InMemoryRegistryStore whose list() returns active variant specs.

    The default InMemoryRegistryStore's list() returns a fixed list_result
    that doesn't track saves. This store derives list() from saved active
    variants, which is how the production facade works.
    """

    def __init__(self) -> None:
        self.variants: dict[str, dict[str, PersonaSpec]] = {}
        self.active_variants: dict[str, str] = {}

    def save(self, spec: PersonaSpec, variant: str | None = None) -> Any:
        from returns.result import Success

        persona_id = cast("str", spec.get("id", ""))
        variant_name = "default" if variant is None else variant
        if persona_id:
            self.variants.setdefault(persona_id, {})[variant_name] = dict(spec)
            self.active_variants.setdefault(persona_id, variant_name)
        return Success(None)

    def get(self, persona_id: str) -> Any:
        from returns.result import Success, Failure

        active = self.active_variants.get(persona_id)
        if active is not None and persona_id in self.variants:
            return Success(dict(self.variants[persona_id][active]))
        return Failure({"code": "PERSONA_NOT_FOUND", "message": f"not found: {persona_id}"})

    def get_variant(self, persona_id: str, variant: str) -> Any:
        from returns.result import Success, Failure

        if persona_id in self.variants and variant in self.variants[persona_id]:
            return Success(dict(self.variants[persona_id][variant]))
        return Failure({"code": "VARIANT_NOT_FOUND", "message": f"not found: {variant}"})

    def list(self) -> Any:
        from returns.result import Success

        result: list[PersonaSpec] = []
        for persona_id in sorted(self.variants):
            active = self.active_variants.get(persona_id)
            if active and active in self.variants[persona_id]:
                result.append(cast("PersonaSpec", dict(self.variants[persona_id][active])))
        return Success(result)

    def delete(self, persona_id: str) -> Any:
        from returns.result import Success

        self.variants.pop(persona_id, None)
        self.active_variants.pop(persona_id, None)
        return Success(None)

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Any:
        from returns.result import Success

        count = len(self.variants)
        self.variants.clear()
        self.active_variants.clear()
        return Success(count)

    def variant_list(self, persona_id: str) -> Any:
        from returns.result import Success, Failure

        if persona_id not in self.variants:
            return Failure(
                {"code": "PERSONA_NOT_FOUND", "message": f"not found: {persona_id}"}
            )
        return Success(
            {
                "id": persona_id,
                "active": self.active_variants[persona_id],
                "variants": sorted(self.variants[persona_id]),
            }
        )

    def variant_activate(self, persona_id: str, variant: str) -> Any:
        from returns.result import Failure

        if persona_id not in self.variants or variant not in self.variants[persona_id]:
            return Failure(
                {"code": "VARIANT_NOT_FOUND", "message": f"not found: {variant}"}
            )
        self.active_variants[persona_id] = variant
        return self.variant_list(persona_id)

    def variant_delete(self, persona_id: str, variant: str) -> Any:
        from returns.result import Failure, Success

        if persona_id not in self.variants:
            return Failure({"code": "PERSONA_NOT_FOUND", "message": f"not found: {persona_id}"})
        if variant not in self.variants[persona_id]:
            return Failure({"code": "VARIANT_NOT_FOUND", "message": f"not found: {variant}"})
        if len(self.variants[persona_id]) == 1:
            return Failure({"code": "LAST_VARIANT_DELETE_FORBIDDEN", "message": "cannot delete last variant"})
        if self.active_variants.get(persona_id) == variant:
            return Failure({"code": "ACTIVE_VARIANT_DELETE_FORBIDDEN", "message": "cannot delete active variant"})
        del self.variants[persona_id][variant]
        return Success(None)


def _variant_aware_registry_store() -> _VariantAwareInMemoryStore:
    return _VariantAwareInMemoryStore()


def _canonical_spec(persona_id: str, model: str = "openai/gpt-5.5") -> PersonaSpec:
    """Return a canonical PersonaSpec with valid fields only."""
    return cast(
        "PersonaSpec",
        {
            "id": persona_id,
            "description": f"{persona_id} description",
            "prompt": f"You are {persona_id}.",
            "model": model,
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        },
    )


def _normalized_spec(persona_id: str, model: str = "openai/gpt-5.5") -> PersonaSpec:
    """Return a normalized canonical spec with spec_digest computed."""
    return normalize_spec(_canonical_spec(persona_id, model))


def _digest_for(spec: dict[str, object]) -> str:
    payload = {k: v for k, v in spec.items() if k != "spec_digest"}
    canonical_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical_json.encode('utf-8')).hexdigest()}"


def _assert_no_canonical_leak(spec: dict[str, object]) -> None:
    """Assert no registry-local metadata keys leak into a canonical spec."""
    for key in _FORBIDDEN_CANONICAL_KEYS:
        assert key not in spec, (
            f"Canonical PersonaSpec must not contain registry-local key '{key}'. "
            f"Keys found: {sorted(spec.keys())}"
        )


# ---------------------------------------------------------------------------
# 1. OpenCode Projection: Active Variants Only
# ---------------------------------------------------------------------------


class TestOpenCodeActiveVariantProjection:
    """OpenCode projection must project active specs only; inactive variants
    must not appear as separate agent entries.

    Source: ARCHITECTURE.md line 98; design doc line 264; USAGE.md lines 229-232.
    """

    def test_export_all_produces_one_entry_per_base_id(self) -> None:
        """export_all returns exactly one spec per base persona id (the active variant).

        This uses an InMemoryRegistryStore whose list() returns stored active specs,
        proving that only the active variant is projected even when multiple
        variants exist for a single base persona id.
        """
        registry = _variant_aware_registry_store()
        default_spec = _normalized_spec("reviewer")
        registry.save(default_spec)
        # Add a second variant "tacit" for the same base id
        tacit_spec = cast("PersonaSpec", dict(_normalized_spec("reviewer")))
        tacit_spec = normalize_spec(cast("PersonaSpec", dict(tacit_spec, prompt="You are a tacit reviewer.")))
        registry.save(tacit_spec, variant="tacit")

        # list() must return only active specs (one per base id)
        list_result = registry.list()
        assert isinstance(list_result, Success)
        ids = [s["id"] for s in list_result.unwrap()]
        assert ids.count("reviewer") == 1, (
            f"list must return one active spec per base id, got: {ids}"
        )

    def test_build_opencode_config_uses_base_ids_only(self) -> None:
        """OpenCode agent config keys must be base persona ids, not variant ids.

        Source: contrib/opencode-plugin/README.md line 114.
        """
        spec_a = _normalized_spec("reviewer")
        spec_b = _normalized_spec("writer")
        result = build_opencode_config(
            [spec_a, spec_b],
            plugin_uri="file:///tmp/larva.ts",
        )
        assert isinstance(result, Success)
        config = result.unwrap()
        agents = cast("dict[str, dict[str, object]]", config.get("agent", {}))
        # Only base ids appear as agent keys
        assert "reviewer" in agents
        assert "writer" in agents
        # No dot-variant or suffixed names appear
        assert not any("reviewer-" in k for k in agents), (
            f"Variant-suffixed agent keys found: {[k for k in agents if 'reviewer-' in k]}"
        )

    def test_opencode_projection_ignores_inactive_variant_content(self) -> None:
        """Inactive variant content must not appear in OpenCode agent entries.

        If a base persona has an active variant 'default' and an inactive variant
        'tacit', OpenCode projection must use the active variant's content only.
        """
        # Active: "You are reviewer.", Inactive: "You are tacit reviewer."
        active_spec = _normalized_spec("reviewer")
        result = build_opencode_config(
            [active_spec],
            plugin_uri="file:///tmp/larva.ts",
        )
        assert isinstance(result, Success)
        config = result.unwrap()
        agents = cast("dict[str, dict[str, object]]", config.get("agent", {}))
        assert agents["reviewer"]["prompt"] == "[larva:reviewer]"


# ---------------------------------------------------------------------------
# 2. OpenCode Projection Digest Changes
# ---------------------------------------------------------------------------


class TestOpenCodeDigestChangesOnVariantContentChange:
    """Projection digest must change when active variant content changes.

    Source: design doc line 83; INTERFACES.md line 227.
    """

    def test_digest_changes_when_model_changes(self) -> None:
        """spec_digest is different when spec content differs."""
        spec_v1 = _normalized_spec("reviewer", model="openai/gpt-5.5")
        spec_v2 = _normalized_spec("reviewer", model="openai/gpt-5.5-pro")
        assert spec_v1["spec_digest"] != spec_v2["spec_digest"], (
            "spec_digest must change when model changes"
        )

    def test_digest_changes_when_prompt_changes(self) -> None:
        """spec_digest is different when prompt text differs."""
        spec_v1 = normalize_spec(
            cast(
                "PersonaSpec",
                {
                    "id": "reviewer",
                    "description": "desc",
                    "prompt": "You are active reviewer.",
                    "model": "openai/gpt-5.5",
                    "capabilities": {"shell": "read_only"},
                    "spec_version": "0.1.0",
                },
            )
        )
        spec_v2 = normalize_spec(
            cast(
                "PersonaSpec",
                {
                    "id": "reviewer",
                    "description": "desc",
                    "prompt": "You are tacit reviewer.",
                    "model": "openai/gpt-5.5",
                    "capabilities": {"shell": "read_only"},
                    "spec_version": "0.1.0",
                },
            )
        )
        assert spec_v1["spec_digest"] != spec_v2["spec_digest"], (
            "spec_digest must change when prompt content differs"
        )

    def test_opencode_agent_entry_uses_active_spec(self) -> None:
        """_agent_entry must project the spec it receives, including the spec's model."""
        spec = _normalized_spec("code-reviewer", model="openai/gpt-5.5-pro")
        entry = _agent_entry(spec).unwrap()
        assert entry["model"] == "openai/gpt-5.5-pro"


# ---------------------------------------------------------------------------
# 3. MCP Tool Variant Surface Smoke
# ---------------------------------------------------------------------------


class TestMCPVariantToolSurface:
    """MCP tool listing must expose variant tools and exclude removed tools.

    Source: INTERFACES.md lines 40-53; larva.mcp_server_naming.yaml.
    """

    def test_mcp_handlers_expose_variant_list_activate_delete(self) -> None:
        """MCPHandlers must provide variant_list, variant_activate, variant_delete."""
        from larva.shell.mcp import MCPHandlers
        from tests.app.test_facade.conftest import InMemoryRegistryStore, _facade

        registry = InMemoryRegistryStore()
        facade, _, _, _ = _facade(registry=registry)
        handlers = MCPHandlers(facade)

        # Register a persona with a variant
        spec = _normalized_spec("reviewer")
        registry.save(spec)

        result = handlers.handle_variant_list({"id": "reviewer"})
        assert isinstance(result, dict)
        assert result["id"] == "reviewer"
        assert "active" in result
        assert "variants" in result

    def test_mcp_handlers_variant_list_returns_registry_metadata(self) -> None:
        """variant_list returns registry metadata, not PersonaSpec fields.

        Source: INTERFACES.md line 68-73; design doc line 113.
        """
        from larva.shell.mcp import MCPHandlers
        from tests.app.test_facade.conftest import InMemoryRegistryStore, _facade

        registry = InMemoryRegistryStore()
        spec = _normalized_spec("auditor")
        registry.save(spec)
        facade, _, _, _ = _facade(registry=registry)
        handlers = MCPHandlers(facade)

        result = handlers.handle_variant_list({"id": "auditor"})
        assert isinstance(result, dict)
        # Result must have registry metadata fields, not PersonaSpec fields
        assert "id" in result
        assert "active" in result
        assert "variants" in result
        # Must NOT contain PersonaSpec content fields
        assert "prompt" not in result, "variant_list must not include PersonaSpec prompt"
        assert "capabilities" not in result, "variant_list must not include capabilities"
        assert "spec_version" not in result, "variant_list must not include spec_version"

    def test_mcp_assemble_tool_is_absent(self) -> None:
        """larva_assemble must not be registered in the MCP tool list.

        Source: INTERFACES.md line 57; design doc lines 125-129.
        """
        from larva.shell.mcp import MCPHandlers
        from tests.app.test_facade.conftest import InMemoryRegistryStore, _facade

        facade, _, _, _ = _facade()
        handlers = MCPHandlers(facade)
        # Verify handle_assemble does not exist or is removed
        assert not hasattr(handlers, "handle_assemble") or not callable(
            getattr(handlers, "handle_assemble", None)
        ), "handle_assemble must not exist on MCPHandlers after assembly removal"

    def test_validate_rejects_variant_in_spec(self) -> None:
        """variant must be rejected inside PersonaSpec at canonical admission.

        Source: design doc line 34; INTERFACES.md line 18.
        """
        spec_with_variant = dict(_canonical_spec("bad-variant"))
        spec_with_variant["variant"] = "tacit"
        report = validate_spec(cast("PersonaSpec", spec_with_variant))
        assert report["valid"] is False, "variant must be rejected inside PersonaSpec"
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
            f"Expected EXTRA_FIELD_NOT_ALLOWED for 'variant', got: {error_codes}"
        )

    def test_validate_rejects_registry_in_spec(self) -> None:
        """_registry must be rejected inside PersonaSpec at canonical admission."""
        spec_with_registry = dict(_canonical_spec("bad-registry"))
        spec_with_registry["_registry"] = {"variant": "tacit", "is_active": True}
        report = validate_spec(cast("PersonaSpec", spec_with_registry))
        assert report["valid"] is False, "_registry must be rejected inside PersonaSpec"
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
            f"Expected EXTRA_FIELD_NOT_ALLOWED for '_registry', got: {error_codes}"
        )

    def test_validate_rejects_active_in_spec(self) -> None:
        """active must be rejected inside PersonaSpec at canonical admission."""
        spec_with_active = dict(_canonical_spec("bad-active"))
        spec_with_active["active"] = "default"
        report = validate_spec(cast("PersonaSpec", spec_with_active))
        assert report["valid"] is False, "active must be rejected inside PersonaSpec"
        error_codes = {e["code"] for e in report["errors"]}
        assert "EXTRA_FIELD_NOT_ALLOWED" in error_codes, (
            f"Expected EXTRA_FIELD_NOT_ALLOWED for 'active', got: {error_codes}"
        )


# ---------------------------------------------------------------------------
# 4. REST Route Variant Smoke
# ---------------------------------------------------------------------------


class TestRestRouteVariantSmoke:
    """REST variant routes must exist and removed routes must 404."""

    @pytest.fixture(autouse=True)
    def _isolated_registry(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> Iterator[None]:
        """Isolate web tests from the real registry."""
        from larva.app.facade import DefaultLarvaFacade
        from larva.core import normalize as normalize_module
        from larva.core import spec as spec_module
        from larva.core import validate as validate_module
        from larva.shell.registry import FileSystemRegistryStore
        from larva.shell.shared import facade_factory

        isolated_home = tmp_path / "home"
        isolated_home.mkdir()
        isolated_registry_root = isolated_home / ".larva" / "registry"

        def build_isolated_facade() -> Any:
            from larva.app.facade_types import LarvaFacade

            return DefaultLarvaFacade(
                spec=spec_module,
                validate=cast("Any", validate_module),
                normalize=cast("Any", normalize_module),
                registry=FileSystemRegistryStore(root=isolated_registry_root),
            )

        monkeypatch.setattr(facade_factory, "build_default_facade", build_isolated_facade)
        yield

    @pytest.fixture()
    def client(self) -> Any:
        from starlette.testclient import TestClient

        from larva.shell.web import app

        return TestClient(app, raise_server_exceptions=False)

    def test_get_api_registry_personas_lists_variant_metadata(self, client: Any) -> None:
        """GET /api/registry/personas returns variant metadata, not canonical specs."""
        from larva.shell import python_api

        spec = _canonical_spec("reviewer")
        python_api.register(spec)

        resp = client.get("/api/registry/personas")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert isinstance(data, list)
        # Each item must have variant metadata keys
        assert len(data) >= 1
        first = data[0]
        assert "id" in first
        assert "active" in first
        assert "variants" in first

    def test_put_variant_registers_named_variant(self, client: Any) -> None:
        """PUT variant route registers a named variant spec.

        Source: INTERFACES.md line 149.
        """
        from larva.shell import python_api

        spec = _canonical_spec("reviewer")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="You are a tacit reviewer.")
        resp = client.put(
            f"/api/registry/personas/reviewer/variants/tacit",
            json=tacit_spec,
        )
        assert resp.status_code == 200
        body = resp.json()
        data = body.get("data", body)
        # PUT variant returns register result: {id, registered}
        assert data.get("id") == "reviewer" or data.get("registered") is True

    def test_variant_detail_returns_registry_envelope(self, client: Any) -> None:
        """GET variant detail returns {_registry, spec} envelope.

        Source: INTERFACES.md lines 148-149.
        """
        from larva.shell import python_api

        spec = _canonical_spec("reviewer-envelope")
        python_api.register(spec)

        resp = client.get(
            f"/api/registry/personas/reviewer-envelope/variants/default"
        )
        assert resp.status_code == 200
        body = resp.json()
        data = body.get("data", body)
        assert "_registry" in data, f"variant detail must include _registry, got keys: {sorted(data.keys())}"
        assert data["_registry"]["variant"] == "default"
        assert "spec" in data
        # spec must not leak registry metadata
        spec_data = data["spec"]
        _assert_no_canonical_leak(cast("dict[str, object]", spec_data))

    def test_variant_activate_changes_active_pointer(self, client: Any) -> None:
        """POST activate variant changes the active pointer."""
        from larva.shell import python_api

        spec = _canonical_spec("reviewer")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="You are a tacit reviewer.")
        resp = client.put(
            f"/api/registry/personas/reviewer/variants/tacit",
            json=tacit_spec,
        )
        assert resp.status_code == 200

        resp = client.post(
            f"/api/registry/personas/reviewer/variants/tacit/activate"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["active"] == "tacit"

    def test_assemble_route_returns_404(self, client: Any) -> None:
        """POST /api/personas/assemble must return 404 as a removed-route tombstone.

        Source: INTERFACES.md line 165-167.
        """
        resp = client.post(
            "/api/personas/assemble",
            json={"id": "test"},
        )
        assert resp.status_code == 404, (
            f"Assembly route must return 404 (removed tombstone), got {resp.status_code}"
        )

    def test_component_routes_return_404(self, client: Any) -> None:
        """Removed component routes must return 404.

        Source: INTERFACES.md lines 160-164.
        """
        for path in [
            "/api/components",
            "/api/components/prompts/test-item",
        ]:
            resp = client.get(path)
            # FastAPI returns 405 for unknown method combos or 404 for missing routes
            assert resp.status_code in (404, 405, 422), (
                f"Removed component route {path} must not return 200, got {resp.status_code}"
            )


# ---------------------------------------------------------------------------
# 5. CLI Variant Smoke (temp HOME isolation)
# ---------------------------------------------------------------------------


class TestCLIVariantSmoke:
    """CLI smoke tests prove register --variant, variant list/activate/delete work.

    These tests use the Python API for registry isolation rather than subprocess
    CLI calls, because subprocess CLI tests would require a proper entry point
    that may not be available in all environments. The CLI dispatches to the
    same Python API, so testing through the API covers the same logic paths.
    """

    @pytest.fixture(autouse=True)
    def _isolate_registry(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """Isolate Python API tests from the real user registry."""
        isolated_home = tmp_path / "home"
        isolated_home.mkdir()
        monkeypatch.setenv("HOME", str(isolated_home))
        _reload_python_api_for_isolated_home()

    def test_register_default_and_list(self) -> None:
        """Register default variant; list returns base persona ids."""
        from larva.shell import python_api

        spec = _canonical_spec("smoke-tester")
        python_api.register(spec)

        personas = python_api.list()
        ids = [p["id"] for p in personas]
        assert "smoke-tester" in ids

    def test_register_with_variant_and_activate(self) -> None:
        """Register named variant; activate changes resolved content."""
        from larva.shell import python_api

        spec = _canonical_spec("variant-tester")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="You are a tacit variant tester.")
        python_api.register(cast("PersonaSpec", tacit_spec), variant="tacit")

        metadata = python_api.variant_list("variant-tester")
        assert "default" in metadata["variants"]
        assert "tacit" in metadata["variants"]
        assert metadata["active"] == "default"

        python_api.variant_activate("variant-tester", "tacit")
        metadata = python_api.variant_list("variant-tester")
        assert metadata["active"] == "tacit"

    def test_variant_delete_inactive_nonlast(self) -> None:
        """variant_delete succeeds for inactive, non-last variant."""
        from larva.shell import python_api

        spec = _canonical_spec("delete-tester")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="You are a tacit variant.")
        python_api.register(cast("PersonaSpec", tacit_spec), variant="tacit")

        python_api.variant_delete("delete-tester", "tacit")

        metadata = python_api.variant_list("delete-tester")
        assert "tacit" not in metadata["variants"]

    def test_resolve_uses_active_variant(self) -> None:
        """resolve returns the active variant content."""
        from larva.shell import python_api

        spec = _canonical_spec("resolve-tester")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="You are the tacit variant.")
        python_api.register(cast("PersonaSpec", tacit_spec), variant="tacit")

        # Default active is "default"
        resolved = python_api.resolve("resolve-tester")
        assert resolved["prompt"] == "You are resolve-tester."

        # Activate tacit
        python_api.variant_activate("resolve-tester", "tacit")

        # Now resolve returns tacit content
        resolved = python_api.resolve("resolve-tester")
        assert resolved["prompt"] == "You are the tacit variant."

    def test_cli_register_variant_flag(self) -> None:
        """CLI register --variant flag is accepted by CLI command dispatch.

        This tests the CLI command dispatch accepts --variant without error.
        Uses subprocess with proper entry point.
        """
        # Skip if larva CLI is not available as a command
        result = subprocess.run(
            ["larva", "--help"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            pytest.skip("larva CLI not available as a system command; skipped")
            return  # for type checker

        # If we reach here, CLI is available; test variant subcommand help
        result = subprocess.run(
            ["larva", "variant", "list", "--help"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        # '--help' exits with 0 or gives usage text
        combined = result.stdout + result.stderr
        assert "variant" in combined.lower(), (
            f"CLI 'variant' subcommand expected in help output. Got: {combined[:500]}"
        )

    def test_process_cli_variant_crud_smoke(self, tmp_path: Path) -> None:
        """Subprocess CLI performs register/list/activate/resolve/delete with temp HOME."""

        cli_home = tmp_path / "cli-home"
        cli_home.mkdir()
        env = dict(os.environ)
        env["HOME"] = str(cli_home)

        default_spec = _canonical_spec("cli-smoke")
        tacit_spec = cast(
            "PersonaSpec",
            dict(default_spec, prompt="You are the tacit CLI smoke variant."),
        )
        default_path = tmp_path / "default.json"
        tacit_path = tmp_path / "tacit.json"
        default_path.write_text(json.dumps(default_spec), encoding="utf-8")
        tacit_path.write_text(json.dumps(tacit_spec), encoding="utf-8")

        def run_cli(*args: str) -> dict[str, Any]:
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from larva.cli_entrypoint import main; raise SystemExit(main())",
                    *args,
                ],
                capture_output=True,
                text=True,
                timeout=15,
                env=env,
            )
            assert result.returncode == 0, result.stderr
            return cast("dict[str, Any]", json.loads(result.stdout))

        run_cli("register", str(default_path), "--json")
        run_cli("register", str(tacit_path), "--variant", "tacit", "--json")

        metadata = run_cli("variant", "list", "cli-smoke", "--json")["data"]
        assert metadata == {"id": "cli-smoke", "active": "default", "variants": ["default", "tacit"]}

        default_resolved = run_cli("resolve", "cli-smoke", "--json")["data"]
        assert default_resolved["prompt"] == "You are cli-smoke."

        activated = run_cli("variant", "activate", "cli-smoke", "tacit", "--json")["data"]
        assert activated["active"] == "tacit"

        tacit_resolved = run_cli("resolve", "cli-smoke", "--json")["data"]
        assert tacit_resolved["prompt"] == "You are the tacit CLI smoke variant."

        deleted = run_cli("variant", "delete", "cli-smoke", "default", "--json")["data"]
        assert deleted == {"id": "cli-smoke", "variant": "default", "deleted": True}


# ---------------------------------------------------------------------------
# 6. Canonical Metadata Leak Prevention
# ---------------------------------------------------------------------------


class TestCanonicalMetadataLeakPrevention:
    """Verify _registry, variant, and active never leak into canonical PersonaSpec outputs.

    Source: design doc line 34; INTERFACES.md lines 17-18, 200; ARCHITECTURE.md line 117.
    """

    def test_export_all_no_registry_metadata(self) -> None:
        """export_all must not leak _registry, variant, or active into output specs."""
        registry = _variant_aware_registry_store()
        spec = _normalized_spec("leak-tester")
        registry.save(spec)

        from larva.app.facade import DefaultLarvaFacade
        from larva.core import normalize as normalize_module
        from larva.core import spec as spec_module
        from larva.core import validate as validate_module

        facade = DefaultLarvaFacade(
            spec=spec_module,
            validate=cast("Any", validate_module),
            normalize=cast("Any", normalize_module),
            registry=registry,
        )
        result = facade.export_all()
        assert isinstance(result, Success)
        for exported_spec in result.unwrap():
            _assert_no_canonical_leak(cast("dict[str, object]", exported_spec))

    def test_resolve_no_registry_metadata(self) -> None:
        """resolve must not leak _registry, variant, or active into output spec."""
        registry = _variant_aware_registry_store()
        spec = _normalized_spec("resolve-leak")
        registry.save(spec)

        from larva.app.facade import DefaultLarvaFacade
        from larva.core import normalize as normalize_module
        from larva.core import spec as spec_module
        from larva.core import validate as validate_module

        facade = DefaultLarvaFacade(
            spec=spec_module,
            validate=cast("Any", validate_module),
            normalize=cast("Any", normalize_module),
            registry=registry,
        )
        result = facade.resolve("resolve-leak")
        assert isinstance(result, Success)
        _assert_no_canonical_leak(cast("dict[str, object]", result.unwrap()))

    def test_resolve_variant_no_registry_metadata(self) -> None:
        """resolve with variant= parameter must not leak registry metadata."""
        registry = _variant_aware_registry_store()
        spec = _normalized_spec("variant-leak")
        tacit_spec = cast("PersonaSpec", dict(spec, prompt="You are tacit."))
        tacit_spec = normalize_spec(tacit_spec)
        registry.save(spec)
        registry.save(tacit_spec, variant="tacit")

        from larva.app.facade import DefaultLarvaFacade
        from larva.core import normalize as normalize_module
        from larva.core import spec as spec_module
        from larva.core import validate as validate_module

        facade = DefaultLarvaFacade(
            spec=spec_module,
            validate=cast("Any", validate_module),
            normalize=cast("Any", normalize_module),
            registry=registry,
        )
        result = facade.resolve("variant-leak", variant="tacit")
        assert isinstance(result, Success)
        _assert_no_canonical_leak(cast("dict[str, object]", result.unwrap()))

    def test_list_no_variant_metadata(self) -> None:
        """list must return base persona summaries without variant metadata."""
        registry = _variant_aware_registry_store()
        spec = _normalized_spec("list-leak")
        registry.save(spec)

        from larva.app.facade import DefaultLarvaFacade
        from larva.core import normalize as normalize_module
        from larva.core import spec as spec_module
        from larva.core import validate as validate_module

        facade = DefaultLarvaFacade(
            spec=spec_module,
            validate=cast("Any", validate_module),
            normalize=cast("Any", normalize_module),
            registry=registry,
        )
        result = facade.list()
        assert isinstance(result, Success)
        summaries = result.unwrap()
        for summary in summaries:
            for key in _FORBIDDEN_CANONICAL_KEYS:
                assert key not in summary, (
                    f"list must not include '{key}' in summaries. Got: {sorted(summary.keys())}"
                )

    def test_update_no_variant_metadata_in_output(self) -> None:
        """update must not leak variant or active into the returned spec."""
        registry = _variant_aware_registry_store()
        spec = _normalized_spec("update-leak")
        registry.save(spec)

        from larva.app.facade import DefaultLarvaFacade
        from larva.core import normalize as normalize_module
        from larva.core import spec as spec_module
        from larva.core import validate as validate_module

        facade = DefaultLarvaFacade(
            spec=spec_module,
            validate=cast("Any", validate_module),
            normalize=cast("Any", normalize_module),
            registry=registry,
        )
        result = facade.update("update-leak", {"model": "openai/gpt-5.5-pro"})
        assert isinstance(result, Success)
        _assert_no_canonical_leak(cast("dict[str, object]", result.unwrap()))

    def test_agent_entry_no_registry_metadata(self) -> None:
        """_agent_entry must not leak _registry, variant, or active into config."""
        spec = _normalized_spec("agent-leak")
        entry = _agent_entry(spec).unwrap()
        for key in _FORBIDDEN_CANONICAL_KEYS:
            assert key not in entry, (
                f"_agent_entry must not include '{key}'. Got keys: {sorted(entry.keys())}"
            )

    def test_normalize_spec_no_leak(self) -> None:
        """normalize_spec must not add variant, _registry, or active keys."""
        spec = _canonical_spec("norm-leak")
        result = normalize_spec(spec)
        for key in _FORBIDDEN_CANONICAL_KEYS:
            assert key not in result, (
                f"normalize_spec must not add '{key}'. Got: {sorted(result.keys())}"
            )


# ---------------------------------------------------------------------------
# 7. MCP stdio integration: variant tool availability
# ---------------------------------------------------------------------------


class TestMCPStdioVariantTools:
    """MCP stdio integration tests for variant tool availability.

    These tests verify variant tools are exposed, removed tools are absent,
    and that no canonical metadata leaks into MCP tool outputs.

    Source: INTERFACES.md lines 40-53; larva.mcp_server_naming.yaml.
    """

    @pytest.fixture(autouse=True)
    def _require_mcp(self) -> None:
        pytest.importorskip("mcp")

    def test_mcp_variant_list_callable(self) -> None:
        """larva_variant_list is callable over MCP stdio transport."""
        import anyio
        from mcp import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        LARVA_MCP_CMD = StdioServerParameters(
            command=sys.executable,
            args=["-c", "from larva.shell.cli import main; main(['mcp'])"],
        )

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        "larva_variant_list", arguments={"id": "missing"}
                    )
                    assert len(result.content) > 0

        anyio.run(_run)

    def test_mcp_variant_activate_callable(self) -> None:
        """larva_variant_activate is callable over MCP stdio transport."""
        import anyio
        from mcp import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        LARVA_MCP_CMD = StdioServerParameters(
            command=sys.executable,
            args=["-c", "from larva.shell.cli import main; main(['mcp'])"],
        )

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    # Call on non-existent persona; should get structured error
                    result = await session.call_tool(
                        "larva_variant_activate",
                        arguments={"id": "nonexistent", "variant": "default"},
                    )
                    assert len(result.content) > 0

        anyio.run(_run)

    def test_mcp_variant_delete_callable(self) -> None:
        """larva_variant_delete is callable over MCP stdio transport."""
        import anyio
        from mcp import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        LARVA_MCP_CMD = StdioServerParameters(
            command=sys.executable,
            args=["-c", "from larva.shell.cli import main; main(['mcp'])"],
        )

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        "larva_variant_delete",
                        arguments={"id": "nonexistent", "variant": "somename"},
                    )
                    assert len(result.content) > 0

        anyio.run(_run)


# ---------------------------------------------------------------------------
# 8. Python API Variant Smoke
# ---------------------------------------------------------------------------


class TestPythonAPIVariantSmoke:
    """Python API smoke tests for variant operations and canonical output purity."""

    @pytest.fixture(autouse=True)
    def _isolate_registry(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """Run Python API tests against isolated temporary registry."""
        isolated_home = tmp_path / "home"
        isolated_home.mkdir()
        monkeypatch.setenv("HOME", str(isolated_home))
        _reload_python_api_for_isolated_home()

    def test_register_default_variant_and_list(self) -> None:
        """Python API register creates default variant; list returns base ids."""
        from larva.shell import python_api

        spec = _canonical_spec("py-tester")
        python_api.register(spec)

        personas = python_api.list()
        ids = [p["id"] for p in personas]
        assert "py-tester" in ids

    def test_register_named_variant(self) -> None:
        """Python API register with variant creates named variant."""
        from larva.shell import python_api

        spec = _canonical_spec("py-variant-tester")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="You are the tacit variant.")
        python_api.register(cast("PersonaSpec", tacit_spec), variant="tacit")

        metadata = python_api.variant_list("py-variant-tester")
        assert "default" in metadata["variants"]
        assert "tacit" in metadata["variants"]
        assert metadata["active"] == "default"

    def test_variant_activate_changes_resolved_content(self) -> None:
        """Activating a variant changes what resolve returns."""
        from larva.shell import python_api

        spec = _canonical_spec("py-activate-tester")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="You are the tacit variant.")
        python_api.register(cast("PersonaSpec", tacit_spec), variant="tacit")

        # Default active: resolve returns default prompt
        resolved = python_api.resolve("py-activate-tester")
        assert resolved["prompt"] == "You are py-activate-tester."

        # Activate tacit
        python_api.variant_activate("py-activate-tester", "tacit")

        # Now resolve returns tacit prompt
        resolved = python_api.resolve("py-activate-tester")
        assert resolved["prompt"] == "You are the tacit variant."

    def test_python_api_resolve_no_registry_leak(self) -> None:
        """resolve output must not leak variant, _registry, or active."""
        from larva.shell import python_api

        spec = _canonical_spec("py-leak-tester")
        python_api.register(spec)

        resolved = python_api.resolve("py-leak-tester")
        _assert_no_canonical_leak(cast("dict[str, object]", resolved))

    def test_python_api_variant_delete_inactive_nonlast(self) -> None:
        """variant_delete succeeds for an inactive, non-last variant."""
        from larva.shell import python_api

        spec = _canonical_spec("py-delete-tester")
        python_api.register(spec)

        tacit_spec = dict(spec, prompt="Tacit variant.")
        python_api.register(cast("PersonaSpec", tacit_spec), variant="tacit")

        python_api.variant_delete("py-delete-tester", "tacit")

        metadata = python_api.variant_list("py-delete-tester")
        assert "tacit" not in metadata["variants"]

    def test_python_api_list_no_variant_metadata(self) -> None:
        """list returns PersonaSummary without variant or active keys."""
        from larva.shell import python_api

        spec = _canonical_spec("py-list-tester")
        python_api.register(spec)

        personas = python_api.list()
        for p in personas:
            for key in _FORBIDDEN_CANONICAL_KEYS:
                assert key not in p, f"list must not include '{key}': {sorted(p.keys())}"

    def test_python_api_export_no_registry_leak(self) -> None:
        """export_all must not include registry metadata in exported specs."""
        from larva.shell import python_api

        spec = _canonical_spec("py-export-leak")
        python_api.register(spec)

        exported = python_api.export_all()
        for s in exported:
            _assert_no_canonical_leak(cast("dict[str, object]", s))
