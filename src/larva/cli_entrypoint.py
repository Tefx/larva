"""Process entrypoint helpers for CLI execution."""

from __future__ import annotations

import sys
from collections.abc import Sequence

from larva.shell.components import FilesystemComponentStore
from larva.shell.shared.facade_factory import build_default_facade


# @invar:allow shell_result: process entrypoint returns int exit code for console scripts
def main(argv: Sequence[str] | None = None) -> int:
    """Run the shell CLI and return its integer process exit code."""
    from larva.shell.cli import run_cli

    active_argv = list(sys.argv[1:] if argv is None else argv)
    return int(
        run_cli(
            active_argv,
            facade=build_default_facade(),
            stdout=sys.stdout,
            stderr=sys.stderr,
            component_store=FilesystemComponentStore(),
        )
    )
