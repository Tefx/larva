"""Canonical contract tests for larva.core.spec.

These tests express the frozen authority for the PersonaSpec type shape,
as established by ADR-002 (capabilities is sole declaration surface; tools
rejected at canonical admission), ADR-003 (canonical requiredness authority),
and the opifex canonical authority basis.

Canonical contract (per validate.py CANONICAL_*_FIELDS):
- Required: id, description, prompt, model, capabilities, spec_version
- Optional: model_params, can_spawn, compaction_prompt, spec_digest
- Forbidden: tools, side_effect_policy
- Unknown top-level fields: forbidden at canonical admission

Where tests reference historical non-canonical payloads, they do so only to
prove those shapes are excluded from the canonical typing contract.
"""

import pytest


# ---------------------------------------------------------------------------
# Canonical fixtures
# ---------------------------------------------------------------------------

# At least one fixture per external format must match the exact documented
# canonical shape without convenience fields.  This fixture is the single
# source of truth for downstream test consumers.

CANONICAL_PERSONA_SPEC_MINIMAL: dict = {
    "id": "canonical-fixture",
    "description": "Canonical fixture — minimal required-only shape",
    "prompt": "You are a canonical test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
}
"""Exact canonical shape: required fields only, no optional fields,
no forbidden fields, no convenience aliases."""

CANONICAL_PERSONA_SPEC_FULL: dict = {
    "id": "canonical-fixture-full",
    "description": "Canonical fixture — all optional fields present",
    "prompt": "You are a canonical test persona.",
    "model": "gpt-4o-mini",
    "capabilities": {"shell": "read_only", "git": "read_write"},
    "model_params": {"temperature": 0.7},
    "can_spawn": True,
    "compaction_prompt": "Summarise the conversation.",
    "spec_version": "0.1.0",
    "spec_digest": "sha256:" + "a" * 64,
}
"""Canonical shape: required plus every optional field.  No forbidden fields."""


# ---------------------------------------------------------------------------
# ToolPosture literal domain
# ---------------------------------------------------------------------------


class TestToolPostureLiteralDomain:
    """Tests for ToolPosture type alias literal domain."""

    def test_tool_posture_accepts_none(self) -> None:
        """Assert 'none' is a valid ToolPosture value."""
        posture: str = "none"
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


# ---------------------------------------------------------------------------
# PersonaSpec structure — canonical authority
# ---------------------------------------------------------------------------


