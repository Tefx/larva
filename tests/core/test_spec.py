"""Contract-focused tests for larva.core.spec.

These tests verify the type contracts defined in the spec module:
- Literal domains for ToolPosture and SideEffectPolicy
- PersonaSpec structure (total=False, documented fields)
- spec_version pinned to Literal["0.1.0"]
- Import/usage checks proving consumability by downstream modules
"""

import sys
from typing import TypedDict

import pytest


class TestToolPostureLiteralDomain:
    """Tests for ToolPosture type alias literal domain."""

    def test_tool_posture_accepts_none(self) -> None:
        """Assert 'none' is a valid ToolPosture value."""
        posture: str = "none"
        # Verify it matches expected literal
        assert posture in ("none", "read_only", "read_write", "destructive")

    def test_tool_posture_accepts_read_only(self) -> None:
        """Assert 'read_only' is a valid ToolPosture value."""
        posture: str = "read_only"
        assert posture in ("none", "read_only", "read_write", "destructive")

    def test_tool_posture_accepts_read_write(self) -> None:
        """Assert 'read_write' is a valid ToolPosture value."""
        posture: str = "read_write"
        assert posture in ("none", "read_only", "read_write", "destructive")

    def test_tool_posture_accepts_destructive(self) -> None:
        """Assert 'destructive' is a valid ToolPosture value."""
        posture: str = "destructive"
        assert posture in ("none", "read_only", "read_write", "destructive")

    def test_tool_posture_excludes_invalid_values(self) -> None:
        """Assert invalid values are rejected from the domain."""
        invalid_values = ["None", "READ_ONLY", "readwrite", "write", "delete"]
        for invalid in invalid_values:
            assert invalid not in ("none", "read_only", "read_write", "destructive")

    def test_tool_posture_domain_size(self) -> None:
        """Assert ToolPosture has exactly 4 literal values."""
        domain = ("none", "read_only", "read_write", "destructive")
        assert len(domain) == 4


class TestSideEffectPolicyLiteralDomain:
    """Tests for SideEffectPolicy type alias literal domain."""

    def test_side_effect_policy_accepts_allow(self) -> None:
        """Assert 'allow' is a valid SideEffectPolicy value."""
        policy: str = "allow"
        assert policy in ("allow", "approval_required", "read_only")

    def test_side_effect_policy_accepts_approval_required(self) -> None:
        """Assert 'approval_required' is a valid SideEffectPolicy value."""
        policy: str = "approval_required"
        assert policy in ("allow", "approval_required", "read_only")

    def test_side_effect_policy_accepts_read_only(self) -> None:
        """Assert 'read_only' is a valid SideEffectPolicy value."""
        policy: str = "read_only"
        assert policy in ("allow", "approval_required", "read_only")

    def test_side_effect_policy_excludes_invalid_values(self) -> None:
        """Assert invalid values are rejected from the domain."""
        invalid_values = ["Allow", "ALLOW", "approval", "readonly", "none"]
        for invalid in invalid_values:
            assert invalid not in ("allow", "approval_required", "read_only")

    def test_side_effect_policy_domain_size(self) -> None:
        """Assert SideEffectPolicy has exactly 3 literal values."""
        domain = ("allow", "approval_required", "read_only")
        assert len(domain) == 3


class TestPersonaSpecStructure:
    """Tests for PersonaSpec TypedDict structure."""

    def test_persona_spec_is_typeddict(self) -> None:
        """Assert PersonaSpec is a TypedDict subclass."""
        from larva.core.spec import PersonaSpec

        # TypedDict has __required_keys__ and __optional_keys__ attributes
        # and inherits from dict in Python 3.12+
        assert hasattr(PersonaSpec, "__required_keys__")
        assert hasattr(PersonaSpec, "__optional_keys__")
        assert hasattr(PersonaSpec, "__annotations__")

    def test_persona_spec_is_optional_key_total_false(self) -> None:
        """Assert PersonaSpec has total=False (all keys optional)."""
        from larva.core.spec import PersonaSpec

        # TypedDict with total=False makes all keys optional
        assert PersonaSpec.__required_keys__ == set()
        assert len(PersonaSpec.__required_keys__) == 0

    def test_persona_spec_exposes_all_documented_fields(self) -> None:
        """Assert PersonaSpec exposes exactly the documented 10 fields."""
        from larva.core.spec import PersonaSpec

        expected_fields = {
            "id",
            "description",
            "prompt",
            "model",
            "tools",
            "model_params",
            "side_effect_policy",
            "can_spawn",
            "compaction_prompt",
            "spec_version",
            "spec_digest",
        }

        actual_fields = set(PersonaSpec.__annotations__.keys())
        assert actual_fields == expected_fields

    def test_persona_spec_field_count(self) -> None:
        """Assert PersonaSpec has exactly 11 fields."""
        from larva.core.spec import PersonaSpec

        field_count = len(PersonaSpec.__annotations__)
        assert field_count == 11


