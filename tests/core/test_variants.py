"""Expected-red tests for registry-local variant core semantics.

These tests define the contract for variant-aware core behavior BEFORE the
product implementation exists. They are expected to FAIL because the
implementation step has not yet added:

1. Forbidden registry-metadata fields (variant, _registry, active, manifest)
   to CANONICAL_FORBIDDEN_FIELDS in validation_contract.py
2. validate_variant_name core helper in a new or existing core module
3. FORBIDDEN_PATCH_FIELDS expansion to include variant/active/manifest/_registry
4. Digest exclusivity guarantees when registry metadata is absent

All failures must be caused by the product gap, not by malformed tests.
"""

import hashlib
import json
import re

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from larva.core import validate as validate_module
from larva.core.normalize import compute_spec_digest
from larva.core.patch import FORBIDDEN_PATCH_FIELDS, PatchError, apply_patches
from larva.core.validation_contract import CANONICAL_FORBIDDEN_FIELDS


# ---------------------------------------------------------------------------
# Canonical fixtures
# ---------------------------------------------------------------------------

VALID_SPEC_MINIMAL: dict = {
    "id": "variant-test-fixture",
    "description": "Minimal canonical PersonaSpec for variant contract tests.",
    "prompt": "You are a variant test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
}
"""Canonical shape: required fields only, no registry metadata."""


# ---------------------------------------------------------------------------
# Strategy helpers
# ---------------------------------------------------------------------------

# Variant name pattern: ^[a-z0-9]+(-[a-z0-9]+)*$, max length 64
_VARIANT_NAME_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

# Strategy for valid variant names
_valid_slug_segment = st.from_regex(r"[a-z0-9]{1,16}", fullmatch=True)


@st.composite
def valid_variant_names(draw: st.DrawFn) -> str:
    """Generate variant names matching `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars."""
    first = draw(st.from_regex(r"[a-z0-9]{1,20}", fullmatch=True))
    segments = draw(st.lists(st.from_regex(r"[a-z0-9]{1,20}", fullmatch=True), max_size=3))
    name = "-".join([first] + segments)
    # Ensure max 64 chars
    assume(len(name) <= 64)
    return name


@st.composite
def invalid_variant_names(draw: st.DrawFn) -> str:
    """Generate variant names that violate `^[a-z0-9]+(-[a-z0-9]+)*$` or exceed 64 chars."""
    kind = draw(
        st.sampled_from(
            [
                "uppercase",
                "underscore",
                "dot",
                "space",
                "slash",
                "empty",
                "too_long",
                "leading_dash",
                "trailing_dash",
                "double_dash",
                "special_char",
            ]
        )
    )
    if kind == "uppercase":
        return draw(st.from_regex(r"[A-Z][a-z0-9]+", fullmatch=True))
    elif kind == "underscore":
        return draw(st.from_regex(r"[a-z0-9]+_[a-z0-9]+", fullmatch=True))
    elif kind == "dot":
        return draw(st.from_regex(r"[a-z0-9]+\.[a-z0-9]+", fullmatch=True))
    elif kind == "space":
        return draw(st.from_regex(r"[a-z0-9]+ [a-z0-9]+", fullmatch=True))
    elif kind == "slash":
        return draw(st.from_regex(r"[a-z0-9]+/[a-z0-9]+", fullmatch=True))
    elif kind == "empty":
        return ""
    elif kind == "too_long":
        return "a" * 65
    elif kind == "leading_dash":
        return draw(st.from_regex(r"-[a-z0-9]+", fullmatch=True))
    elif kind == "trailing_dash":
        return draw(st.from_regex(r"[a-z0-9]+-", fullmatch=True))
    elif kind == "double_dash":
        return draw(st.from_regex(r"[a-z0-9]+--[a-z0-9]+", fullmatch=True))
    elif kind == "special_char":
        return draw(st.from_regex(r"[a-z0-9]+[!@#$%]+", fullmatch=True))
    else:
        return "INVALID"


