"""Tests for the repo-local shared-surface CI gate script."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def _load_gate_module():
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts/ci/larva_repo_local_gate.py"
    spec = importlib.util.spec_from_file_location("larva_repo_local_gate", module_path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed to load repo-local gate module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _seed_repo_layout(tmp_path: Path) -> tuple[Path, Path]:
    larva_root = tmp_path / "larva"
    opifex_root = tmp_path / "opifex"
    schema_payload = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["id", "description", "prompt", "model", "capabilities", "spec_version"],
        "properties": {
            "id": {"type": "string"},
            "description": {"type": "string"},
            "prompt": {"type": "string"},
            "model": {"type": "string"},
            "capabilities": {"type": "object"},
            "spec_version": {"type": "string"},
        },
        "additionalProperties": False,
    }
    schema_text = json.dumps(schema_payload, indent=2, sort_keys=True) + "\n"
    _write(larva_root / "contracts/persona_spec.schema.json", schema_text)
    _write(opifex_root / "contracts/persona_spec.schema.json", schema_text)

    _write(
        larva_root / "src/larva/core/validation_contract.py",
        'CANONICAL_REQUIRED_FIELDS = (\n'
        '    "id",\n'
        '    "description",\n'
        '    "prompt",\n'
        '    "model",\n'
        '    "capabilities",\n'
        '    "spec_version",\n'
        ')\n'
        'CANONICAL_FORBIDDEN_FIELDS = ("tools", "side_effect_policy")\n',
    )
    _write(
        larva_root / "src/larva/shell/mcp_contract.py",
        'LARVA_MCP_TOOLS = [\n'
        '    {"name": "larva_validate"},\n'
        '    {"name": "larva_assemble"},\n'
        '    {"name": "larva_register"},\n'
        '    {"name": "larva_resolve"},\n'
        ']\n',
    )
    docs_text = "\n".join(
        (
            "larva_validate larva_assemble larva_register larva_resolve",
            "tools is rejected at canonical admission",
            "side_effect_policy is invalid at canonical admission",
            "prompt is opaque executable text",
        )
    )
    for relative_path in ("README.md", "USAGE.md", "INTERFACES.md"):
        _write(larva_root / relative_path, docs_text)
    return larva_root, opifex_root


def test_run_verify_accepts_matching_repo_layout(tmp_path: Path) -> None:
    module = _load_gate_module()
    larva_root, opifex_root = _seed_repo_layout(tmp_path)

    result = module.run_verify(module.GatePaths(larva_root=larva_root, opifex_root=opifex_root))

    assert result == [
        "schema-authority parity: PASS",
        "capabilities-only admission metadata: PASS",
        "mcp snake_case naming: PASS (4 tools)",
        "repo-facing docs parity: PASS",
    ]


def test_run_expected_red_detects_seeded_drift(tmp_path: Path) -> None:
    module = _load_gate_module()
    larva_root, opifex_root = _seed_repo_layout(tmp_path)

    result = module.run_expected_red(module.GatePaths(larva_root=larva_root, opifex_root=opifex_root))

    assert len(result) == 3
    assert "schema-authority mismatch" in result[0]
    assert "docs parity drift" in result[1]
    assert "capabilities-only admission drift" in result[2]
