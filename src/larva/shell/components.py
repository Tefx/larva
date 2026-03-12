"""Contract-only shell-side protocols for component loading.

This module defines the shell boundary contracts for loading external
prompt, toolset, constraint, and model components from the filesystem.

Contract purity: ENFORCED (no runnable file-loading logic)

See:
- ARCHITECTURE.md :: Module: larva.shell.components
- INTERFACES.md :: C. Component Library
"""

from typing import Protocol

from returns.result import Result

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
# Public API
# -----------------------------------------------------------------------------

__all__ = [
    "ComponentStore",
    "ComponentStoreError",
    "COMPONENT_NOT_FOUND_CODE",
]