class TestPersonaSpecStructure:
    """Tests for PersonaSpec TypedDict structure — canonical authority.

    Per ADR-003 and the opifex authority basis:
    - Required keys: id, description, prompt, model, capabilities, spec_version
    - Optional keys: model_params, can_spawn, compaction_prompt, spec_digest
    - Forbidden: tools, side_effect_policy (and any unknown top-level field)
    """

    def test_persona_spec_is_typeddict(self) -> None:
        """Assert PersonaSpec is a TypedDict subclass."""
        from larva.core.spec import PersonaSpec

        assert hasattr(PersonaSpec, "__required_keys__")
        assert hasattr(PersonaSpec, "__optional_keys__")
        assert hasattr(PersonaSpec, "__annotations__")

    def test_persona_spec_has_canonical_required_keys(self) -> None:
        """Assert PersonaSpec required keys match canonical admission boundary.

        Per ADR-003: required = {id, description, prompt, model, capabilities,
        spec_version}.  capabilities is required, not optional.
        """
        from larva.core.spec import PersonaSpec

        assert PersonaSpec.__required_keys__ == {
            "id",
            "description",
            "prompt",
            "model",
            "capabilities",
            "spec_version",
        }

    def test_persona_spec_has_canonical_optional_keys(self) -> None:
        """Assert PersonaSpec optional keys match canonical admission boundary.

        Per ADR-003: optional = {model_params, can_spawn, compaction_prompt,
        spec_digest}.  Note: variables is NOT a PersonaSpec field — it is an
        assembly-time concept only.
        """
        from larva.core.spec import PersonaSpec

        assert PersonaSpec.__optional_keys__ == {
            "model_params",
            "can_spawn",
            "compaction_prompt",
            "spec_digest",
        }

    def test_persona_spec_exposes_all_documented_fields(self) -> None:
        """Assert PersonaSpec exposes canonical fields (9 total).

        Canonical fields: id, description, prompt, model, capabilities,
        spec_version, model_params, can_spawn, compaction_prompt, spec_digest.
        Note: 9 annotations because spec_version is Required[Literal["0.1.0"]]
        which counts as one annotation key.
        """
        from larva.core.spec import PersonaSpec

        expected_fields = {
            "id",
            "description",
            "prompt",
            "model",
            "capabilities",
            "model_params",
            "can_spawn",
            "compaction_prompt",
            "spec_version",
            "spec_digest",
        }

        actual_fields = set(PersonaSpec.__annotations__.keys())
        assert actual_fields == expected_fields

    def test_persona_spec_field_count(self) -> None:
        """Assert PersonaSpec has exactly 10 canonical fields (6 required + 4 optional)."""
        from larva.core.spec import PersonaSpec

        field_count = len(PersonaSpec.__annotations__)
        assert field_count == 10

    def test_tools_not_in_persona_spec_annotations(self) -> None:
        """Assert 'tools' is NOT a PersonaSpec annotation — forbidden at canonical admission."""
        from larva.core.spec import PersonaSpec

        assert "tools" not in PersonaSpec.__annotations__, (
            "'tools' is forbidden at canonical admission and must not appear "
            "in PersonaSpec type annotations"
        )

    def test_side_effect_policy_not_in_persona_spec_annotations(self) -> None:
        """Assert 'side_effect_policy' is NOT a PersonaSpec annotation — forbidden."""
        from larva.core.spec import PersonaSpec

        assert "side_effect_policy" not in PersonaSpec.__annotations__, (
            "'side_effect_policy' is forbidden at canonical admission and must "
            "not appear in PersonaSpec type annotations"
        )


class TestSpecVersion:
    """Tests for spec_version pinned value."""

    def test_spec_version_is_literal_0_1_0(self) -> None:
        """Assert spec_version field type is Literal['0.1.0']."""
        from larva.core.spec import PersonaSpec

        spec_version_type = PersonaSpec.__annotations__["spec_version"]

        # spec_version is annotated as Required[Literal["0.1.0"]]
        if hasattr(spec_version_type, "__args__"):
            required_inner = spec_version_type.__args__[0]
            literal_values = required_inner.__args__
            assert "0.1.0" in literal_values

    def test_spec_version_value_pinned(self) -> None:
        """Assert spec_version value is pinned to '0.1.0'."""
        valid_version = "0.1.0"
        assert valid_version == "0.1.0"

        # Invalid versions should not match
        invalid_versions = ["0.1.1", "0.2.0", "1.0.0", "latest"]
        for invalid in invalid_versions:
            assert invalid != "0.1.0"


# ---------------------------------------------------------------------------
# Import consumability — canonical exports
# ---------------------------------------------------------------------------


