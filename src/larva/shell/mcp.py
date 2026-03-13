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

from typing import TYPE_CHECKING, Any, Literal, Protocol, TypedDict, Union, cast

from returns.result import Failure, Result, Success

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
# MCP Tool Definitions
# -----------------------------------------------------------------------------
# The MCP server exposes these tools. Each maps to a facade method.
#
# Tool signatures follow INTERFACES.md :: A. MCP Server Interface
# -----------------------------------------------------------------------------

# Error codes from INTERFACES.md :: G. Error Codes
LARVA_ERROR_CODES: dict[str, int] = {
    "INTERNAL": 10,
    "PERSONA_NOT_FOUND": 100,
    "PERSONA_INVALID": 101,
    "PERSONA_CYCLE": 102,
    "VARIABLE_UNRESOLVED": 103,
    "INVALID_PERSONA_ID": 104,
    "COMPONENT_NOT_FOUND": 105,
    "COMPONENT_CONFLICT": 106,
    "REGISTRY_INDEX_READ_FAILED": 107,
    "REGISTRY_SPEC_READ_FAILED": 108,
    "REGISTRY_WRITE_FAILED": 109,
    "REGISTRY_UPDATE_FAILED": 110,
}


class ValidationIssue(TypedDict):
    """Error detail structure for validation failures."""

    code: str
    message: str
    details: dict[str, Any]


class ValidationReport(TypedDict):
    """Response from larva.validate().

    From INTERFACES.md :: larva.validate(spec) returns.

    Example valid response:
    {
        "valid": True,
        "errors": [],
        "warnings": ["model 'gpt-6' not in known models list"]
    }

    Example invalid response:
    {
        "valid": False,
        "errors": [
            {
                "code": "INVALID_SPEC_VERSION",
                "message": "spec_version must be '0.1.0'",
                "details": {"field": "spec_version", "value": "0.2.0"}
            }
        ],
        "warnings": []
    }
    """

    valid: bool
    errors: list[ValidationIssue]
    warnings: list[str]


class MCPToolDefinition(TypedDict):
    """MCP tool metadata for registration."""

    name: str
    description: str
    input_schema: dict[str, Any]


# Documented MCP tool set from INTERFACES.md :: A and README.md
LARVA_MCP_TOOLS: list[MCPToolDefinition] = [
    {
        "name": "larva.validate",
        "description": "Validate a PersonaSpec JSON object against the canonical schema and semantic rules.",
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": "PersonaSpec JSON to validate",
                }
            },
            "required": ["spec"],
        },
    },
    {
        "name": "larva.assemble",
        "description": "Assemble a PersonaSpec from named components (prompts, toolsets, constraints, model).",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id"},
                "prompts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Prompt component names (concatenated in order)",
                },
                "toolsets": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Toolset component names",
                },
                "constraints": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Constraint component names",
                },
                "model": {"type": "string", "description": "Model component name"},
                "overrides": {
                    "type": "object",
                    "description": "Field overrides (wins over components)",
                },
                "variables": {
                    "type": "object",
                    "description": "Variable substitution in prompt text",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "larva.resolve",
        "description": "Resolve a pre-registered persona by id, optionally with runtime overrides.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id in registry"},
                "overrides": {
                    "type": "object",
                    "description": "Field overrides applied to the resolved spec",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "larva.register",
        "description": "Register a PersonaSpec in the global registry.",
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": "PersonaSpec JSON (must pass validation)",
                }
            },
            "required": ["spec"],
        },
    },
    {
        "name": "larva.list",
        "description": "List all registered personas.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
]


# -----------------------------------------------------------------------------
# MCP Handler Contracts
# -----------------------------------------------------------------------------
# These define the delegation seam from MCP tool handlers to the facade.
# Each handler delegates to the corresponding LarvaFacade method.
# -----------------------------------------------------------------------------

