"""Contract-driven tests for larva.core.patch module.

These 12 tests define the acceptance surface for patch application behavior:
1) scalar overwrite
2) protected fields stripped
3) deep merge model_params
4) deep merge tools
5) shallow overwrite other dicts
6) dot notation single level
7) dot notation multi level
8) dot notation merges with existing
9) empty patches
10) new key allowed
11) spec_digest removed from result
12) does not mutate inputs

All behavior tests are marked xfail until implementation step.
"""

import copy

import pytest
from hypothesis import given
from hypothesis import strategies as st

from larva.core.patch import (
    DEEP_MERGE_KEYS,
    DOT_KEY_SEPARATOR,
    PROTECTED_KEYS,
    apply_patches,
)


class TestScalarOverwrite:
    """Test 1: Scalar values in patches overwrite base values."""

    def test_scalar_string_overwrite(self) -> None:
        """Scalar string values in patches overwrite base string values."""
        base = {"id": "persona-a", "prompt": "original prompt"}
        patches = {"prompt": "new prompt"}
        result = apply_patches(base, patches)
        assert result["prompt"] == "new prompt"
        assert result["id"] == "persona-a"  # preserve base

    def test_scalar_int_overwrite(self) -> None:
        """Scalar int values in patches overwrite base int values."""
        base = {"id": "test", "count": 5}
        patches = {"count": 10}
        result = apply_patches(base, patches)
        assert result["count"] == 10

    def test_scalar_bool_overwrite(self) -> None:
        """Scalar bool values in patches overwrite base bool values."""
        base = {"id": "test", "can_spawn": True}
        patches = {"can_spawn": False}
        result = apply_patches(base, patches)
        assert result["can_spawn"] is False


class TestProtectedFieldsStripped:
    """Test 2: Protected keys are stripped from patches before merge."""

    def test_id_stripped_from_patches(self) -> None:
        """Protected key 'id' is stripped from patches."""
        base = {"id": "base-id", "prompt": "original"}
        patches = {"id": "patch-id", "prompt": "new"}
        result = apply_patches(base, patches)
        assert result["id"] == "base-id"  # preserved from base
        assert result["prompt"] == "new"  # applied from patch

    def test_spec_version_stripped_from_patches(self) -> None:
        """Protected key 'spec_version' is stripped from patches."""
        base = {"id": "test", "spec_version": "0.1.0"}
        patches = {"spec_version": "9.9.9", "prompt": "new"}
        result = apply_patches(base, patches)
        assert result["spec_version"] == "0.1.0"  # preserved from base

    def test_spec_digest_stripped_from_patches(self) -> None:
        """Protected key 'spec_digest' is stripped from patches (removed from result)."""
        base = {"id": "test", "spec_digest": "abc123"}
        patches = {"spec_digest": "xyz789", "prompt": "new"}
        result = apply_patches(base, patches)
        assert "spec_digest" not in result  # spec_digest is always removed
        assert result["prompt"] == "new"  # patch applied

    def test_all_protected_keys_defined(self) -> None:
        """Protected keys match expected set."""
        expected = frozenset({"id", "spec_digest", "spec_version"})
        assert PROTECTED_KEYS == expected


class TestDeepMergeModelParams:
    """Test 3: model_params uses deep merge semantics."""

    def test_deep_merge_adds_nested_keys(self) -> None:
        """Deep merge adds new nested keys to model_params."""
        base = {"id": "test", "model_params": {"temperature": 0.7}}
        patches = {"model_params": {"max_tokens": 100}}
        result = apply_patches(base, patches)
        assert result["model_params"] == {"temperature": 0.7, "max_tokens": 100}

    def test_deep_merge_overwrites_nested_keys(self) -> None:
        """Deep merge overwrites existing nested keys in model_params."""
        base = {"id": "test", "model_params": {"temperature": 0.7, "top_p": 0.9}}
        patches = {"model_params": {"temperature": 0.5}}
        result = apply_patches(base, patches)
        assert result["model_params"] == {"temperature": 0.5, "top_p": 0.9}

    def test_deep_merge_empty_base(self) -> None:
        """Deep merge with empty base preserves patch model_params."""
        base = {"id": "test"}
        patches = {"model_params": {"temperature": 0.8}}
        result = apply_patches(base, patches)
        assert result["model_params"] == {"temperature": 0.8}


