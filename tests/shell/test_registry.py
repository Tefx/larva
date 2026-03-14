"""Contract-driven tests for ``larva.shell.registry`` filesystem behavior.

These tests define expected shell-boundary behavior for FileSystemRegistryStore:
- save() persists canonical PersonaSpec and updates index.json digest mapping
- get() returns exact stored PersonaSpec by valid kebab-case id
- get() returns typed shell errors for missing/invalid personas
- list() returns complete canonical PersonaSpec records from registry boundary
- index/spec consistency violations return typed shell errors
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

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _canonical_spec(persona_id: str, digest: str, model: str = "gpt-4o-mini") -> PersonaSpec:
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": f"You are {persona_id}",
        "model": model,
        "tools": {"read": "read_only"},
        "model_params": {"temperature": 0.1},
        "side_effect_policy": "read_only",
        "can_spawn": False,
        "compaction_prompt": "Summarize key facts.",
        "spec_version": "0.1.0",
        "spec_digest": digest,
    }


@pytest.fixture
def registry_root(tmp_path: Path) -> Path:
    root = tmp_path / ".larva" / "registry"
    root.mkdir(parents=True)
    return root


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

    def test_filesystem_clear_is_acceptance_only_stub(self, registry_root: Path) -> None:
        store = FileSystemRegistryStore(root=registry_root)

        with pytest.raises(NotImplementedError):
            store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

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

    # ========== DELETE CONTRACT TESTS (xfail until implementation) ==========

    def test_delete_success(self, registry_root: Path) -> None:
        """save a persona, then delete it; confirm spec file gone and index entry removed."""
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
        """delete non-existent id; confirm PERSONA_NOT_FOUND failure."""
        _write_json(registry_root / INDEX_FILENAME, {})
        store = FileSystemRegistryStore(root=registry_root)

        result = store.delete("missing-persona")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["persona_id"] == "missing-persona"

    def test_delete_invalid_id(self, registry_root: Path) -> None:
        """invalid id returns INVALID_PERSONA_ID and performs no filesystem access."""
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
        """_write_json_atomic fails during index write; spec file remains untouched and index remains readable."""
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
        """spec_path.unlink raises OSError; rollback restores the prior index entry and reports REGISTRY_DELETE_FAILED."""
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
        """Wrong confirm string returns Failure and does not touch filesystem."""
        _write_json(registry_root / INDEX_FILENAME, {})
        store = FileSystemRegistryStore(root=registry_root)

        result = store.clear(confirm="WRONG TOKEN")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "INVALID_CONFIRMATION_TOKEN"
        # Filesystem untouched - index still exists
        assert (registry_root / INDEX_FILENAME).exists()

    def test_clear_empty_registry(self, registry_root: Path) -> None:
        """Clear on empty registry returns Success(0)."""
        store = FileSystemRegistryStore(root=registry_root)

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(0)

    def test_clear_success(self, registry_root: Path) -> None:
        """Clear 2-3 saved personas; all spec files gone, index gone, returned count matches."""
        store = FileSystemRegistryStore(root=registry_root)

        # Save 3 personas
        for name in ("clear-a", "clear-b", "clear-c"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        # Verify all files exist before clear
        for name in ("clear-a", "clear-b", "clear-c"):
            assert (registry_root / f"{name}.json").exists()
        assert (registry_root / INDEX_FILENAME).exists()

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(3)
        # All spec files gone
        for name in ("clear-a", "clear-b", "clear-c"):
            assert not (registry_root / f"{name}.json").exists()
        # Index gone (empty registry = no index file)
        assert not (registry_root / INDEX_FILENAME).exists()

    def test_clear_partial_failure(
        self, registry_root: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """One spec unlink raises OSError; failure reports failed ids while index removal still occurs."""
        store = FileSystemRegistryStore(root=registry_root)

        # Save 3 personas
        for name in ("partial-a", "partial-b", "partial-c"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        # Track which files have been unlinked
        unlinked_files: list[str] = []

        original_unlink = Path.unlink

        def fail_on_partial_b(self: Path, *args: object, **kwargs: object) -> None:
            # Record the file path being unlinked
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
        # failed_spec_paths should contain partial-b
        failed_paths: list[str] = error["failed_spec_paths"]
        assert any("partial-b" in p for p in failed_paths)
        # Index should be removed (clear proceeds even if some unlinks fail)
        assert not (registry_root / INDEX_FILENAME).exists()
        # partial-a and partial-c should be unlinked
        assert any("partial-a" in f for f in unlinked_files)
        assert any("partial-c" in f for f in unlinked_files)
        # partial-b should still exist (failed to unlink)
        assert (registry_root / "partial-b.json").exists()

    def test_clear_returns_correct_count(self, registry_root: Path) -> None:
        """Count equals registry size from pre-clear index snapshot."""
        store = FileSystemRegistryStore(root=registry_root)

        # Save 2 personas
        for name in ("count-a", "count-b"):
            spec = _canonical_spec(name, f"sha256:{name}")
            save_result = store.save(spec)
            assert save_result == Success(None)

        # Snapshot index before clear
        index_before = json.loads((registry_root / INDEX_FILENAME).read_text(encoding="utf-8"))
        expected_count = len(index_before)
        assert expected_count == 2

        result = store.clear(confirm=CLEAR_CONFIRMATION_TOKEN)

        assert result == Success(expected_count)
