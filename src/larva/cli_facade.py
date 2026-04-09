"""Compatibility helpers for constructing CLI facade instances."""

from __future__ import annotations

from larva.app.facade import LarvaFacade
from larva.shell.shared.facade_factory import build_default_facade as build_shared_default_facade


def build_default_facade() -> LarvaFacade:
    """Return a default facade instance for CLI-compatible callers."""
    return build_shared_default_facade()
