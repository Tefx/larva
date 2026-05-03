"""Repo-local shared-surface CI gate for larva.

Sources:
- /Users/tefx/Projects/opifex/design/final-canonical-contract.md
- /Users/tefx/Projects/opifex/contracts/persona_spec.schema.json
- /Users/tefx/Projects/opifex/conformance/shared_surfaces.yaml
- /Users/tefx/Projects/opifex/conformance/case_matrix/larva/*
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
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import yaml

if TYPE_CHECKING:
    from collections.abc import Sequence


DOC_PATHS: tuple[str, ...] = (
    "README.md",
    "docs/guides/USAGE.md",
    "docs/reference/INTERFACES.md",
)
AUTHORITY_LOCK_PATH = Path("design/opifex-frozen-authority-packet.json")
SHARED_SURFACES_PATH = Path("conformance/shared_surfaces.yaml")
SCHEMA_PATH = Path("contracts/persona_spec.schema.json")
MCP_CONTRACT_PATH = Path("src/larva/shell/mcp_contract.py")
VALIDATION_CONTRACT_PATH = Path("src/larva/core/validation_contract.py")
SNAKE_CASE_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
FULL_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
INVALID_FIELD_WORDS = ("reject", "invalid", "forbidden", "not permitted", "non-canonical")
LOCAL_REGISTRY_METADATA_FORBIDDEN_FIELDS = ("variant", "_registry", "active", "manifest")
COPYTREE_IGNORE = shutil.ignore_patterns(
    ".git",
    ".venv",
    ".vectl",
    "__pycache__",
    ".pytest_cache",
)


class GateError(RuntimeError):
    """Raised when a repo-local conformance gate fails."""


@dataclass(frozen=True)
class GatePaths:
    """Filesystem inputs for the repo-local conformance gate."""

    larva_root: Path
    opifex_root: Path


@dataclass(frozen=True)
class FrozenAuthorityPacket:
    """Pinned opifex authority packet metadata.

    Args:
        repository: Source GitHub repository for the authority packet.
        ref: Frozen git commit SHA for the authority checkout.
        packet_doc: Opifex packet document path.
    """

    repository: str
    ref: str
    packet_doc: str


@dataclass(frozen=True)
class AuthorityScope:
    """Repo-local scope derived from opifex authority artifacts.

    Args:
        packet: Frozen authority packet metadata.
        persona_schema_refs: Canonical schema refs consumed by larva shared surfaces.
        shared_tool_names: Shared larva MCP tool names declared by authority.
        forbidden_fields: Top-level canonical fields that larva must reject.
        required_fields: Top-level canonical fields that larva must require.
        dotted_aliases: Dotted shared-name aliases that docs must not advertise.
        prompt_must_be_opaque: Whether authority cases require prompt opacity wording.
    """

    packet: FrozenAuthorityPacket
    persona_schema_refs: tuple[str, ...]
    shared_tool_names: tuple[str, ...]
    forbidden_fields: tuple[str, ...]
    required_fields: tuple[str, ...]
    dotted_aliases: tuple[str, ...]
    prompt_must_be_opaque: bool


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


def _read_yaml(path: Path) -> object:
    """Read YAML from ``path``.

    Args:
        path: YAML file to read.

    Returns:
        Parsed YAML value.
    """

    return yaml.safe_load(_read_text(path))


def _git_head(root: Path) -> str | None:
    """Return the git HEAD SHA for ``root`` when available.

    Args:
        root: Repository root.

    Returns:
        Full HEAD SHA, or ``None`` when ``root`` is not a git checkout.
    """

    if not (root / ".git").exists():
        return None
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
        cwd=root,
    )
    if result.returncode != 0:
        raise GateError(f"{root}: failed to resolve git HEAD: {result.stderr.strip()}")
    return result.stdout.strip()


def _extract_literal_tuple(module_path: Path, variable_name: str) -> tuple[str, ...]:
    """Extract a tuple literal assignment from a Python module.

    Args:
        module_path: Python source file to inspect.
        variable_name: Constant name to extract.

    Returns:
        The literal tuple value.

    Raises:
        GateError: If the variable is missing or not a string tuple literal.
    """

    tree = ast.parse(_read_text(module_path), filename=str(module_path))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id != variable_name or node.value is None:
                continue
            value = ast.literal_eval(node.value)
            if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
                return value
            raise GateError(f"{module_path}: {variable_name} must remain a string tuple literal")
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        if node.targets[0].id != variable_name:
            continue
        value = ast.literal_eval(node.value)
        if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
            return value
        raise GateError(f"{module_path}: {variable_name} must remain a string tuple literal")
    raise GateError(f"{module_path}: missing required constant {variable_name}")


def _extract_mcp_tool_names(mcp_contract_path: Path) -> list[str]:
    """Extract MCP tool names from ``mcp_contract.py``.

    Args:
        mcp_contract_path: File containing MCP tool registrations.

    Returns:
        Tool names in file order.
    """

    names = re.findall(r'"name"\s*:\s*"([^"]+)"', _read_text(mcp_contract_path))
    if not names:
        raise GateError(f"{mcp_contract_path}: no MCP tool registrations found")
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


def _load_case_matrix(path: Path) -> dict[str, object]:
    """Load a case-matrix YAML document.

    Args:
        path: Case-matrix file path.

    Returns:
        Parsed mapping document.

    Raises:
        GateError: If the document is not a mapping.
    """

    payload = _read_yaml(path)
    if not isinstance(payload, dict):
        raise GateError(f"{path}: case matrix must be a mapping")
    return payload


def _load_authority_scope(paths: GatePaths) -> AuthorityScope:
    """Derive larva repo-local scope from opifex authority metadata.

    Sources:
    - final-canonical-contract.md lines 40-99
    - conformance/shared_surfaces.yaml lines 41-85, 362-510
    - conformance/case_matrix/larva/*

    Args:
        paths: Repo locations.

    Returns:
        Derived authority scope for larva repo-local checks.

    Raises:
        GateError: If authority metadata is malformed or incomplete.
    """

    lock_payload = _read_json(paths.larva_root / AUTHORITY_LOCK_PATH)
    if not isinstance(lock_payload, dict):
        raise GateError(f"{AUTHORITY_LOCK_PATH}: authority lock must be a JSON object")
    packet = FrozenAuthorityPacket(
        repository=str(lock_payload.get("repository", "")),
        ref=str(lock_payload.get("ref", "")),
        packet_doc=str(lock_payload.get("packet_doc", "")),
    )
    shared_surfaces_payload = _read_yaml(paths.opifex_root / SHARED_SURFACES_PATH)
    if not isinstance(shared_surfaces_payload, dict):
        raise GateError("conformance/shared_surfaces.yaml: root must be a mapping")
    global_controls = shared_surfaces_payload.get("global_controls")
    frozen_packet = shared_surfaces_payload.get("frozen_followup_packet")
    shared_surfaces = shared_surfaces_payload.get("shared_surfaces")
    if not isinstance(global_controls, dict):
        raise GateError("conformance/shared_surfaces.yaml: missing global_controls mapping")
    if not isinstance(frozen_packet, dict):
        raise GateError("conformance/shared_surfaces.yaml: missing frozen_followup_packet mapping")
    if not isinstance(shared_surfaces, list):
        raise GateError("conformance/shared_surfaces.yaml: shared_surfaces must be a list")
    frozen_followup_ref = global_controls.get("frozen_followup_packet_ref")
    if not isinstance(frozen_followup_ref, str):
        raise GateError("conformance/shared_surfaces.yaml: missing frozen_followup_packet_ref")
    packet_doc = frozen_packet.get("packet_doc")
    if not isinstance(packet_doc, str):
        raise GateError(
            "conformance/shared_surfaces.yaml: "
            "frozen_followup_packet.packet_doc missing"
        )
    if packet_doc != frozen_followup_ref:
        raise GateError(
            "authority packet drift: global_controls frozen_followup_packet_ref and "
            "frozen_followup_packet.packet_doc must match"
        )
    if packet.packet_doc != packet_doc:
        raise GateError(
            "authority packet drift: "
            f"{AUTHORITY_LOCK_PATH} packet_doc must stay pinned to {packet_doc}"
        )
    larva_surfaces = [
        surface
        for surface in shared_surfaces
        if isinstance(surface, dict)
        and surface.get("owner_repo") == "larva"
        and surface.get("exposure") == "shared"
    ]
    if not larva_surfaces:
        raise GateError("conformance/shared_surfaces.yaml: no shared larva surfaces found")

    shared_tool_names: list[str] = []
    persona_schema_refs: set[str] = set()
    required_fields: set[str] = set()
    forbidden_fields: set[str] = set()
    dotted_aliases: set[str] = set()
    prompt_must_be_opaque = False

    for surface in larva_surfaces:
        surface_id = surface.get("id")
        kind = surface.get("kind")
        contract_refs = surface.get("contract_refs", [])
        case_matrix_paths = surface.get("case_matrix", [])
        if not isinstance(surface_id, str):
            raise GateError(
                "conformance/shared_surfaces.yaml: larva surface id must be a string"
            )
        if kind == "mcp_tools_call":
            shared_tool_names.append(surface_id)
        if isinstance(contract_refs, list):
            for contract_ref in contract_refs:
                if contract_ref == SCHEMA_PATH.as_posix():
                    persona_schema_refs.add(contract_ref)
        if not isinstance(case_matrix_paths, list):
            raise GateError(
                f"conformance/shared_surfaces.yaml: surface {surface_id} case_matrix must be a list"
            )
        for case_matrix_path in case_matrix_paths:
            if not isinstance(case_matrix_path, str):
                raise GateError(
                    "conformance/shared_surfaces.yaml: "
                    f"surface {surface_id} case_matrix ref must be a string"
                )
            case_matrix = _load_case_matrix(paths.opifex_root / case_matrix_path)
            cases = case_matrix.get("cases", [])
            if not isinstance(cases, list):
                raise GateError(f"{case_matrix_path}: cases must be a list")
            for case in cases:
                if not isinstance(case, dict):
                    raise GateError(f"{case_matrix_path}: each case must be a mapping")
                case_class = case.get("class")
                expected = case.get("expected", {})
                if not isinstance(expected, dict):
                    raise GateError(f"{case_matrix_path}: case expected must be a mapping")
                field_name = expected.get("field")
                if case_class == "missing_required" and isinstance(field_name, str):
                    required_fields.add(field_name)
                if case_class == "legacy_alias" and isinstance(field_name, str):
                    forbidden_fields.add(field_name)
                absent_names = expected.get("absent_names", [])
                if isinstance(absent_names, list):
                    dotted_aliases.update(
                        name for name in absent_names if isinstance(name, str) and "." in name
                    )
                note = expected.get("note")
                if (
                    field_name == "prompt"
                    and isinstance(note, str)
                    and "opaque" in note.lower()
                ):
                    prompt_must_be_opaque = True

    if not persona_schema_refs:
        raise GateError(
            "authority scope drift: larva shared surfaces no longer reference "
            "PersonaSpec schema"
        )
    if not shared_tool_names:
        raise GateError("authority scope drift: larva shared MCP tool surfaces are empty")
    return AuthorityScope(
        packet=packet,
        persona_schema_refs=tuple(sorted(persona_schema_refs)),
        shared_tool_names=tuple(shared_tool_names),
        forbidden_fields=tuple(sorted(forbidden_fields)),
        required_fields=tuple(sorted(required_fields)),
        dotted_aliases=tuple(sorted(dotted_aliases)),
        prompt_must_be_opaque=prompt_must_be_opaque,
    )


def check_frozen_authority_packet(paths: GatePaths, scope: AuthorityScope) -> None:
    """Require a frozen opifex authority packet ref and matching checkout.

    Sources:
    - final-canonical-contract.md lines 75-99
    - conformance/shared_surfaces.yaml lines 45, 69-85, 103-115

    Args:
        paths: Repo locations.
        scope: Authority scope derived from opifex metadata.

    Raises:
        GateError: If the authority packet pin is floating or the checkout drifts.
    """

    if FULL_SHA_PATTERN.fullmatch(scope.packet.ref) is None:
        raise GateError(
            "frozen authority ref drift: "
            f"{AUTHORITY_LOCK_PATH} ref must be a full commit SHA, got {scope.packet.ref!r}"
        )
    shared_surfaces_payload = _read_yaml(paths.opifex_root / SHARED_SURFACES_PATH)
    if not isinstance(shared_surfaces_payload, dict):
        raise GateError("conformance/shared_surfaces.yaml: root must be a mapping")
    gate_policy = shared_surfaces_payload.get("gate_policy")
    frozen_packet = shared_surfaces_payload.get("frozen_followup_packet")
    if not isinstance(gate_policy, dict) or (
        gate_policy.get("frozen_followup_packet_required_before_downstream_ci") is not True
    ):
        raise GateError(
            "conformance/shared_surfaces.yaml: downstream CI must require the "
            "frozen follow-up packet"
        )
    if not isinstance(frozen_packet, dict) or (
        frozen_packet.get("required_before_downstream_ci") is not True
    ):
        raise GateError(
            "conformance/shared_surfaces.yaml: frozen follow-up packet must remain "
            "required before downstream CI"
        )
    if not (paths.opifex_root / scope.packet.packet_doc).exists():
        raise GateError(
            "frozen authority packet drift: missing pinned packet document "
            f"{scope.packet.packet_doc}"
        )
    actual_head = _git_head(paths.opifex_root)
    if actual_head is not None and actual_head != scope.packet.ref:
        raise GateError(
            "frozen authority ref drift: checked-out opifex SHA does not match "
            f"{AUTHORITY_LOCK_PATH} ({actual_head} != {scope.packet.ref})"
        )


def check_schema_authority(paths: GatePaths, scope: AuthorityScope) -> None:
    """Require exact opifex schema mirror parity.

    Source: final-canonical-contract.md lines 83-92.

    Args:
        paths: Repo locations.

    Raises:
        GateError: If the larva mirror differs from opifex authority.
    """

    if SCHEMA_PATH.as_posix() not in scope.persona_schema_refs:
        raise GateError(
            "authority scope drift: PersonaSpec schema mirror parity lost its "
            "upstream contract reference"
        )
    larva_schema = _read_json(paths.larva_root / SCHEMA_PATH)
    opifex_schema = _read_json(paths.opifex_root / SCHEMA_PATH)
    if larva_schema != opifex_schema:
        raise GateError(
            "schema-authority mismatch: contracts/persona_spec.schema.json no longer "
            "matches opifex canonical authority"
        )


def check_capabilities_only_admission(paths: GatePaths, scope: AuthorityScope) -> None:
    """Require capabilities-only admission metadata and legacy-field rejection.

    Sources:
    - final-canonical-contract.md lines 148-157
    - design/opifex-canonical-authority-basis.md lines 30-35, 38-54

    Args:
        paths: Repo locations.

    Raises:
        GateError: If required/forbidden field metadata drifts.
    """

    required_fields = _extract_literal_tuple(
        paths.larva_root / VALIDATION_CONTRACT_PATH,
        "CANONICAL_REQUIRED_FIELDS",
    )
    forbidden_fields = _extract_literal_tuple(
        paths.larva_root / VALIDATION_CONTRACT_PATH,
        "CANONICAL_FORBIDDEN_FIELDS",
    )
    if "capabilities" not in set(scope.required_fields):
        raise GateError(
            "authority scope drift: larva shared cases must include canonical "
            "capabilities missing-required coverage, "
            f"got {set(scope.required_fields)}"
        )
    authority_legacy_fields = {"side_effect_policy", "tools"}
    if not authority_legacy_fields.issubset(set(scope.forbidden_fields)):
        raise GateError(
            "authority scope drift: larva shared cases must reject at least canonical "
            "legacy fields {'tools', 'side_effect_policy'}, "
            f"got {set(scope.forbidden_fields)}"
        )
    if "capabilities" not in required_fields:
        raise GateError("capabilities-only admission drift: capabilities is no longer required")
    allowed_forbidden_fields = set(scope.forbidden_fields) | set(
        LOCAL_REGISTRY_METADATA_FORBIDDEN_FIELDS
    )
    forbidden_field_set = set(forbidden_fields)
    if not set(scope.forbidden_fields).issubset(forbidden_field_set) or not forbidden_field_set.issubset(
        allowed_forbidden_fields
    ):
        raise GateError(
            "legacy-field drift: forbidden canonical fields must stay aligned with "
            "authority-derived scope plus registry-local metadata exclusions "
            f"{allowed_forbidden_fields}"
        )


def check_mcp_tool_naming(paths: GatePaths, scope: AuthorityScope) -> list[str]:
    """Require shared MCP tools to stay snake_case and never dotted.

    Sources:
    - final-canonical-contract.md lines 103-123
    - conformance/shared_surfaces.yaml lines 496-510

    Args:
        paths: Repo locations.

    Returns:
        Shared larva MCP tool names derived from authority metadata.

    Raises:
        GateError: If any name is not snake_case.
    """

    tool_names = _extract_mcp_tool_names(paths.larva_root / MCP_CONTRACT_PATH)
    invalid = [name for name in tool_names if SNAKE_CASE_PATTERN.fullmatch(name) is None]
    if invalid:
        raise GateError(
            "MCP naming drift: non-snake_case tool names found: "
            + ", ".join(invalid)
        )
    if any("." in name for name in tool_names):
        raise GateError("MCP naming drift: dotted tool names are forbidden")
    missing_shared_tools = [name for name in scope.shared_tool_names if name not in tool_names]
    if missing_shared_tools:
        raise GateError(
            "shared-surface scope drift: MCP registration is missing authority-derived "
            "larva shared tools: "
            + ", ".join(missing_shared_tools)
        )
    return list(scope.shared_tool_names)


def check_docs_parity(paths: GatePaths, scope: AuthorityScope, tool_names: Sequence[str]) -> None:
    """Require repo-facing docs to track shared naming and legacy-field semantics.

    Sources:
    - conformance/shared_surfaces.yaml lines 483-494
    - conformance/case_matrix/larva/*

    Args:
        paths: Repo locations.
        tool_names: Shared MCP tool names exported by larva.

    Raises:
        GateError: If docs drift from shared naming or invalid-field wording.
    """

    docs_text = _combined_docs_text(paths.larva_root)
    missing_tool_names = [name for name in tool_names if name not in docs_text]
    if missing_tool_names:
        raise GateError(
            "docs parity drift: repo-facing docs do not mention registered MCP names: "
            + ", ".join(missing_tool_names)
        )
    authority_dotted_aliases = set(scope.dotted_aliases)
    authority_dotted_aliases.update(_dotted_alias(name) for name in tool_names)
    dotted_names = [alias for alias in sorted(authority_dotted_aliases) if alias in docs_text]
    if dotted_names:
        raise GateError(
            "docs parity drift: dotted MCP aliases appear in repo-facing docs: "
            + ", ".join(dotted_names)
        )
    for field_name in scope.forbidden_fields:
        if field_name not in docs_text:
            raise GateError(
                "docs parity drift: repo-facing docs must mention invalid field "
                f"{field_name}"
            )
        field_window = re.findall(
            rf"[^\n]{{0,120}}{re.escape(field_name)}[^\n]{{0,120}}",
            docs_text,
        )
        if not any(any(word in window for word in INVALID_FIELD_WORDS) for window in field_window):
            raise GateError(
                "docs parity drift: repo-facing docs mention "
                f"{field_name} without invalid/rejected wording"
            )
    if (
        scope.prompt_must_be_opaque
        and "opaque executable" not in docs_text
        and "opaque data" not in docs_text
    ):
        raise GateError(
            "docs parity drift: prompt must remain documented as opaque text/data"
        )


def run_verify(paths: GatePaths) -> list[str]:
    """Run the repo-local conformance gate.

    Args:
        paths: Repo locations.

    Returns:
        Human-readable success evidence lines.
    """

    scope = _load_authority_scope(paths)
    check_frozen_authority_packet(paths, scope)
    check_schema_authority(paths, scope)
    check_capabilities_only_admission(paths, scope)
    tool_names = check_mcp_tool_naming(paths, scope)
    check_docs_parity(paths, scope, tool_names)
    return [
        f"frozen authority packet pin: PASS ({scope.packet.repository}@{scope.packet.ref})",
        "schema-authority parity: PASS",
        "capabilities-only admission metadata: PASS",
        f"mcp snake_case naming: PASS ({len(tool_names)} tools)",
        "repo-facing docs parity: PASS",
    ]


def _seed_expected_red_floating_ref_drift(workspace_root: Path) -> str:
    """Mutate the frozen authority ref to a floating value and confirm failure.

    Args:
        workspace_root: Temporary workspace root.

    Returns:
        Failure message from the gate.
    """

    lock_path = workspace_root / "larva" / AUTHORITY_LOCK_PATH
    lock_payload = _read_json(lock_path)
    if not isinstance(lock_payload, dict):
        raise GateError("expected-red setup failed: authority lock is not an object")
    lock_payload["ref"] = "main"
    lock_path.write_text(
        json.dumps(lock_payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    try:
        run_verify(
            GatePaths(
                larva_root=workspace_root / "larva",
                opifex_root=workspace_root / "opifex",
            )
        )
    except GateError as exc:
        return str(exc)
    raise GateError("expected-red failed: floating ref drift did not trip the gate")


def _seed_expected_red_scope_drift(workspace_root: Path) -> str:
    """Add an authority-derived shared tool and confirm local scope fails closed.

    Args:
        workspace_root: Temporary workspace root.

    Returns:
        Failure message from the gate.
    """

    shared_surfaces_path = workspace_root / "opifex" / SHARED_SURFACES_PATH
    shared_surfaces = _read_yaml(shared_surfaces_path)
    if not isinstance(shared_surfaces, dict):
        raise GateError("expected-red setup failed: shared_surfaces root is not a mapping")
    surfaces = shared_surfaces.get("shared_surfaces")
    if not isinstance(surfaces, list):
        raise GateError("expected-red setup failed: shared_surfaces list missing")
    surfaces.append(
        {
            "id": "larva_shadow",
            "owner_repo": "larva",
            "kind": "mcp_tools_call",
            "exposure": "shared",
            "contract_refs": [
                "design/final-canonical-contract.md",
                "contracts/persona_spec.schema.json",
            ],
            "case_matrix": ["conformance/case_matrix/larva/larva.shadow.yaml"],
        }
    )
    shared_surfaces_path.write_text(
        yaml.safe_dump(shared_surfaces, sort_keys=False),
        encoding="utf-8",
    )
    shadow_case_path = (
        workspace_root / "opifex" / "conformance/case_matrix/larva/larva.shadow.yaml"
    )
    shadow_case_path.parent.mkdir(parents=True, exist_ok=True)
    shadow_case_path.write_text(
        yaml.safe_dump(
            {
                "surface_id": "larva_shadow",
                "cases": [
                    {
                        "id": "happy_path",
                        "class": "happy_path",
                        "expected": {"result": "accept"},
                    }
                ],
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    try:
        run_verify(
            GatePaths(
                larva_root=workspace_root / "larva",
                opifex_root=workspace_root / "opifex",
            )
        )
    except GateError as exc:
        return str(exc)
    raise GateError("expected-red failed: authority scope drift did not trip the gate")


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
        raise GateError("expected-red setup failed: schema root is not an object")
    schema["description"] = "Drifted local schema description"
    schema_path.write_text(
        json.dumps(schema, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    try:
        run_verify(
            GatePaths(
                larva_root=workspace_root / "larva",
                opifex_root=workspace_root / "opifex",
            )
        )
    except GateError as exc:
        return str(exc)
    raise GateError("expected-red failed: schema drift did not trip the gate")


def _seed_expected_red_docs_drift(workspace_root: Path) -> str:
    """Mutate docs to a dotted MCP name and confirm the gate fails.

    Args:
        workspace_root: Temporary workspace root.

    Returns:
        Failure message from the gate.
    """

    readme_path = workspace_root / "larva" / "README.md"
    readme_text = _read_text(readme_path)
    readme_path.write_text(
        readme_text.replace("larva_resolve", "larva.resolve", 1),
        encoding="utf-8",
    )
    try:
        run_verify(
            GatePaths(
                larva_root=workspace_root / "larva",
                opifex_root=workspace_root / "opifex",
            )
        )
    except GateError as exc:
        return str(exc)
    raise GateError("expected-red failed: docs naming drift did not trip the gate")


def _seed_expected_red_capability_drift(workspace_root: Path) -> str:
    """Mutate required-field metadata and confirm the gate fails.

    Args:
        workspace_root: Temporary workspace root.

    Returns:
        Failure message from the gate.
    """

    contract_path = workspace_root / "larva" / VALIDATION_CONTRACT_PATH
    contract_text = _read_text(contract_path)
    contract_path.write_text(
        contract_text.replace('    "capabilities",\n', "", 1),
        encoding="utf-8",
    )
    try:
        run_verify(
            GatePaths(
                larva_root=workspace_root / "larva",
                opifex_root=workspace_root / "opifex",
            )
        )
    except GateError as exc:
        return str(exc)
    raise GateError("expected-red failed: capabilities drift did not trip the gate")


def run_expected_red(paths: GatePaths) -> list[str]:
    """Seed representative drift and prove the gate fails closed.

    Args:
        paths: Repo locations.

    Returns:
        Human-readable evidence lines.
    """

    with tempfile.TemporaryDirectory(prefix="larva-repo-local-gate-") as tmp_dir:
        workspace_root = Path(tmp_dir)
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=COPYTREE_IGNORE)
        shutil.copytree(paths.opifex_root, workspace_root / "opifex", ignore=COPYTREE_IGNORE)
        schema_failure = _seed_expected_red_schema_drift(workspace_root)

        shutil.rmtree(workspace_root / "larva")
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=COPYTREE_IGNORE)
        docs_failure = _seed_expected_red_docs_drift(workspace_root)

        shutil.rmtree(workspace_root / "larva")
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=COPYTREE_IGNORE)
        capability_failure = _seed_expected_red_capability_drift(workspace_root)

        shutil.rmtree(workspace_root / "larva")
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=COPYTREE_IGNORE)
        floating_ref_failure = _seed_expected_red_floating_ref_drift(workspace_root)

        shutil.rmtree(workspace_root / "larva")
        shutil.copytree(paths.larva_root, workspace_root / "larva", ignore=COPYTREE_IGNORE)
        scope_failure = _seed_expected_red_scope_drift(workspace_root)

    return [
        f"expected-red frozen ref drift: PASS ({floating_ref_failure})",
        f"expected-red schema drift: PASS ({schema_failure})",
        f"expected-red docs naming drift: PASS ({docs_failure})",
        f"expected-red capabilities drift: PASS ({capability_failure})",
        f"expected-red authority scope drift: PASS ({scope_failure})",
    ]


def _build_parser() -> argparse.ArgumentParser:
    """Build the CLI parser.

    Returns:
        Configured argument parser.
    """

    parser = argparse.ArgumentParser(
        description="larva repo-local shared-surface CI gate"
    )
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
    paths = GatePaths(
        larva_root=args.larva_root.resolve(),
        opifex_root=args.opifex_root.resolve(),
    )
    try:
        evidence_lines = (
            run_expected_red(paths)
            if args.mode == "expected-red"
            else run_verify(paths)
        )
    except GateError as exc:
        print(f"FAIL: {exc}")
        return 1
    for line in evidence_lines:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
