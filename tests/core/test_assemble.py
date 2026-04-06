"""Tests for larva.core.assemble module contracts and behavior."""

import deal
import pytest
from inspect import signature

from larva.core.assemble import AssemblyError, assemble_candidate
from larva.core.spec import (
    AssemblyInput,
    ConstraintComponent,
    ModelComponent,
    PromptComponent,
    ToolsetComponent,
)


class TestAssembleCandidateExists:
    """Test that assemble_candidate exists with correct signature."""

    def test_function_exists(self):
        """assemble_candidate should be a callable function."""
        assert callable(assemble_candidate)

    def test_function_has_correct_signature(self):
        """assemble_candidate should accept a single data parameter."""
        sig = signature(assemble_candidate)
        params = list(sig.parameters.keys())
        assert params == ["data"], f"Expected ['data'], got {params}"

    def test_function_has_type_hints(self):
        """assemble_candidate should have type hints for input and output."""
        hints = assemble_candidate.__annotations__
        assert "data" in hints, "data parameter should have type hint"
        assert "return" in hints, "Return type should be annotated"


class TestAssembleCandidateContracts:
    """Test that assemble_candidate has correct @pre and @post contracts (via deal)."""

    def test_has_deal_contract(self):
        """assemble_candidate should have a __deal_contract attribute from invar."""
        # Check that the function has __deal_contract attribute from invar/deal
        assert hasattr(assemble_candidate, "__deal_contract"), (
            "assemble_candidate should have __deal_contract"
        )

    def test_pre_contract_rejects_non_dict(self):
        """@pre contract should reject non-dict input."""
        # Invalid: not a dict - should raise due to contract violation
        with pytest.raises(deal.PreContractError):
            assemble_candidate("not a dict")

    def test_pre_contract_rejects_dict_without_id(self):
        """@pre contract should reject dict without 'id' key."""
        # Invalid: dict without id
        with pytest.raises(deal.PreContractError):
            assemble_candidate({"name": "test"})

    def test_pre_contract_accepts_valid_input(self):
        """@pre contract should accept a valid dict with id."""
        result = assemble_candidate({"id": "test-persona"})
        assert result["id"] == "test-persona"

    def test_post_contract_returns_dict_with_id(self):
        """@post contract should ensure result has 'id' key."""
        result = assemble_candidate({"id": "test"})
        assert isinstance(result, dict)
        assert "id" in result


