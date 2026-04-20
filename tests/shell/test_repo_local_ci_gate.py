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
    frozen_ref = "69b68603299a3d10cf09a25e12c7b9378312f76b"
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
        larva_root / "design/opifex-frozen-authority-packet.json",
        json.dumps(
            {
                "repository": "Tefx/opifex",
                "ref": frozen_ref,
                "packet_doc": "design/cross-repo-followup-packet.md",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(opifex_root / "design/cross-repo-followup-packet.md", "# frozen packet\n")

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
        '    {"name": "larva_component_show"},\n'
        '    {"name": "larva_export"},\n'
        ']\n',
    )
    docs_text = "\n".join(
        (
            "larva_validate larva_assemble larva_register larva_resolve "
            "larva_component_show larva_export",
            "tools is rejected at canonical admission",
            "side_effect_policy is invalid at canonical admission",
            "prompt is opaque executable text",
        )
    )
    for relative_path in ("README.md", "USAGE.md", "INTERFACES.md"):
        _write(larva_root / relative_path, docs_text)

    _write(
        opifex_root / "conformance/shared_surfaces.yaml",
        json.dumps(
            {
                "global_controls": {
                    "frozen_followup_packet_ref": "design/cross-repo-followup-packet.md"
                },
                "gate_policy": {
                    "frozen_followup_packet_required_before_downstream_ci": True
                },
                "frozen_followup_packet": {
                    "packet_doc": "design/cross-repo-followup-packet.md",
                    "required_before_downstream_ci": True,
                },
                "shared_surfaces": [
                    {
                        "id": "larva_validate",
                        "owner_repo": "larva",
                        "kind": "mcp_tools_call",
                        "exposure": "shared",
                        "contract_refs": [
                            "design/final-canonical-contract.md",
                            "contracts/persona_spec.schema.json",
                        ],
                        "case_matrix": ["conformance/case_matrix/larva/larva.validate.yaml"],
                    },
                    {
                        "id": "larva_assemble",
                        "owner_repo": "larva",
                        "kind": "mcp_tools_call",
                        "exposure": "shared",
                        "contract_refs": [
                            "design/final-canonical-contract.md",
                            "contracts/persona_spec.schema.json",
                        ],
                        "case_matrix": ["conformance/case_matrix/larva/larva.assemble.yaml"],
                    },
                    {
                        "id": "larva_register",
                        "owner_repo": "larva",
                        "kind": "mcp_tools_call",
                        "exposure": "shared",
                        "contract_refs": [
                            "design/final-canonical-contract.md",
                            "contracts/persona_spec.schema.json",
                        ],
                        "case_matrix": ["conformance/case_matrix/larva/larva.register.yaml"],
                    },
                    {
                        "id": "larva_resolve",
                        "owner_repo": "larva",
                        "kind": "mcp_tools_call",
                        "exposure": "shared",
                        "contract_refs": [
                            "design/final-canonical-contract.md",
                            "contracts/persona_spec.schema.json",
                        ],
                        "case_matrix": ["conformance/case_matrix/larva/larva.resolve.yaml"],
                    },
                    {
                        "id": "larva_component_show",
                        "owner_repo": "larva",
                        "kind": "mcp_tools_call",
                        "exposure": "shared",
                        "contract_refs": ["design/final-canonical-contract.md"],
                        "case_matrix": ["conformance/case_matrix/larva/larva.component_show.yaml"],
                    },
                    {
                        "id": "larva_export",
                        "owner_repo": "larva",
                        "kind": "mcp_tools_call",
                        "exposure": "shared",
                        "contract_refs": ["design/final-canonical-contract.md"],
                        "case_matrix": ["conformance/case_matrix/larva/larva.export.yaml"],
                    },
                    {
                        "id": "larva_shared_naming_docs",
                        "owner_repo": "larva",
                        "kind": "docs_parity",
                        "exposure": "shared",
                        "contract_refs": [
                            "design/final-canonical-contract.md",
                            "contracts/persona_spec.schema.json",
                        ],
                        "case_matrix": [
                            "conformance/case_matrix/larva/larva.shared_naming_docs.yaml"
                        ],
                    },
                    {
                        "id": "larva_mcp_server_naming",
                        "owner_repo": "larva",
                        "kind": "mcp_server_registration",
                        "exposure": "shared",
                        "contract_refs": ["design/final-canonical-contract.md"],
                        "case_matrix": [
                            "conformance/case_matrix/larva/larva.mcp_server_naming.yaml"
                        ],
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.validate.yaml",
        json.dumps(
            {
                "surface_id": "larva_validate",
                "cases": [
                    {
                        "id": "missing_capabilities",
                        "class": "missing_required",
                        "expected": {"field": "capabilities"},
                    },
                    {
                        "id": "legacy_tools",
                        "class": "legacy_alias",
                        "expected": {"field": "tools"},
                    },
                    {
                        "id": "prompt_opaque",
                        "class": "happy_path",
                        "expected": {
                            "field": "prompt",
                            "note": "prompt text is validated as opaque executable text",
                        },
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.assemble.yaml",
        json.dumps(
            {
                "surface_id": "larva_assemble",
                "cases": [
                    {
                        "id": "legacy_tools",
                        "class": "legacy_alias",
                        "expected": {"field": "tools"},
                    }
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.register.yaml",
        json.dumps(
            {
                "surface_id": "larva_register",
                "cases": [
                    {
                        "id": "missing_capabilities",
                        "class": "missing_required",
                        "expected": {"field": "capabilities"},
                    },
                    {
                        "id": "tools_field_present",
                        "class": "legacy_alias",
                        "expected": {"field": "tools"},
                    },
                    {
                        "id": "side_effect_policy_present",
                        "class": "legacy_alias",
                        "expected": {"field": "side_effect_policy"},
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.resolve.yaml",
        json.dumps(
            {
                "surface_id": "larva_resolve",
                "cases": [
                    {
                        "id": "legacy_override_field",
                        "class": "legacy_alias",
                        "expected": {"field": "tools"},
                    },
                    {
                        "id": "resolved_prompt_preserved_opaquely",
                        "class": "happy_path",
                        "expected": {
                            "field": "prompt",
                            "note": "resolve returns canonical prompt text opaquely",
                        },
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.component_show.yaml",
        json.dumps(
            {
                "surface_id": "larva_component_show",
                "cases": [
                    {
                        "id": "tools",
                        "class": "legacy_alias",
                        "expected": {"field": "tools"},
                    },
                    {
                        "id": "side_effect_policy",
                        "class": "legacy_alias",
                        "expected": {"field": "side_effect_policy"},
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.export.yaml",
        json.dumps(
            {
                "surface_id": "larva_export",
                "cases": [
                    {"id": "happy_path", "class": "happy_path", "expected": {"result": "accept"}}
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.shared_naming_docs.yaml",
        json.dumps(
            {
                "surface_id": "larva_shared_naming_docs",
                "cases": [
                    {
                        "id": "docs_use_snake_case_tool_names",
                        "class": "bad_enum",
                        "expected": {"absent_names": ["larva.resolve"]},
                    },
                    {
                        "id": "docs_prompt_opaque",
                        "class": "docs_example_parity",
                        "expected": {
                            "field": "prompt",
                            "note": "larva-facing docs describe prompt as opaque executable text",
                        },
                    },
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    _write(
        opifex_root / "conformance/case_matrix/larva/larva.mcp_server_naming.yaml",
        json.dumps(
            {
                "surface_id": "larva_mcp_server_naming",
                "cases": [
                    {
                        "id": "no_dotted_larva_names",
                        "class": "bad_enum",
                        "expected": {"absent_names": ["larva.resolve"]},
                    }
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )
    return larva_root, opifex_root


def test_run_verify_accepts_matching_repo_layout(tmp_path: Path) -> None:
    module = _load_gate_module()
    larva_root, opifex_root = _seed_repo_layout(tmp_path)

    result = module.run_verify(module.GatePaths(larva_root=larva_root, opifex_root=opifex_root))

    assert result == [
        "frozen authority packet pin: PASS (Tefx/opifex@69b68603299a3d10cf09a25e12c7b9378312f76b)",
        "schema-authority parity: PASS",
        "capabilities-only admission metadata: PASS",
        "mcp snake_case naming: PASS (6 tools)",
        "repo-facing docs parity: PASS",
    ]


def test_run_expected_red_detects_seeded_drift(tmp_path: Path) -> None:
    module = _load_gate_module()
    larva_root, opifex_root = _seed_repo_layout(tmp_path)

    result = module.run_expected_red(
        module.GatePaths(larva_root=larva_root, opifex_root=opifex_root)
    )

    assert len(result) == 5
    assert "frozen authority ref drift" in result[0]
    assert "schema-authority mismatch" in result[1]
    assert "docs parity drift" in result[2]
    assert "capabilities-only admission drift" in result[3]
    assert "shared-surface scope drift" in result[4]
