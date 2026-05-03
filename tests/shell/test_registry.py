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

        assert "no dangling index entry" in delete_doc
        assert "best-effort rollback" in delete_doc
        assert "exactly equal ``CLEAR_CONFIRMATION_TOKEN``" in clear_doc
        assert "Partial spec-file deletion failures" in clear_doc

    def test_filesystem_clear_is_implemented(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(0)

    def test_save_persists_spec_and_updates_index_digest_mapping(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec = _canonical_spec("ops-analyst", "sha256:ops-analyst")

        result = store.save(spec)

        assert result == Success(None)

        spec_path = registry_root / "ops-analyst.json"
        index_path = registry_root / INDEX_FILENAME
        assert spec_path.exists()
        assert index_path.exists()

        persisted_spec = json.loads(spec_path.read_text(encoding="utf-8"))
        persisted_index = json.loads(index_path.read_text(encoding="utf-8"))
        assert persisted_spec == spec
        assert persisted_index == {"ops-analyst": "sha256:ops-analyst"}

    def test_save_preserves_explicit_null_values(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec_payload = dict(_canonical_spec("null-preserver", "sha256:null-preserver"))
        spec_payload["description"] = None
        spec_payload["model_params"] = {"temperature": None}
        spec = cast("PersonaSpec", spec_payload)

        result = store.save(spec)

        assert result == Success(None)
        persisted_spec = json.loads(
            (registry_root / "null-preserver.json").read_text(encoding="utf-8")
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

    def test_save_rolls_back_spec_when_index_update_fails(
        self, registry_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        initial = _canonical_spec("rollback-agent", "sha256:original")
        _write_json(registry_root / "rollback-agent.json", initial)
        _write_json(registry_root / INDEX_FILENAME, {"rollback-agent": "sha256:original"})

        store = FileSystemRegistryStore(root=registry_root)
        updated = _canonical_spec("rollback-agent", "sha256:updated")

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
                        "message": "simulated index update failure",
                        "persona_id": persona_id,
                        "path": str(path),
                    }
                )
            return original_write_json_atomic(path, payload, kind, persona_id)

        monkeypatch.setattr(store, "_write_json_atomic", fail_index_write)

        result = store.save(updated)

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_UPDATE_FAILED"
        assert "index" in error["path"]

        persisted_spec = json.loads(
            (registry_root / "rollback-agent.json").read_text(encoding="utf-8")
        )
        persisted_index = json.loads((registry_root / INDEX_FILENAME).read_text(encoding="utf-8"))
        assert persisted_spec == initial
        assert persisted_index == {"rollback-agent": "sha256:original"}

    # ========== DELETE CONTRACT TESTS ==========

    def test_delete_success(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)
        spec = _canonical_spec("delete-target", "sha256:delete-target")

        save_result = store.save(spec)
        assert save_result == Success(None)

        spec_path = registry_root / "delete-target.json"
        index_path = registry_root / INDEX_FILENAME

        assert spec_path.exists()
        assert spec_path.read_text(encoding="utf-8")
        assert index_path.exists()
        index_before = json.loads(index_path.read_text(encoding="utf-8"))
        assert index_before == {"delete-target": "sha256:delete-target"}

        delete_result = store.delete("delete-target")

        assert delete_result == Success(None)
        assert not spec_path.exists()

        index_after = json.loads(index_path.read_text(encoding="utf-8"))
        assert "delete-target" not in index_after

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
            assert (registry_root / f"{name}.json").exists()
        assert (registry_root / INDEX_FILENAME).exists()

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(3)
        for name in ("clear-a", "clear-b", "clear-c"):
            assert not (registry_root / f"{name}.json").exists()
        assert not (registry_root / INDEX_FILENAME).exists()

    def test_clear_partial_failure(
        self, registry_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        for name in ("partial-a", "partial-b", "partial-c"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        unlinked_files: list[str] = []
        original_unlink = Path.unlink

        def fail_on_partial_b(self: Path, *args: object, **kwargs: object) -> None:
            if "partial-b" in str(self):
                raise OSError("simulated unlink failure for partial-b")
            unlinked_files.append(str(self))
            original_unlink(self)

        monkeypatch.setattr(Path, "unlink", fail_on_partial_b)

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "REGISTRY_DELETE_FAILED"
        assert error["operation"] == "clear"
        assert error["persona_id"] is None
        failed_paths: list[str] = error["failed_spec_paths"]
        assert any("partial-b" in p for p in failed_paths)
        assert not (registry_root / INDEX_FILENAME).exists()
        assert any("partial-a" in f for f in unlinked_files)
        assert any("partial-c" in f for f in unlinked_files)
        assert (registry_root / "partial-b.json").exists()

    def test_clear_returns_correct_count(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        for name in ("count-a", "count-b"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        index_before = json.loads((registry_root / INDEX_FILENAME).read_text(encoding="utf-8"))
        expected_count = len(index_before)
        assert expected_count == 2

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(expected_count)


# ===========================================================================
# REGISTRY-LOCAL VARIANT TESTS (expected red until implementation lands)
# ===========================================================================


class TestRegistryVariantStorageLayout:
    """Registry-local variant layout: manifest.json + variants/*.json.

    These tests define the target-state filesystem contract for variant storage.
    They are expected-RED because the current FileSystemRegistryStore uses
    flat <id>.json files with index.json, not the new <id>/manifest.json +
    <id>/variants/<variant>.json layout.
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
        # The target design: register creates <id>/manifest.json with {"active": "default"}
        result = store.save(spec)
        assert isinstance(result, Success) or isinstance(result, Failure)

        manifest = variant_root / "manifest-check" / "manifest.json"
        # This test will RED because current code creates flat <id>.json + index.json,
        # not the new directory layout with manifest.json
        assert manifest.exists(), (
            "Expected ~./larva/registry/<id>/manifest.json to exist after register; "
            "current implementation uses flat <id>.json + index.json"
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

        # Current code has no concept of variants; this will fail
        assert isinstance(result, Failure), (
            "Expected REGISTRY_CORRUPT or redesign; current implementation "
            "does not support variant directory layout"
        )

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
        import hashlib

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


class TestRegistryVariantInvalidName:
    """Variant name validation: must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be <= 64 chars.

    These tests are expected-RED because the current facade does not accept
    a variant parameter and the registry has no variant name validation.
    """

    @pytest.fixture
    def variant_root(self, tmp_path: Path) -> Path:
        root = tmp_path / ".larva" / "registry"
        root.mkdir(parents=True)
        return root

    @pytest.mark.parametrize(
        "invalid_name",
        [
            "UPPERCASE",       # uppercase letters
            "with_underscore", # underscore
            "with.dot",         # dot
            "with/slash",      # path separator
            "with space",      # space
            "",                # empty string
            "a" * 65,          # too long (>64 chars)
            "..",              # double dot traversal
        ],
    )
    def test_invalid_variant_name_rejected(self, invalid_name: str) -> None:
        """Invalid variant names must produce INVALID_VARIANT_NAME error.

        This test calls the register facade method with an invalid variant
        name, which does not exist in the current API.
        """
        # The current facade.register() does not accept a variant parameter.
        # When the variant-aware register(spec, variant=...) is added,
        # passing an invalid variant name must produce INVALID_VARIANT_NAME.
        pytest.xfail(
            "register(spec, variant=...) does not exist yet; "
            f"INVALID_VARIANT_NAME for '{invalid_name[:20]}...' expected after implementation"
        )

    def test_variant_name_exactly_64_chars_accepted(self) -> None:
        """A variant name of exactly 64 lowercase kebab chars must be accepted."""
        name_64 = "a" * 64
        # Will xfail because variant parameter doesn't exist yet
        pytest.xfail(
            f"register(spec, variant='{name_64}') does not exist yet; "
            "expected to accept 64-char variant names after implementation"
        )


class TestRegistryVariantActivate:
    """variant_activate uses same-directory write-then-rename for manifest.json.

    Expected-RED because variant_activate does not exist yet.
    """

    @pytest.fixture
    def variant_root(self, tmp_path: Path) -> Path:
        root = tmp_path / ".larva" / "registry"
        root.mkdir(parents=True)
        return root

    def test_variant_activate_writes_manifest_atomically(self, variant_root: Path) -> None:
        """Activation must write manifest.json using same-dir write-then-rename."""
        pytest.xfail(
            "variant_activate does not exist yet; "
            "expected to test atomic manifest write after implementation"
        )

    def test_variant_activate_returns_id_and_active(self) -> None:
        """variant_activate returns {id, active} on success."""
        pytest.xfail(
            "variant_activate does not exist yet; "
            "expected to return {id, active} after implementation"
        )


class TestRegistryVariantDelete:
    """variant_delete: reject active, reject last variant, accept inactive.

    Expected-RED because variant_delete does not exist yet.
    """

    def test_variant_delete_active_variant_rejected(self) -> None:
        """Deleting the active variant must produce ACTIVE_VARIANT_DELETE_FORBIDDEN."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "ACTIVE_VARIANT_DELETE_FORBIDDEN expected after implementation"
        )

    def test_variant_delete_last_variant_rejected(self) -> None:
        """Deleting the last remaining variant must produce LAST_VARIANT_DELETE_FORBIDDEN."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "LAST_VARIANT_DELETE_FORBIDDEN expected after implementation"
        )

    def test_variant_delete_inactive_variant_succeeds(self) -> None:
        """Deleting an inactive non-last variant returns {id, variant, deleted: true}."""
        pytest.xfail(
            "variant_delete does not exist yet; "
            "successful inactive variant deletion expected after implementation"
        )

    def test_variant_delete_base_persona_removes_directory(self) -> None:
        """Deleting the base persona removes the entire directory including all variants."""
        pytest.xfail(
            "delete(persona_id) with variants does not exist yet; "
            "expected to remove full <id>/ directory after implementation"
        )