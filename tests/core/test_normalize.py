"""Contract-focused tests for larva.core.normalize module.

These tests verify the contract-only interface of normalize_spec
without testing implementation details.
"""

import pytest


class TestNormalizeSpecImport:
    """Test module-level imports work correctly."""

    def test_persona_spec_importable_from_larva_core_spec(self) -> None:
        """PersonaSpec should be importable from larva.core.spec."""
        from larva.core.spec import PersonaSpec

        # Verify it's a valid TypedDict
        assert issubclass(PersonaSpec, dict)

    def test_normalize_spec_importable(self) -> None:
        """normalize_spec should be importable from larva.core.normalize."""
        from larva.core.normalize import normalize_spec

        assert callable(normalize_spec)


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


class TestNormalizeSpecContractAnnotations:
    """Test contract annotations are present on normalize_spec."""

    def test_has_pre_decorator(self) -> None:
        """normalize_spec should have @pre decorator (deal contract)."""
        from larva.core.normalize import normalize_spec

        # Deal adds __deal_contract attribute when pre/post decorators are used
        # Use getattr to avoid name mangling issues
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

        # Verify the pre condition function exists
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

        # Verify the post condition function exists
        post_validator = contract.posts[0]
        assert hasattr(post_validator, "function"), "Post validator should have function attribute"


class TestNormalizeSpecBehavior:
    """Test normalize_spec runtime behavior."""

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


class TestNormalizeSpecCapabilitiesTransition:
    """Test ADR-002 tools->capabilities normalization behavior."""

    def test_tools_only_normalizes_to_capabilities(self) -> None:
        """When only tools present, copy to capabilities."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "tools": {"filesystem": "read_only"}})
        assert result.get("capabilities") == {"filesystem": "read_only"}
        assert result.get("tools") == {"filesystem": "read_only"}

    def test_capabilities_only_passes_through(self) -> None:
        """When only capabilities present, use as-is."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "capabilities": {"git": "read_write"}})
        assert result.get("capabilities") == {"git": "read_write"}
        assert result.get("tools") == {"git": "read_write"}

    def test_both_fields_capabilities_wins(self) -> None:
        """When both tools and capabilities present, capabilities wins."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec(
            {
                "id": "test",
                "tools": {"filesystem": "read_only"},
                "capabilities": {"git": "read_write"},
            }
        )
        assert result.get("capabilities") == {"git": "read_write"}
        assert result.get("tools") == {"git": "read_write"}

    def test_neither_field_no_change(self) -> None:
        """When neither tools nor capabilities present, neither is added."""
        from larva.core.normalize import normalize_spec

        result = normalize_spec({"id": "test", "model": "gpt-4"})
        assert "capabilities" not in result or result.get("capabilities") is None
        assert "tools" not in result or result.get("tools") is None

    def test_digest_includes_capabilities_after_normalization(self) -> None:
        """Digest should reflect normalized capabilities field."""
        from larva.core.normalize import normalize_spec

        # tools-only input should produce same digest as if it had capabilities from start
        tools_only = normalize_spec({"id": "test", "tools": {"git": "read_only"}})
        capabilities_only = normalize_spec({"id": "test", "capabilities": {"git": "read_only"}})
        assert tools_only["spec_digest"] == capabilities_only["spec_digest"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