# Type alias for MCP tool handler functions
MCPHandler = Any  # Callable[[dict[str, Any]], Result[Any, LarvaError]]


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

    def handle_validate(self, params: dict[str, Any]) -> ValidationReport:
        """Handle larva.validate MCP tool call.

        Delegates to: facade.validate(spec)

        Args:
            params: MCP request parameters containing 'spec' key.

        Returns:
            ValidationReport with valid flag, errors, and warnings.

        Raises:
            ValueError: If 'spec' key is missing from params.
        """
        # Request parsing: extract 'spec' parameter
        if "spec" not in params:
            raise ValueError("Missing required parameter: 'spec'")
        spec = params["spec"]

        # Delegate to facade - returns ValidationReport directly
        return self._facade.validate(cast("PersonaSpec", spec))

    def handle_assemble(self, params: dict[str, Any]) -> Union[PersonaSpec, LarvaError]:
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

        Raises:
            ValueError: If 'id' key is missing from params.
        """
        # Request parsing: validate required 'id' parameter
        if "id" not in params:
            raise ValueError("Missing required parameter: 'id'")

        # Build AssembleRequest - preserve falsey overrides
        request: AssembleRequest = {
            "id": params["id"],
            "prompts": params.get("prompts", []),
            "toolsets": params.get("toolsets", []),
            "constraints": params.get("constraints", []),
            "model": params.get("model", ""),
            "overrides": params.get("overrides", {}),
            "variables": params.get("variables", {}),
        }

        # Delegate to facade
        result = self._facade.assemble(request)

        # Success shaping: return PersonaSpec on success
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_resolve(self, params: dict[str, Any]) -> Union[PersonaSpec, LarvaError]:
        """Handle larva.resolve MCP tool call.

        Delegates to: facade.resolve(id, overrides)

        Args:
            params: MCP request parameters:
                - id: Persona id in registry (required)
                - overrides: optional field overrides (preserves falsey values)

        Returns:
            PersonaSpec JSON on success, or error envelope on failure.

        Raises:
            ValueError: If 'id' key is missing from params.
        """
        # Request parsing: validate required 'id' parameter
        if "id" not in params:
            raise ValueError("Missing required parameter: 'id'")

        persona_id = params["id"]
        # Preserve falsey/null override values - pass None if not provided
        overrides: dict[str, object] | None = params.get("overrides")

        # Delegate to facade
        result = self._facade.resolve(persona_id, overrides)

        # Success shaping: return PersonaSpec on success
        if isinstance(result, Success):
            return cast("PersonaSpec", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_register(self, params: dict[str, Any]) -> Union[RegisteredPersona, LarvaError]:
        """Handle larva.register MCP tool call.

        Delegates to: facade.register(spec)

        Args:
            params: MCP request parameters containing 'spec' key.

        Returns:
            {"id": str, "registered": True} on success, or error envelope on failure.

        Raises:
            ValueError: If 'spec' key is missing from params.
        """
        # Request parsing: extract 'spec' parameter
        if "spec" not in params:
            raise ValueError("Missing required parameter: 'spec'")
        spec = params["spec"]

        # Delegate to facade
        result = self._facade.register(cast("PersonaSpec", spec))

        # Success shaping: return RegisteredPersona on success
        if isinstance(result, Success):
            return cast("RegisteredPersona", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error

    def handle_list(self, params: dict[str, Any]) -> Union[list[dict[str, str]], LarvaError]:
        """Handle larva.list MCP tool call.

        Delegates to: facade.list()

        Args:
            params: MCP request parameters (unused).

        Returns:
            List of persona summaries on success:
            [{"id": str, "spec_digest": str, "model": str}, ...]
            Or error envelope on failure.
        """
        # No parameters needed for list
        del params  # Explicitly indicate unused

        # Delegate to facade
        result = self._facade.list()

        # Success shaping: return list of summaries
        if isinstance(result, Success):
            return cast("list[dict[str, str]]", result.unwrap())

        # Error envelope fidelity: return error with code, numeric_code, message, details
        error = result.failure()
        return error


# -----------------------------------------------------------------------------
# MCP Transport Adapter Contract
# -----------------------------------------------------------------------------
# Defines the contract for the MCP server transport layer.
# -----------------------------------------------------------------------------


# Type alias for supported MCP transport modes
MCPTransportMode = Literal["stdio", "sse"]
"""Supported MCP transport modes: 'stdio' for Standard I/O, 'sse' for Server-Sent Events."""


class MCPServerConfig(TypedDict, total=False):
    """Configuration for MCP server startup."""

    transport: MCPTransportMode
    host: str | None  # For SSE mode
    port: int | None  # For SSE mode


class MCPServer(Protocol):
    """Contract for MCP server runtime.

    This protocol defines the interface for starting and stopping
    the MCP server. Actual implementation handles:
    - Transport layer (stdio/SSE)
    - Protocol frame encoding/decoding
    - Tool registration
    - Request dispatch to handlers

    Implementation note: This is contract-only for this step.
    The actual server startup belongs to a later implementation step.
    """

    def __init__(self, handlers: MCPHandlers, config: MCPServerConfig) -> None:
        """Initialize the MCP server.

        Args:
            handlers: Container with tool handlers.
            config: Server configuration.
        """
        ...

    def run(self) -> None:
        """Start the MCP server and run until shutdown.

        Raises:
            NotImplementedError: Server startup is out of scope for contract.
        """
        raise NotImplementedError(
            "MCP server runtime startup is not implemented in this contract step"
        )

    def shutdown(self) -> None:
        """Gracefully stop the MCP server."""
        ...


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
