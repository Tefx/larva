"""Integration tests for larva.shell.components filesystem store.

These tests exercise the production FilesystemComponentStore against real
temporary filesystem fixtures for success, list, and typed error paths.
"""

from pathlib import Path

import pytest
from returns.result import Failure, Result, Success

from larva.shell.components import (
    COMPONENT_NOT_FOUND_CODE,
    ComponentStore,
    ComponentStoreError,
    FilesystemComponentStore,
)


@pytest.fixture
def temp_component_store(tmp_path: Path) -> FilesystemComponentStore:
    """Create a production store with fixture components on disk."""
    components_dir = tmp_path / "components"
    prompts_dir = components_dir / "prompts"
    toolsets_dir = components_dir / "toolsets"
    constraints_dir = components_dir / "constraints"
    models_dir = components_dir / "models"

    prompts_dir.mkdir(parents=True)
    toolsets_dir.mkdir(parents=True)
    constraints_dir.mkdir(parents=True)
    models_dir.mkdir(parents=True)

    (prompts_dir / "test_prompt.md").write_text(
        "# Test Prompt\n\nThis is a test prompt for the persona.",
        encoding="utf-8",
    )
    (toolsets_dir / "test_toolset.yaml").write_text(
        """# Per ADR-002: toolsets use capabilities (canonical) with tools mirrored for backward compat
capabilities:
  filesystem: read_write
  shell: read_only
  http: none
tools:  # DEPRECATED: mirrored from capabilities (ADR-002)
  filesystem: read_write
  shell: read_only
  http: none
""",
        encoding="utf-8",
    )
    (constraints_dir / "test_constraint.yaml").write_text(
        """# Note: side_effect_policy is deprecated in constraints (ADR-002)
# Runtime concerns like approval policy don't belong in persona artifacts
can_spawn: true
side_effect_policy: approval_required  # DEPRECATED
compaction_prompt: Compact the state.
""",
        encoding="utf-8",
    )
    (models_dir / "test_model.yaml").write_text(
        """model: gpt-4
model_params:
  temperature: 0.7
  top_p: 0.9
""",
        encoding="utf-8",
    )

    return FilesystemComponentStore(components_dir)


class TestFilesystemComponentStoreIntegration:
    def test_uses_production_store_implementation(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove tests are wired to production larva.shell.components implementation."""
        assert FilesystemComponentStore.__module__ == "larva.shell.components"
        assert temp_component_store.__class__.__module__ == "larva.shell.components"

    def test_load_prompt_returns_raw_markdown(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        result = temp_component_store.load_prompt("test_prompt")

        assert isinstance(result, Result)
        assert isinstance(result, Success)
        prompt = result.unwrap()
        assert "# Test Prompt" in prompt["text"]
        assert "test prompt for the persona" in prompt["text"]

    def test_load_toolset_parses_yaml(self, temp_component_store: FilesystemComponentStore) -> None:
        result = temp_component_store.load_toolset("test_toolset")

        assert isinstance(result, Result)
        assert isinstance(result, Success)
        toolset = result.unwrap()
        # Per ADR-002: capabilities is canonical
        assert toolset["capabilities"]["filesystem"] == "read_write"
        assert toolset["capabilities"]["shell"] == "read_only"
        assert toolset["capabilities"]["http"] == "none"
        # Canonical: only capabilities field is present, tools is not mirrored

    def test_load_constraint_parses_yaml(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        result = temp_component_store.load_constraint("test_constraint")

        assert isinstance(result, Success)
        constraint = result.unwrap()
        assert constraint["can_spawn"] is True
        # Canonical: side_effect_policy is stripped, not returned
        assert "side_effect_policy" not in constraint
        assert constraint["compaction_prompt"] == "Compact the state."

    def test_load_model_parses_yaml(self, temp_component_store: FilesystemComponentStore) -> None:
        result = temp_component_store.load_model("test_model")

        assert isinstance(result, Success)
        model = result.unwrap()
        assert model["model"] == "gpt-4"
        assert model["model_params"]["temperature"] == 0.7
        assert model["model_params"]["top_p"] == 0.9

    def test_list_components_returns_sorted_inventory(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        result = temp_component_store.list_components()

        assert isinstance(result, Success)
        inventory = result.unwrap()
        assert inventory == {
            "prompts": ["test_prompt"],
            "toolsets": ["test_toolset"],
            "constraints": ["test_constraint"],
            "models": ["test_model"],
        }

    @pytest.mark.parametrize(
        ("loader_name", "component_type"),
        [
            ("load_prompt", "prompt"),
            ("load_toolset", "toolset"),
            ("load_constraint", "constraint"),
            ("load_model", "model"),
        ],
    )
    def test_missing_component_returns_typed_error(
        self,
        temp_component_store: FilesystemComponentStore,
        loader_name: str,
        component_type: str,
    ) -> None:
        loader = getattr(temp_component_store, loader_name)
        result = loader("nonexistent")

        assert isinstance(result, Failure)
        error = result.failure()
        assert isinstance(error, ComponentStoreError)
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert error.component_type == component_type
        assert error.component_name == "nonexistent"

    @pytest.mark.parametrize(
        ("loader_name", "component_type", "escaped_name"),
        [
            ("load_prompt", "prompt", "../constraints/test_constraint"),
            ("load_toolset", "toolset", "../models/test_model"),
            ("load_constraint", "constraint", "../toolsets/test_toolset"),
            ("load_model", "model", "../constraints/test_constraint"),
            ("load_model", "model", "..\\constraints\\test_constraint"),
        ],
    )
    def test_cross_type_and_traversal_names_are_rejected_with_typed_error(
        self,
        temp_component_store: FilesystemComponentStore,
        loader_name: str,
        component_type: str,
        escaped_name: str,
    ) -> None:
        loader = getattr(temp_component_store, loader_name)
        result = loader(escaped_name)

        assert isinstance(result, Failure)
        error = result.failure()
        assert isinstance(error, ComponentStoreError)
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert error.component_type == component_type
        assert error.component_name == escaped_name
        assert "Invalid" in str(error)

    def test_load_prompt_read_error_returns_typed_error(self, tmp_path: Path) -> None:
        components_dir = tmp_path / "components"
        prompts_dir = components_dir / "prompts"
        prompts_dir.mkdir(parents=True)
        (components_dir / "toolsets").mkdir()
        (components_dir / "constraints").mkdir()
        (components_dir / "models").mkdir()
        (prompts_dir / "bad.md").mkdir()

        store = FilesystemComponentStore(components_dir)
        result = store.load_prompt("bad")

        assert isinstance(result, Failure)
        error = result.failure()
        assert isinstance(error, ComponentStoreError)
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert error.component_type == "prompt"
        assert error.component_name == "bad"


class TestComponentStoreProtocolCompliance:
    def test_implements_protocol(self, temp_component_store: FilesystemComponentStore) -> None:
        store: ComponentStore = temp_component_store
        assert store is not None

    def test_component_store_error_is_typed_shell_error(self) -> None:
        error = ComponentStoreError(
            "Test error",
            component_type="prompt",
            component_name="test",
        )
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert str(error) == "Test error"
        assert error.component_type == "prompt"
        assert error.component_name == "test"
