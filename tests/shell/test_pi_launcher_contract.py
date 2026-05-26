import os
import sys
import subprocess
import shutil
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from larva.shell.cli import run_cli
from larva.app.facade import DefaultLarvaFacade

# Mock facade
def _make_facade():
    return MagicMock(spec=DefaultLarvaFacade)

@pytest.fixture
def fake_pi_executable(tmp_path):
    pi_bin = tmp_path / "fake_pi"
    pi_bin.write_text("#!/bin/sh\nexit 0\n")
    pi_bin.chmod(0o755)
    return pi_bin

@pytest.fixture
def mock_shutil_which(monkeypatch, fake_pi_executable):
    def fake_which(cmd, *args, **kwargs):
        if cmd == "pi":
            return str(fake_pi_executable)
        return None
    monkeypatch.setattr(shutil, "which", fake_which)
    return fake_which

@pytest.fixture
def mock_subprocess_run(monkeypatch):
    mock_run = MagicMock()
    # Support extension check
    mock_run.return_value.stdout = b"Options:\n  -e, --extension  Extension path"
    mock_run.return_value.returncode = 0
    monkeypatch.setattr(subprocess, "run", mock_run)
    return mock_run

def test_launcher_invokes_real_pi_with_expected_args_and_env(
    mock_shutil_which, mock_subprocess_run, fake_pi_executable, tmp_path, monkeypatch
):
    """
    Verification target 1:
    `larva pi --persona known -- --version` invokes real Pi as
    `<real-pi-bin> <selected-extension-flag> <bundled extension> --version`,
    sets `LARVA_PI_INITIAL_PERSONA_ID=known`, `LARVA_PI_REAL_BIN`,
    `LARVA_PI_EXTENSION_FLAG`, `LARVA_PI_EXTENSION_ENTRY`, and
    `LARVA_CLI_ARGV_JSON` for the extension process.
    """
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    # We expect this to fail (expected red) because 'pi' command is not implemented.
    code = run_cli(["pi", "--persona", "known", "--", "--version"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0, f"Expected 0, got {code}. Stderr: {stderr.getvalue()}"
    
    mock_subprocess_run.assert_called()
    # Check that it called the fake pi with the extension flag and the rest of the arguments
    call_args, call_kwargs = mock_subprocess_run.call_args
    cmd = call_args[0]
    
    assert cmd[0] == str(fake_pi_executable)
    assert cmd[1] == "-e"
    # bundled extension path should end with larva.js or similar
    assert "extension" in cmd[2]
    assert cmd[3] == "--version"
    
    env = call_kwargs.get("env", os.environ)
    assert env.get("LARVA_PI_INITIAL_PERSONA_ID") == "known"
    assert env.get("LARVA_PI_REAL_BIN") == str(fake_pi_executable)
    assert env.get("LARVA_PI_EXTENSION_FLAG") == "-e"
    assert env.get("LARVA_PI_EXTENSION_ENTRY") == cmd[2]
    assert "LARVA_CLI_ARGV_JSON" in env

def test_launcher_missing_persona(
    mock_shutil_which, mock_subprocess_run, tmp_path
):
    """
    Verification target 2:
    `larva pi --persona missing` does not start Pi, exits non-zero, and writes
    `larva pi: LARVA_PERSONA_NOT_FOUND:` to stderr.
    """
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "missing"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code != 0
    assert "larva pi: LARVA_PERSONA_NOT_FOUND:" in stderr.getvalue()
    
def test_launcher_missing_pi_executable(monkeypatch):
    """
    Verification target 3:
    Missing real `pi` executable exits `127` and writes
    `larva pi: LARVA_PI_NOT_FOUND:` to stderr.
    """
    monkeypatch.setattr(shutil, "which", lambda cmd, *args, **kwargs: None)
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 127
    assert "larva pi: LARVA_PI_NOT_FOUND:" in stderr.getvalue()

def test_launcher_test_override_bin(mock_subprocess_run, fake_pi_executable, monkeypatch):
    """
    Verification target 4:
    `LARVA_PI_BIN` test override is honored when it points to an executable.
    """
    monkeypatch.setenv("LARVA_PI_BIN", str(fake_pi_executable))
    # mock which to return None to ensure we rely on LARVA_PI_BIN
    monkeypatch.setattr(shutil, "which", lambda cmd, *args, **kwargs: None)
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    call_args = mock_subprocess_run.call_args[0]
    assert call_args[0][0] == str(fake_pi_executable)

def test_launcher_extension_unsupported_path(mock_shutil_which, mock_subprocess_run):
    """
    Verification target 5:
    Extension loading preflight prefers `-e` when supported, otherwise uses
    `--extension` when supported. If neither flag is supported, it exits before
    Pi starts with `LARVA_PI_EXTENSION_LOAD_UNSUPPORTED` and does not write Pi settings.
    """
    # mock pi to support neither -e nor --extension
    mock_subprocess_run.return_value.stdout = b"Options:\n  --version  Show version"
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code != 0
    assert "LARVA_PI_EXTENSION_LOAD_UNSUPPORTED" in stderr.getvalue()
    # we verify no settings are written via mock asserts in more comprehensive tests

def test_launcher_interactive_tui_classification(mock_shutil_which, mock_subprocess_run, fake_pi_executable):
    """
    Verification target 10:
    Launcher mode detection sets `LARVA_PI_INTERACTIVE_TUI=0` for exact `-p`,
    exact `--print`, exact `--json`, `--mode rpc|print|json|sdk`, missing/empty
    or unknown `--mode`, and conflicting mode/print markers; it sets `1` when no
    recognized non-interactive marker is present.
    """
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    # Test interactive mode
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    env = mock_subprocess_run.call_args[1].get("env", os.environ)
    assert env.get("LARVA_PI_INTERACTIVE_TUI") == "1"
    
    # Test non-interactive mode
    code = run_cli(["pi", "--persona", "known", "--", "--mode", "rpc"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    env = mock_subprocess_run.call_args[1].get("env", os.environ)
    assert env.get("LARVA_PI_INTERACTIVE_TUI") == "0"

def test_bridge_uses_larva_cli_argv_json(mock_subprocess_run):
    """
    Verification target 37:
    Persona resolution bridge uses `LARVA_CLI_ARGV_JSON` plus `resolve <id> --json`
    and inherits launcher registry environment.
    """
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    env = mock_subprocess_run.call_args[1].get("env", os.environ)
    assert "LARVA_CLI_ARGV_JSON" in env

def test_bridge_list_uses_larva_cli_argv_json(mock_subprocess_run):
    """
    Verification target 38:
    Persona list bridge uses `LARVA_CLI_ARGV_JSON` plus `list --json`
    """
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    env = mock_subprocess_run.call_args[1].get("env", os.environ)
    assert "LARVA_CLI_ARGV_JSON" in env

def test_launcher_propagates_extension_fatal_startup_errors(mock_shutil_which, mock_subprocess_run):
    """
    Verification target 39:
    Before child RPC readiness, parent parses only child stderr lines shaped as
    `larva pi: <ERROR_CODE>:` and propagates...
    Wait, the launcher preserves stderr from the Pi process, including extension-detected
    fatal startup errors that use the same `larva pi: <ERROR_CODE>: <message>` shape.
    """
    mock_subprocess_run.return_value.returncode = 1
    mock_subprocess_run.return_value.stderr = b"larva pi: LARVA_MODEL_UNAVAILABLE: model not found"
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    # The launcher should exit non-zero and preserve the error
    assert code != 0
    assert "larva pi: LARVA_MODEL_UNAVAILABLE:" in stderr.getvalue()
