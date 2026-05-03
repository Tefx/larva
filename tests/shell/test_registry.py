"""Contract-driven tests for ``larva.shell.registry`` filesystem behavior.

These tests define expected shell-boundary behavior for FileSystemRegistryStore:
- save() persists canonical PersonaSpec and updates index.json digest mapping
- get() returns exact stored PersonaSpec by valid kebab-case id
- get() returns typed shell errors for missing/invalid personas
- list() returns complete canonical PersonaSpec records from registry boundary
- index/spec consistency violations return typed shell errors

Registry-local variant tests:
- manifest.json stores exactly {"active": "default"} for a valid persona
- variant specs live under <id>/variants/<variant>.json
- variant spec id must equal base persona id (directory name)
- corrupt/missing manifest => REGISTRY_CORRUPT
- missing active variant file => REGISTRY_CORRUPT
- invalid variant names are rejected with INVALID_VARIANT_NAME
- variant_activate uses same-directory write-then-rename
"""

from __future__ import annotations

import inspect
import json
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Literal, cast, get_args

import pytest
from returns.result import Failure, Success

from larva.shell.registry import (
    CLEAR_CONFIRMATION_TOKEN,
    INDEX_FILENAME,
    DeleteFailureError,
    FileSystemRegistryStore,
    InvalidConfirmError,
    RegistryError,
    RegistryStore,
)
from tests.shell.fixture_taxonomy import canonical_persona_spec

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _canonical_spec(persona_id: str, digest: str, model: str = "gpt-4o-mini") -> PersonaSpec:
    spec = dict(canonical_persona_spec(persona_id=persona_id, digest=digest, model=model))
    spec["prompt"] = f"You are {persona_id}"
    spec["capabilities"] = {"read": "read_only"}
    spec["compaction_prompt"] = "Summarize key facts."
    return cast("PersonaSpec", spec)


@pytest.fixture
def registry_root(tmp_path: Path) -> Path:
    root = tmp_path / ".larva" / "registry"
    root.mkdir(parents=True)
    return root


# ===========================================================================
# EXISTING FLAT-FILE REGISTRY TESTS (unchanged – keep baseline passing)
# ===========================================================================


