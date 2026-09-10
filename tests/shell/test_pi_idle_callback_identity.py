"""Idle triggerTurn identity projection: runtime slots and real Pi 0.85 seam."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Final

import pytest

ROOT: Final = Path(__file__).resolve().parents[2]
RUNTIME: Final = ROOT / "contrib" / "pi-extension" / "test-idle-callback-identity-runtime.mjs"
REAL_PI: Final = ROOT / "contrib" / "pi-extension" / "test-idle-callback-identity-real-pi-0-85-1.mjs"


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for idle callback identity tests")
    return node


def test_idle_callback_identity_runtime_projection() -> None:
    completed = subprocess.run(
        [_node(), str(RUNTIME)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30.0,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "FAIL" not in completed.stdout
    assert "PASS openai-completions wraps the leading system string once" in completed.stdout
    assert "PASS known APIs insert an instruction slot when the container admits one" in completed.stdout
    assert "PASS continuation block is kept once and not duplicated" in completed.stdout


def test_idle_callback_identity_real_pi_tool_continuation() -> None:
    completed = subprocess.run(
        [_node(), str(REAL_PI)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=90.0,
    )
    if completed.returncode == 2 and "PI_0_85_UNAVAILABLE" in completed.stderr:
        assert "PASS" not in completed.stdout
        pytest.skip(completed.stderr.strip())
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "FAIL" not in completed.stdout
    assert "PASS idle custom callback identity on three real-read hops and admitted empty-system repair" in completed.stdout
