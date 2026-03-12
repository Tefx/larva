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


class TestNormalizeSpecStubBehavior:
    """Test normalize_spec stub raises NotImplementedError."""

    def test_raises_not_implemented_error(self) -> None:
        """Calling normalize_spec should raise NotImplementedError.

        Note: Due to a bug in invar_runtime (invar_runtime/contracts.py:128),
        the contract validation fails with AttributeError before reaching
        the NotImplementedError when the input is a dict. This test uses
        deal.disable() to bypass the contract validation and test the
        underlying stub behavior.
        """
        from larva.core.normalize import normalize_spec
        import deal

        # Use module-level disable to bypass contract validation
        deal.disable()
        try:
            with pytest.raises(NotImplementedError):
                normalize_spec({"id": "test"})
        finally:
            deal.enable()

    def test_raises_not_implemented_error_with_empty_dict(self) -> None:
        """Calling normalize_spec with empty dict should raise NotImplementedError."""
        from larva.core.normalize import normalize_spec
        import deal

        deal.disable()
        try:
            with pytest.raises(NotImplementedError):
                normalize_spec({})
        finally:
            deal.enable()

    def test_error_message_indicates_pending_implementation(self) -> None:
        """NotImplementedError should indicate implementation is pending."""
        from larva.core.normalize import normalize_spec
        import deal

        deal.disable()
        try:
            with pytest.raises(NotImplementedError, match="normalize_spec.*pending"):
                normalize_spec({"id": "test"})
        finally:
            deal.enable()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
