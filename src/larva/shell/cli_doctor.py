"""Read-only CLI diagnostics."""

from __future__ import annotations

from returns.result import Failure, Result, Success

from larva.shell.cli_helpers import EXIT_ERROR, EXIT_OK, CliCommandResult, CliFailure


# @shell_complexity: diagnostic branching mirrors probe outcomes across index/read checks
def doctor_registry_command(*, as_json: bool) -> Result[CliCommandResult, CliFailure]:
    """Run read-only diagnostics on the registry."""
    from larva.shell.registry import INDEX_FILENAME, FileSystemRegistryStore

    diagnostics: list[str] = []
    issues: list[str] = []
    fs_store = FileSystemRegistryStore()
    index_result = fs_store._read_index()

    if isinstance(index_result, Failure):
        index_diagnostic = f"  [FAIL] Cannot read registry index: {index_result.failure()}"
        issues.append(index_diagnostic)
        diagnostics.append(index_diagnostic)
    else:
        index = index_result.unwrap()
        diagnostics.append(f"  [OK] Registry index read succeeded ({len(index)} entries)")
        sample_ids = sorted(index.keys())[:3]
        for persona_id in sample_ids:
            spec_result = fs_store._read_spec(persona_id, index.get(persona_id))
            if isinstance(spec_result, Failure):
                spec_diagnostic = (
                    f"  [FAIL] Spec read failed for '{persona_id}': {spec_result.failure()}"
                )
                issues.append(spec_diagnostic)
                diagnostics.append(spec_diagnostic)
                continue
            diagnostics.append(f"  [OK] Spec read succeeded for '{persona_id}'")

        for persona_id in sample_ids:
            spec_result = fs_store._read_spec(persona_id, index.get(persona_id))
            if isinstance(spec_result, Success):
                forbidden = [fld for fld in ("tools", "side_effect_policy") if fld in spec_result.unwrap()]
                if forbidden:
                    diagnostics.append(
                        f"  [WARN] Spec '{persona_id}' contains forbidden legacy fields: {forbidden}"
                    )

    diagnostics.append(f"  [INFO] Registry root: {fs_store.root}")
    diagnostics.append(f"  [INFO] Index path: {fs_store.root / INDEX_FILENAME}")

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
