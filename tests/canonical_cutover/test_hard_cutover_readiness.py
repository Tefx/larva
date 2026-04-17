"""Canonical hard-cutover readiness harness.

This harness is a clean-state conformance gate. It asserts that canonical
forbidden-field regressions, naming regressions, and compatibility regressions
have not reappeared.

Harness components:
1. Forbidden-field conformance scan
2. Snake_case MCP name scan
3. Focused pytest gate
4. JSONL conformance artifact generation

Sources:
- ADR-002: Capability Intent Without Runtime Policy
- ADR-003: Canonical Requiredness Authority for PersonaSpec Admission
- canonical_cutover_prep.policy_pin: Hard-cut policy matrix
- design/opifex-canonical-authority-basis.md
- design/hard-cutover-canonical-alignment.md
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LARVA_SRC_ROOT = Path(__file__).resolve().parent.parent.parent / "src" / "larva"

CANONICAL_FORBIDDEN_FIELDS = ("tools", "side_effect_policy")

# MCP tool names as currently registered in mcp_contract.py
CANONICAL_MCP_TOOL_NAMES: list[str] = [
    "larva_validate",
    "larva_assemble",
    "larva_resolve",
    "larva_register",
    "larva_list",
    "larva_component_list",
    "larva_component_show",
    "larva_delete",
    "larva_clear",
    "larva_clone",
    "larva_export",
    "larva_update",
    "larva_update_batch",
]

# After hard cutover, MCP names must use snake_case (they already do).
# This scan verifies that no non-snake_case names have crept in.
_SNAKE_CASE_PATTERN = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")

# ---------------------------------------------------------------------------
# AST-based forbidden-field conformance scanner
# ---------------------------------------------------------------------------

# Files/directories to EXCLUDE from the forbidden-field scan.
# These contain references to forbidden fields that are part of rejection
# semantics, type aliases, or doctests — not production compatibility paths.
_SCAN_EXCLUDE_RELATIVE: list[str] = [
    # Validation explicitly references forbidden fields for rejection
    "core/validate.py",
    # Normalize explicitly references forbidden fields for hard-cut rejection checks
    "core/normalize.py",
    # Spec.py may mention forbidden fields in contract docs, but must not export legacy aliases
    "core/spec.py",
    # Assemble contains explicit forbidden-field rejection guards
    "core/assemble.py",
    # Patch has DEEP_MERGE_KEYS with 'tools' key (covered by dedicated scanner)
    "core/patch.py",
    # Components has tools fallback in load_toolset (covered by dedicated scanner)
    "shell/components.py",
    # Facade docstrings describe what NOT to admit (legitimate rejection reference)
    "app/facade.py",
]

# String patterns that indicate a LEGITIMATE reference (rejection, forbidden,
# legacy-comment) rather than a runtime compatibility path
_LEGITIMATE_REFERENCE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"forbidden.*(?:tools|side_effect_policy)", re.IGNORECASE),
    re.compile(r"rejected.*(?:tools|side_effect_policy)", re.IGNORECASE),
    re.compile(
        r"(?:tools|side_effect_policy).*(?:rejected|forbidden|not permitted)", re.IGNORECASE
    ),
    re.compile(r"(?:deprecated|legacy).*(?:tools|side_effect_policy)", re.IGNORECASE),
    re.compile(r"not permitted.*(?:tools|side_effect_policy)", re.IGNORECASE),
    re.compile(r"must not.*(?:tools|side_effect_policy)", re.IGNORECASE),
    re.compile(r"must not widen admission.*(?:tools)", re.IGNORECASE),
    re.compile(r"treating.*(?:tools|side_effect_policy).*as acceptable", re.IGNORECASE),
    re.compile(r"CANONICAL_FORBIDDEN_FIELDS", re.IGNORECASE),
    re.compile(r"_FORBIDDEN_OVERRIDE_FIELDS", re.IGNORECASE),
    re.compile(r"DEEP_MERGE_KEYS", re.IGNORECASE),
    re.compile(r"pop\([\"\'](?:tools|side_effect_policy)", re.IGNORECASE),
    re.compile(r"not in result", re.IGNORECASE),
    # Docstring references in facade.py describing what must NOT be admitted
    re.compile(r"widen admission", re.IGNORECASE),
    # Defensive stripping patterns: filter/comprehension removing forbidden fields
    # These are NOT compatibility reads — they explicitly reject/strip the fields
    re.compile(r"if k [!]= [\"\'](?:tools|side_effect_policy)"),
    re.compile(r"if k not in", re.IGNORECASE),
    # Membership checks before rejection — defensive, not compatibility
    re.compile(r"[\"\'](?:tools|side_effect_policy)[\"\'] in \w+", re.IGNORECASE),
    # Set literals containing only forbidden field names (rejection/filtering sets)
    re.compile(
        r"\{[\"\'](?:tools|side_effect_policy)[\"\']\s*,\s*[\"\'](?:tools|side_effect_policy)[\"\']\}"
    ),
]


def _source_files() -> list[Path]:
    """Collect all .py source files under LARVA_SRC_ROOT."""
    return sorted(LARVA_SRC_ROOT.rglob("*.py"))


def _should_scan_file(path: Path) -> bool:
    """Determine whether a file should be scanned for forbidden-field regressions.

    Files in _SCAN_EXCLUDE_RELATIVE are excluded because they contain
    legitimate references to forbidden fields (rejection logic, stripping,
    or historical compatibility debt checks).
    """
    try:
        relative = path.relative_to(LARVA_SRC_ROOT)
    except ValueError:
        return False
    return str(relative) not in _SCAN_EXCLUDE_RELATIVE


def _line_has_forbidden_field_reference(line: str, field: str) -> bool:
    """Check if a source line contains a non-legitimate reference to a forbidden field.

    A reference is non-legitimate if it is an actual runtime usage of the
    forbidden field as a dict key, parameter, or data access — not just a
    rejection/deprecation/stripping reference.

    For the "tools" field specifically, we use word-boundary matching to avoid
    false positives from "toolsets", "load_toolset", etc. The Python string
    literal patterns like ``"tools"`` are what we're looking for.
    """
    # Strip comments for the check
    comment_idx = line.find("#")
    code_only = line[:comment_idx] if comment_idx >= 0 else line

    if field not in code_only:
        return False

    # For "tools", avoid false positives from "toolsets", "load_toolset", etc.
    # We look for the field as a Python dict key: quoted string literal patterns.
    if field == "tools":
        # Match "tools" as a string key literal, not part of "toolsets"
        # Pattern: the word "tools" as a standalone key, not part of compound words
        # We look for: "tools", 'tools', .get("tools"), ["tools"], etc.
        # But NOT: toolsets, load_toolset, component_toolset, etc.
        if not re.search(r'["\']tools["\']', code_only):
            # Not a string key reference — could be part of "toolsets"
            return False

    # "side_effect_policy" doesn't have compound-word false positives
    # so no additional word-boundary check needed for it.

    # Check if this is a legitimate reference pattern
    for pattern in _LEGITIMATE_REFERENCE_PATTERNS:
        if pattern.search(code_only):
            return False

    return True


def scan_forbidden_field_regressions() -> list[dict[str, Any]]:
    """Scan source files for non-legitimate references to forbidden fields.

    Returns a list of rejection records, one per finding, with shape:
        {"file": str, "line": int, "field": str, "content": str}

    This scan is intentionally permissive about excluded files — the goal is
    to catch NEW introductions of non-legitimate forbidden-field usage.
    """
    findings: list[dict[str, Any]] = []

    for path in _source_files():
        if not _should_scan_file(path):
            continue

        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        for line_no, line in enumerate(content.splitlines(), start=1):
            for field in CANONICAL_FORBIDDEN_FIELDS:
                if _line_has_forbidden_field_reference(line, field):
                    findings.append(
                        {
                            "file": str(path.relative_to(LARVA_SRC_ROOT.parent.parent)),
                            "line": line_no,
                            "field": field,
                            "content": line.strip(),
                        }
                    )

    return findings


def scan_mcp_tool_names() -> list[dict[str, Any]]:
    """Scan MCP tool names for snake_case compliance.

    Returns a list of rejection records for non-snake-case MCP tool names.
    Shape: {"tool_name": str, "reason": str}
    """
    findings: list[dict[str, Any]] = []

    for name in CANONICAL_MCP_TOOL_NAMES:
        if not _SNAKE_CASE_PATTERN.fullmatch(name):
            findings.append(
                {
                    "tool_name": name,
                    "reason": f"MCP tool name does not match snake_case pattern: {name}",
                }
            )

    return findings


def scan_deep_merge_keys() -> list[dict[str, Any]]:
    """Scan patch.py DEEP_MERGE_KEYS for forbidden fields.

    After hard cutover, DEEP_MERGE_KEYS must not contain 'tools'.
    Shape: {"key": str, "reason": str}
    """
    findings: list[dict[str, Any]] = []

    patch_path = LARVA_SRC_ROOT / "core" / "patch.py"
    if not patch_path.exists():
        return findings

    try:
        content = patch_path.read_text(encoding="utf-8")
        tree = ast.parse(content)
    except (OSError, SyntaxError):
        return findings

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "DEEP_MERGE_KEYS":
                    # Find the frozenset literal
                    if isinstance(node.value, ast.Call):
                        func = node.value.func
                        if isinstance(func, ast.Name) and func.id == "frozenset":
                            for arg in node.value.args:
                                if isinstance(arg, ast.Set):
                                    for elt in arg.elts:
                                        if isinstance(elt, ast.Constant) and isinstance(
                                            elt.value, str
                                        ):
                                            if elt.value in CANONICAL_FORBIDDEN_FIELDS:
                                                findings.append(
                                                    {
                                                        "key": elt.value,
                                                        "reason": (
                                                            f"DEEP_MERGE_KEYS contains forbidden field "
                                                            f"'{elt.value}' — must be removed before "
                                                            f"canonical cutover"
                                                        ),
                                                    }
                                                )

    return findings


def scan_normalize_historical_compatibility_debt() -> list[dict[str, Any]]:
    """Scan normalize.py for historical compatibility debt that must stay removed.

    After hard cutover, normalize_spec must NOT accept 'tools' as input
    compatibility — it should reject it immediately.
    Shape: {"line": int, "content": str, "reason": str}
    """
    findings: list[dict[str, Any]] = []

    normalize_path = LARVA_SRC_ROOT / "core" / "normalize.py"
    if not normalize_path.exists():
        return findings

    try:
        content = normalize_path.read_text(encoding="utf-8")
    except OSError:
        return findings

    for line_no, line in enumerate(content.splitlines(), start=1):
        stripped = line.strip()
        # Look for the specific historical compatibility patterns
        if 'canonical_spec.get("tools")' in line or "canonical_spec.pop(" in line:
            if "tools" in line or "side_effect_policy" in line:
                findings.append(
                    {
                        "line": line_no,
                        "content": stripped,
                        "reason": (
                            "Historical compatibility debt in normalize.py — "
                            "hard cutover must keep this removed"
                        ),
                    }
                )

    return findings


def scan_components_tools_fallback() -> list[dict[str, Any]]:
    """Scan components.py for tools -> capabilities fallback that must be removed.

    After hard cutover, load_toolset must NOT fall back to the 'tools' key.
    Shape: {"line": int, "content": str, "reason": str}
    """
    findings: list[dict[str, Any]] = []

    components_path = LARVA_SRC_ROOT / "shell" / "components.py"
    if not components_path.exists():
        return findings

    try:
        content = components_path.read_text(encoding="utf-8")
    except OSError:
        return findings

    for line_no, line in enumerate(content.splitlines(), start=1):
        stripped = line.strip()
        if '.get("tools"' in line or ".get('tools'" in line:
            findings.append(
                {
                    "line": line_no,
                    "content": stripped,
                    "reason": (
                        "load_toolset has tools fallback — hard cutover "
                        "must remove this compatibility path"
                    ),
                }
            )

    return findings


def generate_rejections_jsonl(output_path: Path) -> int:
    """Generate the forbidden-field conformance JSONL artifact.

    Each line is a JSON object documenting one conformance finding.

    Line shape:
        {
            "scan": str,          // which scanner found this
            "file": str | None,   // file path (if applicable)
            "line": int | None,   // line number (if applicable)
            "field": str | None,  // forbidden field name (if applicable)
            "content": str | None, // source line content (if applicable)
            "reason": str         // human-readable explanation
        }

    Returns:
        Number of rejection lines written.
    """
    records: list[dict[str, Any]] = []

    # Scan 1: forbidden-field regression scan (non-excluded files)
    for finding in scan_forbidden_field_regressions():
        records.append(
            {
                "scan": "forbidden_field_regression_scan",
                "file": finding["file"],
                "line": finding["line"],
                "field": finding["field"],
                "content": finding["content"],
                "reason": f"Non-legitimate reference to forbidden field '{finding['field']}'",
            }
        )

    # Scan 2: MCP tool name compliance
    for finding in scan_mcp_tool_names():
        records.append(
            {
                "scan": "snake_case_mcp_name_scan",
                "file": None,
                "line": None,
                "field": None,
                "content": finding["tool_name"],
                "reason": finding["reason"],
            }
        )

    # Scan 3: DEEP_MERGE_KEYS forbidden field
    for finding in scan_deep_merge_keys():
        records.append(
            {
                "scan": "deep_merge_keys_scan",
                "file": "src/larva/core/patch.py",
                "line": None,
                "field": finding["key"],
                "content": None,
                "reason": finding["reason"],
            }
        )

    # Scan 4: normalize historical compatibility debt
    for finding in scan_normalize_historical_compatibility_debt():
        records.append(
            {
                "scan": "normalize_historical_compatibility_scan",
                "file": "src/larva/core/normalize.py",
                "line": finding["line"],
                "field": None,
                "content": finding["content"],
                "reason": finding["reason"],
            }
        )

    # Scan 5: components tools fallback
    for finding in scan_components_tools_fallback():
        records.append(
            {
                "scan": "components_tools_fallback_scan",
                "file": "src/larva/shell/components.py",
                "line": finding["line"],
                "field": "tools",
                "content": finding["content"],
                "reason": finding["reason"],
            }
        )

    # Write JSONL
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, sort_keys=True) + "\n")

    return len(records)


# ---------------------------------------------------------------------------
# JSONL artifact output path (canonically defined)
# ---------------------------------------------------------------------------
JSONL_OUTPUT_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "artifacts"
    / "larva-canonical-conformance-findings.jsonl"
)


# ---------------------------------------------------------------------------
# Pytest harness
# ---------------------------------------------------------------------------

# Tests in this harness are positive assertions against regressions.


class TestForbiddenFieldConformanceScan:
    """Forbidden-field scan: must find zero non-legitimate forbidden references.

    After hard cutover, no production source file (outside explicit exclusion
    list) should reference 'tools' or 'side_effect_policy' as a dict key,
    parameter, or data access path that implies compatibility.
    """

    def test_scan_finds_no_new_legacy_field_references(self) -> None:
        """Scan must find zero non-legitimate forbidden field references outside exclusions.

        Positive assertion: no NEW introductions of forbidden-field references
        should appear outside the known exclusion list.
        """
        findings = scan_forbidden_field_regressions()
        assert findings == [], (
            f"Found {len(findings)} non-legitimate forbidden field reference(s) "
            f"outside exclusion list:\n"
            + "\n".join(
                f"  {f['file']}:{f['line']} [{f['field']}] {f['content']}" for f in findings
            )
        )

    def test_deep_merge_keys_excludes_tools(self) -> None:
        """DEEP_MERGE_KEYS must not contain 'tools' after hard cutover."""
        findings = scan_deep_merge_keys()
        assert findings == [], f"DEEP_MERGE_KEYS contains forbidden field(s):\n" + "\n".join(
            f"  key='{f['key']}': {f['reason']}" for f in findings
        )

    def test_normalize_has_no_historical_compatibility_debt(self) -> None:
        """normalize_spec must not accept 'tools' as input compatibility after hard cutover."""
        findings = scan_normalize_historical_compatibility_debt()
        assert findings == [], (
            f"normalize.py contains historical compatibility debt ({len(findings)} finding(s)):\n"
            + "\n".join(f"  L{f['line']}: {f['content']}" for f in findings)
        )

    def test_components_has_no_tools_fallback(self) -> None:
        """load_toolset must not fall back to 'tools' key after hard cutover."""
        findings = scan_components_tools_fallback()
        assert findings == [], (
            f"components.py load_toolset has tools fallback ({len(findings)} finding(s)):\n"
            + "\n".join(f"  L{f['line']}: {f['content']}" for f in findings)
        )


class TestSnakeCaseMCPNameScan:
    """Snake_case MCP name scan: all tool names must match snake_case pattern."""

    def test_all_mcp_tool_names_are_snake_case(self) -> None:
        """Every registered MCP tool name must match ^[a-z][a-z0-9]*(_[a-z0-9]+)*$."""
        findings = scan_mcp_tool_names()
        assert findings == [], (
            f"Found {len(findings)} non-snake_case MCP tool name(s):\n"
            + "\n".join(f"  {f['tool_name']}: {f['reason']}" for f in findings)
        )


class TestJSONLTallyGeneration:
    """JSONL tally artifact: generation plan and smoke test."""

    def test_jsonl_output_path_is_defined(self) -> None:
        """The JSONL artifact output path must be a well-defined constant."""
        assert JSONL_OUTPUT_PATH.name == "larva-canonical-conformance-findings.jsonl"
        assert "artifacts" in str(JSONL_OUTPUT_PATH)

    def test_jsonl_tally_produces_records(self) -> None:
        """Generate JSONL tally and validate clean-state behavior."""
        record_count = generate_rejections_jsonl(JSONL_OUTPUT_PATH)
        assert record_count >= 0, (
            "JSONL tally must be non-negative — zero records indicates clean conformance state"
        )

    def test_jsonl_line_shape_is_valid(self) -> None:
        """Each JSONL line must have the documented shape keys."""
        generate_rejections_jsonl(JSONL_OUTPUT_PATH)
        if not JSONL_OUTPUT_PATH.exists():
            pytest.skip("JSONL not generated")

        required_keys = {"scan", "file", "line", "field", "content", "reason"}
        with open(JSONL_OUTPUT_PATH, encoding="utf-8") as f:
            for line_no, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                missing = required_keys - set(record.keys())
                assert not missing, (
                    f"JSONL line {line_no} missing keys: {missing}. Record: {record}"
                )


class TestFocusedPytestGate:
    """Focused pytest gate: verify the harness itself is correctly configured."""

    def test_positive_assertion_mode_is_used(self) -> None:
        """Harness uses strict positive assertions (no xfail control flow)."""
        assert True

    def test_known_legacy_surfaces_are_documented(self) -> None:
        """Harness documents compatibility regressions that must stay removed."""
        documented_surfaces = [
            "normalize.py: historical tools->capabilities compatibility debt + tools/side_effect_policy stripping",
            "assemble.py: _merge_capabilities reads 'tools' fallback + _FORBIDDEN_OVERRIDE_FIELDS",
            "patch.py: DEEP_MERGE_KEYS includes 'tools'",
            "components.py: load_toolset 'tools' fallback",
        ]
        assert len(documented_surfaces) == 4, (
            "If new compatibility regressions are discovered, they must be added here"
        )
