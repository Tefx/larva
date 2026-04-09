"""Compatibility helpers for constructing CLI facade instances."""

from __future__ import annotations

from larva.app.facade import LarvaFacade
from larva.shell.shared import facade_factory


def build_default_facade() -> LarvaFacade:
    """Return a default facade instance for CLI-compatible callers."""
    return facade_factory.build_default_facade()