class TestAssembleCandidateBehavior:
    """Test concrete assemble behavior and failure signals."""

    def test_concatenates_prompts_in_order(self):
        """Prompt components should concatenate using a double-newline separator."""
        result = assemble_candidate(
            {
                "id": "persona",
                "prompts": [{"text": "first"}, {"text": "second"}],
            }
        )
        assert result["prompt"] == "first\n\nsecond"

    def test_passes_through_description_when_provided(self):
        """Top-level description should be carried into assembled candidate."""
        result = assemble_candidate({"id": "persona", "description": "persona description"})
        assert result["description"] == "persona description"

    def test_raises_component_conflict_for_contradictory_tool_posture(self):
        """Conflicting tool postures should raise AssemblyError with conflict code."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [
                        {"tools": {"read": "read_only"}},
                        {"tools": {"read": "read_write"}},
                    ],
                }
            )
        assert exc_info.value.code == "COMPONENT_CONFLICT"
        assert "Contradictory posture" in exc_info.value.message

    def test_capabilities_input_canonical(self):
        """Capabilities field should be canonical input for toolsets."""
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [{"capabilities": {"read": "read_only", "write": "read_write"}}],
            }
        )
        assert result["capabilities"] == {"read": "read_only", "write": "read_write"}
        assert result["tools"] == {"read": "read_only", "write": "read_write"}  # mirrored

    def test_tools_input_backward_compat(self):
        """Tools field (deprecated) should still work for backward compat."""
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [{"tools": {"read": "read_only", "write": "read_write"}}],
            }
        )
        assert result["capabilities"] == {"read": "read_only", "write": "read_write"}
        assert result["tools"] == {"read": "read_only", "write": "read_write"}

    def test_capabilities_preferred_over_tools(self):
        """Capabilities should be preferred over tools when both present."""
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [
                    {"capabilities": {"read": "read_only"}, "tools": {"read": "read_write"}},
                ],
            }
        )
        # capabilities takes precedence
        assert result["capabilities"] == {"read": "read_only"}
        assert result["tools"] == {"read": "read_only"}

    def test_capabilities_merges_with_tools_across_toolsets(self):
        """Capabilities from one toolset should merge with tools from another."""
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [
                    {"capabilities": {"read": "read_only"}},
                    {"tools": {"write": "read_write"}},
                ],
            }
        )
        assert result["capabilities"] == {"read": "read_only", "write": "read_write"}
        assert result["tools"] == {"read": "read_only", "write": "read_write"}

    def test_raises_component_conflict_for_contradictory_capability_posture(self):
        """Conflicting capability postures should raise AssemblyError."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [
                        {"capabilities": {"read": "read_only"}},
                        {"capabilities": {"read": "read_write"}},
                    ],
                }
            )
        assert exc_info.value.code == "COMPONENT_CONFLICT"
        assert "Contradictory posture" in exc_info.value.message

    def test_raises_component_conflict_for_mixed_capability_tools_conflict(self):
        """Conflicting capabilities vs tools postures should raise AssemblyError."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [
                        {"capabilities": {"read": "read_only"}},
                        {"tools": {"read": "read_write"}},
                    ],
                }
            )
        assert exc_info.value.code == "COMPONENT_CONFLICT"
        assert "Contradictory posture" in exc_info.value.message


class TestTypedDictShapes:
    """Test that TypedDict shapes match expected contracts from spec.py."""

    def test_prompt_component_has_text(self):
        """PromptComponent should have 'text' field per spec."""
        prompt: PromptComponent = {"text": "You are a helpful assistant"}
        assert prompt["text"] == "You are a helpful assistant"

    def test_toolset_component_has_tools(self):
        """ToolsetComponent should have 'tools' field per spec."""
        toolset: ToolsetComponent = {"tools": {"read": "read_only", "write": "read_write"}}
        assert toolset["tools"]["read"] == "read_only"

    def test_constraint_component_fields(self):
        """ConstraintComponent should have can_spawn, side_effect_policy, compaction_prompt."""
        constraint: ConstraintComponent = {
            "can_spawn": True,
            "side_effect_policy": "approval_required",
            "compaction_prompt": "Summarize the conversation",
        }
        assert constraint["can_spawn"] is True
        assert constraint["side_effect_policy"] == "approval_required"

    def test_model_component_fields(self):
        """ModelComponent should have model and model_params fields."""
        model: ModelComponent = {
            "model": "gpt-4",
            "model_params": {"temperature": 0.7, "top_p": 0.9},
        }
        assert model["model"] == "gpt-4"
        assert model["model_params"]["temperature"] == 0.7

    def test_assembly_input_id(self):
        """AssemblyInput should support 'id' field."""
        data: AssemblyInput = {"id": "my-persona"}
        assert "id" in data
        assert data["id"] == "my-persona"

    def test_assembly_input_all_fields_optional(self):
        """AssemblyInput should have total=False (all fields optional)."""
        # Empty dict should be valid for AssemblyInput
        data: AssemblyInput = {}
        assert isinstance(data, dict)

    def test_assembly_input_supports_prompts(self):
        """AssemblyInput should support 'prompts' field as list[PromptComponent]."""
        data: AssemblyInput = {
            "id": "test",
            "prompts": [{"text": "prompt1"}, {"text": "prompt2"}],
        }
        assert len(data["prompts"]) == 2
        assert data["prompts"][0]["text"] == "prompt1"

    def test_assembly_input_supports_description(self):
        """AssemblyInput should support top-level description passthrough."""
        data: AssemblyInput = {
            "id": "test",
            "description": "persona description",
        }
        assert data["description"] == "persona description"

    def test_assembly_input_supports_toolsets(self):
        """AssemblyInput should support 'toolsets' field as list[ToolsetComponent]."""
        data: AssemblyInput = {
            "id": "test",
            "toolsets": [{"tools": {"read": "read_only"}}],
        }
        assert len(data["toolsets"]) == 1

    def test_assembly_input_supports_constraints(self):
        """AssemblyInput should support 'constraints' field as list[ConstraintComponent]."""
        data: AssemblyInput = {
            "id": "test",
            "constraints": [{"can_spawn": True}],
        }
        assert len(data["constraints"]) == 1

    def test_assembly_input_supports_model(self):
        """AssemblyInput should support 'model' field as ModelComponent | str."""
        # String form
        data1: AssemblyInput = {"id": "test", "model": "gpt-4"}
        assert data1["model"] == "gpt-4"
        # Dict form
        data2: AssemblyInput = {"id": "test", "model": {"model": "gpt-4"}}
        assert data2["model"]["model"] == "gpt-4"

    def test_assembly_input_supports_overrides(self):
        """AssemblyInput should support 'overrides' field as dict[str, object]."""
        data: AssemblyInput = {
            "id": "test",
            "overrides": {"temperature": 0.7},
        }
        assert data["overrides"]["temperature"] == 0.7

    def test_assembly_input_supports_variables(self):
        """AssemblyInput should support 'variables' field as dict[str, str]."""
        data: AssemblyInput = {
            "id": "test",
            "variables": {"name": "Alice"},
        }
        assert data["variables"]["name"] == "Alice"

    def test_assembly_input_full_example(self):
        """AssemblyInput should accept a complete example per spec."""
        data: AssemblyInput = {
            "id": "full-test-persona",
            "prompts": [{"text": "system-prompt"}, {"text": "user-prompt"}],
            "toolsets": [{"tools": {"read": "read_only"}}],
            "constraints": [{"can_spawn": True, "side_effect_policy": "allow"}],
            "model": {"model": "gpt-4", "model_params": {"temperature": 0.5}},
            "overrides": {"temperature": 0.7},
            "variables": {"agent_name": "TestBot"},
        }

        assert data["id"] == "full-test-persona"
        assert len(data["prompts"]) == 2
        assert len(data["toolsets"]) == 1
        assert len(data["constraints"]) == 1
        assert data["model"]["model"] == "gpt-4"
        assert data["overrides"]["temperature"] == 0.7
        assert data["variables"]["agent_name"] == "TestBot"


class TestContractExports:
    """Test that required contracts are properly exported."""

    def test_prompt_component_exported(self):
        """PromptComponent should be importable."""
        assert PromptComponent is not None

    def test_toolset_component_exported(self):
        """ToolsetComponent should be importable."""
        assert ToolsetComponent is not None

    def test_constraint_component_exported(self):
        """ConstraintComponent should be importable."""
        assert ConstraintComponent is not None

    def test_model_component_exported(self):
        """ModelComponent should be importable."""
        assert ModelComponent is not None

    def test_assembly_input_exported(self):
        """AssemblyInput should be importable."""
        assert AssemblyInput is not None

    def test_assemble_candidate_exported(self):
        """assemble_candidate should be importable."""
        assert assemble_candidate is not None
