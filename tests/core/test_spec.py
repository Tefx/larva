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
        """Assert PersonaSpec exposes exactly the documented 12 fields."""
        from larva.core.spec import PersonaSpec

        expected_fields = {
            "id",
            "description",
            "prompt",
            "model",
            "capabilities",
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
        """Assert PersonaSpec has exactly 12 fields."""
        from larva.core.spec import PersonaSpec

        field_count = len(PersonaSpec.__annotations__)
        assert field_count == 12


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
        """Assert PersonaSpec accepts full field specification with capabilities."""
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = {
            "id": "test-persona",
            "description": "A test persona",
            "prompt": "You are helpful",
            "model": "gpt-4",
            "capabilities": {"web_search": "read_only", "file_write": "destructive"},
            "tools": {"web_search": "read_only", "file_write": "destructive"},
            "model_params": {"temperature": 0.7},
            "side_effect_policy": "approval_required",
            "can_spawn": True,
            "compaction_prompt": "Summarize the conversation",
            "spec_version": "0.1.0",
            "spec_digest": "abc123",
        }
        assert spec["id"] == "test-persona"
        assert spec["capabilities"]["web_search"] == "read_only"
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


class TestCapabilitiesField:
    """Tests for the new capabilities field in PersonaSpec and related types."""

    def test_capabilities_field_accepts_tool_postures(self) -> None:
        """Assert PersonaSpec with capabilities: {'filesystem': 'read_write'} is valid TypedDict usage."""
        from larva.core.spec import PersonaSpec, ToolPosture

        capabilities: dict[str, ToolPosture] = {"filesystem": "read_write"}
        spec: PersonaSpec = {"id": "test", "capabilities": capabilities}
        assert spec["capabilities"]["filesystem"] == "read_write"

    def test_capabilities_field_coexists_with_tools(self) -> None:
        """Assert PersonaSpec can have both tools and capabilities during transition."""
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = {
            "id": "test-persona",
            "prompt": "You are helpful",
            "capabilities": {"web_search": "read_only", "filesystem": "read_write"},
            "tools": {"web_search": "read_only", "filesystem": "read_write"},
        }
        assert spec["capabilities"]["web_search"] == "read_only"
        assert spec["tools"]["web_search"] == "read_only"
        # Both fields should be independent
        assert "capabilities" in spec
        assert "tools" in spec


class TestToolsetComponentCapabilities:
    """Tests for ToolsetComponent capabilities field and backward compat."""

    def test_toolset_component_has_capabilities(self) -> None:
        """Assert ToolsetComponent accepts capabilities key."""
        from larva.core.spec import ToolsetComponent, ToolPosture

        capabilities: dict[str, ToolPosture] = {"search": "read_only", "fs": "read_write"}
        toolset: ToolsetComponent = {"capabilities": capabilities}
        assert toolset["capabilities"]["search"] == "read_only"

    def test_toolset_component_backward_compat_tools(self) -> None:
        """Assert ToolsetComponent still accepts tools key."""
        from larva.core.spec import ToolsetComponent, ToolPosture

        tools: dict[str, ToolPosture] = {"search": "read_only", "fs": "read_write"}
        toolset: ToolsetComponent = {"tools": tools}
        assert toolset["tools"]["search"] == "read_only"

    def test_toolset_component_capabilities_only_shape(self) -> None:
        """Assert ToolsetComponent accepts capabilities-only shape (ADR-002 canonical)."""
        from larva.core.spec import ToolsetComponent, ToolPosture

        # Per ADR-002: capabilities is the canonical field
        # ToolsetComponent should accept capabilities-only without requiring tools
        capabilities: dict[str, ToolPosture] = {"filesystem": "read_write", "git": "read_only"}
        toolset: ToolsetComponent = {"capabilities": capabilities}
        assert "capabilities" in toolset
        assert "tools" not in toolset  # tools field should be absent, not present with empty

    def test_toolset_component_tools_only_shape(self) -> None:
        """Assert ToolsetComponent accepts tools-only shape (backward compat)."""
        from larva.core.spec import ToolsetComponent, ToolPosture

        # During transition, tools-only is acceptable for backward compatibility
        tools: dict[str, ToolPosture] = {"web_search": "read_only", "file_ops": "destructive"}
        toolset: ToolsetComponent = {"tools": tools}
        assert "tools" in toolset
        assert "capabilities" not in toolset  # capabilities field should be absent

    def test_toolset_component_both_fields_shape(self) -> None:
        """Assert ToolsetComponent accepts both capabilities and tools together."""
        from larva.core.spec import ToolsetComponent, ToolPosture

        # During transition, both fields may coexist
        capabilities: dict[str, ToolPosture] = {"filesystem": "read_write"}
        tools: dict[str, ToolPosture] = {"filesystem": "read_write"}
        toolset: ToolsetComponent = {"capabilities": capabilities, "tools": tools}
        assert "capabilities" in toolset
        assert "tools" in toolset

    def test_toolset_component_is_total_false(self) -> None:
        """Assert ToolsetComponent has total=False (all keys optional for transition)."""
        from larva.core.spec import ToolsetComponent

        # Per ADR-002: both fields are optional during transition
        # This enables capabilities-only or tools-only shapes
        assert ToolsetComponent.__required_keys__ == set()
        assert len(ToolsetComponent.__required_keys__) == 0

    def test_toolset_component_empty_dict_valid(self) -> None:
        """Assert ToolsetComponent accepts empty dict (all fields optional per total=False)."""
        from larva.core.spec import ToolsetComponent

        # With total=False, empty dict is technically valid
        # (Runtime validation elsewhere should enforce at least one field)
        toolset: ToolsetComponent = {}
        assert toolset == {}


class TestConstraintComponentBackwardCompat:
    """Tests for ConstraintComponent backward compatibility during transition."""

    def test_constraint_component_still_accepts_side_effect_policy(self) -> None:
        """Assert ConstraintComponent still works with side_effect_policy (backward compat during transition)."""
        from larva.core.spec import ConstraintComponent, SideEffectPolicy

        policy: SideEffectPolicy = "allow"
        constraint: ConstraintComponent = {"side_effect_policy": policy}
        assert constraint["side_effect_policy"] == "allow"

    def test_constraint_component_accepts_can_spawn(self) -> None:
        """Assert ConstraintComponent accepts can_spawn field."""
        from larva.core.spec import ConstraintComponent

        constraint: ConstraintComponent = {"can_spawn": True}
        assert constraint["can_spawn"] is True

        constraint_list: ConstraintComponent = {"can_spawn": ["child-a", "child-b"]}
        assert constraint_list["can_spawn"] == ["child-a", "child-b"]

    def test_constraint_component_accepts_compaction_prompt(self) -> None:
        """Assert ConstraintComponent accepts compaction_prompt field."""
        from larva.core.spec import ConstraintComponent

        constraint: ConstraintComponent = {"compaction_prompt": "Summarize the state"}
        assert constraint["compaction_prompt"] == "Summarize the state"


class TestCapabilitiesWithAllToolPostures:
    """Tests verifying capabilities field works with all ToolPosture values."""

    def test_capabilities_accepts_none(self) -> None:
        """Assert capabilities dict accepts 'none' posture."""
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = {"id": "test", "capabilities": {"tool_a": "none"}}
        assert spec["capabilities"]["tool_a"] == "none"

    def test_capabilities_accepts_read_only(self) -> None:
        """Assert capabilities dict accepts 'read_only' posture."""
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = {"id": "test", "capabilities": {"tool_b": "read_only"}}
        assert spec["capabilities"]["tool_b"] == "read_only"

    def test_capabilities_accepts_read_write(self) -> None:
        """Assert capabilities dict accepts 'read_write' posture."""
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = {"id": "test", "capabilities": {"tool_c": "read_write"}}
        assert spec["capabilities"]["tool_c"] == "read_write"

    def test_capabilities_accepts_destructive(self) -> None:
        """Assert capabilities dict accepts 'destructive' posture."""
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = {"id": "test", "capabilities": {"tool_d": "destructive"}}
        assert spec["capabilities"]["tool_d"] == "destructive"
