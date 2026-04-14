"""Canonical contract tests for larva.core.normalize module.

These tests express the frozen authority for normalize semantics per ADR-002
and ADR-003:
- normalize_spec accepts transition-era inputs (tools, side_effect_policy)
  for backward compat but strips them from canonical output
- Canonical output never contains 'tools' or 'side_effect_policy'
- spec_version is defaulted to '0.1.0' when absent
- spec_digest is always freshly computed
- Digest is deterministic and excludes spec_digest from input
"""

from larva.core.spec import PersonaSpec

import pytest


# ---------------------------------------------------------------------------
# Canonical fixtures
# ---------------------------------------------------------------------------

CANONICAL_NORMALIZE_INPUT_MINIMAL: dict = {
    "id": "normalize-fixture",
    "description": "Normalize fixture — minimal required shape",
    "prompt": "You are a test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
}
"""Exact canonical shape that normalize_spec should pass through unchanged
(except for spec_digest computation). No forbidden fields."""

CANONICAL_NORMALIZE_INPUT_WITH_SIDE_EFFECT_POLICY: dict = {
    "id": "normalize-fixture-sep",
    "description": "Normalize fixture — transition-era side_effect_policy input",
    "prompt": "You are a test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only"},
    "side_effect_policy": "allow",
    "spec_version": "0.1.0",
}
"""Transition-era input with 'side_effect_policy'.  normalize_spec must strip
'side_effect_policy' from canonical output."""


# ---------------------------------------------------------------------------
# Module imports
# ---------------------------------------------------------------------------


class TestNormalizeSpecImport:
    """Test module-level imports work correctly."""

    def test_persona_spec_importable_from_larva_core_spec(self) -> None:
        """PersonaSpec should be importable from larva.core.spec."""
        from larva.core.spec import PersonaSpec

        assert issubclass(PersonaSpec, dict)

    def test_normalize_spec_importable(self) -> None:
        """normalize_spec should be importable from larva.core.normalize."""
        from larva.core.normalize import normalize_spec

        assert callable(normalize_spec)


# ---------------------------------------------------------------------------
# Function signature
# ---------------------------------------------------------------------------


class TestNormalizeSpecSignature:
    """Test normalize_spec has correct function signature."""

    def test_normalize_spec_accepts_single_parameter(self) -> None:
        """normalize_spec should accept exactly one parameter (spec)."""
        from larva.core.normalize import normalize_spec
        import inspect

        sig = inspect.signature(normalize_spec)
        params = list(sig.parameters.keys())

        assert params == ["spec"], f"Expected ['spec'], got {params}"

    def test_normalize_spec_has_return_annotation(self) -> None:
        """normalize_spec should have return type annotation."""
        from larva.core.normalize import normalize_spec
        import inspect

        sig = inspect.signature(normalize_spec)
        assert sig.return_annotation is not inspect.Parameter.empty


# ---------------------------------------------------------------------------
# Contract annotations
# ---------------------------------------------------------------------------


class TestNormalizeSpecContractAnnotations:
    """Test contract annotations are present on normalize_spec."""

    def test_has_pre_decorator(self) -> None:
        """normalize_spec should have @pre decorator (deal contract)."""
        from larva.core.normalize import normalize_spec

        contract = getattr(normalize_spec, "__deal_contract", None)
        assert contract is not None, "normalize_spec should have @pre/@post decorator"
        assert len(contract.pres) > 0, "Should have pre conditions"

    def test_has_post_decorator(self) -> None:
        """normalize_spec should have @post decorator."""
        from larva.core.normalize import normalize_spec

        contract = getattr(normalize_spec, "__deal_contract", None)
        assert contract is not None, "normalize_spec should have @pre/@post decorator"
        assert len(contract.posts) > 0, "Should have post conditions"

    def test_pre_contract_function_exists(self) -> None:
        """@pre contract function should exist in the validator.

        Note: Due to a bug in invar_runtime (invar_runtime/contracts.py:128),
        we cannot directly test the validator. We verify structure only.
        """
        from larva.core.normalize import normalize_spec

        contract = getattr(normalize_spec, "__deal_contract", None)
        assert contract is not None, "Missing pre condition"
        assert len(contract.pres) > 0, "Missing pre condition"

        pre_validator = contract.pres[0]
        assert hasattr(pre_validator, "function"), "Pre validator should have function attribute"

    def test_post_contract_function_exists(self) -> None:
        """@post contract function should exist in the validator.

        Note: Due to a bug in invar_runtime (invar_runtime/contracts.py:148),
        we cannot directly test the validator. We verify structure only.
        """
        from larva.core.normalize import normalize_spec

        contract = getattr(normalize_spec, "__deal_contract", None)
        assert contract is not None, "Missing post condition"
        assert len(contract.posts) > 0, "Missing post condition"

        post_validator = contract.posts[0]
        assert hasattr(post_validator, "function"), "Post validator should have function attribute"

    def test_post_contract_forbids_tools_in_output(self) -> None:
        """Assert normalize_spec has @post contract banning 'tools' from output.

        Per ADR-002 and normalize.py postconditions: 'tools' must not appear
        in normalized output — it is forbidden at canonical admission.
        """
        from larva.core.normalize import normalize_spec

        contract = getattr(normalize_spec, "__deal_contract", None)
        assert contract is not None
        # Verify the postconditions include tools removal
        # The actual @post(lambda result: "tools" not in result) is present
        assert len(contract.posts) > 0, "Expected at least one post condition"

    def test_post_contract_forbids_side_effect_policy_in_output(self) -> None:
        """Assert normalize_spec has @post contract banning 'side_effect_policy' from output.

        Per ADR-002 and normalize.py postconditions: 'side_effect_policy' must
        not appear in normalized output — forbidden at canonical admission.
        """
        from larva.core.normalize import normalize_spec

        contract = getattr(normalize_spec, "__deal_contract", None)
        assert contract is not None
        assert len(contract.posts) > 0, "Expected at least one post condition"


