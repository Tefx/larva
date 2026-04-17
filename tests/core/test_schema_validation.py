"""Parity checks for schema and MCP projections derived from validator metadata.

This module asserts that downstream projections stay aligned with the single
contract metadata seam in ``larva.core.validate``. It also includes explicit
failure-path tests that demonstrate drift detection for field sets and
canonical error wording.

Canonical authority (per ADR-002, ADR-003, opifex authority basis):
- Schema is a derived projection of validate.py metadata, not an independent owner.
- Forbidden fields (tools, side_effect_policy) must NOT appear in schema properties.
- additionalProperties must be false at canonical boundary.
- Canonical required/optional field sets are authoritative from validate.py.
"""

import json
from pathlib import Path
from typing import Any, get_type_hints

import jsonschema
import pytest
from hypothesis import given
from hypothesis import strategies as st

from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.shell import mcp_contract

SCHEMA_PATH = Path(__file__).parent.parent.parent / "contracts" / "persona_spec.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text())
OPIFEX_SCHEMA_PATH = Path("/Users/tefx/Projects/opifex/contracts/persona_spec.schema.json")
OPIFEX_SCHEMA = json.loads(OPIFEX_SCHEMA_PATH.read_text())

# ---------------------------------------------------------------------------
# Canonical fixtures
# ---------------------------------------------------------------------------

CANONICAL_SCHEMA_INSTANCE_MINIMAL: dict = {
    "id": "canonical-schema-fixture",
    "description": "Canonical schema fixture — minimal required-only shape",
    "prompt": "You are a canonical test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
}
"""Exact canonical shape that MUST validate against the JSON schema.
Required fields only, no optional fields, no forbidden fields."""

CANONICAL_SCHEMA_INSTANCE_FULL: dict = {
    "id": "canonical-schema-fixture-full",
    "description": "Canonical schema fixture — all optional fields present",
    "prompt": "You are a canonical test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only", "git": "read_write"},
    "model_params": {"temperature": 0.7},
    "can_spawn": True,
    "compaction_prompt": "Summarise the conversation.",
    "spec_version": "0.1.0",
    "spec_digest": "sha256:" + "a" * 64,
}
"""Canonical shape with every optional field present."""

NON_CANONICAL_EXTRA_FIELDS = ("variables", "tools", "side_effect_policy")


def _schema_parity_violations(schema: dict[str, Any]) -> list[str]:
    violations: list[str] = []

    expected_required = list(OPIFEX_SCHEMA["required"])
    actual_required = list(schema.get("required", []))
    if actual_required != expected_required:
        violations.append(
            f"required mismatch: expected={expected_required}, actual={actual_required}"
        )

    expected_allowed = set(OPIFEX_SCHEMA["properties"].keys())
    actual_properties = set(schema.get("properties", {}).keys())
    if actual_properties != expected_allowed:
        violations.append(
            f"properties mismatch: expected={sorted(expected_allowed)}, "
            f"actual={sorted(actual_properties)}"
        )

    forbidden = set(NON_CANONICAL_EXTRA_FIELDS)
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


def _tool_definition(name: str) -> Any:
    return next(tool for tool in mcp_contract.LARVA_MCP_TOOLS if tool["name"] == name)


class TestSchemaProjectionParity:
    """Tests that schema projection matches the single authoritative seam in validate.py."""

    def test_schema_projection_matches_validator_field_metadata(self) -> None:
        assert _schema_parity_violations(SCHEMA) == []

    def test_schema_forbids_tools_field(self) -> None:
        """Assert 'tools' does not appear in schema properties — ADR-002."""
        assert "tools" not in SCHEMA.get("properties", {}), (
            "'tools' must not be in schema properties; forbidden at canonical admission"
        )

    def test_schema_forbids_side_effect_policy_field(self) -> None:
        """Assert 'side_effect_policy' does not appear in schema properties — ADR-002."""
        assert "side_effect_policy" not in SCHEMA.get("properties", {}), (
            "'side_effect_policy' must not be in schema properties; "
            "forbidden at canonical admission"
        )

    def test_schema_sets_additional_properties_false(self) -> None:
        """Assert schema has additionalProperties=false at canonical boundary."""
        assert SCHEMA.get("additionalProperties") is False, (
            "Schema must set additionalProperties=false at canonical admission boundary"
        )


