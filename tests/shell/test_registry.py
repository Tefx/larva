"""Contract-driven tests for ``larva.shell.registry`` filesystem behavior.

These tests define expected shell-boundary behavior for FileSystemRegistryStore:
- save() persists canonical PersonaSpec and updates index.json digest mapping
- get() returns exact stored PersonaSpec by valid kebab-case id
- get() returns typed shell errors for missing/invalid personas
- list() returns complete canonical PersonaSpec records from registry boundary
- index/spec consistency violations return typed shell errors
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from returns.result import Failure, Success

from larva.core.spec import PersonaSpec
from larva.shell.registry import FileSystemRegistryStore, INDEX_FILENAME


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
        spec = _canonical_spec("null-preserver", "sha256:null-preserver")
        spec["description"] = None
        spec["model_params"] = {"temperature": None}

        result = store.save(spec)

        assert result == Success(None)
        persisted_spec = json.loads(
            (registry_root / "null-preserver.json").read_text(encoding="utf-8")
        )
        assert "description" in persisted_spec
        assert persisted_spec["description"] is None
        assert persisted_spec["model_params"]["temperature"] is None

    def test_get_returns_exact_stored_spec_for_valid_kebab_case_id(
        self, registry_root: Path
    ) -> None:
        spec = _canonical_spec("infra-reviewer", "sha256:infra-reviewer")
        _write_json(registry_root / "infra-reviewer.json", spec)
        _write_json(registry_root / INDEX_FILENAME, {"infra-reviewer": spec["spec_digest"]})

        store = FileSystemRegistryStore(root=registry_root)
        result = store.get("infra-reviewer")

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

        def fail_index_write(path: Path, payload: object, kind: str, persona_id: str):
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
