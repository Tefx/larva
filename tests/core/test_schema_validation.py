"""Schema validation tests for persona_spec.schema.json during ADR-002 transition.

Tests verify that the schema correctly supports:
1. tools-only specs (backward compatibility)
2. capabilities-only specs (target model)
3. both-fields specs (transition period)
4. neither-field specs (must fail - no tool access declared)
"""

import json
from pathlib import Path

import jsonschema
import pytest


# Load schema once for all tests
SCHEMA_PATH = Path(__file__).parent.parent.parent / "contracts" / "persona_spec.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text())


def validate_persona_spec(spec: dict) -> tuple[bool, str]:
    """Validate a persona spec against the schema.

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        jsonschema.validate(spec, SCHEMA)
        return True, ""
    except jsonschema.ValidationError as e:
        return False, str(e.message)


class TestToolsOnlySpec:
    """Tests for tools-only persona spec (backward compatibility during transition)."""

    def test_tools_only_spec_validates(self) -> None:
        """Assert tools-only spec validates during transition window."""
        spec = {
            "id": "test-persona",
            "description": "A test persona with tools only",
            "prompt": "You are a helpful assistant",
            "model": "gpt-4",
            "tools": {"filesystem": "read_write", "git": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert is_valid, f"tools-only spec should validate, but got error: {error}"

    def test_tools_only_without_capabilities_field(self) -> None:
        """Assert tools-only spec without capabilities field is valid."""
        spec = {
            "id": "legacy-persona",
            "description": "Legacy persona using tools",
            "prompt": "You are helpful",
            "model": "claude-sonnet-4-20250514",
            "tools": {"web_search": "read_only"},
            "spec_version": "0.1.0",
        }
        # Ensure capabilities field is absent
        assert "capabilities" not in spec
        is_valid, error = validate_persona_spec(spec)
        assert is_valid, f"tools-only without capabilities should validate: {error}"


class TestCapabilitiesOnlySpec:
    """Tests for capabilities-only persona spec (ADR-002 target model)."""

    def test_capabilities_only_spec_validates(self) -> None:
        """Assert capabilities-only spec validates (canonical target model)."""
        spec = {
            "id": "developer",
            "description": "Developer persona",
            "prompt": "You help with development",
            "model": "claude-sonnet-4-20250514",
            "capabilities": {"filesystem": "read_write", "git": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert is_valid, f"capabilities-only spec should validate: {error}"

    def test_capabilities_only_without_tools_field(self) -> None:
        """Assert capabilities-only spec without tools field is valid."""
        spec = {
            "id": "new-persona",
            "description": "New persona using capabilities",
            "prompt": "You assist",
            "model": "gpt-4",
            "capabilities": {"search": "read_only"},
            "spec_version": "0.1.0",
        }
        # Ensure tools field is absent
        assert "tools" not in spec
        is_valid, error = validate_persona_spec(spec)
        assert is_valid, f"capabilities-only without tools should validate: {error}"


class TestBothFieldsSpec:
    """Tests for persona specs with both tools and capabilities (transition period)."""

    def test_both_fields_spec_validates(self) -> None:
        """Assert spec with both tools and capabilities validates during transition."""
        spec = {
            "id": "transition-persona",
            "description": "Persona during transition",
            "prompt": "You help",
            "model": "gpt-4",
            "tools": {"filesystem": "read_write"},
            "capabilities": {"filesystem": "read_write"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert is_valid, f"both-fields spec should validate: {error}"

    def test_both_fields_with_different_values(self) -> None:
        """Assert both fields can have different values during transition."""
        spec = {
            "id": "migration-persona",
            "description": "Migrating persona",
            "prompt": "You assist",
            "model": "claude-sonnet-4-20250514",
            "tools": {"filesystem": "read_only"},
            "capabilities": {"filesystem": "read_write"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert is_valid, f"both-fields with different values should validate: {error}"


class TestNeitherFieldSpec:
    """Tests for persona specs with neither tools nor capabilities (must fail)."""

    def test_neither_field_spec_fails(self) -> None:
        """Assert spec without tools or capabilities fails validation."""
        spec = {
            "id": "invalid-persona",
            "description": "Invalid persona",
            "prompt": "You help",
            "model": "gpt-4",
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert not is_valid, "spec without tools or capabilities should fail validation"
        # Error message should contain "anyOf" or mention the schema constraint
        assert "anyOf" in error.lower() or "schema" in error.lower()

    def test_neither_field_error_message(self) -> None:
        """Assert validation error mentions tools/capabilities requirement."""
        spec = {
            "id": "bad-persona",
            "description": "Bad",
            "prompt": "You help",
            "model": "gpt-4",
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert not is_valid
        # Error should mention that validation failed under anyOf schemas
        assert "anyOf" in error.lower() or "schema" in error.lower()


class TestSchemaRequiredFields:
    """Tests to verify required fields remain properly constrained."""

    def test_id_always_required(self) -> None:
        """Assert id field is always required."""
        spec = {
            "description": "No id",
            "prompt": "You help",
            "model": "gpt-4",
            "capabilities": {"search": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert not is_valid

    def test_description_always_required(self) -> None:
        """Assert description field is always required."""
        spec = {
            "id": "test",
            "prompt": "You help",
            "model": "gpt-4",
            "capabilities": {"search": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert not is_valid

    def test_prompt_always_required(self) -> None:
        """Assert prompt field is always required."""
        spec = {
            "id": "test",
            "description": "Test",
            "model": "gpt-4",
            "capabilities": {"search": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert not is_valid

    def test_model_always_required(self) -> None:
        """Assert model field is always required."""
        spec = {
            "id": "test",
            "description": "Test",
            "prompt": "You help",
            "capabilities": {"search": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert not is_valid

    def test_spec_version_always_required(self) -> None:
        """Assert spec_version field is always required."""
        spec = {
            "id": "test",
            "description": "Test",
            "prompt": "You help",
            "model": "gpt-4",
            "capabilities": {"search": "read_only"},
        }
        is_valid, error = validate_persona_spec(spec)
        assert not is_valid


class TestSchemaDriftFromCanonical:
    """Tests exposing schema drift from canonical contract.

    These tests document the divergence between:
    - the local JSON schema (contracts/persona_spec.schema.json)
    - the opifex canonical contract (INTERFACES.md / validate.py docstring)

    Gap documentation:
    - gap_1: schema accepts tools (anyOf requires tools OR capabilities)
    - gap_2: schema accepts side_effect_policy (declared but not forbidden)
    - gap_3: schema does NOT enforce capabilities as required
    - gap_4: schema allows extra unknown fields (additionalProperties: true in model_params only)
      BUT the canonical contract forbids unknown top-level fields
    - gap_5: tools is not marked as forbidden in schema
    """

    def test_schema_allows_tools_without_capabilities(self) -> None:
        """Schema accepts tools-only spec, but canonical contract forbids tools.

        Gap: Schema uses anyOf to allow tools OR capabilities.
        Canonical: tools is never admissible at canonical boundary.
        Downstream step: canonical_core_admission.implementation
        """
        # This spec uses only tools (no capabilities) - allowed by schema, forbidden by canonical
        spec = {
            "id": "tools-only-persona",
            "description": "Persona using deprecated tools field",
            "prompt": "You are helpful",
            "model": "gpt-4",
            "tools": {"filesystem": "read_write"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        # Schema says valid, but canonical contract says FORBIDDEN
        assert is_valid, (
            f"Schema accepts tools-only (valid per schema), but canonical forbids it: {error}"
        )
        # This documents the gap - schema permits but canonical rejects

    def test_schema_allows_side_effect_policy(self) -> None:
        """Schema accepts side_effect_policy, but canonical contract forbids it.

        Gap: side_effect_policy is declared in schema properties but not forbidden.
        Canonical: side_effect_policy is forbidden at canonical admission boundary.
        Downstream step: canonical_core_admission.implementation
        """
        spec = {
            "id": "sep-persona",
            "description": "Persona with deprecated side_effect_policy",
            "prompt": "You are helpful",
            "model": "gpt-4",
            "capabilities": {"shell": "read_only"},
            "side_effect_policy": "read_only",
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        # Schema says valid, canonical contract says forbidden
        assert is_valid, f"Schema accepts side_effect_policy, but canonical forbids: {error}"

    def test_schema_allows_extra_top_level_fields(self) -> None:
        """Schema allows extra unknown fields, but canonical contract forbids them.

        Gap: additionalProperties is false at root, BUT the schema structure
        means local validate.py doesn't actually check this.
        This test documents that the JSON schema itself doesn't validate
        extra field prohibition (it relies on code-level validation).
        Downstream step: canonical_core_admission.implementation
        """
        spec = {
            "id": "extra-fields-persona",
            "description": "Persona with unknown extra field",
            "prompt": "You are helpful",
            "model": "gpt-4",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
            "unknown_canonical_field": "forbidden_value",
        }
        is_valid, error = validate_persona_spec(spec)
        # Schema with additionalProperties:false should reject extra fields
        assert not is_valid, (
            "Schema should reject unknown top-level fields "
            "(additionalProperties:false at root), but got valid"
        )

    def test_canonical_required_only_shape_passes_schema(self) -> None:
        """Canonical required-only shape (id, description, prompt, model, capabilities, spec_version).

        This is the shape that canonical contract says MUST be admitted.
        Schema should accept it.
        """
        canonical = {
            "id": "canonical-persona",
            "description": "Canonical test persona",
            "prompt": "You are a test assistant.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(canonical)
        assert is_valid, f"Canonical required-only shape should pass schema: {error}"

    def test_tools_with_capabilities_passes_schema(self) -> None:
        """Spec with both tools and capabilities passes schema.

        Gap: Schema allows this; canonical contract forbids tools presence entirely.
        """
        spec = {
            "id": "both-fields-persona",
            "description": "Persona with both tools and capabilities",
            "prompt": "You are helpful",
            "model": "gpt-4",
            "capabilities": {"shell": "read_only"},
            "tools": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        is_valid, error = validate_persona_spec(spec)
        assert is_valid, f"Schema allows both fields, but canonical forbids tools: {error}"


class TestSchemaVsCanonicalContractSummary:
    """Summary of schema vs. canonical contract drift.

    These tests summarize the expected behaviors for the implementation phase.
    """

    def test_canonical_fixtures_summary(self) -> None:
        """Summary: Canonical contract requires capabilities, forbids tools/side_effect_policy.

        Canonical admission contract (per INTERFACES.md and validate.py):
        - REQUIRED: id, description, prompt, model, capabilities, spec_version
        - FORBIDDEN: tools, side_effect_policy, unknown extra fields
        - OPTIONAL: model_params, can_spawn, compaction_prompt, spec_digest

        Schema (contracts/persona_spec.schema.json):
        - REQUIRED: id, description, prompt, model, spec_version (capabilities NOT required by schema)
        - anyOf: tools OR capabilities (so tools-only is valid per schema)
        - side_effect_policy: declared in properties (accepted)
        - additionalProperties: false at root (extra fields rejected by schema, but gap_3)

        This divergence is what the implementation step must resolve.
        """
        pass  # Documentation only - actual gap tests above
