"""Filesystem-backed shell adapter for component loading.

This module defines the shell boundary protocol and its filesystem-backed
implementation for loading external prompt, toolset, constraint, and model
components.

See:
- ARCHITECTURE.md :: Module: larva.shell.components
- INTERFACES.md :: C. Component Library
"""

from pathlib import Path
from typing import Protocol, cast

from returns.result import Result, Success, Failure

from larva.core.spec import (
    ConstraintComponent,
    ModelComponent,
    PromptComponent,
    ToolsetComponent,
)

_VALID_TOOL_POSTURES = frozenset({"none", "read_only", "read_write", "destructive"})
_CANONICAL_COMPONENT_KIND_INDEX = {
    "prompt": "prompts",
    "prompts": "prompts",
    "toolset": "toolsets",
    "toolsets": "toolsets",
    "constraint": "constraints",
    "constraints": "constraints",
    "model": "models",
    "models": "models",
}
_COMPONENT_ALLOWED_KEYS = {
    "prompts": frozenset({"text"}),
    "toolsets": frozenset({"capabilities"}),
    "constraints": frozenset({"can_spawn", "compaction_prompt"}),
    "models": frozenset({"model", "model_params"}),
}

# -----------------------------------------------------------------------------
# Shell Error Types
# -----------------------------------------------------------------------------

# Error code mapping: COMPONENT_NOT_FOUND = 105 (from contracts/errors.yaml)
COMPONENT_NOT_FOUND_CODE: int = 105


class ComponentStoreError(Exception):
    """Shell error raised when component loading fails.

    This typed shell error maps to documented shell boundary failures and is
    converted to transport responses by higher layers.
    """

    code: int = COMPONENT_NOT_FOUND_CODE

    def __init__(
        self, message: str, component_type: str | None = None, component_name: str | None = None
    ) -> None:
        self.component_type = component_type
        self.component_name = component_name
        super().__init__(message)


def ensure_component_payload(
    component_type: str,
    component_name: str,
    payload: object,
) -> Result[dict[str, object], ComponentStoreError]:
    """Validate one component payload without stripping malformed metadata.

    The shared component-show surface and direct component loaders both depend on
    this helper so malformed payloads fail closed instead of being cleaned on
    read.
    """

    canonical_kind = _CANONICAL_COMPONENT_KIND_INDEX.get(component_type, component_type)
    if not isinstance(payload, dict):
        return Failure(
            ComponentStoreError(
                f"{component_type.capitalize()} {component_name} is not a valid mapping",
                component_type=component_type,
                component_name=component_name,
            )
        )

    data = dict(payload)
    allowed_keys = _COMPONENT_ALLOWED_KEYS.get(canonical_kind)
    if allowed_keys is None:
        return Failure(
            ComponentStoreError(
                f"Unsupported component type: {component_type}",
                component_type=component_type,
                component_name=component_name,
            )
        )

    unknown_keys = sorted(set(data) - allowed_keys)
    if unknown_keys:
        return Failure(
            ComponentStoreError(
                f"{component_type.capitalize()} {component_name} contains unsupported field(s): {unknown_keys}",
                component_type=component_type,
                component_name=component_name,
            )
        )

    if canonical_kind == "prompts":
        text = data.get("text")
        if not isinstance(text, str):
            return Failure(
                ComponentStoreError(
                    f"Prompt {component_name} must contain string field 'text'",
                    component_type=component_type,
                    component_name=component_name,
                )
            )
        return Success(data)

    if canonical_kind == "toolsets":
        capabilities = data.get("capabilities")
        if not isinstance(capabilities, dict):
            return Failure(
                ComponentStoreError(
                    f"Toolset {component_name} capabilities must be a mapping of strings to canonical postures.",
                    component_type=component_type,
                    component_name=component_name,
                )
            )
        for capability_name, posture in capabilities.items():
            if not isinstance(capability_name, str) or not isinstance(posture, str):
                return Failure(
                    ComponentStoreError(
                        f"Toolset {component_name} capabilities entries must use string keys and posture values.",
                        component_type=component_type,
                        component_name=component_name,
                    )
                )
            if posture not in _VALID_TOOL_POSTURES:
                return Failure(
                    ComponentStoreError(
                        f"Toolset {component_name} capabilities entry '{capability_name}' uses invalid posture '{posture}'.",
                        component_type=component_type,
                        component_name=component_name,
                    )
                )
        return Success(data)

    if canonical_kind == "constraints":
        can_spawn = data.get("can_spawn")
        if can_spawn is not None:
            if isinstance(can_spawn, bool):
                pass
            elif isinstance(can_spawn, list) and all(
                isinstance(item, str) and item != "" for item in can_spawn
            ) and len(set(can_spawn)) == len(can_spawn):
                pass
            else:
                return Failure(
                    ComponentStoreError(
                        f"Constraint {component_name} field 'can_spawn' must be boolean or list[string] with unique non-empty entries.",
                        component_type=component_type,
                        component_name=component_name,
                    )
                )
        compaction_prompt = data.get("compaction_prompt")
        if compaction_prompt is not None and not isinstance(compaction_prompt, str):
            return Failure(
                ComponentStoreError(
                    f"Constraint {component_name} field 'compaction_prompt' must be a string.",
                    component_type=component_type,
                    component_name=component_name,
                )
            )
        return Success(data)

    model_name = data.get("model")
    if model_name is not None and not isinstance(model_name, str):
        return Failure(
            ComponentStoreError(
                f"Model {component_name} field 'model' must be a string.",
                component_type=component_type,
                component_name=component_name,
            )
        )
    model_params = data.get("model_params")
    if model_params is not None and not isinstance(model_params, dict):
        return Failure(
            ComponentStoreError(
                f"Model {component_name} field 'model_params' must be a mapping.",
                component_type=component_type,
                component_name=component_name,
            )
        )
    return Success(data)


