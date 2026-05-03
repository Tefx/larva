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

from typing import TYPE_CHECKING, Any, Union, cast

from returns.result import Failure, Success

from larva.shell.components import ComponentStore
from larva.shell.mcp_contract import (
    LARVA_ERROR_CODES,
    LARVA_MCP_TOOLS,
    MCPToolDefinition,
    ValidationIssue,
    ValidationReport,
)
from larva.shell.mcp_export import handle_export as handle_export_tool
from larva.shell.mcp_params import MCPParamValidationMixin
from larva.shell.mcp_update_batch import handle_update_batch as handle_update_batch_tool

if TYPE_CHECKING:
    from larva.app.facade import (
        ClearedRegistry,
        DeletedPersona,
        LarvaError,
        LarvaFacade,
        RegisteredPersona,
        VariantMetadata,
        ActivatedVariant,
        DeletedVariant,
    )
    from larva.core.spec import PersonaSpec
    from larva.core.validate import ValidationReport


# -----------------------------------------------------------------------------
# MCP Handler Contracts
# -----------------------------------------------------------------------------
# These define the delegation seam from MCP tool handlers to the facade.
# Each handler delegates to the corresponding LarvaFacade method.
# -----------------------------------------------------------------------------

class MCPHandlers(MCPParamValidationMixin):
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

    _facade: Any
    _components: ComponentStore | None

    def __init__(self, facade: LarvaFacade, components: ComponentStore | None = None) -> None:
        """Initialize handlers with a facade instance and optional component store.

        Args:
            facade: The app-layer facade to delegate operations to.
            components: Optional component store for component operations.
        """
        self._facade = facade
        self._components = components

    # -------------------------------------------------------------------------
    # Inlined implementation methods (formerly in mcp_handler_ops module)
    # -------------------------------------------------------------------------

    def handle_validate(self, params: object) -> Union[ValidationReport, LarvaError]:
        """Handle ``larva_validate`` MCP tool call."""
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

    def handle_resolve(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle ``larva_resolve`` MCP tool call."""
        validated_params = self._validated_params(
            "larva_resolve",
            params,
            allowed_keys={"id", "overrides", "variant"},
            required_keys=("id",),
            typed_keys=(("id", str, "string"), ("overrides", dict, "object"), ("variant", str, "string")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()

        persona_id = checked_params["id"]
        overrides: dict[str, object] | None = checked_params.get("overrides")
        variant: str | None = checked_params.get("variant")
        facade = cast("Any", self._facade)
        return cast(
            "PersonaSpec | LarvaError", self._unwrap_result(facade.resolve(persona_id, overrides, variant=variant))
        )

    def handle_register(self, params: object) -> Union[RegisteredPersona, LarvaError]:
        """Handle ``larva_register`` MCP tool call.

        Delegates to: facade.register(spec)

        Args:
            params: MCP request parameters containing 'spec' key.

        Returns:
            {"id": str, "registered": True} on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._validated_params(
            "larva_register",
            params,
            allowed_keys={"spec", "variant"},
            required_keys=("spec",),
            typed_keys=(("spec", dict, "object"), ("variant", str, "string")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        spec = checked_params["spec"]
        variant: str | None = checked_params.get("variant")
        return cast(
            "RegisteredPersona | LarvaError",
            self._unwrap_result(self._facade.register(cast("PersonaSpec", spec), variant=variant)),
        )

    def handle_list(self, params: object) -> Union[list[dict[str, str]], LarvaError]:
        """Handle ``larva_list`` MCP tool call.

        Delegates to: facade.list()

        Args:
            params: MCP request parameters (unused).

        Returns:
            List of persona summaries on success:
            [{"id": str, "description": str, "spec_digest": str, "model": str}, ...]
            Or error envelope on failure.
        """
        validated_params = self._validated_params("larva_list", params, allowed_keys=set())
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        return cast("list[dict[str, str]] | LarvaError", self._unwrap_result(self._facade.list()))

    def handle_delete(self, params: object) -> Union["DeletedPersona", LarvaError]:
        """Handle ``larva_delete`` MCP tool call.

        Delegates to: facade.delete(persona_id)

        Args:
            params: MCP request parameters:
                - id: Persona id to delete (required)

        Returns:
            {"id": str, "deleted": True} on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._validated_params(
            "larva_delete",
            params,
            allowed_keys={"id"},
            required_keys=("id",),
            typed_keys=(("id", str, "string"),),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        persona_id = checked_params["id"]
        return cast(
            "DeletedPersona | LarvaError", self._unwrap_result(self._facade.delete(persona_id))
        )

    def handle_clear(self, params: object) -> Union["ClearedRegistry", LarvaError]:
        """Handle ``larva_clear`` MCP tool call.

        Delegates to: facade.clear(confirm)

        Args:
            params: MCP request parameters:
                - confirm: Confirmation string, must match exactly (required)

        Returns:
            {"cleared": True, "count": int} on success, or error envelope on failure.
            Wrong confirm token returns INVALID_CONFIRMATION_TOKEN error.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._validated_params(
            "larva_clear",
            params,
            allowed_keys={"confirm"},
            required_keys=("confirm",),
            typed_keys=(("confirm", str, "string"),),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        confirm = checked_params["confirm"]
        return cast(
            "ClearedRegistry | LarvaError", self._unwrap_result(self._facade.clear(confirm))
        )

    def handle_clone(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle ``larva_clone`` MCP tool call.

        Delegates to: facade.clone(source_id, new_id)

        Args:
            params: MCP request parameters:
                - source_id: Persona id to clone from (required)
                - new_id: New persona id for the clone (required)

        Returns:
            PersonaSpec JSON on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._validated_params(
            "larva_clone",
            params,
            allowed_keys={"source_id", "new_id"},
            required_keys=("source_id", "new_id"),
            typed_keys=(("source_id", str, "string"), ("new_id", str, "string")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()

        source_id = checked_params["source_id"]
        new_id = checked_params["new_id"]
        return cast(
            "PersonaSpec | LarvaError", self._unwrap_result(self._facade.clone(source_id, new_id))
        )

    def handle_update(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle ``larva_update`` MCP tool call.

        Delegates to: facade.update(persona_id, patches)

        Args:
            params: MCP request parameters:
                - id: Persona id to update (required)
                - patches: JSON merge patches to apply (required, must be object)

        Returns:
            PersonaSpec JSON on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._validated_params(
            "larva_update",
            params,
            allowed_keys={"id", "patches", "variant"},
            required_keys=("id", "patches"),
            typed_keys=(("id", str, "string"), ("patches", dict, "object"), ("variant", str, "string")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()

        persona_id = checked_params["id"]
        patches = checked_params["patches"]
        variant: str | None = checked_params.get("variant")
        return cast(
            "PersonaSpec | LarvaError",
            self._unwrap_result(self._facade.update(persona_id, patches, variant=variant)),
        )

    def handle_variant_list(self, params: object) -> Union["VariantMetadata", LarvaError]:
        """Handle ``larva_variant_list`` MCP tool call."""
        validated_params = self._validated_params(
            "larva_variant_list",
            params,
            allowed_keys={"id"},
            required_keys=("id",),
            typed_keys=(("id", str, "string"),),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        return cast(
            "VariantMetadata | LarvaError",
            self._unwrap_result(self._facade.variant_list(validated_params.unwrap()["id"])),
        )

    def handle_variant_activate(self, params: object) -> Union["ActivatedVariant", LarvaError]:
        """Handle ``larva_variant_activate`` MCP tool call."""
        validated_params = self._validated_params(
            "larva_variant_activate",
            params,
            allowed_keys={"id", "variant"},
            required_keys=("id", "variant"),
            typed_keys=(("id", str, "string"), ("variant", str, "string")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked = validated_params.unwrap()
        return cast(
            "ActivatedVariant | LarvaError",
            self._unwrap_result(self._facade.variant_activate(checked["id"], checked["variant"])),
        )

    def handle_variant_delete(self, params: object) -> Union["DeletedVariant", LarvaError]:
        """Handle ``larva_variant_delete`` MCP tool call."""
        validated_params = self._validated_params(
            "larva_variant_delete",
            params,
            allowed_keys={"id", "variant"},
            required_keys=("id", "variant"),
            typed_keys=(("id", str, "string"), ("variant", str, "string")),
        )
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked = validated_params.unwrap()
        return cast(
            "DeletedVariant | LarvaError",
            self._unwrap_result(self._facade.variant_delete(checked["id"], checked["variant"])),
        )

    def handle_update_batch(self, params: object) -> Union[dict[str, object], LarvaError]:
        """Handle ``larva_update_batch`` MCP tool call.

        Delegates to shared update_batch handler logic with where/patches/dry_run validation.
        """
        result = handle_update_batch_tool(self, params)
        if isinstance(result, Success):
            return cast("dict[str, object]", result.unwrap())
        return result.failure()

    def handle_export(self, params: object) -> Union[list["PersonaSpec"], LarvaError]:
        """Handle ``larva_export`` MCP tool call.

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