class TestFileSystemRegistryStoreContract:
    def test_registry_error_includes_delete_failure_shape(self) -> None:
        assert DeleteFailureError in get_args(RegistryError)

    def test_registry_error_includes_invalid_confirm_error_shape(self) -> None:
        assert InvalidConfirmError in get_args(RegistryError)

    def test_registry_store_protocol_declares_delete_and_clear_contract_signatures(self) -> None:
        delete_signature = inspect.signature(RegistryStore.delete)
        clear_signature = inspect.signature(RegistryStore.clear)

        assert tuple(delete_signature.parameters) == ("self", "persona_id")
        assert tuple(clear_signature.parameters) == ("self", "confirm")
        assert clear_signature.parameters["confirm"].default == CLEAR_CONFIRMATION_TOKEN

    def test_registry_store_clear_contract_returns_int_count(self) -> None:
        clear_signature = inspect.signature(RegistryStore.clear)
        return_annotation = clear_signature.return_annotation

        # Result[int, RegistryError] -> extract the success type
        assert return_annotation == "Result[int, RegistryError]"

    def test_registry_store_contract_docstrings_pin_delete_and_clear_ordering(self) -> None:
        delete_doc = RegistryStore.delete.__doc__ or ""
        clear_doc = RegistryStore.clear.__doc__ or ""

        assert "Delete one persona directory" in delete_doc
        assert "Legacy flat-file records" in delete_doc
        assert "exactly equal ``CLEAR_CONFIRMATION_TOKEN``" in clear_doc
        assert "Partial deletion failures" in clear_doc

    def test_filesystem_clear_is_implemented(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(0)

    def test_save_persists_spec_to_registry_local_variant_layout(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec = _canonical_spec("ops-analyst", "sha256:ops-analyst")

        result = store.save(spec)

        assert result == Success(None)

        spec_path = registry_root / "ops-analyst" / "variants" / "default.json"
        manifest_path = registry_root / "ops-analyst" / "manifest.json"
        index_path = registry_root / INDEX_FILENAME
        assert spec_path.exists()
        assert manifest_path.exists()
        assert not index_path.exists()
        assert not (registry_root / "ops-analyst.json").exists()

        persisted_spec = json.loads(spec_path.read_text(encoding="utf-8"))
        persisted_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert persisted_spec == spec
        assert persisted_manifest == {"active": "default"}

    def test_save_preserves_explicit_null_values(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec_payload = dict(_canonical_spec("null-preserver", "sha256:null-preserver"))
        spec_payload["description"] = None
        spec_payload["model_params"] = {"temperature": None}
        spec = cast("PersonaSpec", spec_payload)

        result = store.save(spec)

        assert result == Success(None)
        persisted_spec = json.loads(
            (registry_root / "null-preserver" / "variants" / "default.json").read_text(
                encoding="utf-8"
            )
        )
        assert "description" in persisted_spec
        assert persisted_spec["description"] is None
        assert persisted_spec["model_params"]["temperature"] is None

    def test_save_rejects_empty_spec_digest(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec = _canonical_spec("empty-digest", "")

        result = store.save(spec)

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_WRITE_FAILED"
        assert error["persona_id"] == "empty-digest"
        assert "spec_digest" in error["message"]
        assert not (registry_root / "empty-digest.json").exists()
        assert not (registry_root / "empty-digest" / "variants" / "default.json").exists()

    def test_get_rejects_spec_with_empty_spec_digest(self, registry_root: Path) -> None:
        spec = _canonical_spec("bad-digest", "sha256:good")
        spec["spec_digest"] = ""
        _write_json(registry_root / "bad-digest.json", spec)

        store = FileSystemRegistryStore(root=registry_root)
        result = store.get("bad-digest")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert error["persona_id"] == "bad-digest"
        assert "spec_digest" in error["message"]

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("variant", "local"),
            ("_registry", {"source": "local"}),
            ("active", True),
            ("manifest", {"path": "personas.yaml"}),
        ],
    )
    def test_get_rejects_registry_metadata_fields_at_shell_boundary(
        self, registry_root: Path, field: str, value: object
    ) -> None:
        spec = dict(_canonical_spec("metadata-leak", "sha256:metadata-leak"))
        spec[field] = value
        _write_json(registry_root / "metadata-leak.json", spec)
        _write_json(registry_root / INDEX_FILENAME, {"metadata-leak": spec["spec_digest"]})

        store = FileSystemRegistryStore(root=registry_root)
        result = store.get("metadata-leak")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert error["persona_id"] == "metadata-leak"
        assert field in error["message"]
        assert "not permitted at canonical boundary" in error["message"]

    def test_get_returns_exact_stored_spec_for_valid_kebab_case_id(
        self, registry_root: Path
    ) -> None:
        spec = _canonical_spec("infra-reviewer", "sha256:infra-reviewer")
        _write_json(registry_root / "infra-reviewer.json", spec)
        _write_json(registry_root / INDEX_FILENAME, {"infra-reviewer": spec["spec_digest"]})

        store = FileSystemRegistryStore(root=registry_root)
        result = store.get("infra-reviewer")

        assert result == Success(spec)

    def test_get_returns_spec_when_index_file_is_missing(self, registry_root: Path) -> None:
        spec = _canonical_spec("indexless-agent", "sha256:indexless-agent")
        _write_json(registry_root / "indexless-agent.json", spec)

        store = FileSystemRegistryStore(root=registry_root)
        result = store.get("indexless-agent")

        assert result == Success(spec)

    def test_get_returns_spec_when_index_entry_is_missing(self, registry_root: Path) -> None:
        spec = _canonical_spec("stale-index-agent", "sha256:stale-index-agent")
        _write_json(registry_root / "stale-index-agent.json", spec)
        _write_json(registry_root / INDEX_FILENAME, {})

        store = FileSystemRegistryStore(root=registry_root)
        result = store.get("stale-index-agent")

        assert result == Success(spec)

    def test_get_missing_persona_returns_typed_persona_not_found_error(
        self,
        registry_root: Path,
    ) -> None:
        _write_json(registry_root / INDEX_FILENAME, {})
        store = FileSystemRegistryStore(root=registry_root)

        result = store.get("missing-persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["persona_id"] == "missing-persona"
        assert "missing-persona" in error["message"]

    def test_get_with_missing_index_returns_persona_not_found(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        result = store.get("missing-persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["persona_id"] == "missing-persona"

    def test_get_rejects_invalid_id_with_typed_shell_error(self, registry_root: Path) -> None:
        _write_json(registry_root / INDEX_FILENAME, {})
        store = FileSystemRegistryStore(root=registry_root)

        result = store.get("Invalid_Persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "INVALID_PERSONA_ID"
        assert error["persona_id"] == "Invalid_Persona"

    def test_list_returns_complete_canonical_specs_from_registry_boundary(
        self,
        registry_root: Path,
    ) -> None:
        spec_a = _canonical_spec("analysis-agent", "sha256:analysis-agent", model="gpt-4.1")
        spec_b = _canonical_spec("ops-agent", "sha256:ops-agent", model="gpt-4o")
        _write_json(registry_root / "analysis-agent.json", spec_a)
        _write_json(registry_root / "ops-agent.json", spec_b)
        _write_json(
            registry_root / INDEX_FILENAME,
            {
                "analysis-agent": spec_a["spec_digest"],
                "ops-agent": spec_b["spec_digest"],
            },
        )

        store = FileSystemRegistryStore(root=registry_root)
        result = store.list()

        assert isinstance(result, Success)
        specs = result.unwrap()
        by_id = {spec["id"]: spec for spec in specs}
        assert by_id == {"analysis-agent": spec_a, "ops-agent": spec_b}

    def test_list_with_missing_index_returns_empty_registry(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        result = store.list()

        assert result == Success([])

    def test_list_rejects_index_entry_with_empty_digest(self, registry_root: Path) -> None:
        spec = _canonical_spec("empty-index-digest", "sha256:actual")
        _write_json(registry_root / "empty-index-digest.json", spec)
        _write_json(registry_root / INDEX_FILENAME, {"empty-index-digest": ""})

        store = FileSystemRegistryStore(root=registry_root)
        result = store.list()

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert "digest" in error["message"].lower()

    def test_list_fails_with_typed_error_when_index_digest_disagrees_with_spec(
        self,
        registry_root: Path,
    ) -> None:
        spec = _canonical_spec("drifted-agent", "sha256:actual-digest")
        _write_json(registry_root / "drifted-agent.json", spec)
        _write_json(
            registry_root / INDEX_FILENAME,
            {"drifted-agent": "sha256:stale-digest"},
        )

        store = FileSystemRegistryStore(root=registry_root)
        result = store.list()

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert error["persona_id"] == "drifted-agent"
        assert "digest" in error["message"].lower()

    def test_list_fails_with_typed_error_when_index_references_missing_spec_file(
        self,
        registry_root: Path,
    ) -> None:
        _write_json(registry_root / INDEX_FILENAME, {"missing-agent": "sha256:missing-agent"})
        store = FileSystemRegistryStore(root=registry_root)

        result = store.list()

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_SPEC_READ_FAILED"
        assert error["persona_id"] == "missing-agent"
        assert error["path"].endswith("missing-agent.json")

    def test_save_rolls_back_spec_when_manifest_update_fails(
        self, registry_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec = _canonical_spec("rollback-agent", "sha256:updated")

        original_write_json_atomic = store._write_json_atomic

        def fail_index_write(
            path: Path,
            payload: object,
            kind: Literal["spec", "index", "manifest"],
            persona_id: str,
        ) -> object:
            if kind == "manifest":
                return Failure(
                    {
                        "code": "REGISTRY_UPDATE_FAILED",
                        "message": "simulated manifest update failure",
                        "persona_id": persona_id,
                        "path": str(path),
                    }
                )
            return original_write_json_atomic(path, payload, kind, persona_id)

        monkeypatch.setattr(store, "_write_json_atomic", fail_index_write)

        result = store.save(spec)

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_UPDATE_FAILED"
        assert "manifest" in error["path"]

        assert not (registry_root / "rollback-agent" / "variants" / "default.json").exists()

    # ========== DELETE CONTRACT TESTS ==========

    def test_delete_success(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec = _canonical_spec("delete-target", "sha256:delete-target")

        save_result = store.save(spec)
        assert save_result == Success(None)

        spec_path = registry_root / "delete-target" / "variants" / "default.json"
        index_path = registry_root / INDEX_FILENAME

        assert spec_path.exists()
        assert spec_path.read_text(encoding="utf-8")
        assert not index_path.exists()

        delete_result = store.delete("delete-target")

        assert delete_result == Success(None)
        assert not spec_path.exists()
        assert not (registry_root / "delete-target").exists()

    def test_delete_not_found(self, registry_root: Path) -> None:
        _write_json(registry_root / INDEX_FILENAME, {})
        store = FileSystemRegistryStore(root=registry_root)

        result = store.delete("missing-persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["persona_id"] == "missing-persona"

    def test_delete_invalid_id(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        result = store.delete("Invalid_Persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "INVALID_PERSONA_ID"
        assert error["persona_id"] == "Invalid_Persona"

        assert not (registry_root / "Invalid_Persona.json").exists()
        assert not (registry_root / INDEX_FILENAME).exists()

    def test_delete_index_write_failure(
        self, registry_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        spec = _canonical_spec("delete-index-fail", "sha256:delete-index-fail")
        _write_json(registry_root / "delete-index-fail.json", spec)
        _write_json(
            registry_root / INDEX_FILENAME, {"delete-index-fail": "sha256:delete-index-fail"}
        )

        store = FileSystemRegistryStore(root=registry_root)

        original_write_json_atomic = store._write_json_atomic

        def fail_index_write(
            path: Path,
            payload: object,
            kind: Literal["spec", "index"],
            persona_id: str,
        ) -> object:
            if kind == "index":
                return Failure(
                    {
                        "code": "REGISTRY_UPDATE_FAILED",
                        "message": "simulated index write failure during delete",
                        "persona_id": persona_id,
                        "path": str(path),
                    }
                )
            return original_write_json_atomic(path, payload, kind, persona_id)

        monkeypatch.setattr(store, "_write_json_atomic", fail_index_write)

        result = store.delete("delete-index-fail")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_UPDATE_FAILED"

        assert (registry_root / "delete-index-fail.json").exists()

        index_data = json.loads((registry_root / INDEX_FILENAME).read_text(encoding="utf-8"))
        assert index_data == {"delete-index-fail": "sha256:delete-index-fail"}

    def test_delete_spec_unlink_failure(
        self, registry_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        spec = _canonical_spec("delete-unlink-fail", "sha256:delete-unlink-fail")
        _write_json(registry_root / "delete-unlink-fail.json", spec)
        _write_json(
            registry_root / INDEX_FILENAME, {"delete-unlink-fail": "sha256:delete-unlink-fail"}
        )

        store = FileSystemRegistryStore(root=registry_root)

        def fail_unlink_with_oserror(self: Path) -> None:
            raise OSError("simulated unlink failure")

        monkeypatch.setattr(Path, "unlink", fail_unlink_with_oserror)

        result = store.delete("delete-unlink-fail")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_DELETE_FAILED"
        assert error["operation"] == "delete"
        assert error["persona_id"] == "delete-unlink-fail"
        assert any("delete-unlink-fail.json" in p for p in error["failed_spec_paths"])

        assert (registry_root / "delete-unlink-fail.json").exists()

        index_data = json.loads((registry_root / INDEX_FILENAME).read_text(encoding="utf-8"))
        assert index_data == {"delete-unlink-fail": "sha256:delete-unlink-fail"}

    # ========== CLEAR CONTRACT TESTS ==========

    def test_clear_wrong_confirm(self, registry_root: Path) -> None:
        _write_json(registry_root / INDEX_FILENAME, {})
        store = FileSystemRegistryStore(root=registry_root)

        result = store.clear(confirm="WRONG TOKEN")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "INVALID_CONFIRMATION_TOKEN"
        assert (registry_root / INDEX_FILENAME).exists()

    def test_clear_empty_registry(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(0)

    def test_clear_success(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        for name in ("clear-a", "clear-b", "clear-c"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        for name in ("clear-a", "clear-b", "clear-c"):
            assert (registry_root / name / "variants" / "default.json").exists()
        assert not (registry_root / INDEX_FILENAME).exists()

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(3)
        for name in ("clear-a", "clear-b", "clear-c"):
            assert not (registry_root / name).exists()
        assert not (registry_root / INDEX_FILENAME).exists()

    def test_clear_partial_failure(
        self, registry_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        for name in ("partial-a", "partial-b", "partial-c"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        removed_dirs: list[str] = []
        import larva.shell.registry as registry_module

        original_rmtree = registry_module.shutil.rmtree

        def fail_on_partial_b(path: Path, *_args: object, **_kwargs: object) -> None:
            if "partial-b" in str(path):
                raise OSError("simulated rmtree failure for partial-b")
            removed_dirs.append(str(path))
            original_rmtree(path)

        monkeypatch.setattr(registry_module.shutil, "rmtree", fail_on_partial_b)

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_DELETE_FAILED"
        assert error["operation"] == "clear"
        assert error["persona_id"] is None
        failed_paths: list[str] = error["failed_spec_paths"]
        assert any("partial-b" in p for p in failed_paths)
        assert not (registry_root / INDEX_FILENAME).exists()
        assert any("partial-a" in f for f in removed_dirs)
        assert any("partial-c" in f for f in removed_dirs)
        assert (registry_root / "partial-b").exists()

    def test_clear_returns_correct_count(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        for name in ("count-a", "count-b"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        expected_count = len([path for path in registry_root.iterdir() if path.is_dir()])
        assert expected_count == 2

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(expected_count)


# ===========================================================================
# REGISTRY-LOCAL VARIANT TESTS (implemented registry-local variant contract)
# ===========================================================================


class TestRegistryVariantStorageLayout:
    """Registry-local variant layout: manifest.json + variants/*.json.

    These tests verify the filesystem contract for implemented variant storage:
    <id>/manifest.json stores the active variant pointer and
    <id>/variants/<variant>.json stores each canonical PersonaSpec.
    """

    @pytest.fixture
    def variant_root(self, tmp_path: Path) -> Path:
        root = tmp_path / ".larva" / "registry"
        root.mkdir(parents=True)
        return root

    def _make_spec(self, persona_id: str, model: str = "gpt-4o-mini") -> PersonaSpec:
        """Create a canonical spec with a valid digest for the given persona_id."""
        import hashlib

        spec: PersonaSpec = {
            "id": persona_id,
            "description": f"Persona {persona_id}",
            "prompt": f"You are {persona_id}",
            "model": model,
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        payload = {k: v for k, v in spec.items() if k != "spec_digest"}
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        spec["spec_digest"] = f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"
        return spec

    def _write_persona_dir(
        self,
        root: Path,
        persona_id: str,
        active: str,
        variants: dict[str, PersonaSpec],
    ) -> None:
        """Write a complete persona directory with manifest.json and variants."""
        persona_dir = root / persona_id
        persona_dir.mkdir(parents=True, exist_ok=True)
        _write_json(persona_dir / "manifest.json", {"active": active})
        variants_dir = persona_dir / "variants"
        variants_dir.mkdir(exist_ok=True)
        for variant_name, spec in variants.items():
            _write_json(variants_dir / f"{variant_name}.json", spec)

    def test_manifest_json_stores_exactly_active_pointer(self, variant_root: Path) -> None:
        """manifest.json contains exactly {"active": "default"}, no extra keys."""
        store = FileSystemRegistryStore(root=variant_root)
        spec = self._make_spec("manifest-check")
        # Register creates <id>/manifest.json with {"active": "default"}.
        result = store.save(spec)
        assert isinstance(result, (Success, Failure))

        manifest = variant_root / "manifest-check" / "manifest.json"
        assert manifest.exists(), (
            "Expected ~./larva/registry/<id>/manifest.json to exist after register; "
            "registry-local variants require the manifest-backed directory layout"
        )
        manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
        assert manifest_data == {"active": "default"}

    def test_variant_spec_id_must_equal_base_persona_id(self, variant_root: Path) -> None:
        """Every variants/<variant>.json must have spec.id == <persona-dir-name>."""
        self._write_persona_dir(
            variant_root,
            "code-reviewer",
            "default",
            {
                "default": self._make_spec("code-reviewer"),
                "tacit": self._make_spec("code-reviewer", model="gpt-4.1"),
            },
        )

        store = FileSystemRegistryStore(root=variant_root)
        # When resolving a variant, the spec.id must equal the base persona id
        result = store.get("code-reviewer")

        assert result == Success(self._make_spec("code-reviewer"))

    def test_corrupt_manifest_returns_registry_corrupt(self, variant_root: Path) -> None:
        """Missing or malformed manifest.json must produce REGISTRY_CORRUPT."""
        persona_dir = variant_root / "corrupt-persona"
        persona_dir.mkdir(parents=True)
        variants_dir = persona_dir / "variants"
        variants_dir.mkdir()
        # Write variant but NO manifest
        _write_json(variants_dir / "default.json", self._make_spec("corrupt-persona"))

        store = FileSystemRegistryStore(root=variant_root)
        result = store.get("corrupt-persona")

        # Expected: REGISTRY_CORRUPT error; current code will give
        # PERSONA_NOT_FOUND (different error code)
        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_CORRUPT", (
            f"Expected REGISTRY_CORRUPT for missing manifest, got {error['code']}"
        )

    def test_malformed_manifest_returns_registry_corrupt(self, variant_root: Path) -> None:
        """manifest.json with wrong shape must produce REGISTRY_CORRUPT."""

        persona_dir = variant_root / "malformed-persona"
        persona_dir.mkdir(parents=True)
        variants_dir = persona_dir / "variants"
        variants_dir.mkdir()
        spec = self._make_spec("malformed-persona")
        _write_json(variants_dir / "default.json", spec)
        # Malformed manifest: missing "active" key
        _write_json(persona_dir / "manifest.json", {"version": "1.0"})

        store = FileSystemRegistryStore(root=variant_root)
        result = store.get("malformed-persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_CORRUPT", (
            f"Expected REGISTRY_CORRUPT for malformed manifest, got {error['code']}"
        )

    def test_active_pointer_to_missing_variant_returns_registry_corrupt(
        self, variant_root: Path
    ) -> None:
        """manifest.json pointing to nonexistent variant file => REGISTRY_CORRUPT."""
        persona_dir = variant_root / "dangling-persona"
        persona_dir.mkdir(parents=True)
        variants_dir = persona_dir / "variants"
        variants_dir.mkdir()
        spec = self._make_spec("dangling-persona")
        _write_json(variants_dir / "default.json", spec)
        # Manifest points to a variant that doesn't exist on disk
        _write_json(persona_dir / "manifest.json", {"active": "vanished"})

        store = FileSystemRegistryStore(root=variant_root)
        result = store.get("dangling-persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_CORRUPT", (
            f"Expected REGISTRY_CORRUPT for active pointing to missing variant, got {error['code']}"
        )

    def test_no_auto_invent_manifest(self, variant_root: Path) -> None:
        """If manifest.json is absent, larva must NOT auto-invent one."""
        persona_dir = variant_root / "no-auto-invent"
        persona_dir.mkdir(parents=True)
        variants_dir = persona_dir / "variants"
        variants_dir.mkdir()
        spec = self._make_spec("no-auto-invent")
        _write_json(variants_dir / "default.json", spec)
        # No manifest.json at all

        store = FileSystemRegistryStore(root=variant_root)
        result = store.get("no-auto-invent")

        # Must be REGISTRY_CORRUPT, not auto-heal or auto-generate
        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_CORRUPT"
        # Verify manifest was NOT auto-created
        assert not (persona_dir / "manifest.json").exists()

    def test_list_uses_directory_scan_not_index_json_for_variant_records(
        self, variant_root: Path
    ) -> None:
        """Variant records enumerate from persona directories, not legacy index.json."""
        store = FileSystemRegistryStore(root=variant_root)
        spec = self._make_spec("scan-source")

        assert store.save(spec) == Success(None)
        _write_json(variant_root / INDEX_FILENAME, {"stale-entry": "sha256:stale"})

        result = store.list()

        assert isinstance(result, Success)
        assert result.unwrap() == [spec]


class TestRegistryVariantInvalidName:
    """Variant name validation: must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be <= 64 chars.

    These tests verify that invalid variant names are rejected before registry
    writes and that the maximum-length valid kebab-case name is accepted.
    """

    @pytest.fixture
    def variant_root(self, tmp_path: Path) -> Path:
        root = tmp_path / ".larva" / "registry"
        root.mkdir(parents=True)
        return root

    @pytest.mark.parametrize(
        "invalid_name",
        [
            "UPPERCASE",  # uppercase letters
            "with_underscore",  # underscore
            "with.dot",  # dot
            "with/slash",  # path separator
            "with space",  # space
            "",  # empty string
            "a" * 65,  # too long (>64 chars)
            "..",  # double dot traversal
        ],
    )
    def test_invalid_variant_name_rejected(self, invalid_name: str) -> None:
        """Invalid variant names must produce INVALID_VARIANT_NAME error.

        This test calls the registry save method with an invalid variant name.
        """
        root = Path("/")
        store = FileSystemRegistryStore(root=root)
        result = store.save(
            _canonical_spec("variant-name-check", "sha256:variant"), variant=invalid_name
        )

        assert isinstance(result, Failure)
        assert result.failure()["code"] == "INVALID_VARIANT_NAME"

    def test_variant_name_exactly_64_chars_accepted(self) -> None:
        """A variant name of exactly 64 lowercase kebab chars must be accepted."""
        name_64 = "a" * 64
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "registry"
            store = FileSystemRegistryStore(root=root)
            result = store.save(
                _canonical_spec("variant-name-ok", "sha256:variant-ok"), variant=name_64
            )
            assert result == Success(None)
            assert (root / "variant-name-ok" / "variants" / f"{name_64}.json").exists()


class TestRegistryVariantActivate:
    """variant_activate uses same-directory write-then-rename for manifest.json.

    Activation switches the manifest active pointer without rewriting specs.
    """

    @pytest.fixture
    def variant_root(self, tmp_path: Path) -> Path:
        root = tmp_path / ".larva" / "registry"
        root.mkdir(parents=True)
        return root

    def test_variant_activate_writes_manifest_atomically(self, variant_root: Path) -> None:
        """Activation must write manifest.json using same-dir write-then-rename."""
        store = FileSystemRegistryStore(root=variant_root)
        assert store.save(_canonical_spec("activate-target", "sha256:default")) == Success(None)
        assert store.save(
            _canonical_spec("activate-target", "sha256:tacit"), variant="tacit"
        ) == Success(None)

        result = store.variant_activate("activate-target", "tacit")

        assert isinstance(result, Success)
        manifest = json.loads(
            (variant_root / "activate-target" / "manifest.json").read_text(encoding="utf-8")
        )
        assert manifest == {"active": "tacit"}

    def test_variant_activate_returns_id_and_active(self) -> None:
        """variant_activate returns {id, active} on success."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "registry"
            store = FileSystemRegistryStore(root=root)
            assert store.save(_canonical_spec("activate-shape", "sha256:default")) == Success(None)
            assert store.save(
                _canonical_spec("activate-shape", "sha256:tacit"), variant="tacit"
            ) == Success(None)

            result = store.variant_activate("activate-shape", "tacit")

        assert isinstance(result, Success)
        assert result.unwrap()["id"] == "activate-shape"
        assert result.unwrap()["active"] == "tacit"


class TestRegistryVariantDelete:
    """variant_delete: reject active, reject last variant, accept inactive.

    Deletion preserves active and last-variant invariants.
    """

    def test_variant_delete_active_variant_rejected(self) -> None:
        """Deleting the active variant must produce ACTIVE_VARIANT_DELETE_FORBIDDEN."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = FileSystemRegistryStore(root=Path(tmp_dir) / "registry")
            assert store.save(_canonical_spec("active-delete", "sha256:default")) == Success(None)
            assert store.save(
                _canonical_spec("active-delete", "sha256:tacit"), variant="tacit"
            ) == Success(None)
            result = store.variant_delete("active-delete", "default")
        assert isinstance(result, Failure)
        assert result.failure()["code"] == "ACTIVE_VARIANT_DELETE_FORBIDDEN"

    def test_variant_delete_last_variant_rejected(self) -> None:
        """Deleting the last remaining variant must produce LAST_VARIANT_DELETE_FORBIDDEN."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = FileSystemRegistryStore(root=Path(tmp_dir) / "registry")
            assert store.save(_canonical_spec("last-delete", "sha256:default")) == Success(None)
            result = store.variant_delete("last-delete", "default")
        assert isinstance(result, Failure)
        assert result.failure()["code"] == "LAST_VARIANT_DELETE_FORBIDDEN"

    def test_variant_delete_inactive_variant_succeeds(self) -> None:
        """Deleting an inactive non-last variant returns {id, variant, deleted: true}."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "registry"
            store = FileSystemRegistryStore(root=root)
            assert store.save(_canonical_spec("inactive-delete", "sha256:default")) == Success(None)
            assert store.save(
                _canonical_spec("inactive-delete", "sha256:tacit"), variant="tacit"
            ) == Success(None)

            result = store.variant_delete("inactive-delete", "tacit")

            assert result == Success(None)
            assert not (root / "inactive-delete" / "variants" / "tacit.json").exists()

    def test_variant_delete_base_persona_removes_directory(self) -> None:
        """Deleting the base persona removes the entire directory including all variants."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "registry"
            store = FileSystemRegistryStore(root=root)
            assert store.save(_canonical_spec("base-delete", "sha256:default")) == Success(None)
            assert store.save(
                _canonical_spec("base-delete", "sha256:tacit"), variant="tacit"
            ) == Success(None)

            result = store.delete("base-delete")

            assert result == Success(None)
            assert not (root / "base-delete").exists()

    def test_variant_delete_invalid_name_rejected_before_lookup(self) -> None:
        """Malformed variant names produce INVALID_VARIANT_NAME, not VARIANT_NOT_FOUND."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            store = FileSystemRegistryStore(root=Path(tmp_dir) / "registry")
            assert store.save(_canonical_spec("invalid-delete", "sha256:default")) == Success(None)

            result = store.variant_delete("invalid-delete", "bad_variant")

        assert isinstance(result, Failure)
        assert result.failure()["code"] == "INVALID_VARIANT_NAME"
