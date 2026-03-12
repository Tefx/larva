"""Contract-only shell-side protocols for component loading.

This module defines the shell boundary contracts for loading external
prompt, toolset, constraint, and model components from the filesystem.

Contract purity: ENFORCED (no runnable file-loading logic)

See:
- ARCHITECTURE.md :: Module: larva.shell.components
- INTERFACES.md :: C. Component Library
"""

from pathlib import Path
from typing import Protocol

from returns.result import Result, Success, Failure

from larva.core.spec import (
    ConstraintComponent,
    ModelComponent,
    PromptComponent,
    ToolsetComponent,
)

# -----------------------------------------------------------------------------
# Shell Error Types
# -----------------------------------------------------------------------------

# Error code mapping: COMPONENT_NOT_FOUND = 105 (from contracts/errors.yaml)
COMPONENT_NOT_FOUND_CODE: int = 105


class ComponentStoreError(Exception):
    """Shell error raised when component loading fails.

    This typed shell error maps to the documented `COMPONENT_NOT_FOUND`
    transport error (code 105) for downstream error handling.
    """

    code: int = COMPONENT_NOT_FOUND_CODE

    def __init__(
        self, message: str, component_type: str | None = None, component_name: str | None = None
    ) -> None:
        self.component_type = component_type
        self.component_name = component_name
        super().__init__(message)

    def to_dict(self) -> dict[str, object]:
        """Convert to error dictionary for transport formatting."""
        return {
            "code": self.code,
            "message": str(self),
            "component_type": self.component_type,
            "component_name": self.component_name,
        }


# -----------------------------------------------------------------------------
# Component Store Protocol
# -----------------------------------------------------------------------------


class ComponentStore(Protocol):
    """Protocol for loading and listing external components.

    This protocol defines the shell-side contract for filesystem-backed
    component loading. Implementation loads from `~/.larva/components/`
    with the documented directory structure:

    - prompts/<name>.md     -> PromptComponent with raw markdown text
    - toolsets/<name>.yaml  -> ToolsetComponent with posture mappings
    - constraints/<name>.yaml -> ConstraintComponent with policy values
    - models/<name>.yaml   -> ModelComponent with model config
    """

    def load_prompt(self, name: str) -> Result[PromptComponent, ComponentStoreError]:
        """Load a prompt component by name.

        Args:
            name: Component name (without .md extension).

        Returns:
            Ok(PromptComponent) with raw markdown text.
            Err(ComponentStoreError) if not found or read error.
        """
        ...

    def load_toolset(self, name: str) -> Result[ToolsetComponent, ComponentStoreError]:
        """Load a toolset component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ToolsetComponent) with posture mappings.
            Err(ComponentStoreError) if not found or parse error.
        """
        ...

    def load_constraint(self, name: str) -> Result[ConstraintComponent, ComponentStoreError]:
        """Load a constraint component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ConstraintComponent) with policy values.
            Err(ComponentStoreError) if not found or parse error.
        """
        ...

    def load_model(self, name: str) -> Result[ModelComponent, ComponentStoreError]:
        """Load a model component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ModelComponent) with model configuration.
            Err(ComponentStoreError) if not found or parse error.
        """
        ...

    def list_components(self) -> Result[dict[str, list[str]], ComponentStoreError]:
        """List all available components by type.

        Returns:
            Ok(dict[str, list[str]]) mapping directory keys to component names:
                - "prompts": list of available prompt names
                - "toolsets": list of available toolset names
                - "constraints": list of available constraint names
                - "models": list of available model names
            Err(ComponentStoreError) if directory read fails.
        """
        ...


# -----------------------------------------------------------------------------
# Filesystem-backed ComponentStore Implementation
# -----------------------------------------------------------------------------


