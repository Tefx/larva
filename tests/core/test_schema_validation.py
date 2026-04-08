"""Parity checks for schema and MCP projections derived from validator metadata.

This module asserts that downstream projections stay aligned with the single
contract metadata seam in ``larva.core.validate``. It also includes explicit
failure-path tests that demonstrate drift detection for field sets and
canonical error wording.
"""

import json
from pathlib import Path
from typing import Any, get_type_hints

from larva.core import validate as validate_module
from larva.shell import mcp_contract

SCHEMA_PATH = Path(__file__).parent.parent.parent / "contracts" / "persona_spec.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text())


def _schema_parity_violations(schema: dict[str, Any]) -> list[str]:
    violations: list[str] = []

    expected_required = list(validate_module.CANONICAL_REQUIRED_FIELDS)
    actual_required = list(schema.get("required", []))
    if actual_required != expected_required:
        violations.append(
            f"required mismatch: expected={expected_required}, actual={actual_required}"
        )

    expected_allowed = set(validate_module.CANONICAL_REQUIRED_FIELDS) | set(
        validate_module.CANONICAL_OPTIONAL_FIELDS
    )
    actual_properties = set(schema.get("properties", {}).keys())
    if actual_properties != expected_allowed:
        violations.append(
            f"properties mismatch: expected={sorted(expected_allowed)}, "
            f"actual={sorted(actual_properties)}"
        )

    forbidden = set(validate_module.CANONICAL_FORBIDDEN_FIELDS)
    leaked_forbidden = sorted(forbidden & actual_properties)
    if leaked_forbidden:
        violations.append(f"forbidden fields present in schema properties: {leaked_forbidden}")

    if schema.get("additionalProperties") is not False:
        violations.append("schema must set additionalProperties=false at canonical boundary")

    return violations


def _tool_phrase_violations(*, text: str, require_capabilities_term: bool) -> list[str]:
    violations: list[str] = []
    lowered = text.lower()

    if validate_module.CANONICAL_TOOLS_REJECTED_CLAUSE not in lowered:
        violations.append("missing canonical tools-rejected clause")

    if require_capabilities_term and "requires capabilities" not in lowered:
        violations.append("missing canonical capabilities-required clause")

    return violations


def _tool_definition(name: str) -> dict[str, Any]:
    return next(tool for tool in mcp_contract.LARVA_MCP_TOOLS if tool["name"] == name)


class TestSchemaProjectionParity:
    def test_schema_projection_matches_validator_field_metadata(self) -> None:
        assert _schema_parity_violations(SCHEMA) == []


class TestMCPProjectionParity:
    def test_validation_shapes_match_validator_shape_metadata(self) -> None:
        issue_keys = tuple(get_type_hints(mcp_contract.ValidationIssue).keys())
        report_keys = tuple(get_type_hints(mcp_contract.ValidationReport).keys())

        assert issue_keys == validate_module.VALIDATION_ISSUE_KEYS
        assert report_keys == validate_module.VALIDATION_REPORT_KEYS

    def test_validate_tool_projection_mentions_tools_rejected_clause(self) -> None:
        validate_tool = _tool_definition("larva_validate")
        projection_text = " ".join(
            [
                str(validate_tool["description"]),
                str(validate_tool["input_schema"]["properties"]["spec"]["description"]),
            ]
        ).lower()

        assert _tool_phrase_violations(text=projection_text, require_capabilities_term=False) == []

    def test_mutating_tools_rejected_phrase_is_detected(self) -> None:
        drifted_text = "Validate a PersonaSpec using capabilities field only."
        violations = _tool_phrase_violations(
            text=drifted_text,
            require_capabilities_term=False,
        )
        assert "missing canonical tools-rejected clause" in violations

    def test_capabilities_required_tool_projections_include_both_terms(self) -> None:
        for tool_name in (
            "larva_assemble",
            "larva_resolve",
            "larva_register",
            "larva_update",
            "larva_update_batch",
        ):
            description = str(_tool_definition(tool_name)["description"]).lower()
            assert (
                _tool_phrase_violations(
                    text=description,
                    require_capabilities_term=True,
                )
                == []
            )

    def test_mutating_capabilities_required_phrase_is_detected(self) -> None:
        drifted_text = (
            "Register a PersonaSpec in the global registry; "
            "tools is rejected at canonical admission."
        )
        violations = _tool_phrase_violations(
            text=drifted_text,
            require_capabilities_term=True,
        )
        assert "missing canonical capabilities-required clause" in violations


class TestFailurePathDriftDetection:
    def test_required_field_drift_is_detected(self) -> None:
        drifted_schema = dict(SCHEMA)
        drifted_schema["required"] = [
            field for field in SCHEMA["required"] if field != "capabilities"
        ]

        violations = _schema_parity_violations(drifted_schema)
        assert any(v.startswith("required mismatch") for v in violations)

    def test_forbidden_field_drift_is_detected(self) -> None:
        drifted_schema = dict(SCHEMA)
        drifted_properties = dict(SCHEMA["properties"])
        drifted_properties["tools"] = {"type": "object"}
        drifted_schema["properties"] = drifted_properties

        violations = _schema_parity_violations(drifted_schema)
        assert any("forbidden fields present" in v for v in violations)
