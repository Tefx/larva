"""Compatibility shim for legacy ``larva.cli`` entrypoints.

Authoritative CLI behavior lives in ``larva.shell.cli``. This module exists only
to preserve the import and module-execution surface for callers still using
``larva.cli``.
"""

from __future__ import annotations

from collections.abc import Sequence

from larva.shell import cli as shell_cli


def main(argv: Sequence[str] | None = None) -> int:
    """Delegate to ``larva.shell.cli.main`` without adding CLI behavior."""
    return shell_cli.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
