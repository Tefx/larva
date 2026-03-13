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

from typing import TYPE_CHECKING, Any, Protocol, TypeVar, Union, cast

from returns.result import Failure, Result, Success

from larva.shell.mcp_contract import (
    LARVA_ERROR_CODES,
    LARVA_MCP_TOOLS,
    MCPServer,
    MCPServerConfig,
    MCPToolDefinition,
    MCPTransportMode,
    ValidationIssue,
    ValidationReport,
)

if TYPE_CHECKING:
    from larva.app.facade import (
        AssembleRequest,
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


class MCPHandlers:
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
    """

    def __init__(self, facade: LarvaFacade) -> None:
        """Initialize handlers with a facade instance.

        Args:
            facade: The app-layer facade to delegate operations to.
        """
        self._facade = facade

    @staticmethod
    def _malformed_params_error(
        tool_name: str,
        reason: str,
        details: dict[str, object],
    ) -> LarvaError:
        """Build a documented MCP error envelope for malformed request params."""
        return {
            "code": "INTERNAL",
            "numeric_code": LARVA_ERROR_CODES["INTERNAL"],
            "message": f"Malformed parameters for '{tool_name}': {reason}",
            "details": {"tool": tool_name, "reason": reason, **details},
        }

    def _require_params_object(
        self,
        tool_name: str,
        params: object,
    ) -> Result[dict[str, Any], LarvaError]:
        """Validate MCP params top-level shape as JSON object."""
        if not isinstance(params, dict):
            return Failure(
                self._malformed_params_error(
                    tool_name,
                    "params must be an object",
                    {"field": "params", "received_type": type(params).__name__},
                )
            )
        return Success(params)

    def _reject_unknown_params(
        self,
        tool_name: str,
        params: dict[str, Any],
        allowed_keys: set[str],
    ) -> LarvaError | None:
        """Reject unsupported parameters at MCP boundary."""
        unknown_keys = sorted(key for key in params if key not in allowed_keys)
        if unknown_keys:
            return self._malformed_params_error(
                tool_name,
                "unknown parameter(s)",
                {"field": "params", "unknown": unknown_keys},
            )
        return None

    def _require_param(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> LarvaError | None:
        """Require key presence for mandatory parameters."""
        if key not in params:
            return self._malformed_params_error(
                tool_name,
                f"missing required parameter '{key}'",
                {"field": key},
            )
        return None

    def _require_type(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
        expected_type: type[object],
        expected_label: str,
    ) -> LarvaError | None:
        """Require parameter runtime type at MCP boundary."""
        value = params.get(key)
        if not isinstance(value, expected_type):
            return self._malformed_params_error(
                tool_name,
                f"parameter '{key}' must be {expected_label}",
                {
                    "field": key,
                    "expected_type": expected_label,
                    "received_type": type(value).__name__,
                },
            )
        return None

    def _require_list_of_strings(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> LarvaError | None:
        """Require optional list[str] parameter shape when present."""
        if key not in params:
            return None

        value = params[key]
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            return self._malformed_params_error(
                tool_name,
                f"parameter '{key}' must be list[string]",
                {
                    "field": key,
                    "expected_type": "list[string]",
                    "received_type": type(value).__name__,
                },
            )
        return None

    def handle_validate(self, params: object) -> Union[ValidationReport, LarvaError]:
        """Handle larva.validate MCP tool call.

        Delegates to: facade.validate(spec)

        Args:
            params: MCP request parameters containing 'spec' key.

        Returns:
            ValidationReport with valid flag, errors, and warnings.
            Missing `spec.id` (or invalid id format) is reported as
            INVALID_PERSONA_ID through the report errors list.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva.validate", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva.validate", checked_params, {"spec"}):
            return error
        if error := self._require_param("larva.validate", checked_params, "spec"):
            return error
        if error := self._require_type("larva.validate", checked_params, "spec", dict, "object"):
            return error
        spec = checked_params["spec"]

        # Delegate to facade - returns ValidationReport directly
        return self._facade.validate(cast("PersonaSpec", spec))

    def handle_assemble(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle larva.assemble MCP tool call.

        Delegates to: facade.assemble(request)

        Args:
            params: MCP request parameters matching AssembleRequest:
                - id: Persona id (required)
                - prompts: list of prompt component names
                - toolsets: list of toolset component names
                - constraints: list of constraint component names
                - model: model component name
                - overrides: field overrides (preserves falsey values)
                - variables: variable substitution

        Returns:
            PersonaSpec JSON on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva.assemble", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params(
            "larva.assemble",
            checked_params,
            {"id", "prompts", "toolsets", "constraints", "model", "overrides", "variables"},
        ):
            return error
        if error := self._require_param("larva.assemble", checked_params, "id"):
            return error
        if error := self._require_type("larva.assemble", checked_params, "id", str, "string"):
            return error
        if error := self._require_list_of_strings("larva.assemble", checked_params, "prompts"):
            return error
        if error := self._require_list_of_strings("larva.assemble", checked_params, "toolsets"):
            return error
        if error := self._require_list_of_strings("larva.assemble", checked_params, "constraints"):
            return error
        if "model" in checked_params and (
            error := self._require_type("larva.assemble", checked_params, "model", str, "string")
        ):
            return error
        if "overrides" in checked_params and (
            error := self._require_type(
                "larva.assemble", checked_params, "overrides", dict, "object"
            )
        ):
            return error
        if "variables" in checked_params and (
            error := self._require_type(
                "larva.assemble", checked_params, "variables", dict, "object"
            )
        ):
            return error

        # Build AssembleRequest - preserve falsey overrides
        request: AssembleRequest = {
            "id": checked_params["id"],
            "prompts": checked_params.get("prompts", []),
            "toolsets": checked_params.get("toolsets", []),
            "constraints": checked_params.get("constraints", []),
            "model": checked_params.get("model", ""),
            "overrides": checked_params.get("overrides", {}),
            "variables": checked_params.get("variables", {}),
        }

        # Delegate to facade
        result = self._facade.assemble(request)

        # Success shaping: return PersonaSpec on success
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_resolve(self, params: object) -> Union[PersonaSpec, LarvaError]:
        """Handle larva.resolve MCP tool call.

        Delegates to: facade.resolve(id, overrides)

        Args:
            params: MCP request parameters:
                - id: Persona id in registry (required)
                - overrides: optional field overrides (preserves falsey values)

        Returns:
            PersonaSpec JSON on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva.resolve", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params(
            "larva.resolve", checked_params, {"id", "overrides"}
        ):
            return error
        if error := self._require_param("larva.resolve", checked_params, "id"):
            return error
        if error := self._require_type("larva.resolve", checked_params, "id", str, "string"):
            return error
        if "overrides" in checked_params and (
            error := self._require_type(
                "larva.resolve", checked_params, "overrides", dict, "object"
            )
        ):
            return error

        persona_id = checked_params["id"]
        # Preserve falsey/null override values - pass None if not provided
        overrides: dict[str, object] | None = checked_params.get("overrides")

        # Delegate to facade
        result = self._facade.resolve(persona_id, overrides)

        # Success shaping: return PersonaSpec on success
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_register(self, params: object) -> Union[RegisteredPersona, LarvaError]:
        """Handle larva.register MCP tool call.

        Delegates to: facade.register(spec)

        Args:
            params: MCP request parameters containing 'spec' key.

        Returns:
            {"id": str, "registered": True} on success, or error envelope on failure.

        Malformed requests return the documented MCP error envelope.
        """
        validated_params = self._require_params_object("larva.register", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva.register", checked_params, {"spec"}):
            return error
        if error := self._require_param("larva.register", checked_params, "spec"):
            return error
        if error := self._require_type("larva.register", checked_params, "spec", dict, "object"):
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
        validated_params = self._require_params_object("larva.list", params)
        if isinstance(validated_params, Failure):
            return validated_params.failure()
        checked_params = validated_params.unwrap()
        if error := self._reject_unknown_params("larva.list", checked_params, set()):
            return error

        # Delegate to facade
        result = self._facade.list()

        # Success shaping: return list of summaries
        if isinstance(result, Success):
            return cast("list[dict[str, str]]", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error


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
    "MCPServer",
    "MCPServerConfig",
    "MCPTransportMode",
    "ValidationIssue",
    "ValidationReport",
]