class FilesystemComponentStore:
    """Filesystem-backed ComponentStore implementation.

    Loads components from the documented `~/.larva/components/` layout:
    - prompts/<name>.md     -> PromptComponent with raw markdown text
    - toolsets/<name>.yaml  -> ToolsetComponent with posture mappings
    - constraints/<name>.yaml -> ConstraintComponent with policy values
    - models/<name>.yaml   -> ModelComponent with model config
    """

    def __init__(self, components_dir: Path | None = None) -> None:
        """Initialize the component store.

        Args:
            components_dir: Root directory for components. Defaults to ~/.larva/components/
        """
        if components_dir is None:
            components_dir = Path.home() / ".larva" / "components"
        self.components_dir = Path(components_dir)

    def _ensure_components_dir(self) -> Result[Path, ComponentStoreError]:
        """Ensure the components directory exists."""
        if not self.components_dir.exists():
            return Failure(
                ComponentStoreError(
                    f"Components directory not found: {self.components_dir}",
                    component_type=None,
                    component_name=None,
                )
            )
        return Success(self.components_dir)

    def _resolve_component_path(
        self,
        *,
        component_type: str,
        component_name: str,
        subdirectory: str,
        extension: str,
    ) -> Result[Path, ComponentStoreError]:
        """Resolve a component path while rejecting traversal and cross-type escapes."""
        if (
            not component_name
            or component_name in {".", ".."}
            or "/" in component_name
            or "\\" in component_name
            or ".." in Path(component_name).parts
        ):
            return Failure(
                ComponentStoreError(
                    f"Invalid {component_type} component name: {component_name}",
                    component_type=component_type,
                    component_name=component_name,
                )
            )

        component_dir = self.components_dir / subdirectory
        target_path = component_dir / f"{component_name}{extension}"

        try:
            resolved_dir = component_dir.resolve(strict=False)
            resolved_target = target_path.resolve(strict=False)
        except Exception as e:
            return Failure(
                ComponentStoreError(
                    f"Failed to resolve {component_type} component path {component_name}: {e}",
                    component_type=component_type,
                    component_name=component_name,
                )
            )

        if resolved_target.parent != resolved_dir:
            return Failure(
                ComponentStoreError(
                    f"Invalid {component_type} component path: {component_name}",
                    component_type=component_type,
                    component_name=component_name,
                )
            )

        return Success(target_path)

    def load_prompt(self, name: str) -> Result[PromptComponent, ComponentStoreError]:
        """Load a prompt component by name.

        Args:
            name: Component name (without .md extension).

        Returns:
            Ok(PromptComponent) with raw markdown text.
            Err(ComponentStoreError) if not found or read error.
        """
        try:
            path_result = self._resolve_component_path(
                component_type="prompt",
                component_name=name,
                subdirectory="prompts",
                extension=".md",
            )
            if isinstance(path_result, Failure):
                return path_result

            prompt_path = path_result.unwrap()
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
        """Load a toolset component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ToolsetComponent) with posture mappings.
            Err(ComponentStoreError) if not found or parse error.
        """
        try:
            import yaml

            path_result = self._resolve_component_path(
                component_type="toolset",
                component_name=name,
                subdirectory="toolsets",
                extension=".yaml",
            )
            if isinstance(path_result, Failure):
                return path_result

            toolset_path = path_result.unwrap()
            if not toolset_path.exists():
                return Failure(
                    ComponentStoreError(
                        f"Toolset not found: {name}",
                        component_type="toolset",
                        component_name=name,
                    )
                )
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
        """Load a constraint component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ConstraintComponent) with policy values.
            Err(ComponentStoreError) if not found or parse error.
        """
        try:
            import yaml

            path_result = self._resolve_component_path(
                component_type="constraint",
                component_name=name,
                subdirectory="constraints",
                extension=".yaml",
            )
            if isinstance(path_result, Failure):
                return path_result

            constraint_path = path_result.unwrap()
            if not constraint_path.exists():
                return Failure(
                    ComponentStoreError(
                        f"Constraint not found: {name}",
                        component_type="constraint",
                        component_name=name,
                    )
                )
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
        """Load a model component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ModelComponent) with model configuration.
            Err(ComponentStoreError) if not found or parse error.
        """
        try:
            import yaml

            path_result = self._resolve_component_path(
                component_type="model",
                component_name=name,
                subdirectory="models",
                extension=".yaml",
            )
            if isinstance(path_result, Failure):
                return path_result

            model_path = path_result.unwrap()
            if not model_path.exists():
                return Failure(
                    ComponentStoreError(
                        f"Model not found: {name}",
                        component_type="model",
                        component_name=name,
                    )
                )
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
        """List all available components by type.

        Returns:
            Ok(dict[str, list[str]]) mapping directory keys to component names:
                - "prompts": list of available prompt names
                - "toolsets": list of available toolset names
                - "constraints": list of available constraint names
                - "models": list of available model names
            Err(ComponentStoreError) if directory read fails.
        """
        try:
            result: dict[str, list[str]] = {
                "prompts": [],
                "toolsets": [],
                "constraints": [],
                "models": [],
            }

            prompts_dir = self.components_dir / "prompts"
            if prompts_dir.exists():
                result["prompts"] = sorted([p.stem for p in prompts_dir.glob("*.md")])

            toolsets_dir = self.components_dir / "toolsets"
            if toolsets_dir.exists():
                result["toolsets"] = sorted([p.stem for p in toolsets_dir.glob("*.yaml")])

            constraints_dir = self.components_dir / "constraints"
            if constraints_dir.exists():
                result["constraints"] = sorted([p.stem for p in constraints_dir.glob("*.yaml")])

            models_dir = self.components_dir / "models"
            if models_dir.exists():
                result["models"] = sorted([p.stem for p in models_dir.glob("*.yaml")])

            return Success(result)
        except Exception as e:
            return Failure(ComponentStoreError(f"Failed to list components: {e}"))


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

__all__ = [
    "ComponentStore",
    "ComponentStoreError",
    "FilesystemComponentStore",
    "COMPONENT_NOT_FOUND_CODE",
]
