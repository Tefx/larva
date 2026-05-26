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

def test_launcher_path_discovery_skips_larva_shim(tmp_path, mock_subprocess_run, monkeypatch):
    """
    Verification target 4 (B1):
    PATH discovery skips Larva's own shim path and uses the first valid real `pi`
    when `LARVA_PI_BIN` is not overriding.
    """
    shim_dir = tmp_path / "shim"
    shim_dir.mkdir()
    shim_bin = shim_dir / "pi"
    shim_bin.write_text("#!/bin/sh\nexit 0\n")
    shim_bin.chmod(0o755)
    
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    real_bin = real_dir / "pi"
    real_bin.write_text("#!/bin/sh\nexit 0\n")
    real_bin.chmod(0o755)
    
    monkeypatch.setattr(sys, "argv", [str(shim_bin), "--version"])
    monkeypatch.setenv("PATH", f"{shim_dir}:{real_dir}")
    monkeypatch.delenv("LARVA_PI_BIN", raising=False)
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    
    call_args = mock_subprocess_run.call_args[0]
    assert call_args[0][0] == str(real_bin)

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

def test_launcher_extension_unsupported_path(mock_shutil_which, mock_subprocess_run, tmp_path, monkeypatch):
    """
    Verification target 5 (B2):
    Extension loading preflight prefers `-e` when supported, otherwise uses
    `--extension` when supported. If neither flag is supported, it exits before
    Pi starts with `LARVA_PI_EXTENSION_LOAD_UNSUPPORTED` and does not write Pi settings.
    """
    # mock pi to support neither -e nor --extension
    mock_subprocess_run.return_value.stdout = b"Options:\n  --version  Show version"
    
    settings_dir = tmp_path / ".pi" / "settings"
    settings_dir.mkdir(parents=True)
    monkeypatch.setenv("PI_SETTINGS_DIR", str(settings_dir))
    
    original_write_text = Path.write_text
    writes = []
    def spy_write_text(self, *args, **kwargs):
        writes.append(self)
        return original_write_text(self, *args, **kwargs)
    monkeypatch.setattr(Path, "write_text", spy_write_text)
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code != 0
    assert "LARVA_PI_EXTENSION_LOAD_UNSUPPORTED" in stderr.getvalue()
    
    pi_writes = [p for p in writes if ".pi" in str(p)]
    assert not pi_writes, f"Expected no Pi settings writes, got {pi_writes}"
    # we verify no settings are written via mock asserts in more comprehensive tests

@pytest.mark.parametrize("args, expected_tui", [
    (["pi", "--persona", "known"], "1"),
    (["pi", "--persona", "known", "--", "-p"], "0"),
    (["pi", "--persona", "known", "--", "--print"], "0"),
    (["pi", "--persona", "known", "--", "--json"], "0"),
    (["pi", "--persona", "known", "--", "--mode", "rpc"], "0"),
    (["pi", "--persona", "known", "--", "--mode", "print"], "0"),
    (["pi", "--persona", "known", "--", "--mode", "json"], "0"),
    (["pi", "--persona", "known", "--", "--mode", "sdk"], "0"),
    (["pi", "--persona", "known", "--", "--mode"], "0"),
    (["pi", "--persona", "known", "--", "--mode", "unknown"], "0"),
    (["pi", "--persona", "known", "--", "--mode", "rpc", "--print"], "0"),
])
def test_launcher_interactive_tui_classification(mock_shutil_which, mock_subprocess_run, fake_pi_executable, args, expected_tui):
    """
    Verification target 10 (B3):
    Launcher mode detection matrix sets `LARVA_PI_INTERACTIVE_TUI=0` for exact `-p`,
    exact `--print`, exact `--json`, `--mode rpc|print|json|sdk`, missing/empty
    or unknown `--mode`, and conflicting mode/print markers; it sets `1` when no
    recognized non-interactive marker is present.
    """
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(args, facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    env = mock_subprocess_run.call_args[1].get("env", os.environ)
    assert env.get("LARVA_PI_INTERACTIVE_TUI") == expected_tui

def test_bridge_uses_larva_cli_argv_json(mock_shutil_which, mock_subprocess_run, monkeypatch):
    """
    Verification target 37 (B4):
    Persona resolution bridge uses `LARVA_CLI_ARGV_JSON` plus `resolve <id> --json`
    and inherits launcher registry environment.
    OWNERSHIP NOTE: Bridge suffix/fallback/list failure semantics are explicitly
    owned by the extension runtime implementation (see test_pi_extension_contract.py).
    """
    import io
    import json
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    monkeypatch.setattr(sys, "argv", ["larva", "pi", "--persona", "known"])
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    env = mock_subprocess_run.call_args[1].get("env", os.environ)
    assert "LARVA_CLI_ARGV_JSON" in env
    
    argv_prefix = json.loads(env["LARVA_CLI_ARGV_JSON"])
    assert isinstance(argv_prefix, list)
    assert len(argv_prefix) >= 1

def test_bridge_list_uses_larva_cli_argv_json(mock_shutil_which, mock_subprocess_run, monkeypatch):
    """
    Verification target 38 (B4):
    Persona list bridge uses `LARVA_CLI_ARGV_JSON` plus `list --json`
    OWNERSHIP NOTE: Bridge suffix/fallback/list failure semantics are explicitly
    owned by the extension runtime implementation (see test_pi_extension_contract.py).
    """
    import io
    import json
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    monkeypatch.setattr(sys, "argv", ["larva", "pi", "--persona", "known"])
    code = run_cli(["pi", "--persona", "known"], facade=_make_facade(), stdout=stdout, stderr=stderr)
    assert code == 0
    env = mock_subprocess_run.call_args[1].get("env", os.environ)
    assert "LARVA_CLI_ARGV_JSON" in env
    
    argv_prefix = json.loads(env["LARVA_CLI_ARGV_JSON"])
    assert isinstance(argv_prefix, list)
    assert len(argv_prefix) >= 1

def test_launcher_propagates_extension_fatal_startup_errors(mock_shutil_which, mock_subprocess_run):
    """
    Verification target 39 (B5):
    Launcher preserves stderr from the Pi process, including extension-detected
    fatal startup errors that use the `larva pi: <ERROR_CODE>: <message>` shape.
    OWNERSHIP NOTE: The parent-child pre-RPC whitelist mapping logic is distinctly
    owned by the extension runtime implementation (see test_child_stderr_startup_error_whitelist).
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
