"""Seam proof test for facade against real components.

This test verifies facade integration with actual filesystem-based
components and registry (not in-memory mocks), writing artifacts for
replay verification.

Sources:
- ARCHITECTURE.md section 7 (Integration seams)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from returns.result import Success

from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.shell.components import FilesystemComponentStore
from larva.shell.registry import FileSystemRegistryStore

from .conftest import _canonical_spec

if TYPE_CHECKING:
    from pathlib import Path


class TestFacadeSeamProof:
    def test_replayable_seam_proof_command_writes_artifact_with_actual_outputs(
        self, tmp_path: Path
    ) -> None:
        registry_root = tmp_path / "registry"
        artifact_path = tmp_path / "facade-seam-proof-artifact.json"

        # Import DefaultLarvaFacade here to avoid circular import at module level
        from larva.app.facade import DefaultLarvaFacade

        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=SpyAssembleModule(_canonical_spec("unused"), []),
            validate=validate_module,
            normalize=normalize_module,
            components=FilesystemComponentStore(components_dir=tmp_path / "components"),
            registry=FileSystemRegistryStore(root=registry_root),
        )

        register_result = facade.register(_canonical_spec("facade-live", digest="sha256:stale"))
        list_result = facade.list()
        resolve_result = facade.resolve(
            "facade-live", overrides={"model_params": {"temperature": 0}}
        )

        assert isinstance(register_result, Success)
        assert isinstance(list_result, Success)
        assert isinstance(resolve_result, Success)

        artifact = {
            "command": (
                "uv run pytest -q tests/app/test_facade.py "
                "-k replayable_seam_proof_command_writes_artifact_with_actual_outputs"
            ),
            "register": register_result.unwrap(),
            "list": list_result.unwrap(),
            "resolve": resolve_result.unwrap(),
        }
        artifact_path.write_text(json.dumps(artifact, indent=2, sort_keys=True), encoding="utf-8")

        persisted_artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        assert persisted_artifact["command"].startswith("uv run pytest -q tests/app/test_facade.py")
        assert persisted_artifact["register"] == {"id": "facade-live", "registered": True}
        assert persisted_artifact["list"] == [
            {
                "id": "facade-live",
                "model": "gpt-4o-mini",
                "spec_digest": persisted_artifact["list"][0]["spec_digest"],
            }
        ]
        assert persisted_artifact["resolve"]["id"] == "facade-live"
        assert persisted_artifact["resolve"]["model_params"] == {"temperature": 0}
        assert (
            persisted_artifact["list"][0]["spec_digest"]
            != persisted_artifact["resolve"]["spec_digest"]
        )
        assert persisted_artifact["list"][0]["spec_digest"].startswith("sha256:")
        assert persisted_artifact["resolve"]["spec_digest"].startswith("sha256:")


# Import for SeamProof test
from dataclasses import dataclass, field


@dataclass
class SpyAssembleModule:
    candidate: dict
    calls: list[str]
    inputs: list[dict] = field(default_factory=list)

    def assemble_candidate(self, data: dict) -> dict:
        self.calls.append("assemble")
        self.inputs.append(data)
        return dict(self.candidate)