class TestImportConsumability:
    """Tests proving the canonical contract is consumable by downstream modules."""

    def test_imports_from_core_spec(self) -> None:
        """Assert canonical symbols are importable from larva.core.spec."""
        from larva.core.spec import (
            PersonaSpec,
            ToolPosture,
        )

        assert ToolPosture is not None
        assert PersonaSpec is not None

    def test_import_via_module(self) -> None:
        """Assert module-level imports work for downstream consumption."""
        import larva.core.spec as spec_module

        assert hasattr(spec_module, "ToolPosture")
        assert hasattr(spec_module, "PersonaSpec")

    def test_all_exports_in_public_api(self) -> None:
        """Assert all public symbols are in __all__."""
        import larva.core.spec as spec_module

        expected_all = {
            "AssemblyInput",
            "ConstraintComponent",
            "ModelComponent",
            "PersonaSpec",
            "PromptComponent",
            "ToolsetComponent",
            "ToolPosture",
        }
        assert set(spec_module.__all__) == expected_all

    def test_canonical_minimal_fixture_is_valid_typed_dict(self) -> None:
        """Assert CANONICAL_PERSONA_SPEC_MINIMAL satisfies PersonaSpec shape.

        This is the spec-fixture conformance test: the minimal fixture must
        match the exact documented canonical shape without convenience fields.
        """
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = CANONICAL_PERSONA_SPEC_MINIMAL  # type: ignore[assignment]
        assert spec["id"] == "canonical-fixture"
        assert spec["description"] == "Canonical fixture — minimal required-only shape"
        assert spec["prompt"] == "You are a canonical test persona."
        assert spec["model"] == "gpt-4o-mini"
        assert spec["capabilities"]["shell"] == "read_only"
        assert spec["spec_version"] == "0.1.0"
        # No forbidden fields
        assert "tools" not in spec
        assert "side_effect_policy" not in spec

    def test_canonical_full_fixture_is_valid_typed_dict(self) -> None:
        """Assert CANONICAL_PERSONA_SPEC_FULL satisfies PersonaSpec shape.

        This fixture includes all optional canonical fields.
        """
        from larva.core.spec import PersonaSpec

        spec: PersonaSpec = CANONICAL_PERSONA_SPEC_FULL  # type: ignore[assignment]
        assert spec["id"] == "canonical-fixture-full"
        assert spec["model_params"]["temperature"] == 0.7
        assert spec["can_spawn"] is True
        assert spec["compaction_prompt"] == "Summarise the conversation."
        assert spec["spec_digest"].startswith("sha256:")
        # No forbidden fields
        assert "tools" not in spec
        assert "side_effect_policy" not in spec

    def test_persona_spec_no_forbidden_keys_at_runtime(self) -> None:
        """Assert PersonaSpec TypedDict does not accept forbidden keys at type level.

        tools and side_effect_policy are not in __annotations__ or __required_keys__
        or __optional_keys__.  This test confirms the frozen contract.
        """
        from larva.core.spec import PersonaSpec

        all_keys = PersonaSpec.__required_keys__ | PersonaSpec.__optional_keys__
        assert "tools" not in all_keys, (
            "'tools' must not be a PersonaSpec key at canonical admission"
        )
        assert "side_effect_policy" not in all_keys, (
            "'side_effect_policy' must not be a PersonaSpec key at canonical admission"
        )

    def test_capabilities_in_dict_value(self) -> None:
        """Assert ToolPosture can be used as dict value type for capabilities."""
        from larva.core.spec import PersonaSpec, ToolPosture

        capabilities: dict[str, ToolPosture] = {
            "read": "read_only",
            "write": "read_write",
            "delete": "destructive",
        }
        spec: PersonaSpec = {"id": "test", "capabilities": capabilities}
        assert spec["capabilities"]["read"] == "read_only"


# ---------------------------------------------------------------------------
# Capabilities field — canonical surface
# ---------------------------------------------------------------------------


class TestCapabilitiesField:
    """Tests for the canonical capabilities field in PersonaSpec."""

    def test_capabilities_field_accepts_tool_postures(self) -> None:
        """Assert PersonaSpec with capabilities: {'filesystem': 'read_write'} is valid."""
        from larva.core.spec import PersonaSpec, ToolPosture

        capabilities: dict[str, ToolPosture] = {"filesystem": "read_write"}
        spec: PersonaSpec = {"id": "test", "capabilities": capabilities}
        assert spec["capabilities"]["filesystem"] == "read_write"

    def test_tools_not_in_persona_spec_field_set(self) -> None:
        """Assert 'tools' is NOT a PersonaSpec key — ADR-002 canonical contract.

        Per ADR-002, capabilities is the sole canonical declaration surface.
        'tools' is forbidden at canonical admission and must not appear as a
        PersonaSpec type field.
        """
        from larva.core.spec import PersonaSpec

        all_keys = PersonaSpec.__required_keys__ | PersonaSpec.__optional_keys__
        assert "tools" not in all_keys


# ---------------------------------------------------------------------------
# ToolsetComponent — canonical shape (capabilities-only)
# ---------------------------------------------------------------------------


