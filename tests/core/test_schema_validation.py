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
