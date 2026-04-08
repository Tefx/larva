"""Contract surface for MCP server adapter.

This module defines the shell boundary for exposing larva functionality
via the Model Context Protocol (MCP). It provides MCP tool definitions
that delegate to the app-layer facade.

Scope of this contract module:
- define MCP tool handler signatures
- define MCP transport adapter contract
- document delegation seam to ``larva.app.facade``

Out of scope for this contract step:
- MCP server runtime startup (stdio/SSE)
- MCP protocol frame handling
- facade invocation implementation
- registry/component logic

Boundary citations:
- ARCHITECTURE.md :: Module: ``larva.shell.mcp``
- ARCHITECTURE.md :: 7. Cross-Module Interface Contracts
- INTERFACES.md :: A. MCP Server Interface
- README.md :: MCP Server (primary)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, TypeVar, Union, cast

from returns.result import Failure, Success

from larva.shell.mcp_contract import (
    LARVA_ERROR_CODES,
    LARVA_MCP_TOOLS,
    MCPToolDefinition,
    ValidationIssue,
    ValidationReport,
)
from larva.shell.mcp_handler_ops import MCPHandlerOpsMixin
from larva.shell.components import ComponentStore
from larva.shell.mcp_export import handle_export as handle_export_tool
from larva.shell.mcp_update_batch import handle_update_batch as handle_update_batch_tool

if TYPE_CHECKING:
    from larva.app.facade import (
        ClearedRegistry,
        DeletedPersona,
        LarvaError,
        LarvaFacade,
        RegisteredPersona,
    )
    from larva.core.spec import PersonaSpec
    from larva.core.validate import ValidationReport


# -----------------------------------------------------------------------------
# MCP Handler Contracts
# -----------------------------------------------------------------------------
# These define the delegation seam from MCP tool handlers to the facade.
# Each handler delegates to the corresponding LarvaFacade method.
# -----------------------------------------------------------------------------

_HandlerSuccessT = TypeVar("_HandlerSuccessT")


class MCPHandler(Protocol[_HandlerSuccessT]):
    """Typed MCP tool-handler callable contract."""

    def __call__(self, params: object) -> _HandlerSuccessT | LarvaError: ...


class MCPHandlers(MCPHandlerOpsMixin):
    """Container for MCP tool handlers.

    This class provides MCP tool handlers that delegate to the
    ``larva.app.facade.LarvaFacade`` protocol.

    Each method is a handler that:
    1. Extracts parameters from MCP request
    2. Validates parameter structure at MCP boundary
    3. Delegates to the appropriate facade method
    4. Returns MCP-formatted response or error envelope

    The handlers preserve falsey/null override values in resolve/assemble
    and ensure error envelopes have: code, numeric_code, message, details.

    Boundary Split (pinned for component operations):
    - Malformed/unknown/type-invalid params => _malformed_params_error (INTERNAL, numeric 10)
    - Unsupported component type or component lookup failures => COMPONENT_NOT_FOUND (numeric 105)
    """

    def __init__(self, facade: LarvaFacade, components: ComponentStore | None = None) -> None:
        """Initialize handlers with a facade instance and optional component store.

        Args:
            facade: The app-layer facade to delegate operations to.
            components: Optional component store for component operations.
                Defaults to None for backward compatibility.
        """
        self._facade = facade
        self._components = components

    def handle_component_list(self, params: object) -> Union[dict[str, list[str]], LarvaError]:
        """Handle larva.component_list MCP tool call."""
        return self._handle_component_list_impl(params)

    def handle_component_show(self, params: object) -> Union[dict[str, object], LarvaError]:
        """Handle larva.component_show MCP tool call."""
        return self._handle_component_show_impl(params)

    def handle_validate(self, params: object) -> Union[ValidationReport, LarvaError]:
        """Handle larva.validate MCP tool call."""
        return self._handle_validate_impl(params)

    def handle_assemble(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle larva.assemble MCP tool call."""
        return self._handle_assemble_impl(params)

    def handle_resolve(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle larva.resolve MCP tool call."""
        return self._handle_resolve_impl(params)

    def handle_register(self, params: object) -> Union[RegisteredPersona, LarvaError]:
        """Handle larva.register MCP tool call.

        Delegates to: facade.register(spec)

        Args:
            params: MCP request parameters containing 'spec' key.

        Returns:
            {"id": str, "registered": True} on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva_register", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva_register", checked_params, {"spec"}):
            return error
        if error := self._require_param("larva_register", checked_params, "spec"):
            return error
        if error := self._require_type("larva_register", checked_params, "spec", dict, "object"):
            return error
        spec = checked_params["spec"]

        # Delegate to facade
        result = self._facade.register(cast("PersonaSpec", spec))

        # Success shaping: return RegisteredPersona on success
        if isinstance(result, Success):
            return cast("RegisteredPersona", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_list(self, params: object) -> Union[list[dict[str, str]], LarvaError]:
        """Handle larva.list MCP tool call.

        Delegates to: facade.list()

        Args:
            params: MCP request parameters (unused).

        Returns:
            List of persona summaries on success:
            [{"id": str, "spec_digest": str, "model": str}, ...]
            Or error envelope on failure.
        """
        validated_params = self._require_params_object("larva_list", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva_list", checked_params, set()):
            return error

        # Delegate to facade
        result = self._facade.list()

        # Success shaping: return list of summaries
        if isinstance(result, Success):
            return cast("list[dict[str, str]]", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_delete(self, params: object) -> Union["DeletedPersona", LarvaError]:
        """Handle larva.delete MCP tool call.

        Delegates to: facade.delete(persona_id)

        Args:
            params: MCP request parameters:
                - id: Persona id to delete (required)

        Returns:
            {"id": str, "deleted": True} on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva_delete", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva_delete", checked_params, {"id"}):
            return error
        if error := self._require_param("larva_delete", checked_params, "id"):
            return error
        if error := self._require_type("larva_delete", checked_params, "id", str, "string"):
            return error

        persona_id = checked_params["id"]

        # Delegate to facade
        result = self._facade.delete(persona_id)

        # Success shaping: return DeletedPersona on success
        if isinstance(result, Success):
            return cast("DeletedPersona", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_clear(self, params: object) -> Union["ClearedRegistry", LarvaError]:
        """Handle larva.clear MCP tool call.

        Delegates to: facade.clear(confirm)

        Args:
            params: MCP request parameters:
                - confirm: Confirmation string, must match exactly (required)

        Returns:
            {"cleared": True, "count": int} on success, or error envelope on failure.
            Wrong confirm token returns INVALID_CONFIRMATION_TOKEN error.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva_clear", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva_clear", checked_params, {"confirm"}):
            return error
        if error := self._require_param("larva_clear", checked_params, "confirm"):
            return error
        if error := self._require_type("larva_clear", checked_params, "confirm", str, "string"):
            return error

        confirm = checked_params["confirm"]

        # Delegate to facade
        result = self._facade.clear(confirm)

        # Success shaping: return ClearedRegistry on success
        if isinstance(result, Success):
            return cast("ClearedRegistry", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_clone(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle larva.clone MCP tool call.

        Delegates to: facade.clone(source_id, new_id)

        Args:
            params: MCP request parameters:
                - source_id: Persona id to clone from (required)
                - new_id: New persona id for the clone (required)

        Returns:
            PersonaSpec JSON on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva_clone", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params(
            "larva_clone", checked_params, {"source_id", "new_id"}
        ):
            return error
        if error := self._require_param("larva_clone", checked_params, "source_id"):
            return error
        if error := self._require_param("larva_clone", checked_params, "new_id"):
            return error
        if error := self._require_type("larva_clone", checked_params, "source_id", str, "string"):
            return error
        if error := self._require_type("larva_clone", checked_params, "new_id", str, "string"):
            return error

        source_id = checked_params["source_id"]
        new_id = checked_params["new_id"]

        # Delegate to facade
        result = self._facade.clone(source_id, new_id)

        # Success shaping: return PersonaSpec on success
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_update(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle larva.update MCP tool call.

        Delegates to: facade.update(persona_id, patches)

        Args:
            params: MCP request parameters:
                - id: Persona id to update (required)
                - patches: JSON merge patches to apply (required, must be object)

        Returns:
            PersonaSpec JSON on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva_update", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva_update", checked_params, {"id", "patches"}):
            return error
        if error := self._require_param("larva_update", checked_params, "id"):
            return error
        if error := self._require_param("larva_update", checked_params, "patches"):
            return error
        if error := self._require_type("larva_update", checked_params, "id", str, "string"):
            return error
        if error := self._require_type("larva_update", checked_params, "patches", dict, "object"):
            return error

        persona_id = checked_params["id"]
        patches = checked_params["patches"]

        # Delegate to facade
        result = self._facade.update(persona_id, patches)

        # Success shaping: return PersonaSpec on success
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_update_batch(self, params: object) -> Union[dict[str, object], LarvaError]:
        """Handle larva.update_batch MCP tool call.

        Delegates to shared update_batch handler logic with where/patches/dry_run validation.
        """
        result = handle_update_batch_tool(self, params)
        if isinstance(result, Success):
            return cast("dict[str, object]", result.unwrap())
        return result.failure()

    def handle_export(self, params: object) -> Union[list["PersonaSpec"], LarvaError]:
        """Handle larva.export MCP tool call.

        Delegates to shared export handler logic with ``all`` xor ``ids`` validation.
        """
        result = handle_export_tool(self, params)
        if isinstance(result, Success):
            return cast("list[PersonaSpec]", result.unwrap())
        return result.failure()


# -----------------------------------------------------------------------------
# Delegation Seam Documentation
# -----------------------------------------------------------------------------
# The MCP adapter delegates to the app-layer facade, not to core modules.
# This ensures:
#   - Transport adapters remain thin
#   - Business logic lives in one place (facade)
#   - CLI, MCP, and Python APIs share the same flow
#
# Call flow:
#   MCP request -> MCPHandlers.handle_*() -> LarvaFacade.method() -> core/* / shell/*
#
# Boundary: shell/mcp -> app/facade -> core/* + shell/*
# -----------------------------------------------------------------------------

__all__ = [
    "LARVA_MCP_TOOLS",
    "LARVA_ERROR_CODES",
    "MCPToolDefinition",
    "MCPHandlers",
    "ValidationIssue",
    "ValidationReport",
]
