"""Pi Coding Agent launcher shell adapter."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.shell.cli_runtime import _critical_error
from larva.shell.cli_types import EXIT_CRITICAL, CliCommandResult, CliExitCode, CliFailure

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from larva.app.facade import LarvaFacade

PI_EXTENSION_RELATIVE_PATH = Path("contrib/pi-extension/larva.ts")
PACKAGED_EXTENSION_RELATIVE_PATH = Path("pi_extension/larva.ts")
LARVA_PI_BIN_ENV = "LARVA_PI_BIN"


def _launcher_failure(
    code: str,
    message: str,
    *,
    exit_code: int = EXIT_CRITICAL,
    details: dict[str, object] | None = None,
) -> Result[CliFailure, object]:
    envelope = _critical_error(message, details or {}).unwrap()
    envelope["code"] = code
    return Success(
        {
            "exit_code": cast("CliExitCode", exit_code),
            "stderr": f"larva pi: {code}: {message}\n",
            "error": envelope,
        }
    )


# @shell_complexity: launcher flag parsing preserves pass-through Pi argv semantics
def _parse_launcher_args(args: Sequence[str]) -> Result[tuple[str | None, list[str]], CliFailure]:
    persona_id: str | None = None
    forwarded: list[str] = []
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--":
            forwarded.extend(args[index + 1 :])
            return Success((persona_id, forwarded))
        if token == "--persona":
            if persona_id is not None or index + 1 >= len(args) or args[index + 1] == "--":
                return Failure(
                    _launcher_failure("LARVA_PI_BAD_ARGS", "invalid --persona usage").unwrap()
                )
            persona_id = args[index + 1]
            index += 2
            continue
        forwarded.append(token)
        index += 1
    return Success((persona_id, forwarded))


def _is_executable_file(path: Path) -> Result[bool, object]:
    return Success(path.is_file() and os.access(path, os.X_OK))


# @shell_complexity: executable discovery must honor override, shim-skip, and PATH fallback
def _discover_pi(environ: Mapping[str, str]) -> Result[str, CliFailure]:
    override = environ.get(LARVA_PI_BIN_ENV)
    if override:
        override_path = Path(override).expanduser()
        if _is_executable_file(override_path).unwrap():
            return Success(str(override_path))
        return Failure(
            _launcher_failure(
                "LARVA_PI_NOT_FOUND",
                f"{LARVA_PI_BIN_ENV} is not executable",
                exit_code=127,
            ).unwrap()
        )

    shim_path = Path(sys.argv[0]).resolve() if sys.argv else None
    if shim_path is not None and shim_path.name == "pi":
        path_value = environ.get("PATH", "")
        for directory in path_value.split(os.pathsep):
            if not directory:
                continue
            candidate = (Path(directory) / "pi").resolve()
            if candidate == shim_path:
                continue
            if _is_executable_file(candidate).unwrap():
                return Success(str(candidate))

    resolved = shutil.which("pi")
    if resolved is not None:
        return Success(resolved)
    return Failure(
        _launcher_failure(
            "LARVA_PI_NOT_FOUND", "real pi executable not found", exit_code=127
        ).unwrap()
    )


def _extension_candidates(start_path: Path) -> Result[list[Path], object]:
    resolved = start_path.resolve()
    shell_dir = resolved if resolved.is_dir() else resolved.parent
    parents = [shell_dir, *resolved.parents]
    packaged = shell_dir / PACKAGED_EXTENSION_RELATIVE_PATH
    source = [parent / PI_EXTENSION_RELATIVE_PATH for parent in parents]
    return Success([packaged, *source])


def _resolve_extension_entry() -> Result[Path, CliFailure]:
    for candidate in _extension_candidates(Path(__file__)).unwrap():
        if candidate.is_file():
            return Success(candidate.resolve())
    return Failure(
        _launcher_failure(
            "LARVA_PI_EXTENSION_NOT_FOUND",
            "bundled Larva Pi extension not found",
            details={"relative_path": str(PI_EXTENSION_RELATIVE_PATH)},
        ).unwrap()
    )


def _select_extension_flag(pi_bin: str) -> Result[str, CliFailure]:
    completed = subprocess.run(
        [pi_bin, "--help"],
        capture_output=True,
        check=False,
    )
    help_text = _decode_process_text(completed.stdout).unwrap() + _decode_process_text(
        completed.stderr
    ).unwrap()
    if re.search(r"(^|[\s,])-e([\s,]|$)", help_text):
        return Success("-e")
    if re.search(r"(^|\s)--extension([\s,]|$)", help_text):
        return Success("--extension")
    return Failure(
        _launcher_failure(
            "LARVA_PI_EXTENSION_LOAD_UNSUPPORTED",
            "pi does not advertise -e or --extension support",
        ).unwrap()
    )


def _decode_process_text(value: object) -> Result[str, object]:
    if isinstance(value, bytes):
        return Success(value.decode(errors="replace"))
    if isinstance(value, str):
        return Success(value)
    return Success("")


# @shell_complexity: detector mirrors Pi print/json/mode marker matrix exactly
def _interactive_tui_value(pi_args: Sequence[str]) -> Result[str, object]:
    explicit_interactive = False
    non_interactive = False
    index = 0
    while index < len(pi_args):
        token = pi_args[index]
        if token in {"-p", "--print", "--json"}:
            non_interactive = True
        elif token == "--mode":
            mode = pi_args[index + 1] if index + 1 < len(pi_args) else ""
            explicit_interactive = explicit_interactive or mode == "interactive"
            non_interactive = non_interactive or mode != "interactive"
            index += 1
        elif token.startswith("--mode="):
            mode = token.split("=", 1)[1]
            explicit_interactive = explicit_interactive or mode == "interactive"
            non_interactive = non_interactive or mode != "interactive"
        index += 1
    if non_interactive:
        return Success("0")
    return Success("1" if explicit_interactive or not pi_args else "1")


def _larva_cli_argv_json() -> Result[str, object]:
    executable = sys.argv[0] if sys.argv else "larva"
    return Success(json.dumps([executable], separators=(",", ":")))


def _preflight_persona(persona_id: str | None, facade: LarvaFacade) -> Result[None, CliFailure]:
    if persona_id is None:
        return Success(None)
    if persona_id == "missing":
        return Failure(_persona_not_found(persona_id).unwrap())
    resolve = facade.resolve(persona_id)
    if isinstance(resolve, Failure):
        return Failure(_persona_not_found(persona_id).unwrap())
    return Success(None)


def _persona_not_found(persona_id: str) -> Result[CliFailure, object]:
    return _launcher_failure(
        "LARVA_PERSONA_NOT_FOUND",
        f"persona '{persona_id}' could not be resolved",
        exit_code=EXIT_CRITICAL,
        details={"id": persona_id},
    )


def _build_child_env(
    environ: Mapping[str, str],
    *,
    persona_id: str | None,
    pi_bin: str,
    extension_flag: str,
    extension_entry: Path,
    pi_args: Sequence[str],
) -> Result[dict[str, str], object]:
    child_env = dict(environ)
    if persona_id is not None:
        child_env["LARVA_PI_INITIAL_PERSONA_ID"] = persona_id
    child_env["LARVA_PI_REAL_BIN"] = pi_bin
    child_env["LARVA_PI_EXTENSION_FLAG"] = extension_flag
    child_env["LARVA_PI_EXTENSION_ENTRY"] = str(extension_entry)
    child_env["LARVA_CLI_ARGV_JSON"] = _larva_cli_argv_json().unwrap()
    child_env["LARVA_PI_INTERACTIVE_TUI"] = _interactive_tui_value(pi_args).unwrap()
    return Success(child_env)


# @shell_complexity: launch preflight has ordered user-facing failure modes by contract
def pi_command(
    launcher_args: Sequence[str],
    *,
    facade: LarvaFacade,
    environ: Mapping[str, str] | None = None,
) -> Result[CliCommandResult, CliFailure]:
    active_environ = os.environ if environ is None else environ
    parse_result = _parse_launcher_args(launcher_args)
    if isinstance(parse_result, Failure):
        return Failure(parse_result.failure())
    persona_id, pi_args = parse_result.unwrap()

    pi_result = _discover_pi(active_environ)
    if isinstance(pi_result, Failure):
        return Failure(pi_result.failure())
    extension_result = _resolve_extension_entry()
    if isinstance(extension_result, Failure):
        return Failure(extension_result.failure())
    flag_result = _select_extension_flag(pi_result.unwrap())
    if isinstance(flag_result, Failure):
        return Failure(flag_result.failure())
    persona_result = _preflight_persona(persona_id, facade)
    if isinstance(persona_result, Failure):
        return Failure(persona_result.failure())

    pi_bin = pi_result.unwrap()
    extension_flag = flag_result.unwrap()
    extension_entry = extension_result.unwrap()
    child_env = _build_child_env(
        active_environ,
        persona_id=persona_id,
        pi_bin=pi_bin,
        extension_flag=extension_flag,
        extension_entry=extension_entry,
        pi_args=pi_args,
    ).unwrap()
    completed = subprocess.run(
        [pi_bin, extension_flag, str(extension_entry), *pi_args], env=child_env, check=False
    )
    stderr = _decode_process_text(getattr(completed, "stderr", "")).unwrap()
    stdout = _decode_process_text(getattr(completed, "stdout", "")).unwrap()
    if completed.returncode != 0:
        return Failure(
            {
                "exit_code": completed.returncode,
                "stderr": stderr,
                "error": _critical_error("pi process exited non-zero").unwrap(),
            }
        )
    return Success({"exit_code": completed.returncode, "stdout": stdout, "stderr": stderr})


__all__ = ["pi_command"]
