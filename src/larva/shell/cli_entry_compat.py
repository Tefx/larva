"""Compatibility wrappers for CLI entrypoint helpers."""

from __future__ import annotations

from larva.shell.cli_parser import _CliParser, build_cli_parser


# @invar:allow shell_result: CLI entrypoint parser must return argparse parser instance
def _build_parser() -> _CliParser:
    return build_cli_parser().unwrap()
