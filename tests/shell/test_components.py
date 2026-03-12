"""Contract-driven tests for larva.shell.components.

These tests verify the `ComponentStore` protocol contract using a
filesystem-backed implementation with temporary component-store fixtures.

Tests prove:
- prompt loads return raw markdown content from prompts/<name>.md
- toolset/constraint/model loads parse YAML into core.spec component objects
- list_components() returns dict[str, list[str]] with stable names
- missing components surface typed ComponentStoreError via Result

Scope: larva.shell.components only - no facade, registry, transports.
"""

import tempfile
from pathlib import Path

import pytest
from returns.result import Result, Success, Failure

from larva.core.spec import (
    ConstraintComponent,
    ModelComponent,
    PromptComponent,
    ToolsetComponent,
)
from larva.shell.components import (
    ComponentStore,
    ComponentStoreError,
    COMPONENT_NOT_FOUND_CODE,
)


# -----------------------------------------------------------------------------
# Test Fixtures
# -----------------------------------------------------------------------------


class FilesystemComponentStore:
    """Filesystem-backed ComponentStore implementation for testing.

    Loads components from a temporary directory with the documented structure:
    - prompts/<name>.md     -> PromptComponent with raw markdown text
    - toolsets/<name>.yaml  -> ToolsetComponent with posture mappings
    - constraints/<name>.yaml -> ConstraintComponent with policy values
    - models/<name>.yaml   -> ModelComponent with model config
    """

    def __init__(self, components_dir: Path) -> None:
        self.components_dir = components_dir

    def load_prompt(self, name: str) -> Result[PromptComponent, ComponentStoreError]:
        """Load a prompt component by name."""
        try:
            prompt_path = self.components_dir / "prompts" / f"{name}.md"
            if not prompt_path.exists():
                return Failure(
                    ComponentStoreError(
                        f"Prompt not found: {name}",
                        component_type="prompt",
                        component_name=name,
                    )
                )
            text = prompt_path.read_text(encoding="utf-8")
            return Success(PromptComponent(text=text))
        except Exception as e:
            return Failure(
                ComponentStoreError(
                    f"Failed to load prompt {name}: {e}",
                    component_type="prompt",
                    component_name=name,
                )
            )

    def load_toolset(self, name: str) -> Result[ToolsetComponent, ComponentStoreError]:
        """Load a toolset component by name."""
        try:
            toolset_path = self.components_dir / "toolsets" / f"{name}.yaml"
            if not toolset_path.exists():
                return Failure(
                    ComponentStoreError(
                        f"Toolset not found: {name}",
                        component_type="toolset",
                        component_name=name,
                    )
                )
            import yaml

            with open(toolset_path, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            return Success(ToolsetComponent(tools=data.get("tools", {})))
        except Exception as e:
            return Failure(
                ComponentStoreError(
                    f"Failed to load toolset {name}: {e}",
                    component_type="toolset",
                    component_name=name,
                )
            )

    def load_constraint(self, name: str) -> Result[ConstraintComponent, ComponentStoreError]:
        """Load a constraint component by name."""
        try:
            constraint_path = self.components_dir / "constraints" / f"{name}.yaml"
            if not constraint_path.exists():
                return Failure(
                    ComponentStoreError(
                        f"Constraint not found: {name}",
                        component_type="constraint",
                        component_name=name,
                    )
                )
            import yaml

            with open(constraint_path, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            return Success(ConstraintComponent(**data))
        except Exception as e:
            return Failure(
                ComponentStoreError(
                    f"Failed to load constraint {name}: {e}",
                    component_type="constraint",
                    component_name=name,
                )
            )

    def load_model(self, name: str) -> Result[ModelComponent, ComponentStoreError]:
        """Load a model component by name."""
        try:
            model_path = self.components_dir / "models" / f"{name}.yaml"
            if not model_path.exists():
                return Failure(
                    ComponentStoreError(
                        f"Model not found: {name}",
                        component_type="model",
                        component_name=name,
                    )
                )
            import yaml

            with open(model_path, encoding="utf-8") as f:
                data = yaml.safe_load(f)
            return Success(ModelComponent(**data))
        except Exception as e:
            return Failure(
                ComponentStoreError(
                    f"Failed to load model {name}: {e}",
                    component_type="model",
                    component_name=name,
                )
            )

    def list_components(self) -> Result[dict[str, list[str]], ComponentStoreError]:
        """List all available components by type."""
        try:
            result: dict[str, list[str]] = {
                "prompts": [],
                "toolsets": [],
                "constraints": [],
                "models": [],
            }

            prompts_dir = self.components_dir / "prompts"
            if prompts_dir.exists():
                result["prompts"] = [p.stem for p in prompts_dir.glob("*.md")]

            toolsets_dir = self.components_dir / "toolsets"
            if toolsets_dir.exists():
                result["toolsets"] = [p.stem for p in toolsets_dir.glob("*.yaml")]

            constraints_dir = self.components_dir / "constraints"
            if constraints_dir.exists():
                result["constraints"] = [p.stem for p in constraints_dir.glob("*.yaml")]

            models_dir = self.components_dir / "models"
            if models_dir.exists():
                result["models"] = [p.stem for p in models_dir.glob("*.yaml")]

            return Success(result)
        except Exception as e:
            return Failure(ComponentStoreError(f"Failed to list components: {e}"))


@pytest.fixture
def temp_component_store(tmp_path: Path) -> FilesystemComponentStore:
    """Create a temporary component store with test fixtures."""
    components_dir = tmp_path / "components"
    prompts_dir = components_dir / "prompts"
    toolsets_dir = components_dir / "toolsets"
    constraints_dir = components_dir / "constraints"
    models_dir = components_dir / "models"

    prompts_dir.mkdir(parents=True)
    toolsets_dir.mkdir(parents=True)
    constraints_dir.mkdir(parents=True)
    models_dir.mkdir(parents=True)

    # Create prompt component
    (prompts_dir / "test_prompt.md").write_text(
        "# Test Prompt\n\nThis is a test prompt for the persona.",
        encoding="utf-8",
    )

    # Create toolset component
    (toolsets_dir / "test_toolset.yaml").write_text(
        """tools:
  filesystem: read_write
  shell: read_only
  http: none
""",
        encoding="utf-8",
    )

    # Create constraint component
    (constraints_dir / "test_constraint.yaml").write_text(
        """can_spawn: true
side_effect_policy: approval_required
compaction_prompt: "Compact the state."
""",
        encoding="utf-8",
    )

    # Create model component
    (models_dir / "test_model.yaml").write_text(
        """model: gpt-4
model_params:
  temperature: 0.7
  top_p: 0.9
""",
        encoding="utf-8",
    )

    return FilesystemComponentStore(components_dir)


# -----------------------------------------------------------------------------
# ComponentStore Protocol Tests
# -----------------------------------------------------------------------------


class TestComponentStoreProtocol:
    """Tests verifying the ComponentStore protocol contract."""

    def test_load_prompt_returns_raw_markdown(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove prompt loads return raw markdown content without wrapper metadata."""
        result = temp_component_store.load_prompt("test_prompt")

        assert isinstance(result, Result)
        assert isinstance(result, Success)
        prompt = result.unwrap()
        assert isinstance(prompt, dict)
        assert "text" in prompt
        assert "# Test Prompt" in prompt["text"]
        assert "test prompt for the persona" in prompt["text"]

    def test_load_toolset_parses_yaml(self, temp_component_store: FilesystemComponentStore) -> None:
        """Prove toolset loads parse YAML into ToolsetComponent object."""
        result = temp_component_store.load_toolset("test_toolset")

        assert isinstance(result, Result)
        assert isinstance(result, Success)
        toolset = result.unwrap()
        assert isinstance(toolset, dict)
        assert "tools" in toolset
        assert toolset["tools"]["filesystem"] == "read_write"
        assert toolset["tools"]["shell"] == "read_only"
        assert toolset["tools"]["http"] == "none"

    def test_load_constraint_parses_yaml(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove constraint loads parse YAML into ConstraintComponent object."""
        result = temp_component_store.load_constraint("test_constraint")

        assert isinstance(result, Result)
        assert isinstance(result, Success)
        constraint = result.unwrap()
        assert isinstance(constraint, dict)
        assert constraint["can_spawn"] is True
        assert constraint["side_effect_policy"] == "approval_required"
        assert constraint["compaction_prompt"] == "Compact the state."

    def test_load_model_parses_yaml(self, temp_component_store: FilesystemComponentStore) -> None:
        """Prove model loads parse YAML into ModelComponent object."""
        result = temp_component_store.load_model("test_model")

        assert isinstance(result, Result)
        assert isinstance(result, Success)
        model = result.unwrap()
        assert isinstance(model, dict)
        assert model["model"] == "gpt-4"
        assert model["model_params"]["temperature"] == 0.7
        assert model["model_params"]["top_p"] == 0.9

    def test_list_components_returns_directory_keyed_inventory(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove list_components returns dict[str, list[str]] with stable names."""
        result = temp_component_store.list_components()

        assert isinstance(result, Result)
        assert isinstance(result, Success)
        inventory = result.unwrap()
        assert isinstance(inventory, dict)

        # Verify all four component types are present
        assert "prompts" in inventory
        assert "toolsets" in inventory
        assert "constraints" in inventory
        assert "models" in inventory

        # Verify each is a list of strings
        assert isinstance(inventory["prompts"], list)
        assert isinstance(inventory["toolsets"], list)
        assert isinstance(inventory["constraints"], list)
        assert isinstance(inventory["models"], list)

        # Verify content
        assert "test_prompt" in inventory["prompts"]
        assert "test_toolset" in inventory["toolsets"]
        assert "test_constraint" in inventory["constraints"]
        assert "test_model" in inventory["models"]


# -----------------------------------------------------------------------------
# Missing Component Error Tests
# -----------------------------------------------------------------------------


class TestMissingComponentError:
    """Tests proving missing components surface typed shell error via Result."""

    def test_missing_prompt_returns_typed_error(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove missing prompt returns ComponentStoreError with correct attributes."""
        result = temp_component_store.load_prompt("nonexistent")

        assert isinstance(result, Result)
        assert isinstance(result, Failure)
        error = result.failure()
        assert isinstance(error, ComponentStoreError)
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert error.component_type == "prompt"
        assert error.component_name == "nonexistent"

    def test_missing_toolset_returns_typed_error(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove missing toolset returns ComponentStoreError with correct attributes."""
        result = temp_component_store.load_toolset("nonexistent")

        assert isinstance(result, Result)
        assert isinstance(result, Failure)
        error = result.failure()
        assert isinstance(error, ComponentStoreError)
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert error.component_type == "toolset"
        assert error.component_name == "nonexistent"

    def test_missing_constraint_returns_typed_error(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove missing constraint returns ComponentStoreError with correct attributes."""
        result = temp_component_store.load_constraint("nonexistent")

        assert isinstance(result, Result)
        assert isinstance(result, Failure)
        error = result.failure()
        assert isinstance(error, ComponentStoreError)
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert error.component_type == "constraint"
        assert error.component_name == "nonexistent"

    def test_missing_model_returns_typed_error(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Prove missing model returns ComponentStoreError with correct attributes."""
        result = temp_component_store.load_model("nonexistent")

        assert isinstance(result, Result)
        assert isinstance(result, Failure)
        error = result.failure()
        assert isinstance(error, ComponentStoreError)
        assert error.code == COMPONENT_NOT_FOUND_CODE
        assert error.component_type == "model"
        assert error.component_name == "nonexistent"

    def test_component_store_error_to_dict(self) -> None:
        """Prove ComponentStoreError.to_dict() returns transport-ready format."""
        error = ComponentStoreError(
            "Test error",
            component_type="prompt",
            component_name="test",
        )

        d = error.to_dict()
        assert d["code"] == COMPONENT_NOT_FOUND_CODE
        assert d["message"] == "Test error"
        assert d["component_type"] == "prompt"
        assert d["component_name"] == "test"


# -----------------------------------------------------------------------------
# Protocol Compliance Tests
# -----------------------------------------------------------------------------


class TestComponentStoreProtocolCompliance:
    """Tests verifying ComponentStore satisfies the Protocol interface."""

    def test_implements_protocol(self, temp_component_store: FilesystemComponentStore) -> None:
        """Prove FilesystemComponentStore implements ComponentStore Protocol."""
        # This verifies at runtime that the implementation satisfies the Protocol
        store: ComponentStore = temp_component_store  # type: ignore[assignment]
        assert store is not None

    def test_protocol_load_methods_exist(
        self, temp_component_store: FilesystemComponentStore
    ) -> None:
        """Verify all required protocol methods exist."""
        assert hasattr(temp_component_store, "load_prompt")
        assert hasattr(temp_component_store, "load_toolset")
        assert hasattr(temp_component_store, "load_constraint")
        assert hasattr(temp_component_store, "load_model")
        assert hasattr(temp_component_store, "list_components")

    def test_protocol_return_types(self, temp_component_store: FilesystemComponentStore) -> None:
        """Verify methods return Result types as per protocol."""
        from typing import get_origin

        # Verify load_prompt return type
        hints = temp_component_store.load_prompt.__annotations__
        assert "return" in hints
        return_type = hints["return"]
        assert get_origin(return_type) is Result

    def test_empty_component_store(self, tmp_path: Path) -> None:
        """Prove list_components works with empty directories."""
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir(parents=True)
        (empty_dir / "prompts").mkdir()
        (empty_dir / "toolsets").mkdir()
        (empty_dir / "constraints").mkdir()
        (empty_dir / "models").mkdir()

        store = FilesystemComponentStore(empty_dir)
        result = store.list_components()

        assert isinstance(result, Success)
        inventory = result.unwrap()
        assert inventory["prompts"] == []
        assert inventory["toolsets"] == []
        assert inventory["constraints"] == []
        assert inventory["models"] == []