class TestSchemaAcceptanceRejection:
    """Tests for schema acceptance/rejection of canonical and forbidden shapes.

    Uses jsonschema to validate canonical fixtures pass and forbidden shapes fail.
    """

    def test_canonical_minimal_fixture_passes_schema(self) -> None:
        """Assert CANONICAL_SCHEMA_INSTANCE_MINIMAL validates against the schema.

        Spec-Fixture Conformance: this fixture matches the exact documented
        canonical shape without convenience fields.
        """
        jsonschema.validate(CANONICAL_SCHEMA_INSTANCE_MINIMAL, SCHEMA)

    def test_canonical_full_fixture_passes_schema(self) -> None:
        """Assert CANONICAL_SCHEMA_INSTANCE_FULL validates against the schema.

        Includes all optional canonical fields.
        """
        jsonschema.validate(CANONICAL_SCHEMA_INSTANCE_FULL, SCHEMA)

    @given(extra_field=st.sampled_from(NON_CANONICAL_EXTRA_FIELDS))
    def test_non_canonical_extra_fields_are_rejected_by_schema(self, extra_field: str) -> None:
        """Schema must reject every legacy extra field, not just one example."""
        invalid_spec = dict(CANONICAL_SCHEMA_INSTANCE_MINIMAL)
        invalid_spec[extra_field] = (
            {"shell": "read_only"} if extra_field in {"variables", "tools"} else "allow"
        )
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(invalid_spec, SCHEMA)

    def test_tools_field_rejected_by_schema(self) -> None:
        """Assert spec with 'tools' field is rejected by schema — ADR-002."""
        invalid_spec = dict(CANONICAL_SCHEMA_INSTANCE_MINIMAL)
        invalid_spec["tools"] = {"shell": "read_only"}
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(invalid_spec, SCHEMA)

    def test_side_effect_policy_field_rejected_by_schema(self) -> None:
        """Assert spec with 'side_effect_policy' is rejected by schema — ADR-002."""
        invalid_spec = dict(CANONICAL_SCHEMA_INSTANCE_MINIMAL)
        invalid_spec["side_effect_policy"] = "allow"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(invalid_spec, SCHEMA)

    def test_unknown_field_rejected_by_schema(self) -> None:
        """Assert spec with unknown top-level field is rejected by schema."""
        invalid_spec = dict(CANONICAL_SCHEMA_INSTANCE_MINIMAL)
        invalid_spec["unknown_extra"] = "value"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(invalid_spec, SCHEMA)

    @given(extra_field=st.sampled_from(NON_CANONICAL_EXTRA_FIELDS))
    def test_validator_uses_canonical_extra_field_error(self, extra_field: str) -> None:
        """Core validator taxonomy must match PersonaSpec v1 extra-field vocabulary."""
        invalid_spec = dict(CANONICAL_SCHEMA_INSTANCE_MINIMAL)
        invalid_spec[extra_field] = (
            {"shell": "read_only"} if extra_field in {"variables", "tools"} else "allow"
        )
        report = validate_module.validate_spec(invalid_spec)

        assert report["valid"] is False
        assert any(issue["code"] == "EXTRA_FIELD_NOT_ALLOWED" for issue in report["errors"])

    def test_missing_capabilities_rejected_by_schema(self) -> None:
        """Assert spec without 'capabilities' is rejected — required field."""
        invalid_spec = {
            "id": "no-caps",
            "description": "Test",
            "prompt": "You help.",
            "model": "gpt-4o-mini",
            "spec_version": "0.1.0",
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(invalid_spec, SCHEMA)

    def test_empty_spec_rejected_by_schema(self) -> None:
        """Assert empty dict is rejected by schema — all required fields missing."""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate({}, SCHEMA)


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


class TestCanonicalTypingSurface:
    def test_validator_metadata_does_not_advertise_variables(self) -> None:
        assert "variables" not in validate_module.CANONICAL_OPTIONAL_FIELDS

    def test_persona_spec_typed_dict_matches_canonical_schema_fields(self) -> None:
        persona_spec_fields = set(get_type_hints(spec_module.PersonaSpec).keys())
        assert persona_spec_fields == set(OPIFEX_SCHEMA["properties"].keys())

    def test_assembly_input_does_not_advertise_variables(self) -> None:
        assembly_input_fields = set(get_type_hints(spec_module.AssemblyInput).keys())
        assert "variables" not in assembly_input_fields

    def test_mcp_contract_does_not_advertise_variables(self) -> None:
        persona_spec_properties = mcp_contract._PERSONA_SPEC_INPUT_SCHEMA["properties"]
        assert "variables" not in persona_spec_properties

        assemble_definition = _tool_definition("larva_assemble")
        assemble_properties = assemble_definition["input_schema"]["properties"]
        assert "variables" not in assemble_properties

    def test_historical_alias_is_not_exported_from_canonical_typing_module(self) -> None:
        assert "SideEffectPolicy" not in spec_module.__all__
        assert not hasattr(spec_module, "SideEffectPolicy")
