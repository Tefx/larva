"""Compatibility helpers for constructing CLI facade instances."""

from __future__ import annotations

from larva.app.facade import LarvaFacade
from larva.shell.cli_runtime import _build_default_facade


def build_default_facade() -> LarvaFacade:
    """Return a default facade instance for CLI-compatible callers."""
    return _build_default_facade().unwrap()
