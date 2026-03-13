"""Contract-only CLI shell surface for larva.

Task boundary (shell_cli.shell-cli-contract):
- signatures, type definitions, interface notes, and stubs only
- no argument parsing implementation
- no file I/O implementation
- no facade/component invocation implementation
- no JSON emission implementation

Authoritative downstream seams (clarified contract):
- Persona commands route to `larva.app.facade.LarvaFacade`
  (`validate`, `assemble`, `register`, `resolve`, `list`)
- Component read commands route directly to
  `larva.shell.components.ComponentStore`
  (`component list`, `component show`)

Acceptance-level notes for `--json` and process exits:
- All commands accept `--json` as a transport formatting flag.
- Exit code strategy uses small shell-friendly codes only:
  - `0`: success
  - `1`: domain/application error
  - `2`: critical/transport failure
- With `--json`, error payloads include app error identity fields
  (`code`, `numeric_code`, `message`, `details`) while process exit remains
  in `{0, 1, 2}`.

Sources:
- INTERFACES.md :: B. CLI Interface
- INTERFACES.md :: G. Error Codes
- ARCHITECTURE.md :: Module: `larva.shell.cli`
- ARCHITECTURE.md :: Decision 4 (component subcommands bypass facade)
"""

from __future__ import annotations

from typing import Literal, TypedDict

from returns.result import Result

from larva.app.facade import (
    AssembleRequest,
    LarvaError,
    LarvaFacade,
    PersonaSummary,
    RegisteredPersona,
)
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStore

CliExitCode = Literal[0, 1, 2]

EXIT_OK: CliExitCode = 0
EXIT_ERROR: CliExitCode = 1
EXIT_CRITICAL: CliExitCode = 2

CommandName = Literal[
    "validate",
    "assemble",
    "register",
    "resolve",
    "list",
    "component list",
    "component show",
]


class JsonErrorEnvelope(TypedDict):
    """Machine-readable error payload for `--json` mode."""

    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


class CliFailure(TypedDict, total=False):
    """Transport-neutral CLI failure contract."""

    exit_code: CliExitCode
    stderr: str
    error: JsonErrorEnvelope


class CliJsonSuccess(TypedDict):
    """Machine-readable stdout payload for successful CLI commands."""

    data: object


class CliCommandResult(TypedDict, total=False):
    """Normalized contract result produced by CLI handlers."""

    exit_code: CliExitCode
    stdout: str
    stderr: str
    json: CliJsonSuccess


class JsonModeSpec(TypedDict):
    """Acceptance note entry for JSON behavior."""

    command: CommandName
    behavior: str


JSON_MODE_ACCEPTANCE: tuple[JsonModeSpec, ...] = (
    {
        "command": "validate",
        "behavior": "When --json is set, success/error are represented as JSON payloads on stdout.",
    },
    {
        "command": "assemble",
        "behavior": "When --json is set, assembled PersonaSpec is emitted as JSON payload.",
    },
    {
        "command": "register",
        "behavior": "When --json is set, registration outcome is emitted as JSON payload.",
    },
    {
        "command": "resolve",
        "behavior": "When --json is set, resolved PersonaSpec is emitted as JSON payload.",
    },
    {
        "command": "list",
        "behavior": "When --json is set, persona summaries are emitted as JSON payload.",
    },
    {
        "command": "component list",
        "behavior": "When --json is set, component index is emitted as JSON payload.",
    },
    {
        "command": "component show",
        "behavior": "When --json is set, selected component payload is emitted as JSON payload.",
    },
)


EXIT_CODE_ACCEPTANCE: tuple[tuple[CliExitCode, str], ...] = (
    (EXIT_OK, "success"),
    (EXIT_ERROR, "domain/application error"),
    (EXIT_CRITICAL, "critical/transport failure"),
)


PERSONA_COMMAND_SEAM = "larva.app.facade.LarvaFacade"
COMPONENT_COMMAND_SEAM = "larva.shell.components.ComponentStore"


def validate_command(
    spec: PersonaSpec,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Contract stub for `larva validate` command handling."""
    raise NotImplementedError("cli contract-only: validate command wiring deferred")


def assemble_command(
    request: AssembleRequest,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Contract stub for `larva assemble` command handling."""
    raise NotImplementedError("cli contract-only: assemble command wiring deferred")


def register_command(
    spec: PersonaSpec,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Contract stub for `larva register` command handling."""
    raise NotImplementedError("cli contract-only: register command wiring deferred")


def resolve_command(
    persona_id: str,
    *,
    overrides: dict[str, object] | None,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Contract stub for `larva resolve` command handling."""
    raise NotImplementedError("cli contract-only: resolve command wiring deferred")


def list_command(
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Contract stub for `larva list` command handling."""
    raise NotImplementedError("cli contract-only: list command wiring deferred")


def component_list_command(
    *,
    as_json: bool,
    component_store: ComponentStore,
) -> Result[CliCommandResult, CliFailure]:
    """Contract stub for `larva component list` command handling."""
    raise NotImplementedError("cli contract-only: component list wiring deferred")


def component_show_command(
    component_ref: str,
    *,
    as_json: bool,
    component_store: ComponentStore,
) -> Result[CliCommandResult, CliFailure]:
    """Contract stub for `larva component show` command handling."""
    raise NotImplementedError("cli contract-only: component show wiring deferred")


__all__ = [
    "CliCommandResult",
    "CliExitCode",
    "CliFailure",
    "CommandName",
    "COMPONENT_COMMAND_SEAM",
    "EXIT_CODE_ACCEPTANCE",
    "EXIT_CRITICAL",
    "EXIT_ERROR",
    "EXIT_OK",
    "JSON_MODE_ACCEPTANCE",
    "JsonErrorEnvelope",
    "PERSONA_COMMAND_SEAM",
    "assemble_command",
    "component_list_command",
    "component_show_command",
    "list_command",
    "register_command",
    "resolve_command",
    "validate_command",
    "PersonaSpec",
    "ValidationReport",
    "AssembleRequest",
    "RegisteredPersona",
    "PersonaSummary",
    "LarvaError",
]
