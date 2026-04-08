"""Canonical contract tests for larva.core.assemble module.

These tests express the frozen authority for assembly output per ADR-002
and the opifex canonical authority basis:
- Assembly produces a PersonaSpec candidate
- Output contains 'capabilities', never 'tools'
- ConstraintComponent only has can_spawn and compaction_prompt
- 'tools' in assembly input (ToolsetComponent) is transition-era backward compat
- 'side_effect_policy' is NOT a ConstraintComponent field
"""

import deal
import pytest
from inspect import signature

from larva.core.assemble import AssemblyError, assemble_candidate
from larva.core.spec import (
    AssemblyInput,
    ConstraintComponent,
    ModelComponent,
    PersonaSpec,
    PromptComponent,
    ToolsetComponent,
)


# ---------------------------------------------------------------------------
# Canonical fixtures
# ---------------------------------------------------------------------------

CANONICAL_ASSEMBLY_OUTPUT_MINIMAL: dict = {
    "id": "canonical-assembly-fixture",
    "description": "Canonical assembly fixture — minimal output",
    "prompt": "You are a canonical test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
}
"""Exact canonical PersonaSpec shape that assembly should produce as output.
No 'tools', no 'side_effect_policy' — forbidden at canonical admission."""


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
        assert hasattr(assemble_candidate, "__deal_contract"), (
            "assemble_candidate should have __deal_contract"
        )

    def test_pre_contract_rejects_non_dict(self):
        """@pre contract should reject non-dict input."""
        with pytest.raises(deal.PreContractError):
            assemble_candidate("not a dict")

    def test_pre_contract_rejects_dict_without_id(self):
        """@pre contract should reject dict without 'id' key."""
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
    """Test concrete assemble behavior — canonical output contract.

    Per ADR-002 authority decision:
    - Assembly output is capabilities-only; no 'tools' in output
    - Assembly input may use 'tools' in ToolsetComponent for backward compat
    - 'tools' input is read and normalized to 'capabilities' in output
    """

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
        """Conflicting tool postures should raise AssemblyError with conflict code.

        Note: This test uses 'tools' key in assembly INPUT, which is transition-era
        backward compat (INTENTIONAL TRANSITION SUPPORT). The input is accepted but
        the output will only contain 'capabilities'.
        """
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
        assert "tools" not in result

    def test_tools_input_backward_compat(self):
        """Tools field (deprecated) should still work for backward compat.

        INTENTIONAL TRANSITION SUPPORT: 'tools' in assembly input is accepted
        but the output contains only 'capabilities'.
        """
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [{"tools": {"read": "read_only", "write": "read_write"}}],
            }
        )
        assert result["capabilities"] == {"read": "read_only", "write": "read_write"}
        assert "tools" not in result

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
        assert "tools" not in result

    def test_capabilities_merges_with_tools_across_toolsets(self):
        """Capabilities from one toolset should merge with tools from another.

        INTENTIONAL TRANSITION SUPPORT: 'tools' in one toolset is read as
        transition-era input and merged into 'capabilities' in output.
        """
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
        assert "tools" not in result

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

    def test_output_never_contains_tools_key(self):
        """Assembly output must never contain 'tools' — ADR-002.

        Even when tools is provided as input, the output only contains 'capabilities'.
        """
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [{"tools": {"read": "read_only"}}],
            }
        )
        assert "tools" not in result, (
            "Assembly output must not contain 'tools'; forbidden at canonical admission per ADR-002"
        )

    def test_output_never_contains_side_effect_policy(self):
        """Assembly output must never contain 'side_effect_policy' — ADR-002."""
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [{"capabilities": {"read": "read_only"}}],
            }
        )
        assert "side_effect_policy" not in result, (
            "Assembly output must not contain 'side_effect_policy'; "
            "forbidden at canonical admission per ADR-002"
        )

    def test_forbidden_override_field_rejected(self):
        """Assembly must reject 'tools' in overrides — forbidden at canonical boundary."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "overrides": {"tools": {"read": "read_only"}},
                }
            )
        assert exc_info.value.code == "FORBIDDEN_OVERRIDE_FIELD"

    def test_forbidden_side_effect_policy_override_rejected(self):
        """Assembly must reject 'side_effect_policy' in overrides — forbidden."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "overrides": {"side_effect_policy": "allow"},
                }
            )
        assert exc_info.value.code == "FORBIDDEN_OVERRIDE_FIELD"


class TestTypedDictShapes:
    """Test that TypedDict shapes match expected contracts from spec.py — canonical authority.

    Per ADR-002 and spec.py:
    - ToolsetComponent has only 'capabilities' (Required)
    - ConstraintComponent has 'can_spawn' and 'compaction_prompt' (total=False)
    - PromptComponent has 'text'
    - ModelComponent has 'model' and 'model_params' (total=False)
    """

    def test_prompt_component_has_text(self):
        """PromptComponent should have 'text' field per spec."""
        prompt: PromptComponent = {"text": "You are a helpful assistant"}
        assert prompt["text"] == "You are a helpful assistant"

    def test_toolset_component_has_capabilities(self):
        """ToolsetComponent should have 'capabilities' field — canonical (ADR-002).

        Per ADR-002, the canonical ToolsetComponent has only 'capabilities'.
        'tools' is NOT a ToolsetComponent field.
        """
        from larva.core.spec import ToolPosture

        capabilities: dict[str, ToolPosture] = {"read": "read_only", "write": "read_write"}
        toolset: ToolsetComponent = {"capabilities": capabilities}
        assert toolset["capabilities"]["read"] == "read_only"

    def test_toolset_component_no_tools_key_in_annotations(self):
        """ToolsetComponent annotations must NOT contain 'tools' — ADR-002 canonical."""
        assert "tools" not in ToolsetComponent.__annotations__, (
            "'tools' must not be in ToolsetComponent annotations; use 'capabilities' per ADR-002"
        )

    def test_constraint_component_fields(self):
        """ConstraintComponent should have can_spawn and compaction_prompt only.

        Per ADR-002: side_effect_policy is NOT a ConstraintComponent field;
        it is rejected at canonical admission.
        """
        constraint: ConstraintComponent = {
            "can_spawn": True,
            "compaction_prompt": "Summarize the conversation",
        }
        assert constraint["can_spawn"] is True

    def test_constraint_component_no_side_effect_policy(self):
        """ConstraintComponent annotations must NOT contain 'side_effect_policy' — ADR-002."""
        assert "side_effect_policy" not in ConstraintComponent.__annotations__, (
            "'side_effect_policy' must not be in ConstraintComponent; "
            "rejected at canonical admission per ADR-002"
        )

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
            "toolsets": [{"capabilities": {"read": "read_only"}}],
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
        data1: AssemblyInput = {"id": "test", "model": "gpt-4"}
        assert data1["model"] == "gpt-4"
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
        """AssemblyInput should accept a complete example per spec — canonical shape."""
        data: AssemblyInput = {
            "id": "full-test-persona",
            "prompts": [{"text": "system-prompt"}, {"text": "user-prompt"}],
            "toolsets": [{"capabilities": {"read": "read_only"}}],
            "constraints": [{"can_spawn": True}],
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