class TestForbiddenLegacyPatches:
    """Forbidden legacy fields must be rejected before patch application."""

    def test_tools_patch_rejected(self) -> None:
        """tools patches must fail closed instead of applying."""
        with pytest.raises(Exception):
            apply_patches({"id": "test"}, {"tools": {"shell": "destructive"}})

    def test_variables_patch_rejected(self) -> None:
        """variables patches must fail closed instead of applying."""
        with pytest.raises(Exception):
            apply_patches({"id": "test"}, {"variables": {"role": "assistant"}})

    def test_side_effect_policy_patch_rejected(self) -> None:
        """side_effect_policy patches must fail closed instead of applying."""
        with pytest.raises(Exception):
            apply_patches({"id": "test"}, {"side_effect_policy": "allow"})

    @given(field=st.sampled_from(("tools", "variables", "side_effect_policy")))
    def test_forbidden_root_patch_keys_rejected(self, field: str) -> None:
        """Forbidden legacy patch roots must be rejected before merge semantics."""
        value: object = (
            "allow"
            if field == "side_effect_policy"
            else {"shell": "read_only"}
            if field == "tools"
            else {"role": "assistant"}
        )
        with pytest.raises(Exception):
            apply_patches({"id": "test"}, {field: value})

    @given(field=st.sampled_from(("tools", "variables", "side_effect_policy")))
    def test_forbidden_dot_patch_roots_rejected(self, field: str) -> None:
        """Forbidden legacy patch roots must be rejected before dot expansion."""
        with pytest.raises(Exception):
            apply_patches({"id": "test"}, {f"{field}.nested": "value"})


class TestShallowOverwriteOtherDicts:
    """Test 5: Other dict fields shallow overwrite."""

    def test_non_deep_merge_dict_shallow_replace(self) -> None:
        """Dict fields NOT in DEEP_MERGE_KEYS shallow replace entire dict."""
        base = {"id": "test", "variables": {"VAR1": "value1", "VAR2": "value2"}}
        patches = {"variables": {"VAR3": "value3"}}
        with pytest.raises(Exception):
            apply_patches(base, patches)

    def test_unknown_dict_key_shallow_replace(self) -> None:
        """Unknown dict keys are shallow replaced."""
        base = {"id": "test", "custom_dict": {"a": 1, "b": 2}}
        patches = {"custom_dict": {"c": 3}}
        result = apply_patches(base, patches)
        assert result["custom_dict"] == {"c": 3}


class TestDotNotationSingleLevel:
    """Test 6: Dot notation keys expand to single-level nested dicts."""

    def test_single_dot_expands_to_nested(self) -> None:
        """Dot notation 'a.b' creates nested dict {'a': {'b': value}}."""
        base = {"id": "test"}
        patches = {"model_params.temperature": 0.5}
        result = apply_patches(base, patches)
        assert result["model_params"] == {"temperature": 0.5}

    def test_single_dot_with_existing_nested(self) -> None:
        """Dot notation merges with existing nested structure."""
        base = {"id": "test", "model_params": {"max_tokens": 100}}
        patches = {"model_params.temperature": 0.5}
        result = apply_patches(base, patches)
        assert result["model_params"] == {"max_tokens": 100, "temperature": 0.5}


class TestDotNotationMultiLevel:
    """Test 7: Dot notation keys expand to multi-level nested dicts."""

    def test_two_dots_creates_three_levels(self) -> None:
        """Dot notation 'a.b.c' creates nested dict {'a': {'b': {'c': value}}}."""
        base = {"id": "test"}
        patches = {"config.database.host": "localhost"}
        result = apply_patches(base, patches)
        assert result == {"id": "test", "config": {"database": {"host": "localhost"}}}

    def test_three_dots_creates_four_levels(self) -> None:
        """Dot notation 'a.b.c.d' creates 4-level nested dict."""
        base = {"id": "test"}
        patches = {"a.b.c.d": "value"}
        result = apply_patches(base, patches)
        assert result == {"id": "test", "a": {"b": {"c": {"d": "value"}}}}


