"""Canonical contract tests for larva.core.assemble module.

These tests express the frozen authority for assembly output per ADR-002
and the opifex canonical authority basis:
- Assembly produces a PersonaSpec candidate
- Output contains 'capabilities', never 'tools'
- ConstraintComponent only has can_spawn and compaction_prompt
- ToolsetComponent remains capabilities-only in canonical typing
- 'side_effect_policy' is NOT a ConstraintComponent field
"""

import deal
import pytest
from hypothesis import given
from hypothesis import strategies as st
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

    Per hard-cut authority decision:
    - Assembly output is capabilities-only; no 'tools' in output
    - Assembly input must not accept 'tools' in ToolsetComponent
    - Prompt text must already be fully composed; no variables path remains
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

    def test_tools_only_toolset_fails_closed(self):
        """Toolset with only 'tools' (no capabilities) must fail closed.

        Per canonical cutover: toolsets must provide 'capabilities' field.
        'tools'-only toolsets are legacy content and must be rejected.
        """
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [{"tools": {"read": "read_only"}}],
                }
            )
        assert exc_info.value.code == "FORBIDDEN_TOOLSET_FIELD"

    def test_raises_component_conflict_for_contradictory_tool_posture(self):
        """Tools-only toolsets are rejected at canonical cutover.

        Per canonical cutover: toolsets must provide 'capabilities' field.
        'tools'-only toolsets are legacy content and must be rejected.
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
        assert exc_info.value.code == "FORBIDDEN_TOOLSET_FIELD"

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

    def test_tools_input_rejected(self):
        """Tools field is legacy content and must be rejected at canonical cutover."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [{"tools": {"read": "read_only", "write": "read_write"}}],
                }
            )
        assert exc_info.value.code == "FORBIDDEN_TOOLSET_FIELD"

    def test_mixed_capabilities_and_tools_payload_rejected(self):
        """Mixed canonical and legacy toolset payload must fail closed."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [
                        {"capabilities": {"read": "read_only"}, "tools": {"read": "read_write"}},
                    ],
                }
            )
        assert exc_info.value.code == "FORBIDDEN_TOOLSET_FIELD"

    @given(
        malformed_capabilities=st.one_of(
            st.none(),
            st.integers(),
            st.text(),
            st.lists(st.text(), max_size=3),
            st.dictionaries(
                keys=st.one_of(st.text(), st.integers()),
                values=st.one_of(
                    st.none(),
                    st.integers(),
                    st.lists(st.text(), max_size=2),
                    st.sampled_from(["invalid", "READ_ONLY", ""]),
                ),
                max_size=3,
            ).filter(
                lambda payload: not (
                    all(isinstance(key, str) for key in payload)
                    and all(
                        isinstance(value, str)
                        and value in {"none", "read_only", "read_write", "destructive"}
                        for value in payload.values()
                    )
                )
            ),
        )
    )
    def test_malformed_capabilities_payload_fails_closed(self, malformed_capabilities: object):
        """Malformed capabilities content must raise instead of degrading to {}."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [{"capabilities": malformed_capabilities}],
                }
            )

        assert exc_info.value.code in {
            "INVALID_TOOLSET_CAPABILITIES_SHAPE",
            "INVALID_TOOLSET_CAPABILITY_ENTRY",
        }

    def test_capabilities_merges_with_tools_across_toolsets(self):
        """Tools-only toolsets are rejected at canonical cutover.

        Per canonical cutover: 'tools' in assembly input is NOT admissible.
        All toolsets must provide 'capabilities' field.
        """
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [
                        {"capabilities": {"read": "read_only"}},
                        {"tools": {"write": "read_write"}},
                    ],
                }
            )
        assert exc_info.value.code == "FORBIDDEN_TOOLSET_FIELD"

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
        """Tools-only toolsets are rejected at canonical cutover.

        Per canonical cutover: 'tools' in assembly input is NOT admissible.
        All toolsets must provide 'capabilities' field.
        """
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
        assert exc_info.value.code == "FORBIDDEN_TOOLSET_FIELD"

    def test_variables_input_rejected(self):
        """Assemble input must reject variables outright at hard cut."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "prompts": [{"text": "You are {role}."}],
                    "variables": {"role": "assistant"},
                }
            )
        assert exc_info.value.code == "VARIABLES_NOT_ALLOWED"

    @given(name=st.sampled_from(("role", "target", "agent_name")))
    def test_unresolved_prompt_placeholders_rejected(self, name: str):
        """Prompt text must already be composed before assembly output."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "prompts": [{"text": f"You are {{{name}}}."}],
                }
            )
        assert exc_info.value.code == "UNRESOLVED_PROMPT_TEXT"

    @given(posture=st.sampled_from(("read_only", "read_write", "destructive")))
    def test_mixed_legacy_toolset_payload_fails_closed(self, posture: str):
        """Any toolset payload that still contains tools must be rejected."""
        with pytest.raises(AssemblyError) as exc_info:
            assemble_candidate(
                {
                    "id": "persona",
                    "toolsets": [
                        {"capabilities": {"read": "read_only"}, "tools": {"write": posture}},
                    ],
                }
            )
        assert exc_info.value.code == "FORBIDDEN_TOOLSET_FIELD"

    def test_output_never_contains_tools_key(self):
        """Assembly output must never contain 'tools' — ADR-002.

        With canonical capabilities input, output contains only 'capabilities'.
        """
        result = assemble_candidate(
            {
                "id": "persona",
                "toolsets": [{"capabilities": {"read": "read_only"}}],
            }
        )
        assert "tools" not in result, (
            "Assembly output must not contain 'tools'; forbidden at canonical admission per ADR-002"
        )
        assert "capabilities" in result

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

    def test_assembly_input_annotations_exclude_variables(self):
        """AssemblyInput annotations must not admit legacy variables input."""
        assert "variables" not in AssemblyInput.__annotations__

    def test_assembly_input_full_example(self):
        """AssemblyInput should accept a complete example per spec — canonical shape."""
        data: AssemblyInput = {
            "id": "full-test-persona",
            "prompts": [{"text": "system-prompt"}, {"text": "user-prompt"}],
            "toolsets": [{"capabilities": {"read": "read_only"}}],
            "constraints": [{"can_spawn": True}],
            "model": {"model": "gpt-4", "model_params": {"temperature": 0.5}},
            "overrides": {"temperature": 0.7},
        }

        assert data["id"] == "full-test-persona"
        assert len(data["prompts"]) == 2
        assert len(data["toolsets"]) == 1
        assert len(data["constraints"]) == 1
        assert data["model"]["model"] == "gpt-4"
        assert data["overrides"]["temperature"] == 0.7


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
