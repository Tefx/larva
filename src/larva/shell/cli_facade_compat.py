"""Compatibility wrapper for default facade construction."""

from __future__ import annotations

from larva.app.facade import LarvaFacade
from larva.shell.cli_runtime import _build_default_facade


# @invar:allow shell_result: compatibility wrapper preserves facade return type for CLI callers/tests
def build_default_facade() -> LarvaFacade:
    return _build_default_facade().unwrap()
