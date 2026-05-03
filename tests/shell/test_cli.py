"""CLI boundary tests for the variant-only public surface."""

from __future__ import annotations

import io
import sys
from dataclasses import dataclass, field
from typing import Any

from returns.result import Result, Success

from larva import cli_entrypoint
from larva.app.facade import DefaultLarvaFacade
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell import cli
from larva.shell.cli import EXIT_CRITICAL, EXIT_OK, list_command, run_cli, validate_command
from tests.shell.fixture_taxonomy import canonical_persona_spec


def _canonical_spec(persona_id: str) -> PersonaSpec:
    return canonical_persona_spec(persona_id=persona_id)


@dataclass
class SpyValidateModule:
    report: ValidationReport = field(
        default_factory=lambda: {"valid": True, "errors": [], "warnings": []}
    )

    def validate_spec(
        self,
        spec: PersonaSpec,
        registry_persona_ids: frozenset[str] | None = None,
    ) -> ValidationReport:
        return self.report


@dataclass
class InMemoryRegistryStore:
    list_result: Result[list[PersonaSpec], Any] = field(default_factory=lambda: Success([]))

    def list(self) -> Result[list[PersonaSpec], Any]:
        return self.list_result

    def get(self, persona_id: str) -> Result[PersonaSpec, Any]:
        return Success(_canonical_spec(persona_id))

    def save(self, spec: PersonaSpec, variant: str | None = None) -> Result[None, Any]:
        return Success(None)


def _make_facade() -> DefaultLarvaFacade:
    return DefaultLarvaFacade(
        spec=spec_module,
        validate=SpyValidateModule(),
        normalize=normalize_module,
        registry=InMemoryRegistryStore(),
    )


def test_cli_entrypoint_delegates_to_shell_cli_main(monkeypatch) -> None:
    facade = object()
    calls: list[tuple[list[str], object]] = []

    def fake_build_default_facade() -> object:
        return facade

    def fake_run_cli(argv: list[str], *, facade: object, stdout: object, stderr: object) -> int:
        calls.append((argv, facade))
        assert stdout is sys.stdout
        assert stderr is sys.stderr
        return 23

    monkeypatch.setattr(cli_entrypoint, "build_default_facade", fake_build_default_facade)
    monkeypatch.setattr("larva.shell.cli.run_cli", fake_run_cli)

    assert cli_entrypoint.main(["list"]) == 23
    assert calls == [(["list"], facade)]


def test_validate_command_still_delegates_to_facade() -> None:
    facade = _make_facade()

    result = validate_command(_canonical_spec("valid-spec"), as_json=True, facade=facade)

    assert result.unwrap()["exit_code"] == EXIT_OK
    assert result.unwrap()["json"]["data"]["valid"] is True


def test_list_command_still_delegates_to_facade() -> None:
    facade = _make_facade()

    result = list_command(as_json=True, facade=facade)

    assert result.unwrap()["exit_code"] == EXIT_OK
    assert result.unwrap()["json"]["data"] == []


def test_removed_assemble_and_component_commands_are_not_cli_subcommands() -> None:
    facade = _make_facade()

    for argv in (["assemble", "--id", "x"], ["component", "list"]):
        stdout = io.StringIO()
        stderr = io.StringIO()
        exit_code = run_cli(argv, facade=facade, stdout=stdout, stderr=stderr)

        assert exit_code == EXIT_CRITICAL
        assert "Argument parsing failed" in stderr.getvalue()


def test_shell_cli_exports_no_removed_command_handlers() -> None:
    assert not hasattr(cli, "assemble_command")
    assert not hasattr(cli, "component_list_command")
    assert not hasattr(cli, "component_show_command")