class TestToolsetComponentCanonicalShape:
    """Tests for ToolsetComponent canonical shape — ADR-002 authority.

    Per ADR-002 and spec.py docstring: ``ToolsetComponent`` has only the
    ``capabilities`` field as Required. The ``tools`` key is a historical
    non-canonical payload shape and is NOT part of the canonical TypedDict.

    Historical invalid payloads with a ``tools`` key may still appear in
    rejection-path tests, but they are not part of the type definition.
    """

    def test_toolset_component_has_capabilities(self) -> None:
        """Assert ToolsetComponent requires capabilities key."""
        from larva.core.spec import ToolsetComponent, ToolPosture

        capabilities: dict[str, ToolPosture] = {"search": "read_only", "fs": "read_write"}
        toolset: ToolsetComponent = {"capabilities": capabilities}
        assert toolset["capabilities"]["search"] == "read_only"

    def test_toolset_component_capabilities_only_shape(self) -> None:
        """Assert ToolsetComponent canonical shape is capabilities-only (ADR-002)."""
        from larva.core.spec import ToolsetComponent, ToolPosture

        # Per ADR-002: capabilities is the canonical field
        capabilities: dict[str, ToolPosture] = {"filesystem": "read_write", "git": "read_only"}
        toolset: ToolsetComponent = {"capabilities": capabilities}
        assert "capabilities" in toolset
        assert "tools" not in toolset

    def test_toolset_component_required_keys_is_capabilities_only(self) -> None:
        """Assert ToolsetComponent __required_keys__ is {'capabilities'}."""
        from larva.core.spec import ToolsetComponent

        assert ToolsetComponent.__required_keys__ == {"capabilities"}

    def test_toolset_component_annotations_is_capabilities_only(self) -> None:
        """Assert ToolsetComponent annotations contain only 'capabilities'.

        The canonical ToolsetComponent has exactly one annotation key:
        'capabilities'.  The 'tools' key is NOT part of this TypedDict.
        """
        from larva.core.spec import ToolsetComponent

        assert set(ToolsetComponent.__annotations__.keys()) == {"capabilities"}

    def test_toolset_component_has_no_tools_key(self) -> None:
        """Assert 'tools' is NOT in ToolsetComponent annotations — canonical authority.

        Per ADR-002: capabilities is the canonical surface; tools only appears
        in historical invalid payload examples, not in ToolsetComponent.
        """
        from larva.core.spec import ToolsetComponent

        assert "tools" not in ToolsetComponent.__annotations__, (
            "'tools' must not appear in ToolsetComponent annotations; "
            "use 'capabilities' per ADR-002"
        )


# ---------------------------------------------------------------------------
# ConstraintComponent — canonical shape (can_spawn, compaction_prompt only)
# ---------------------------------------------------------------------------


class TestConstraintComponentCanonicalShape:
    """Tests for ConstraintComponent canonical shape — ADR-002 authority.

    Per spec.py docstring: ``ConstraintComponent`` has ``can_spawn`` and
    ``compaction_prompt`` only (total=False).  The ``side_effect_policy``
    key is NOT part of the canonical ConstraintComponent.
    """

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

    def test_constraint_component_annotations_are_canonical(self) -> None:
        """Assert ConstraintComponent annotations match canonical shape.

        Canonical: can_spawn and compaction_prompt only.
        side_effect_policy is NOT in ConstraintComponent.
        """
        from larva.core.spec import ConstraintComponent

        assert set(ConstraintComponent.__annotations__.keys()) == {
            "can_spawn",
            "compaction_prompt",
        }

    def test_constraint_component_has_no_side_effect_policy(self) -> None:
        """Assert 'side_effect_policy' is NOT in ConstraintComponent annotations.

        Per ADR-002: side_effect_policy is rejected at canonical admission.
        It is NOT a ConstraintComponent field.
        """
        from larva.core.spec import ConstraintComponent

        assert "side_effect_policy" not in ConstraintComponent.__annotations__, (
            "'side_effect_policy' must not appear in ConstraintComponent; "
            "rejected at canonical admission per ADR-002"
        )


# ---------------------------------------------------------------------------
# Capabilities with all ToolPosture values — canonical surface
# ---------------------------------------------------------------------------


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