class TestDotNotationMergesWithExisting:
    """Test 8: Dot notation merges with existing nested structure."""

    def test_dot_merge_preserves_sibling_keys(self) -> None:
        """Dot notation merge preserves sibling keys at same level."""
        base = {"id": "test", "model_params": {"max_tokens": 100, "top_p": 0.9}}
        patches = {"model_params.temperature": 0.5}
        result = apply_patches(base, patches)
        assert result["model_params"] == {
            "max_tokens": 100,
            "top_p": 0.9,
            "temperature": 0.5,
        }


class TestEmptyPatches:
    """Test 9: Empty patches result in unchanged base."""

    def test_empty_patches_preserves_base(self) -> None:
        """Empty patches dict returns unchanged copy of base."""
        base = {"id": "test", "prompt": "hello"}
        patches: dict[str, object] = {}
        result = apply_patches(base, patches)
        assert result == {"id": "test", "prompt": "hello"}

    def test_empty_patches_with_protected_only(self) -> None:
        """Patches with only protected keys result in unchanged base."""
        base = {"id": "test", "prompt": "hello"}
        patches = {"id": "ignored", "spec_version": "ignored"}
        result = apply_patches(base, patches)
        assert result == {"id": "test", "prompt": "hello"}


class TestNewKeyAllowed:
    """Test 10: Patches may introduce new keys not in base."""

    def test_new_top_level_key_added(self) -> None:
        """Patches can add new top-level keys."""
        base = {"id": "test"}
        patches = {"prompt": "new prompt"}
        result = apply_patches(base, patches)
        assert result["prompt"] == "new prompt"

    def test_new_nested_key_added_via_dot(self) -> None:
        """Patches can add new nested keys via dot notation."""
        base = {"id": "test"}
        patches = {"model_params.temperature": 0.5}
        result = apply_patches(base, patches)
        assert result["model_params"] == {"temperature": 0.5}


class TestSpecDigestRemoved:
    """Test 11: spec_digest is removed from result."""

    def test_spec_digest_removed_from_result(self) -> None:
        """spec_digest key is never present in result."""
        base = {"id": "test", "spec_digest": "abc123"}
        patches: dict[str, object] = {}
        result = apply_patches(base, patches)
        assert "spec_digest" not in result

    def test_spec_digest_stripped_even_from_base(self) -> None:
        """spec_digest is stripped even if only in base."""
        base = {"id": "test", "spec_digest": "base-digest", "prompt": "hello"}
        patches: dict[str, object] = {}
        result = apply_patches(base, patches)
        assert "spec_digest" not in result


class TestNoInputMutation:
    """Test 12: apply_patches does not mutate inputs."""

    def test_base_not_mutated(self) -> None:
        """apply_patches does not mutate the base dict."""
        base = {"id": "test", "model_params": {"temperature": 0.7}}
        base_copy = copy.deepcopy(base)
        patches = {"prompt": "new"}
        result = apply_patches(base, patches)
        assert base == base_copy, "base was mutated"
        assert result is not base, "result should be a new dict"

    def test_patches_not_mutated(self) -> None:
        """apply_patches does not mutate the patches dict."""
        base = {"id": "test"}
        patches = {"model_params": {"temperature": 0.5}}
        patches_copy = copy.deepcopy(patches)
        result = apply_patches(base, patches)
        assert patches == patches_copy, "patches was mutated"
        assert result is not patches, "result should not reference patches"

    def test_deep_merge_preserves_original_nested(self) -> None:
        """Deep merge doesn't mutate original nested dicts in base."""
        base = {"id": "test", "model_params": {"temperature": 0.7}}
        base_model_params_id = id(base["model_params"])
        patches = {"model_params": {"max_tokens": 100}}
        result = apply_patches(base, patches)
        assert id(base["model_params"]) == base_model_params_id, "base nested dict mutated"
        assert result["model_params"] is not base["model_params"]


class TestContractConstants:
    """Verify module constants match specification."""

    def test_protected_keys(self) -> None:
        """PROTECTED_KEYS contains expected protected field names."""
        assert PROTECTED_KEYS == frozenset({"id", "spec_digest", "spec_version"})

    def test_deep_merge_keys(self) -> None:
        """DEEP_MERGE_KEYS contains fields that use deep merge semantics."""
        assert DEEP_MERGE_KEYS == frozenset({"model_params", "capabilities"})

    def test_dot_key_separator(self) -> None:
        """DOT_KEY_SEPARATOR is a single period."""
        assert DOT_KEY_SEPARATOR == "."
