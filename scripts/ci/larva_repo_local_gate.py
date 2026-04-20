"""Repo-local shared-surface CI gate for larva.

Sources:
- /Users/tefx/Projects/opifex/design/final-canonical-contract.md
- /Users/tefx/Projects/opifex/contracts/persona_spec.schema.json
- /Users/tefx/Projects/opifex/conformance/shared_surfaces.yaml
- /Users/tefx/Projects/opifex/conformance/case_matrix/larva/larva.shared_naming_docs.yaml
- /Users/tefx/Projects/opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml
- design/opifex-canonical-authority-basis.md

This script intentionally checks only the larva repo-local obligations derived from
those authority artifacts: canonical schema mirror parity, capabilities-only
admission metadata, snake_case MCP naming, and repo-facing docs parity.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import shutil
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path


DOC_PATHS: tuple[str, ...] = ("README.md", "USAGE.md", "INTERFACES.md")
SCHEMA_PATH = Path("contracts/persona_spec.schema.json")
MCP_CONTRACT_PATH = Path("src/larva/shell/mcp_contract.py")
VALIDATION_CONTRACT_PATH = Path("src/larva/core/validation_contract.py")
SNAKE_CASE_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
INVALID_FIELD_WORDS = ("reject", "invalid", "forbidden", "not permitted", "non-canonical")
SPEC_BEARING_TOOL_NAMES = (
    "larva_validate",
    "larva_assemble",
    "larva_register",
    "larva_resolve",
)


class GateFailure(RuntimeError):
    """Raised when a repo-local conformance gate fails."""


@dataclass(frozen=True)
class GatePaths:
    """Filesystem inputs for the repo-local conformance gate."""

    larva_root: Path
    opifex_root: Path


def _read_text(path: Path) -> str:
    """Read UTF-8 text from ``path``.

    Args:
        path: File to read.

    Returns:
        File content as UTF-8 text.
    """

    return path.read_text(encoding="utf-8")


def _read_json(path: Path) -> object:
    """Read JSON from ``path``.

    Args:
        path: JSON file to read.

    Returns:
        Parsed JSON value.
    """

    return json.loads(_read_text(path))


def _extract_literal_tuple(module_path: Path, variable_name: str) -> tuple[str, ...]:
    """Extract a tuple literal assignment from a Python module.

    Args:
        module_path: Python source file to inspect.
        variable_name: Constant name to extract.

    Returns:
        The literal tuple value.

    Raises:
        GateFailure: If the variable is missing or not a string tuple literal.
    """

    tree = ast.parse(_read_text(module_path), filename=str(module_path))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id != variable_name or node.value is None:
                continue
            value = ast.literal_eval(node.value)
            if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
                return value
            raise GateFailure(f"{module_path}: {variable_name} must remain a string tuple literal")
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        if node.targets[0].id != variable_name:
            continue
        value = ast.literal_eval(node.value)
        if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
            return value
        raise GateFailure(f"{module_path}: {variable_name} must remain a string tuple literal")
    raise GateFailure(f"{module_path}: missing required constant {variable_name}")


def _extract_mcp_tool_names(mcp_contract_path: Path) -> list[str]:
    """Extract MCP tool names from ``mcp_contract.py``.

    Args:
        mcp_contract_path: File containing MCP tool registrations.

    Returns:
        Tool names in file order.
    """

    names = re.findall(r'"name"\s*:\s*"([^"]+)"', _read_text(mcp_contract_path))
    if not names:
        raise GateFailure(f"{mcp_contract_path}: no MCP tool registrations found")
    return names


def _combined_docs_text(larva_root: Path) -> str:
    """Return a lowercased concatenation of repo-facing docs.

    Args:
        larva_root: Repository root.

    Returns:
        Concatenated lowercased docs text.
    """

    return "\n".join(_read_text(larva_root / relative_path).lower() for relative_path in DOC_PATHS)


def _dotted_alias(tool_name: str) -> str:
    """Convert a shared-surface tool name to its forbidden dotted alias.

    Args:
        tool_name: Snake_case tool name.

    Returns:
        Dotted alias using the prefix separator expected by the opifex cases.
    """

    prefix, separator, remainder = tool_name.partition("_")
    if separator == "":
        return tool_name
    return f"{prefix}.{remainder}"


def check_schema_authority(paths: GatePaths) -> None:
    """Require exact opifex schema mirror parity.

    Source: final-canonical-contract.md lines 83-92.

    Args:
        paths: Repo locations.

    Raises:
        GateFailure: If the larva mirror differs from opifex authority.
    """

    larva_schema = _read_json(paths.larva_root / SCHEMA_PATH)
    opifex_schema = _read_json(paths.opifex_root / SCHEMA_PATH)
    if larva_schema != opifex_schema:
        raise GateFailure(
            "schema-authority mismatch: contracts/persona_spec.schema.json no longer "
            "matches opifex canonical authority"
        )


def check_capabilities_only_admission(paths: GatePaths) -> None:
    """Require capabilities-only admission metadata and legacy-field rejection.

    Sources:
    - final-canonical-contract.md lines 148-157
    - design/opifex-canonical-authority-basis.md lines 30-35, 38-54

    Args:
        paths: Repo locations.

    Raises:
        GateFailure: If required/forbidden field metadata drifts.
    """

    required_fields = _extract_literal_tuple(
        paths.larva_root / VALIDATION_CONTRACT_PATH,
        "CANONICAL_REQUIRED_FIELDS",
    )
    forbidden_fields = _extract_literal_tuple(
        paths.larva_root / VALIDATION_CONTRACT_PATH,
        "CANONICAL_FORBIDDEN_FIELDS",
    )
    if "capabilities" not in required_fields:
        raise GateFailure("capabilities-only admission drift: capabilities is no longer required")
    if set(forbidden_fields) != {"tools", "side_effect_policy"}:
        raise GateFailure(
            "legacy-field drift: forbidden canonical fields must stay exactly tools and "
            "side_effect_policy"
        )


def check_mcp_tool_naming(paths: GatePaths) -> list[str]:
    """Require shared MCP tools to stay snake_case and never dotted.

    Sources:
    - final-canonical-contract.md lines 103-123
    - conformance/shared_surfaces.yaml lines 496-510

    Args:
        paths: Repo locations.

    Returns:
        Extracted MCP tool names.

    Raises:
        GateFailure: If any name is not snake_case.
    """

    tool_names = _extract_mcp_tool_names(paths.larva_root / MCP_CONTRACT_PATH)
    invalid = [name for name in tool_names if SNAKE_CASE_PATTERN.fullmatch(name) is None]
    if invalid:
        raise GateFailure(f"MCP naming drift: non-snake_case tool names found: {', '.join(invalid)}")
    if any("." in name for name in tool_names):
        raise GateFailure("MCP naming drift: dotted tool names are forbidden")
    return tool_names


def check_docs_parity(paths: GatePaths, tool_names: Sequence[str]) -> None:
    """Require repo-facing docs to track shared naming and legacy-field semantics.

    Sources:
    - conformance/shared_surfaces.yaml lines 483-494
    - larva.shared_naming_docs.yaml

    Args:
        paths: Repo locations.
        tool_names: Shared MCP tool names exported by larva.

    Raises:
        GateFailure: If docs drift from shared naming or invalid-field wording.
    """

    docs_text = _combined_docs_text(paths.larva_root)
    missing_tool_names = [name for name in tool_names if name not in docs_text]
    if missing_tool_names:
        raise GateFailure(
            "docs parity drift: repo-facing docs do not mention registered MCP names: "
            + ", ".join(missing_tool_names)
        )
    dotted_names = [alias for alias in (_dotted_alias(name) for name in tool_names) if alias in docs_text]
    if dotted_names:
        raise GateFailure(
            "docs parity drift: dotted MCP aliases appear in repo-facing docs: "
            + ", ".join(dotted_names)
        )
    for field_name in ("tools", "side_effect_policy"):
        if field_name not in docs_text:
            raise GateFailure(f"docs parity drift: repo-facing docs must mention invalid field {field_name}")
        field_window = re.findall(rf"[^\n]{{0,120}}{re.escape(field_name)}[^\n]{{0,120}}", docs_text)
        if not any(any(word in window for word in INVALID_FIELD_WORDS) for window in field_window):
            raise GateFailure(
                f"docs parity drift: repo-facing docs mention {field_name} without invalid/rejected wording"
            )
    if "opaque executable" not in docs_text and "opaque data" not in docs_text:
        raise GateFailure("docs parity drift: prompt must remain documented as opaque text/data")


def run_verify(paths: GatePaths) -> list[str]:
    """Run the repo-local conformance gate.

    Args:
        paths: Repo locations.

    Returns:
        Human-readable success evidence lines.
    """

    check_schema_authority(paths)
    check_capabilities_only_admission(paths)
    tool_names = check_mcp_tool_naming(paths)
    check_docs_parity(paths, tool_names)
    return [
        "schema-authority parity: PASS",
        "capabilities-only admission metadata: PASS",
        f"mcp snake_case naming: PASS ({len(tool_names)} tools)",
        "repo-facing docs parity: PASS",
    ]


def _seed_expected_red_schema_drift(workspace_root: Path) -> str:
    """Mutate the local schema mirror and confirm the gate fails.

    Args:
        workspace_root: Temporary workspace root.

    Returns:
        Failure message from the gate.
    """

    schema_path = workspace_root / "larva" / SCHEMA_PATH
    schema = _read_json(schema_path)
    if not isinstance(schema, dict):
        raise GateFailure("expected-red setup failed: schema root is not an object")
    schema["description"] = "Drifted local schema description"
    schema_path.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        run_verify(GatePaths(larva_root=workspace_root / "larva", opifex_root=workspace_root / "opifex"))
    except GateFailure as exc:
        return str(exc)
    raise GateFailure("expected-red failed: schema drift did not trip the gate")


def _seed_expected_red_docs_drift(workspace_root: Path) -> str:
    """Mutate docs to a dotted MCP name and confirm the gate fails.

    Args:
        workspace_root: Temporary workspace root.

    Returns:
        Failure message from the gate.
    """

    readme_path = workspace_root / "larva" / "README.md"
    readme_text = _read_text(readme_path)
    readme_path.write_text(readme_text.replace("larva_resolve", "larva.resolve", 1), encoding="utf-8")
    try:
        run_verify(GatePaths(larva_root=workspace_root / "larva", opifex_root=workspace_root / "opifex"))
    except GateFailure as exc:
        return str(exc)
    raise GateFailure("expected-red failed: docs naming drift did not trip the gate")


def _seed_expected_red_capability_drift(workspace_root: Path) -> str:
    """Mutate required-field metadata and confirm the gate fails.

    Args:
        workspace_root: Temporary workspace root.

    Returns:
        Failure message from the gate.
    """

    contract_path = workspace_root / "larva" / VALIDATION_CONTRACT_PATH
    contract_text = _read_text(contract_path)
    contract_path.write_text(contract_text.replace('    "capabilities",\n', "", 1), encoding="utf-8")
    try:
        run_verify(GatePaths(larva_root=workspace_root / "larva", opifex_root=workspace_root / "opifex"))
    except GateFailure as exc:
        return str(exc)
    raise GateFailure("expected-red failed: capabilities drift did not trip the gate")


def run_expected_red(paths: GatePaths) -> list[str]:
    """Seed representative drift and prove the gate fails closed.

    Args:
        paths: Repo locations.

    Returns:
        Human-readable evidence lines.
    """

    with tempfile.TemporaryDirectory(prefix="larva-repo-local-gate-") as tmp_dir:
        workspace_root = Path(tmp_dir)
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=shutil.ignore_patterns(".git", ".venv", ".vectl", "__pycache__", ".pytest_cache"))
        shutil.copytree(paths.opifex_root, workspace_root / "opifex", ignore=shutil.ignore_patterns(".git", ".venv", ".vectl", "__pycache__", ".pytest_cache"))
        schema_failure = _seed_expected_red_schema_drift(workspace_root)

        shutil.rmtree(workspace_root / "larva")
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=shutil.ignore_patterns(".git", ".venv", ".vectl", "__pycache__", ".pytest_cache"))
        docs_failure = _seed_expected_red_docs_drift(workspace_root)

        shutil.rmtree(workspace_root / "larva")
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=shutil.ignore_patterns(".git", ".venv", ".vectl", "__pycache__", ".pytest_cache"))
        capability_failure = _seed_expected_red_capability_drift(workspace_root)

    return [
        f"expected-red schema drift: PASS ({schema_failure})",
        f"expected-red docs naming drift: PASS ({docs_failure})",
        f"expected-red capabilities drift: PASS ({capability_failure})",
    ]


def _build_parser() -> argparse.ArgumentParser:
    """Build the CLI parser.

    Returns:
        Configured argument parser.
    """

    parser = argparse.ArgumentParser(description="larva repo-local shared-surface CI gate")
    parser.add_argument(
        "mode",
        choices=("verify", "expected-red"),
        help="verify the current repo or seed representative drift and prove the gate fails",
    )
    parser.add_argument(
        "--larva-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="path to the larva repository root",
    )
    parser.add_argument(
        "--opifex-root",
        type=Path,
        required=True,
        help="path to the opifex repository root",
    )
    return parser


def main() -> int:
    """CLI entrypoint.

    Returns:
        POSIX-style process status code.
    """

    args = _build_parser().parse_args()
    paths = GatePaths(larva_root=args.larva_root.resolve(), opifex_root=args.opifex_root.resolve())
    try:
        evidence_lines = run_expected_red(paths) if args.mode == "expected-red" else run_verify(paths)
    except GateFailure as exc:
        print(f"FAIL: {exc}")
        return 1
    for line in evidence_lines:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