# Forbidden registry metadata keys that must not appear as PersonaSpec fields
REGISTRY_METADATA_FIELDS = ("variant", "_registry", "active", "manifest")


# ---------------------------------------------------------------------------
# 1. Canonical validation rejects registry metadata fields
# ---------------------------------------------------------------------------


class TestForbiddenRegistryMetadataInSpec:
    """Canonical validation MUST reject variant, _registry, active, manifest.

    Per:
    - design/registry-local-variants-and-assembly-removal.md: "variant is not a
      PersonaSpec field, is not accepted inside spec"
    - final-canonical-contract.md: "variant, _registry, active, and manifest
      state are invalid inside PersonaSpec"
    - INTERFACES.md: "larva must reject unknown top-level fields, including
      variant, _registry, active, and manifest state"

    These fields must be rejected by validate_spec, either as explicit
    forbidden fields or as unknown top-level fields.
    """

    @pytest.mark.parametrize(
        "field",
        REGISTRY_METADATA_FIELDS,
    )
    def test_registry_metadata_field_rejected_by_validate(self, field: str) -> None:
        """Each registry metadata field is rejected by validate_spec."""
        spec = {
            **VALID_SPEC_MINIMAL,
            field: "should-be-rejected",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False, (
            f"validate_spec accepted PersonaSpec with '{field}' field; "
            f"registry metadata must never enter PersonaSpec"
        )
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"]), (
            f"Expected EXTRA_FIELD_NOT_ALLOWED error for '{field}', "
            f"got: {[e['code'] for e in report['errors']]}"
        )

    @given(field=st.sampled_from(REGISTRY_METADATA_FIELDS))
    def test_registry_metadata_rejected_property(self, field: str) -> None:
        """Property: every registry metadata field is rejected by validate_spec.

        This uses Hypothesis to permute through the registry metadata field names,
        confirming none slip through validation.
        """
        spec = {
            **VALID_SPEC_MINIMAL,
            field: {"some": "value"} if field in ("_registry", "manifest") else "value",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False
        assert any(e["code"] == "EXTRA_FIELD_NOT_ALLOWED" for e in report["errors"])

    def test_variant_field_in_spec_rejected(self) -> None:
        """'variant' inside PersonaSpec is explicitly rejected.

        Per case_matrix/larva.validate.yaml: variant_inside_spec_rejected
        Per case_matrix/larva.register.yaml: variant_inside_spec_rejected
        """
        spec = {**VALID_SPEC_MINIMAL, "variant": "tacit"}
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False
        variant_errors = [e for e in report["errors"] if e["details"].get("field") == "variant"]
        assert len(variant_errors) > 0, (
            "variant must appear in error details as the rejected field"
        )

    def test_registry_metadata_combined_rejected(self) -> None:
        """Multiple registry metadata fields together are all rejected."""
        spec = {
            **VALID_SPEC_MINIMAL,
            "variant": "tacit",
            "_registry": {"variant": "tacit", "is_active": True},
            "active": "tacit",
            "manifest": {"active": "tacit"},
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False
        rejected_fields = {e["details"].get("field") for e in report["errors"]}
        # All four must appear as rejected fields
        assert {"variant", "_registry", "active", "manifest"} <= rejected_fields, (
            f"Expected all four registry metadata fields in errors, "
            f"got rejected fields: {rejected_fields}"
        )

    def test_registry_metadata_forbidden_alongside_canonical(self) -> None:
        """Registry metadata is rejected even when all canonical fields are present."""
        spec = {
            **VALID_SPEC_MINIMAL,
            "model_params": {"temperature": 0.5},
            "can_spawn": False,
            "compaction_prompt": "Summarize.",
            "spec_digest": "sha256:" + "a" * 64,
            "variant": "should-be-rejected",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False, (
            "Registry metadata 'variant' must be rejected even alongside "
            "all canonical optional fields"
        )

    @given(
        field=st.sampled_from(REGISTRY_METADATA_FIELDS),
        value=st.one_of(
            st.just("tacit"),
            st.just({"active": "default"}),
            st.just({"variant": "x", "is_active": True}),
            st.integers(),
            st.just(None),
        ),
    )
    def test_registry_metadata_rejected_regardless_of_value_type(
        self, field: str, value: object
    ) -> None:
        """Property: registry metadata is rejected for any value type."""
        spec = {**VALID_SPEC_MINIMAL, field: value}
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False


class TestForbiddenFieldsIncludeRegistryMetadata:
    """CANONICAL_FORBIDDEN_FIELDS must include registry metadata keys.

    Per final-canonical-contract.md and design/registry-local-variants-and-assembly-removal.md:
    variant, _registry, active, manifest are forbidden at canonical admission.

    This test will fail until CANONICAL_FORBIDDEN_FIELDS is updated to include
    these fields.
    """

    @pytest.mark.parametrize(
        "field",
        REGISTRY_METADATA_FIELDS,
    )
    def test_canonical_forbidden_fields_includes_registry_metadata(self, field: str) -> None:
        """Each registry metadata field is in CANONICAL_FORBIDDEN_FIELDS."""
        assert field in CANONICAL_FORBIDDEN_FIELDS, (
            f"'{field}' must be in CANONICAL_FORBIDDEN_FIELDS; "
            f"registry metadata must never enter PersonaSpec at canonical admission"
        )

    def test_forbidden_fields_set_includes_known_legacy(self) -> None:
        """tools and side_effect_policy remain in CANONICAL_FORBIDDEN_FIELDS."""
        assert "tools" in CANONICAL_FORBIDDEN_FIELDS
        assert "side_effect_policy" in CANONICAL_FORBIDDEN_FIELDS

    def test_variables_not_canonical_field(self) -> None:
        """variables is also forbidden as a PersonaSpec field."""
        # variables may be in CANONICAL_FORBIDDEN_FIELDS or rejected as unknown.
        # Either way, validation must reject it.
        spec = {**VALID_SPEC_MINIMAL, "variables": {"role": "assistant"}}
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False


# ---------------------------------------------------------------------------
# 2. Variant name acceptance/rejection
# ---------------------------------------------------------------------------


class TestVariantNameAcceptance:
    """Variant names must match ^[a-z0-9]+(-[a-z0-9]+)*$ and length <= 64.

    Per:
    - design/registry-local-variants-and-assembly-removal.md: "Variant names
      use the same slug style as persona ids:
      ^[a-z0-9]+(-[a-z0-9]+)*$. Empty names, path separators, uppercase letters,
      underscores, dots, .., and names longer than 64 characters are invalid."
    - INTERFACES.md: "variant names must match ^[a-z0-9]+(-[a-z0-9]+)*$ and
      be at most 64 characters; violations return INVALID_VARIANT_NAME"

    These tests call a yet-to-be-implemented `validate_variant_name` core
    helper, so they are expected to fail until the implementation step.
    """

    def test_valid_variant_name_default(self) -> None:
        """'default' is a valid variant name."""
        from larva.core.validate import validate_variant_name

        result = validate_variant_name("default")
        assert result is not None  # returns without error
        # The function should return a valid indicator (e.g., True or the name)
        # Exact return contract to be defined by implementation step

    def test_valid_variant_name_tacit(self) -> None:
        """'tacit' is a valid variant name."""
        from larva.core.validate import validate_variant_name

        result = validate_variant_name("tacit")
        assert result is not None

    def test_valid_variant_name_multi_segment(self) -> None:
        """Multi-segment kebab names like 'code-reviewer' are valid."""
        from larva.core.validate import validate_variant_name

        result = validate_variant_name("code-reviewer")
        assert result is not None

    def test_valid_variant_name_exactly_64_chars(self) -> None:
        """Variant name of exactly 64 chars is valid."""
        from larva.core.validate import validate_variant_name

        name_64 = "a" * 64
        result = validate_variant_name(name_64)
        assert result is not None

    def test_invalid_variant_name_65_chars(self) -> None:
        """Variant name of 65 chars is invalid."""
        from larva.core.validate import validate_variant_name

        name_65 = "a" * 65
        with pytest.raises(Exception) as excinfo:
            validate_variant_name(name_65)
        # The error must reference INVALID_VARIANT_NAME
        assert "INVALID_VARIANT_NAME" in str(excinfo.value) or getattr(
            excinfo.value, "code", None
        ) == "INVALID_VARIANT_NAME"

    def test_invalid_variant_name_empty(self) -> None:
        """Empty variant name is invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("")

    def test_invalid_variant_name_uppercase(self) -> None:
        """Uppercase letters are invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("MyVariant")

    def test_invalid_variant_name_underscore(self) -> None:
        """Underscores are invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("my_variant")

    def test_invalid_variant_name_dot(self) -> None:
        """Dots are invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("my.variant")

    def test_invalid_variant_name_slash(self) -> None:
        """Path separators are invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("path/variant")

    def test_invalid_variant_name_double_dash(self) -> None:
        """Double dashes are invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("a--b")

    def test_invalid_variant_name_leading_dash(self) -> None:
        """Leading dash is invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("-leading")

    def test_invalid_variant_name_trailing_dash(self) -> None:
        """Trailing dash is invalid."""
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception):
            validate_variant_name("trailing-")

    @given(name=valid_variant_names())
    def test_valid_variant_names_property(self, name: str) -> None:
        """Property: all generated valid variant names pass validation."""
        from larva.core.validate import validate_variant_name

        result = validate_variant_name(name)
        assert result is not None

    @given(name=invalid_variant_names())
    def test_invalid_variant_names_property(self, name: str) -> None:
        """Property: all generated invalid variant names are rejected.

        Each invalid name must raise an exception referencing INVALID_VARIANT_NAME.
        """
        from larva.core.validate import validate_variant_name

        with pytest.raises(Exception) as excinfo:
            validate_variant_name(name)
        # Must reference INVALID_VARIANT_NAME in the error
        error_str = str(excinfo.value).upper()
        error_code = getattr(excinfo.value, "code", "")
        assert "INVALID_VARIANT_NAME" in error_str or "INVALID_VARIANT_NAME" == error_code, (
            f"Expected INVALID_VARIANT_NAME error for variant name '{name}', got: {excinfo.value}"
        )


class TestVariantNamePatternRegex:
    """Direct regex tests for the variant name pattern.

    These test the pattern directly and are expected to pass regardless
    of implementation, serving as a reference for the correct pattern.
    """

    _PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
    _MAX_LEN = 64

    @given(name=valid_variant_names())
    def test_valid_names_match_pattern(self, name: str) -> None:
        """Generated valid names match the variant name pattern."""
        assert self._PATTERN.fullmatch(name) is not None
        assert len(name) <= self._MAX_LEN

    @given(name=invalid_variant_names())
    def test_invalid_names_do_not_match_pattern(self, name: str) -> None:
        """Generated invalid names do not match the variant name pattern OR exceed 64 chars."""
        if len(name) > self._MAX_LEN:
            return  # Too long is already invalid by length
        if name == "":
            return  # Empty is trivially no match
        assert self._PATTERN.fullmatch(name) is None, (
            f"Invalid variant name '{name}' unexpectedly matched pattern"
        )


# ---------------------------------------------------------------------------
# 3. Variant PersonaSpec payloads remain canonical with spec.id == base id
# ---------------------------------------------------------------------------


class TestVariantPayloadsAreCanonicalPersonaSpec:
    """Every variant file is a canonical PersonaSpec with spec.id == base persona id.

    Per:
    - design/registry-local-variants-and-assembly-removal.md: "Every variant
      file has spec.id == <persona-id>."
    - INTERFACES.md: "variant is an operation parameter, not a PersonaSpec
      field"
    - final-canonical-contract.md: "variant, _registry, active, and manifest
      state are invalid inside PersonaSpec"

    These tests prove that adding registry metadata to a PersonaSpec breaks
    canonical validation, and that a spec with spec.id != base_id is a
    distinct spec, not a variant.
    """

    def test_canonical_spec_with_matching_id_is_valid(self) -> None:
        """A canonical PersonaSpec with id matching base is valid."""
        base_id = "code-reviewer"
        spec = {
            "id": base_id,
            "description": "Reviews code.",
            "prompt": "You are a code reviewer.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is True

    def test_variant_payload_with_registry_metadata_is_invalid(self) -> None:
        """A PersonaSpec with registry metadata fields is invalid.

        Per design: variant, _registry, active, manifest are never inside PersonaSpec.
        Adding them makes the spec fail validation.
        """
        spec = {
            "id": "code-reviewer",
            "description": "Reviews code.",
            "prompt": "You are a code reviewer.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
            "variant": "tacit",  # MUST NOT be in PersonaSpec
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is False, (
            "PersonaSpec with 'variant' field must fail validation; "
            "variant is registry metadata, not a PersonaSpec field"
        )

    def test_variant_payload_must_have_id_equal_to_base(self) -> None:
        """A variant payload with wrong id is a different persona, not a variant.

        This test documents that variant files must have spec.id matching the
        base persona id. If the ids differ, it is an ID_MISMATCH error at
        registration time (shell layer). At the core validation level, the
        spec is still valid as a PersonaSpec with a different id.
        """
        # A spec with different id is still a valid PersonaSpec in isolation
        spec = {
            "id": "different-id",
            "description": "Different persona.",
            "prompt": "You are different.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        report = validate_module.validate_spec(spec)
        assert report["valid"] is True  # valid as a standalone PersonaSpec
        # But at registration time, spec.id MUST match the base persona id
        # This is enforced at the shell/app layer (PERSONA_ID_MISMATCH)


# ---------------------------------------------------------------------------
# 4. Patch/override must not smuggle registry metadata into spec
# ---------------------------------------------------------------------------


class TestPatchRejectsRegistryMetadata:
    """Patching variant/active/manifest/_registry into a PersonaSpec is forbidden.

    Per:
    - design/registry-local-variants-and-assembly-removal.md: variant is an
      operation parameter, not a PersonaSpec field
    - case_matrix/larva.update.yaml: patch_variant_field_rejected
    - INTERFACES.md: variant is an operation parameter, not a PersonaSpec field

    These tests will fail until FORBIDDEN_PATCH_FIELDS in patch.py is expanded
    to include variant, _registry, active, and manifest.
    """

    @pytest.mark.parametrize(
        "field",
        REGISTRY_METADATA_FIELDS,
    )
    def test_patch_registry_metadata_rejected(self, field: str) -> None:
        """Each registry metadata field is rejected as a patch key."""
        base = {**VALID_SPEC_MINIMAL}
        patches = {field: "should-be-rejected"}
        with pytest.raises(PatchError) as excinfo:
            apply_patches(base, patches)
        assert excinfo.value.code == "FORBIDDEN_PATCH_FIELD"

    @given(field=st.sampled_from(REGISTRY_METADATA_FIELDS))
    def test_patch_registry_metadata_rejected_property(self, field: str) -> None:
        """Property: every registry metadata field is rejected in patches."""
        base = {**VALID_SPEC_MINIMAL}
        value: object = (
            {"variant": "x", "is_active": True}
            if field in ("_registry", "manifest")
            else "tacit"
        )
        patches = {field: value}
        with pytest.raises(PatchError):
            apply_patches(base, patches)

    def test_variant_patch_rejected(self) -> None:
        """'variant' in patches raises PatchError with FORBIDDEN_PATCH_FIELD.

        Per larva.update.yaml case_matrix: patch_variant_field_rejected
        """
        base = {**VALID_SPEC_MINIMAL}
        patches = {"variant": "tacit"}
        with pytest.raises(PatchError) as excinfo:
            apply_patches(base, patches)
        assert excinfo.value.code == "FORBIDDEN_PATCH_FIELD"
        assert excinfo.value.details["field"] == "variant"

    def test_active_patch_rejected(self) -> None:
        """'active' in patches raises PatchError."""
        base = {**VALID_SPEC_MINIMAL}
        patches = {"active": "tacit"}
        with pytest.raises(PatchError) as excinfo:
            apply_patches(base, patches)
        assert excinfo.value.code == "FORBIDDEN_PATCH_FIELD"

    def test_manifest_patch_rejected(self) -> None:
        """'manifest' in patches raises PatchError."""
        base = {**VALID_SPEC_MINIMAL}
        patches = {"manifest": {"active": "tacit"}}
        with pytest.raises(PatchError) as excinfo:
            apply_patches(base, patches)
        assert excinfo.value.code == "FORBIDDEN_PATCH_FIELD"

    def test_registry_patch_rejected(self) -> None:
        """'_registry' in patches raises PatchError."""
        base = {**VALID_SPEC_MINIMAL}
        patches = {"_registry": {"variant": "tacit", "is_active": True}}
        with pytest.raises(PatchError) as excinfo:
            apply_patches(base, patches)
        assert excinfo.value.code == "FORBIDDEN_PATCH_FIELD"

    @given(field=st.sampled_from(REGISTRY_METADATA_FIELDS))
    def test_dot_notation_registry_metadata_patch_rejected(self, field: str) -> None:
        """Dot-notation patches for registry metadata are also rejected.

        E.g., variant.name or _registry.variant must fail closed before
        dot-key expansion.
        """
        base = {**VALID_SPEC_MINIMAL}
        # Skip dot notation for _registry since it starts with _
        if field == "_registry":
            patches = {"_registry.variant": "tacit"}
        else:
            patches = {f"{field}.name": "tacit"}
        with pytest.raises(PatchError):
            apply_patches(base, patches)


class TestForbiddenPatchFieldsIncludesRegistryMetadata:
    """FORBIDDEN_PATCH_FIELDS must include variant/active/manifest/_registry.

    This test will fail until FORBIDDEN_PATCH_FIELDS is expanded.
    """

    @pytest.mark.parametrize(
        "field",
        REGISTRY_METADATA_FIELDS,
    )
    def test_forbidden_patch_fields_includes_registry_metadata(self, field: str) -> None:
        """Each registry metadata field is in FORBIDDEN_PATCH_FIELDS."""
        assert field in FORBIDDEN_PATCH_FIELDS, (
            f"'{field}' must be in FORBIDDEN_PATCH_FIELDS; "
            f"registry metadata must not be smuggled into PersonaSpec via patches"
        )

    def test_legacy_fields_remain_forbidden(self) -> None:
        """Legacy forbidden fields (tools, variables, side_effect_policy) remain."""
        assert "tools" in FORBIDDEN_PATCH_FIELDS
        assert "variables" in FORBIDDEN_PATCH_FIELDS
        assert "side_effect_policy" in FORBIDDEN_PATCH_FIELDS


# ---------------------------------------------------------------------------
# 5. Digest recomputation — registry metadata must not affect digest
# ---------------------------------------------------------------------------


class TestDigestExcludesRegistryMetadata:
    """spec_digest must reflect canonical content, not registry metadata.

    Per:
    - design/registry-local-variants-and-assembly-removal.md: "spec_digest is
      computed from canonical PersonaSpec content; switching active variants
      changes the resolved digest whenever resolved content changes."
    - final-canonical-contract.md: "spec_digest is computed from canonical
      PersonaSpec JSON (sorted keys, no whitespace, spec_digest excluded from
      input)"

    The key invariant: if two specs differ ONLY in registry metadata
    (variant/_registry/active/manifest), they MUST have the same digest.
    But if registry metadata somehow makes it into the spec dict, it
    WILL change the digest — proving it must never be there.

    These tests prove:
    1. Identical canonical specs produce identical digests
    2. Adding registry metadata to a spec dict changes the digest
       (confirming these fields must never be in the dict)
    3. Different canonical content produces different digests
    """

    def test_identical_specs_produce_identical_digests(self) -> None:
        """Two specs with identical canonical content have the same digest."""
        spec_a = {**VALID_SPEC_MINIMAL}
        spec_b = {**VALID_SPEC_MINIMAL}
        assert compute_spec_digest(spec_a) == compute_spec_digest(spec_b)

    def test_registry_metadata_in_spec_dict_changes_digest(self) -> None:
        """Adding variant field to a spec dict changes the digest.

        This proves that if variant ever enters the canonical dict,
        it will change the digest computation, which is wrong —
        variant must never be in the PersonaSpec dict.
        """
        base = {**VALID_SPEC_MINIMAL, "spec_version": "0.1.0"}
        with_variant = {**base, "variant": "tacit"}
        # compute_spec_digest includes ALL keys except spec_digest
        # If variant is in the dict, it WILL change the digest
        assert compute_spec_digest(base) != compute_spec_digest(with_variant), (
            "If variant enters the spec dict, it changes the digest — "
            "this is why variant must never be in PersonaSpec"
        )

    @pytest.mark.parametrize(
        "field",
        REGISTRY_METADATA_FIELDS,
    )
    def test_each_registry_metadata_field_changes_digest_if_present(
        self, field: str
    ) -> None:
        """Each registry metadata field would change the digest if present.

        This demonstrates the problem: if registry metadata leaks into the
        canonical spec dict, it artificially changes the digest. The fix is
        to ensure these fields never enter the spec dict.
        """
        base = {**VALID_SPEC_MINIMAL, "spec_version": "0.1.0"}
        value: object = (
            {"variant": "tacit", "is_active": True}
            if field in ("_registry", "manifest")
            else "tacit"
        )
        with_field = {**base, field: value}
        # These produce different digests, proving these fields
        # contaminate the canonical digest
        assert compute_spec_digest(base) != compute_spec_digest(with_field)

    def test_different_canonical_content_produces_different_digest(self) -> None:
        """Different canonical content produces different digests.

        This is the correct behavior: digest changes when canonical
        content changes, not when registry metadata is added.
        """
        spec_a = {
            "id": "reviewer",
            "description": "Reviews code changes.",
            "prompt": "You are a code reviewer.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        spec_b = {
            "id": "reviewer",
            "description": "Reviews code changes strictly.",
            "prompt": "You are a strict code reviewer.",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        assert compute_spec_digest(spec_a) != compute_spec_digest(spec_b)

    def test_same_content_different_id_different_digest(self) -> None:
        """Same content with different id produces different digest."""
        spec_a = {**VALID_SPEC_MINIMAL, "id": "persona-a"}
        spec_b = {**VALID_SPEC_MINIMAL, "id": "persona-b"}
        assert compute_spec_digest(spec_a) != compute_spec_digest(spec_b)

    @given(
        content_suffix=st.text(min_size=1, max_size=20, alphabet="abcdefghijklmnopqrstuvwxyz ")
    )
    def test_prompt_change_changes_digest(self, content_suffix: str) -> None:
        """Property: changing prompt content changes the digest."""
        base = {**VALID_SPEC_MINIMAL}
        modified = {**VALID_SPEC_MINIMAL, "prompt": VALID_SPEC_MINIMAL["prompt"] + content_suffix}
        assert compute_spec_digest(base) != compute_spec_digest(modified)

    def test_digest_deterministic_for_same_spec(self) -> None:
        """Digest is deterministic: same spec always produces same digest."""
        spec = {**VALID_SPEC_MINIMAL}
        digest_a = compute_spec_digest(spec)
        digest_b = compute_spec_digest(spec)
        assert digest_a == digest_b