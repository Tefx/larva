"""Installed-wheel and removed-launcher boundary tests.

The native Pi package owns Pi startup.  These tests keep the Python distribution
focused on the CLI/API data backend and prove that a built wheel does not carry
a second Pi extension copy or a forwarding ``larva pi`` entry point.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import zipfile
from dataclasses import dataclass
from pathlib import Path
from shutil import which
from typing import Any
from unittest.mock import MagicMock

import pytest

from larva.shell.cli import EXIT_CRITICAL, run_cli
from tests.shell.fixture_taxonomy import canonical_persona_spec

ROOT = Path(__file__).resolve().parents[2]
PI_EXTENSION = ROOT / "contrib" / "pi-extension" / "larva.ts"


@dataclass(frozen=True)
class InstalledWheel:
    """Paths for one isolated, wheel-installed Python runtime."""

    wheel: Path
    python: Path
    larva: Path
    home: Path


def _clean_env(**overrides: str) -> dict[str, str]:
    """Return a subprocess environment without an activated project runtime."""
    env = dict(os.environ)
    for key in ("VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "PYTHONPATH"):
        env.pop(key, None)
    env["UV_PYTHON_DOWNLOADS"] = "never"
    env.update(overrides)
    return env


def _run(
    command: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    timeout: float = 180,
) -> subprocess.CompletedProcess[str]:
    """Run a bounded subprocess and return its captured text streams."""
    process_env = _clean_env()
    process_env.update(env or {})
    return subprocess.run(
        command,
        cwd=cwd,
        env=process_env,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )


def _assert_success(result: subprocess.CompletedProcess[str], command: list[str]) -> None:
    """Raise a useful assertion for a failed build/install/backend command."""
    assert result.returncode == 0, (
        f"command failed ({result.returncode}): {' '.join(command)}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


@pytest.fixture(scope="module")
def installed_wheel(tmp_path_factory: pytest.TempPathFactory) -> InstalledWheel:
    """Build and install the wheel with locked project dependencies only."""
    work = tmp_path_factory.mktemp("wheel-retirement")
    wheel_dir = work / "dist"
    wheel_dir.mkdir()

    build_command = [
        "uv",
        "run",
        "--locked",
        "--python",
        "3.12",
        "--group",
        "dev",
        "python",
        "-m",
        "build",
        "--wheel",
        "--outdir",
        str(wheel_dir),
    ]
    built = _run(build_command, timeout=300)
    _assert_success(built, build_command)
    wheels = sorted(wheel_dir.glob("larva-*.whl"))
    assert len(wheels) == 1, f"expected one wheel, found {[path.name for path in wheels]}"

    with zipfile.ZipFile(wheels[0]) as archive:
        archive_names = set(archive.namelist())
    assert "larva/shell/opencode_plugin/larva.ts" in archive_names
    assert "larva/shell/pi.py" not in archive_names
    assert not any(name.startswith("larva/shell/pi_extension/") for name in archive_names)

    venv = work / "venv"
    venv_command = ["uv", "venv", "--python", "3.12", str(venv)]
    created = _run(venv_command, timeout=120)
    _assert_success(created, venv_command)
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    assert python.is_file(), f"isolated interpreter was not created: {python}"

    # Resolve production dependencies from the repository's locked graph, then
    # install the wheel itself without a second unconstrained dependency solve.
    sync_env = _clean_env(UV_PROJECT_ENVIRONMENT=str(venv))
    sync_command = [
        "uv",
        "sync",
        "--locked",
        "--python",
        "3.12",
        "--no-install-project",
        "--no-dev",
    ]
    synced = _run(sync_command, env=sync_env, timeout=300)
    _assert_success(synced, sync_command)

    install_command = ["uv", "pip", "install", "--python", str(python), "--no-deps", str(wheels[0])]
    installed = _run(install_command, timeout=120)
    _assert_success(installed, install_command)

    home = work / "home"
    home.mkdir()
    larva = venv / ("Scripts/larva.exe" if os.name == "nt" else "bin/larva")
    return InstalledWheel(wheel=wheels[0], python=python, larva=larva, home=home)


@pytest.fixture(scope="module")
def wheel_runtime(
    installed_wheel: InstalledWheel,
    tmp_path_factory: pytest.TempPathFactory,
) -> InstalledWheel:
    """Seed one canonical persona through the installed CLI backend."""
    spec_path = tmp_path_factory.mktemp("wheel-fixture") / "wheel-persona.json"
    spec = canonical_persona_spec("wheel-persona", model="openai/gpt-5.5")
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    env = {"HOME": str(installed_wheel.home)}
    command = [str(installed_wheel.larva), "register", str(spec_path), "--json"]
    registered = _run(command, env=env)
    _assert_success(registered, command)
    assert json.loads(registered.stdout)["data"]["registered"] is True
    return installed_wheel


def test_removed_pi_command_is_rejected_by_actual_parser() -> None:
    """The Python CLI no longer parses or dispatches a ``pi`` command."""
    stdout = io.StringIO()
    stderr = io.StringIO()

    exit_code = run_cli(["pi", "--help"], facade=MagicMock(), stdout=stdout, stderr=stderr)

    assert exit_code == EXIT_CRITICAL
    assert stdout.getvalue() == ""
    assert "Argument parsing failed" in stderr.getvalue()
    assert "invalid choice: 'pi'" in stderr.getvalue()


def test_built_wheel_owns_backend_resources_only(installed_wheel: InstalledWheel) -> None:
    """Wheel contents retain OpenCode data but omit the retired Pi copy."""
    with zipfile.ZipFile(installed_wheel.wheel) as archive:
        names = set(archive.namelist())

    assert "larva/shell/opencode_plugin/larva.ts" in names
    assert "larva/shell/pi.py" not in names
    assert not any(name.startswith("larva/shell/pi_extension/") for name in names)


def test_installed_wheel_cli_retains_list_resolve_and_model_map(
    wheel_runtime: InstalledWheel,
) -> None:
    """A clean wheel install serves the CLI backend and model-map command."""
    env = {"HOME": str(wheel_runtime.home)}

    listed_command = [str(wheel_runtime.larva), "list", "--json"]
    listed = _run(listed_command, env=env)
    _assert_success(listed, listed_command)
    assert [item["id"] for item in json.loads(listed.stdout)["data"]] == ["wheel-persona"]

    resolved_command = [str(wheel_runtime.larva), "resolve", "wheel-persona", "--json"]
    resolved = _run(resolved_command, env=env)
    _assert_success(resolved, resolved_command)
    payload = json.loads(resolved.stdout)["data"]
    assert payload["id"] == "wheel-persona"
    assert payload["model"] == "openai/gpt-5.5"

    model_map_help_command = [str(wheel_runtime.larva), "pi-model-map", "--help"]
    model_map_help = _run(model_map_help_command, env=env)
    _assert_success(model_map_help, model_map_help_command)
    assert "pi-model-map" in model_map_help.stdout

    retired_command = [str(wheel_runtime.larva), "pi", "--help"]
    retired = _run(retired_command, env=env)
    assert retired.returncode == EXIT_CRITICAL
    assert "invalid choice: 'pi'" in retired.stderr


def test_installed_wheel_python_api_resolves_backend_persona(
    wheel_runtime: InstalledWheel,
) -> None:
    """The Python API resolves registry data from the wheel installation."""
    script = (
        "import json, larva.shell.python_api as api; "
        "print(json.dumps({'module': api.__file__, 'spec': api.resolve('wheel-persona')}))"
    )
    command = [str(wheel_runtime.python), "-c", script]
    result = _run(command, env={"HOME": str(wheel_runtime.home)}, cwd=wheel_runtime.home)
    _assert_success(result, command)

    payload = json.loads(result.stdout)
    assert "site-packages" in payload["module"]
    assert payload["spec"]["id"] == "wheel-persona"
    assert payload["spec"]["model"] == "openai/gpt-5.5"


def test_native_extension_reads_the_installed_wheel_backend(
    wheel_runtime: InstalledWheel,
) -> None:
    """Native extension bridge calls use the real wheel-installed CLI binding."""
    node = which("node")
    assert node is not None, "node is required for the native backend bridge proof"
    encoded_binding = json.dumps([str(wheel_runtime.larva)])
    script = f"""
import {{ pathToFileURL }} from "node:url";
const extension = await import(pathToFileURL({json.dumps(str(PI_EXTENSION))}).href);
const env = {{
  HOME: {json.dumps(str(wheel_runtime.home))},
  LARVA_CLI_ARGV_JSON: {json.dumps(encoded_binding)},
}};
const listed = await extension.listPersonas({{ env }});
const resolved = await extension.resolvePersona("wheel-persona", {{ env }});
console.log(JSON.stringify({{ listed, resolved }}));
"""
    command = [node, "--input-type=module", "-e", script]
    result = _run(command, env={"HOME": str(wheel_runtime.home)}, cwd=ROOT, timeout=30)
    _assert_success(result, command)

    payload: dict[str, Any] = json.loads(result.stdout)
    assert [item["id"] for item in payload["listed"]] == ["wheel-persona"]
    assert payload["resolved"]["id"] == "wheel-persona"
    assert payload["resolved"]["model"] == "openai/gpt-5.5"