# -----------------------------------------------------------------------------
# Component Store Protocol
# -----------------------------------------------------------------------------


class ComponentStore(Protocol):
    """Protocol for loading and listing external components.

    This protocol defines the shell-side contract for filesystem-backed
    component loading. Implementation loads from `~/.larva/components/`
    with the documented directory structure:

    - prompts/<name>.md     -> PromptComponent with raw markdown text
    - toolsets/<name>.yaml  -> ToolsetComponent with capability posture mappings
    - constraints/<name>.yaml -> ConstraintComponent with policy values
    - models/<name>.yaml   -> ModelComponent with model config

    Canonical boundary rules:
        - Toolsets: ``capabilities`` is required; ``tools`` is not admissible (fail closed)
        - Constraints: ``side_effect_policy`` is not admitted; runtime policy is external
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

        Canonical boundary rule: ``capabilities`` is required. Legacy ``tools``
        field is not admissible — component store fails closed (raises
        ComponentStoreError) rather than falling back.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ToolsetComponent) with capability posture mappings.
            Err(ComponentStoreError) if not found, parse error, or missing
            capabilities (legacy toolset content rejected at hard-cut boundary).
        """
        ...

    def load_constraint(self, name: str) -> Result[ConstraintComponent, ComponentStoreError]:
        """Load a constraint component by name.

        Canonical boundary rule: ``side_effect_policy`` is not admitted.
        Runtime policy ownership is external to PersonaSpec.

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
    - toolsets/<name>.yaml  -> ToolsetComponent with capability posture mappings
    - constraints/<name>.yaml -> ConstraintComponent with policy values
    - models/<name>.yaml   -> ModelComponent with model config

    Canonical boundary rules:
        - Toolsets: ``capabilities`` is required; ``tools`` is not admissible (fail closed)
        - Constraints: ``side_effect_policy`` is not admitted; runtime policy is external

    Trust boundary:
        - `~/.larva/components/` is user-managed shell input, not canonical domain state.
        - This adapter owns filesystem path resolution, file reads, and YAML parsing.
        - Parsed payloads only become authoritative after downstream assembly and
          core normalization/validation accept them.
    """

    def __init__(self, components_dir: Path | None = None) -> None:
        """Initialize the component store.

        Args:
            components_dir: Root directory for components. Defaults to ~/.larva/components/
        """
        if components_dir is None:
            components_dir = Path.home() / ".larva" / "components"
        self.components_dir = Path(components_dir)

    def _error(
        self,
        message: str,
        *,
        component_type: str | None = None,
        component_name: str | None = None,
    ) -> ComponentStoreError:
        return ComponentStoreError(
            message,
            component_type=component_type,
            component_name=component_name,
        )

    def _ensure_components_dir(self) -> Result[Path, ComponentStoreError]:
        """Ensure the components directory exists."""
        if not self.components_dir.exists():
            return Failure(
                self._error(
                    f"Components directory not found: {self.components_dir}",
                    component_type=None,
                    component_name=None,
                )
            )
        return Success(self.components_dir)

    def _read_yaml(self, path: Path) -> object:
        import yaml

        with open(path, encoding="utf-8") as file:
            return yaml.safe_load(file)

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
                self._error(
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
                self._error(
                    f"Failed to resolve {component_type} component path {component_name}: {e}",
                    component_type=component_type,
                    component_name=component_name,
                )
            )

        if resolved_target.parent != resolved_dir:
            return Failure(
                self._error(
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
                    self._error(
                        f"Prompt not found: {name}",
                        component_type="prompt",
                        component_name=name,
                    )
                )
            text = prompt_path.read_text(encoding="utf-8")
            payload_result = ensure_component_payload("prompt", name, {"text": text})
            if isinstance(payload_result, Failure):
                return payload_result
            return Success(PromptComponent(**payload_result.unwrap()))
        except Exception as e:
            return Failure(
                self._error(
                    f"Failed to load prompt {name}: {e}",
                    component_type="prompt",
                    component_name=name,
                )
            )

    def _load_yaml_component(
        self, *, name: str, component_type: str, subdirectory: str
    ) -> Result[object, ComponentStoreError]:
        try:
            path_result = self._resolve_component_path(
                component_type=component_type,
                component_name=name,
                subdirectory=subdirectory,
                extension=".yaml",
            )
            if isinstance(path_result, Failure):
                return path_result

            component_path = path_result.unwrap()
            if not component_path.exists():
                return Failure(
                    self._error(
                        f"{component_type.capitalize()} not found: {name}",
                        component_type=component_type,
                        component_name=name,
                    )
                )
            return Success(self._read_yaml(component_path))
        except Exception as e:
            return Failure(
                self._error(
                    f"Failed to load {component_type} {name}: {e}",
                    component_type=component_type,
                    component_name=name,
                )
            )

    def load_toolset(self, name: str) -> Result[ToolsetComponent, ComponentStoreError]:
        """Load a toolset component by name.

        Canonical boundary rule: ``capabilities`` is required. Legacy ``tools``
        field is not admissible — component store fails closed (raises
        ComponentStoreError) rather than falling back.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ToolsetComponent) with capability posture mappings.
            Err(ComponentStoreError) if not found, parse error, or missing
            capabilities (legacy toolset content rejected at hard-cut boundary).
        """
        yaml_result = self._load_yaml_component(
            name=name,
            component_type="toolset",
            subdirectory="toolsets",
        )
        if isinstance(yaml_result, Failure):
            return yaml_result

        data = yaml_result.unwrap()
        if isinstance(data, dict) and "tools" in data:
            return Failure(
                self._error(
                    f"Toolset {name} contains forbidden legacy field 'tools'. "
                    f"Mixed or legacy toolset payloads are not admissible at canonical cutover.",
                    component_type="toolset",
                    component_name=name,
                )
            )

        if not isinstance(data, dict) or "capabilities" not in data:
            return Failure(
                self._error(
                    f"Toolset {name} is missing 'capabilities' field. "
                    f"Legacy toolset content is not admissible at canonical cutover.",
                    component_type="toolset",
                    component_name=name,
                )
            )

        payload_result = ensure_component_payload("toolset", name, data)
        if isinstance(payload_result, Failure):
            return payload_result
        validated_payload = payload_result.unwrap()
        return Success(ToolsetComponent(capabilities=validated_payload["capabilities"]))

    def load_constraint(self, name: str) -> Result[ConstraintComponent, ComponentStoreError]:
        """Load a constraint component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ConstraintComponent) with policy values.
            Err(ComponentStoreError) if not found or parse error.
        """
        yaml_result = self._load_yaml_component(
            name=name,
            component_type="constraint",
            subdirectory="constraints",
        )
        if isinstance(yaml_result, Failure):
            return yaml_result

        data = yaml_result.unwrap()
        if isinstance(data, dict) and "side_effect_policy" in data:
            return Failure(
                self._error(
                    f"Constraint {name} contains forbidden legacy field 'side_effect_policy'.",
                    component_type="constraint",
                    component_name=name,
                )
            )

        payload_result = ensure_component_payload("constraint", name, data)
        if isinstance(payload_result, Failure):
            return payload_result
        return Success(cast("ConstraintComponent", payload_result.unwrap()))

    def load_model(self, name: str) -> Result[ModelComponent, ComponentStoreError]:
        """Load a model component by name.

        Args:
            name: Component name (without .yaml extension).

        Returns:
            Ok(ModelComponent) with model configuration.
            Err(ComponentStoreError) if not found or parse error.
        """
        yaml_result = self._load_yaml_component(
            name=name,
            component_type="model",
            subdirectory="models",
        )
        if isinstance(yaml_result, Failure):
            return yaml_result

        payload_result = ensure_component_payload("model", name, yaml_result.unwrap())
        if isinstance(payload_result, Failure):
            return payload_result
        return Success(ModelComponent(**payload_result.unwrap()))

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
            return Failure(self._error(f"Failed to list components: {e}"))


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

__all__ = [
    "ComponentStore",
    "ComponentStoreError",
    "FilesystemComponentStore",
    "COMPONENT_NOT_FOUND_CODE",
    "ensure_component_payload",
]
