"""Read-only CLI diagnostics."""

from __future__ import annotations

from typing import TYPE_CHECKING

from returns.result import Failure, Result, Success

from larva.shell.cli_helpers import EXIT_ERROR, EXIT_OK, CliCommandResult, CliFailure

if TYPE_CHECKING:
    from larva.app.facade import LarvaFacade


# @shell_complexity: diagnostic branching mirrors probe outcomes across registry/read checks
def doctor_registry_command(
    *, as_json: bool, facade: LarvaFacade | None = None
) -> Result[CliCommandResult, CliFailure]:
    """Run read-only diagnostics on the registry.

    When facade is provided, performs full canonical admission validation
    (via _normalize_and_validate) to match the same checks that list/serve use.
    Without facade, performs shallow filesystem diagnostics only.
    """
    from larva.shell.registry import FileSystemRegistryStore

    diagnostics: list[str] = []
    issues: list[str] = []
    fs_store = FileSystemRegistryStore()
    list_result = fs_store.list()

    if isinstance(list_result, Failure):
        registry_diagnostic = f"  [FAIL] Cannot read registry variants: {list_result.failure()}"
        issues.append(registry_diagnostic)
        diagnostics.append(registry_diagnostic)
    else:
        specs = list_result.unwrap()
        diagnostics.append(f"  [OK] Registry variant read succeeded ({len(specs)} active specs)")
        for spec in specs[:3]:
            persona_id = str(spec.get("id", ""))
            diagnostics.append(f"  [OK] Spec read succeeded for '{persona_id}'")

            # Facade-backed admission validation: catch the same failures that
            # list/serve would encounter so doctor no longer reports false-OK
            # for registry entries that fail canonical validation.
            if facade is not None:
                normalized_result = facade._normalize_and_validate(spec)
                if isinstance(normalized_result, Failure):
                    error = normalized_result.failure()
                    spec_diagnostic = (
                        f"  [FAIL] Spec validation failed for '{persona_id}': "
                        f"{error.get('code', 'UNKNOWN')}: {error.get('message', 'unknown error')}"
                    )
                    issues.append(spec_diagnostic)
                    diagnostics.append(spec_diagnostic)
                    continue

            forbidden = [fld for fld in ("tools", "side_effect_policy") if fld in spec]
            if forbidden:
                diagnostics.append(
                    f"  [WARN] Spec '{persona_id}' contains forbidden legacy fields: {forbidden}"
                )

    diagnostics.append(f"  [INFO] Registry root: {fs_store.root}")
    diagnostics.append("  [INFO] Registry layout: manifest.json + variants/<variant>.json")

    if issues:
        stdout_lines = ["DIAGNOSTIC FAIL", *diagnostics, ""]
        return Failure(
            {
                "exit_code": EXIT_ERROR,
                "stderr": "\n".join(stdout_lines),
                "error": {
                    "code": "REGISTRY_DIAGNOSTIC_FAILED",
                    "numeric_code": 107,
                    "message": "registry diagnostic found issues",
                    "details": {"issues": issues},
                },
            }
        )

    cli_result: CliCommandResult = {
        "exit_code": EXIT_OK,
        "stdout": "\n".join(["DIAGNOSTIC OK", *diagnostics, ""]) + "\n",
    }
    if as_json:
        cli_result["json"] = {"data": {"status": "ok", "diagnostics": diagnostics}}
    return Success(cli_result)