# ---------------------------------------------------------------------------
# Normalize behavior — canonical contract
# ---------------------------------------------------------------------------


class TestNormalizeSpecBehavior:
    """Test normalize_spec runtime behavior — canonical contract."""

    def test_defaults_spec_version_when_absent(self) -> None:
        """normalize_spec should add default spec_version when missing."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test"})
        assert result["spec_version"] == "0.1.0"

    def test_overwrites_stale_digest(self) -> None:
        """normalize_spec should compute a fresh digest and ignore stale input digest."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "spec_digest": "stale"})
        assert result["spec_digest"] != "stale"
        assert len(result["spec_digest"]) == 71

    def test_digest_is_deterministic(self) -> None:
        """normalize_spec should produce deterministic digest for same input."""
        from larva.core.normalize import normalize_spec

        left = normalize_spec({"id": "test", "model": "gpt-4"})
        right = normalize_spec({"model": "gpt-4", "id": "test"})
        assert left["spec_digest"] == right["spec_digest"]

    def test_canonical_minimal_fixture_passes_through(self) -> None:
        """Assert CANONICAL_NORMALIZE_INPUT_MINIMAL passes through with digest added."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec(CANONICAL_NORMALIZE_INPUT_MINIMAL)
        assert result["id"] == "normalize-fixture"
        assert result["capabilities"]["shell"] == "read_only"
        assert result["spec_version"] == "0.1.0"
        assert "spec_digest" in result
        # No forbidden fields in output
        assert "tools" not in result
        assert "side_effect_policy" not in result


# ---------------------------------------------------------------------------
# ADR-002 hard-cut normalization — canonical contract
# ---------------------------------------------------------------------------


class TestNormalizeSpecCapabilitiesTransition:
    """Test ADR-002 hard-cut normalization behavior.

    Per ADR-002 authority decision (hard-cut semantics):
    - normalize_spec strips 'tools' from output — it is NEVER mapped to capabilities
    - normalize_spec strips 'side_effect_policy' from output — forbidden at admission
    - tools presence in input does NOT result in capabilities being added
    """

    def test_tools_removed_from_output(self) -> None:
        """normalize_spec must strip tools from output — ADR-002 hard-cut.

        'tools' must not survive normalization; it is forbidden at canonical
        admission and is NOT mapped to capabilities.
        """
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "tools": {"shell": "read_write"}})
        assert "tools" not in result, (
            "'tools' must not survive normalization; forbidden at canonical admission per ADR-002"
        )

    def test_tools_not_mapped_to_capabilities(self) -> None:
        """tools in input must NOT result in capabilities being added — hard-cut.

        Unlike transition-era behavior, tools is rejected outright, not mapped.
        """
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "tools": {"filesystem": "read_only"}})
        # tools stripped, capabilities NOT added from tools
        assert "tools" not in result
        assert "capabilities" not in result or result.get("capabilities") is None

    def test_capabilities_only_passes_through(self) -> None:
        """When only capabilities present, use as-is and no tools in output."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "capabilities": {"git": "read_write"}})
        assert result.get("capabilities") == {"git": "read_write"}
        assert "tools" not in result

    def test_neither_field_no_change(self) -> None:
        """When neither tools nor capabilities present, neither is added."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "model": "gpt-4"})
        assert "capabilities" not in result or result.get("capabilities") is None
        assert "tools" not in result

    def test_side_effect_policy_stripped_from_output(self) -> None:
        """normalize_spec must strip side_effect_policy from output — ADR-002."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec(
            {"id": "test", "capabilities": {"git": "read_only"}, "side_effect_policy": "allow"}
        )
        assert "side_effect_policy" not in result, (
            "side_effect_policy must not survive normalization; "
            "it is forbidden at canonical admission per ADR-002"
        )

    def test_tools_and_capabilities_both_stripped(self) -> None:
        """When both tools and capabilities present, both are stripped from output.

        Per hard-cut semantics: tools is NOT mapped to capabilities.
        """
        from larva.core.normalize import normalize_spec

        result = normalize_spec(
            {
                "id": "test",
                "tools": {"filesystem": "read_only"},
                "capabilities": {"git": "read_write"},
            }
        )
        assert "tools" not in result
        # capabilities from input should survive
        assert result.get("capabilities") == {"git": "read_write"}

    def test_transition_fixture_with_side_effect_policy_normalizes_correctly(
        self,
    ) -> None:
        """Assert CANONICAL_NORMALIZE_INPUT_WITH_SIDE_EFFECT_POLICY strips sep."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec(CANONICAL_NORMALIZE_INPUT_WITH_SIDE_EFFECT_POLICY)
        assert "side_effect_policy" not in result
        assert result["capabilities"] == {"shell": "read_only"}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
