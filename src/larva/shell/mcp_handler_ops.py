"""Shared MCP handler method implementations extracted from shell.mcp."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from returns.result import Failure, Success
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
        validated_params = self._require_params_object("larva_component_list", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva_component_list", checked_params, set()):
            return error

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
        validated_params = self._require_params_object("larva_component_show", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params(
            "larva_component_show", checked_params, {"component_type", "name"}
        ):
            return error
        if error := self._require_param("larva_component_show", checked_params, "component_type"):
            return error
        if error := self._require_param("larva_component_show", checked_params, "name"):
            return error
        if error := self._require_type(
            "larva_component_show", checked_params, "component_type", str, "string"
        ):
            return error
        if error := self._require_type(
            "larva_component_show", checked_params, "name", str, "string"
        ):
            return error

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

        return cast("dict[str, object]", result.unwrap())

    def _handle_assemble_impl(self, params: object) -> PersonaSpec | LarvaError:
        validated_params = self._require_params_object("larva_assemble", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params(
            "larva_assemble",
            checked_params,
            {
                "id",
                "description",
                "prompts",
                "toolsets",
                "constraints",
                "model",
                "overrides",
                "variables",
            },
        ):
            return error
        if error := self._require_param("larva_assemble", checked_params, "id"):
            return error
        if error := self._require_type("larva_assemble", checked_params, "id", str, "string"):
            return error
        if "description" in checked_params and (
            error := self._require_type(
                "larva_assemble", checked_params, "description", str, "string"
            )
        ):
            return error
        if error := self._require_list_of_strings("larva_assemble", checked_params, "prompts"):
            return error
        if error := self._require_list_of_strings("larva_assemble", checked_params, "toolsets"):
            return error
        if error := self._require_list_of_strings("larva_assemble", checked_params, "constraints"):
            return error
        if "model" in checked_params and (
            error := self._require_type("larva_assemble", checked_params, "model", str, "string")
        ):
            return error
        if "overrides" in checked_params and (
            error := self._require_type(
                "larva_assemble", checked_params, "overrides", dict, "object"
            )
        ):
            return error
        if "variables" in checked_params and (
            error := self._require_type(
                "larva_assemble", checked_params, "variables", dict, "object"
            )
        ):
            return error

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
        result = cast("Success[object] | Failure[LarvaError]", facade.assemble(request))
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())
        return result.failure()

    def _handle_resolve_impl(self, params: object) -> PersonaSpec | LarvaError:
        validated_params = self._require_params_object("larva_resolve", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params(
            "larva_resolve", checked_params, {"id", "overrides"}
        ):
            return error
        if error := self._require_param("larva_resolve", checked_params, "id"):
            return error
        if error := self._require_type("larva_resolve", checked_params, "id", str, "string"):
            return error
        if "overrides" in checked_params and (
            error := self._require_type(
                "larva_resolve", checked_params, "overrides", dict, "object"
            )
        ):
            return error

        persona_id = checked_params["id"]
        overrides: dict[str, object] | None = checked_params.get("overrides")
        facade = cast("Any", self._facade)
        result = cast(
            "Success[object] | Failure[LarvaError]",
            facade.resolve(persona_id, overrides),
        )
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())
        return result.failure()

    def _handle_validate_impl(self, params: object) -> ValidationReport | LarvaError:
        validated_params = self._require_params_object("larva_validate", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva_validate", checked_params, {"spec"}):
            return error
        if error := self._require_param("larva_validate", checked_params, "spec"):
            return error
        if error := self._require_type("larva_validate", checked_params, "spec", dict, "object"):
            return error
        spec = checked_params["spec"]
        facade = cast("Any", self._facade)
        return cast("ValidationReport", facade.validate(cast("PersonaSpec", spec)))


__all__ = ["MCPHandlerOpsMixin"]
