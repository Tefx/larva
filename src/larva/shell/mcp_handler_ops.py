"""Shared MCP handler method implementations extracted from shell.mcp."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from returns.result import Failure
from larva.core.component_error_projection import (
    component_store_unavailable_error,
    project_component_store_error,
)
from larva.shell.mcp_params import MCPParamValidationMixin
from larva.shell.shared.component_queries import query_component

if TYPE_CHECKING:
    from larva.app.facade import AssembleRequest, LarvaError
    from larva.core.spec import PersonaSpec
    from larva.shell.components import ComponentStore
    from larva.shell.mcp_contract import ValidationReport


class MCPHandlerOpsMixin(MCPParamValidationMixin):
    """Mixin with extracted MCP handler method bodies."""

    _facade: Any
    _components: ComponentStore | None

    def _handle_component_list_impl(self, params: object) -> dict[str, list[str]] | LarvaError:
        validated_params = self._validated_params(
            "larva_component_list", params, allowed_keys=set()
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()

        if self._components is None:
            return component_store_unavailable_error(
                operation="mcp.component_list",
                component_type=None,
                component_name=None,
                reason="Component store not available",
            )

        result = self._components.list_components()
        if isinstance(result, Failure):
            error = result.failure()
            return project_component_store_error(
                operation="mcp.component_list",
                error=error,
            )

        return cast("dict[str, list[str]]", result.unwrap())

    def _handle_component_show_impl(self, params: object) -> dict[str, object] | LarvaError:
        validated_params = self._validated_params(
            "larva_component_show",
            params,
            allowed_keys={"component_type", "name"},
            required_keys=("component_type", "name"),
            typed_keys=(("component_type", str, "string"), ("name", str, "string")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()

        component_type = checked_params["component_type"]
        name = checked_params["name"]

        if self._components is None:
            return component_store_unavailable_error(
                operation="mcp.component_show",
                component_type=component_type,
                component_name=cast("str", name),
                reason="Component store not available",
            )

        result = query_component(
            self._components,
            component_type=cast("str", component_type),
            component_name=cast("str", name),
            operation="mcp.component_show",
        )
        if isinstance(result, Failure):
            return result.failure()

        component_data = result.unwrap()
        # Canonical boundary: toolsets output must be canonical-only (ADR-002).
        # Filter out mirrored `tools` field if present, keeping only `capabilities`.
        if component_type == "toolsets" and "tools" in component_data:
            component_data = {k: v for k, v in component_data.items() if k != "tools"}

        return cast("dict[str, object]", component_data)

    def _handle_assemble_impl(self, params: object) -> PersonaSpec | LarvaError:
        validated_params = self._validated_params(
            "larva_assemble",
            params,
            allowed_keys={
                "id",
                "description",
                "prompts",
                "toolsets",
                "constraints",
                "model",
                "overrides",
                "variables",
            },
            required_keys=("id",),
            typed_keys=(
                ("id", str, "string"),
                ("description", str, "string"),
                ("model", str, "string"),
                ("overrides", dict, "object"),
                ("variables", dict, "object"),
            ),
            list_string_keys=("prompts", "toolsets", "constraints"),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()

        request: AssembleRequest = {
            "id": checked_params["id"],
            "prompts": checked_params.get("prompts", []),
            "toolsets": checked_params.get("toolsets", []),
            "constraints": checked_params.get("constraints", []),
            "model": checked_params.get("model", ""),
            "overrides": checked_params.get("overrides", {}),
            "variables": checked_params.get("variables", {}),
        }
        if "description" in checked_params:
            request["description"] = checked_params["description"]
        facade = cast("Any", self._facade)
        result = cast("Failure[LarvaError] | object", self._unwrap_result(facade.assemble(request)))
        return cast("PersonaSpec | LarvaError", result)

    def _handle_resolve_impl(self, params: object) -> PersonaSpec | LarvaError:
        validated_params = self._validated_params(
            "larva_resolve",
            params,
            allowed_keys={"id", "overrides"},
            required_keys=("id",),
            typed_keys=(("id", str, "string"), ("overrides", dict, "object")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()

        persona_id = checked_params["id"]
        overrides: dict[str, object] | None = checked_params.get("overrides")
        facade = cast("Any", self._facade)
        return cast(
            "PersonaSpec | LarvaError", self._unwrap_result(facade.resolve(persona_id, overrides))
        )

    def _handle_validate_impl(self, params: object) -> ValidationReport | LarvaError:
        validated_params = self._validated_params(
            "larva_validate",
            params,
            allowed_keys={"spec"},
            required_keys=("spec",),
            typed_keys=(("spec", dict, "object"),),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        spec = checked_params["spec"]
        facade = cast("Any", self._facade)
        return cast("ValidationReport", facade.validate(cast("PersonaSpec", spec)))


__all__ = ["MCPHandlerOpsMixin"]