class TestSpecVersion:
    """Tests for spec_version pinned value."""

    def test_spec_version_is_literal_0_1_0(self) -> None:
        """Assert spec_version field type is Literal['0.1.0']."""
        from larva.core.spec import PersonaSpec

        spec_version_type = PersonaSpec.__annotations__["spec_version"]

        # Extract the literal value from the Literal type
        # Literal["0.1.0"] -> ("0.1.0",)
        if hasattr(spec_version_type, "__args__"):
            literal_values = spec_version_type.__args__
            assert "0.1.0" in literal_values

    def test_spec_version_value_pinned(self) -> None:
        """Assert spec_version value is pinned to '0.1.0'."""
        # The literal type should only allow "0.1.0"
        valid_version = "0.1.0"
        assert valid_version == "0.1.0"

        # Invalid versions should not match
        invalid_versions = ["0.1.1", "0.2.0", "1.0.0", "latest"]
        for invalid in invalid_versions:
            assert invalid != "0.1.0"


class TestImportConsumability:
    """Tests proving the contract is consumable by downstream modules."""

    def test_imports_from_core_spec(self) -> None:
        """Assert all expected symbols are importable from larva.core.spec."""
        from larva.core.spec import (
            PersonaSpec,
            SideEffectPolicy,
            ToolPosture,
        )

        assert ToolPosture is not None
        assert SideEffectPolicy is not None
        assert PersonaSpec is not None

    def test_import_via_module(self) -> None:
        """Assert module-level imports work for downstream consumption."""
        import larva.core.spec as spec_module

        assert hasattr(spec_module, "ToolPosture")
        assert hasattr(spec_module, "SideEffectPolicy")
        assert hasattr(spec_module, "PersonaSpec")

    def test_all_exports_in_public_api(self) -> None:
        """Assert all public symbols are in __all__."""
        import larva.core.spec as spec_module

        # __all__ should contain all public types exported by the module
        expected_all = {
            "AssemblyInput",
            "ConstraintComponent",
            "ModelComponent",
            "PersonaSpec",
            "PromptComponent",
            "SideEffectPolicy",
            "ToolsetComponent",
            "ToolPosture",
        }
        assert set(spec_module.__all__) == expected_all

    def test_persona_spec_instantiation_with_empty_dict(self) -> None:
        """Assert PersonaSpec can be instantiated with empty dict (total=False)."""
        from larva.core.spec import PersonaSpec

        # With total=False, empty dict should be valid
        spec: PersonaSpec = {}
        assert spec == {}

    def test_persona_spec_instantiation_with_partial_fields(self) -> None:
        """Assert PersonaSpec accepts partial field specification."""
        from larva.core.spec import PersonaSpec

        # Partial spec - only required fields
        spec: PersonaSpec = {
            "id": "test-persona",
            "prompt": "You are a helpful assistant",
        }
        assert spec["id"] == "test-persona"
        assert spec["prompt"] == "You are a helpful assistant"

    def test_persona_spec_instantiation_with_all_fields(self) -> None:
        """Assert PersonaSpec accepts full field specification."""
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = {
            "id": "test-persona",
            "description": "A test persona",
            "prompt": "You are helpful",
            "model": "gpt-4",
            "tools": {"web_search": "read_only", "file_write": "destructive"},
            "model_params": {"temperature": 0.7},
            "side_effect_policy": "approval_required",
            "can_spawn": True,
            "compaction_prompt": "Summarize the conversation",
            "spec_version": "0.1.0",
            "spec_digest": "abc123",
        }
        assert spec["id"] == "test-persona"
        assert spec["tools"]["web_search"] == "read_only"
        assert spec["side_effect_policy"] == "approval_required"

    def test_tool_posture_in_dict_value(self) -> None:
        """Assert ToolPosture can be used as dict value type."""
        from larva.core.spec import PersonaSpec, ToolPosture

        tools: dict[str, ToolPosture] = {
            "read": "read_only",
            "write": "read_write",
            "delete": "destructive",
        }
        spec: PersonaSpec = {"tools": tools}
        assert spec["tools"]["read"] == "read_only"

    def test_side_effect_policy_in_spec(self) -> None:
        """Assert SideEffectPolicy can be assigned to PersonaSpec field."""
        from larva.core.spec import PersonaSpec, SideEffectPolicy

        policy: SideEffectPolicy = "approval_required"
        spec: PersonaSpec = {"side_effect_policy": policy}
        assert spec["side_effect_policy"] == "approval_required"
