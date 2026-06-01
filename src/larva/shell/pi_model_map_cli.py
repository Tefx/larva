"""CLI command dispatcher for pi-model-map."""

from __future__ import annotations

import argparse
from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.shell.cli_helpers import (
    EXIT_CRITICAL,
    CliCommandResult,
    CliFailure,
    _critical_error,
)

if TYPE_CHECKING:
    from larva.app.facade import LarvaFacade

# Error codes for Pi model map drafting as per design/pi-model-map-draft-helper.md
LARVA_PI_MODELS_UNAVAILABLE = "LARVA_PI_MODELS_UNAVAILABLE"
LARVA_PI_MODEL_MAP_INVALID = "LARVA_PI_MODEL_MAP_INVALID"
LARVA_PI_MODEL_MAP_UNRESOLVED = "LARVA_PI_MODEL_MAP_UNRESOLVED"
LARVA_PI_MODEL_MAP_WRITE_FAILED = "LARVA_PI_MODEL_MAP_WRITE_FAILED"
LARVA_PI_MODEL_MAP_BAD_ARGS = "LARVA_PI_MODEL_MAP_BAD_ARGS"


def _draft_command(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Stub for pi-model-map draft."""
    # @invar:allow dead_param: Stub command implementation
    # Contract constraint: Default stdout is raw draft JSON only.
    # Reports/warnings go to stderr.
    # --json mode returns a Larva envelope (CliCommandResult).
    # Does not read personal dotfiles like /Users/tefx/dotfiles/agent/models.yaml.
    
    # Do not implement runtime behavior in this contract step.
    return Failure(
        {
            "exit_code": EXIT_CRITICAL,
            "stderr": "pi-model-map draft is not yet implemented\n",
            "error": _critical_error("not implemented", {}).unwrap(),
        }
    )

def pi_model_map_command(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Dispatch pi-model-map subcommands."""
    subcommand = getattr(args, "pi_model_map_command", None)
    if subcommand == "draft":
        return _draft_command(args, as_json=as_json, facade=facade)
        
    return Failure(
        {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"Unsupported pi-model-map command: {subcommand}\n",
            "error": _critical_error("unsupported command", {"command": str(subcommand)}).unwrap(),
        }
    )
