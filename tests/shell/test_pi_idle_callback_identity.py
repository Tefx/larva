"""Idle triggerTurn identity projection: runtime slots and real Pi 0.85 seam."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Final

import pytest

ROOT: Final = Path(__file__).resolve().parents[2]
RUNTIME: Final = ROOT / "contrib" / "pi-extension" / "test-idle-callback-identity-runtime.mjs"
REAL_PI: Final = ROOT / "contrib" / "pi-extension" / "test-idle-callback-identity-real-pi-0-85-1.mjs"
RESOLVER_RUNTIME: Final = ROOT / "contrib" / "pi-extension" / "test-system-prompt-resolver-runtime.mjs"


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node is required for idle callback identity tests")
    return node


def _env() -> dict[str, str]:
    env = dict(os.environ)
    if "LARVA_TEST_PI_CODING_AGENT" not in env:
        pkg = ROOT / "contrib" / "pi-extension" / "node_modules" / "@earendil-works" / "pi-coding-agent"
        if pkg.exists():
            env["LARVA_TEST_PI_CODING_AGENT"] = str(pkg)
    return env


def test_idle_callback_identity_runtime_projection() -> None:
    completed = subprocess.run(
        [_node(), str(RUNTIME)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30.0,
        env=_env(),
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_idle_callback_identity_real_pi_tool_continuation() -> None:
    completed = subprocess.run(
        [_node(), str(REAL_PI)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=90.0,
        env=_env(),
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_system_prompt_resolver_runtime() -> None:
    completed = subprocess.run(
        [_node(), str(RESOLVER_RUNTIME)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30.0,
        env=_env(),
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
