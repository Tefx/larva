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
        pytest.skip("node is required for idle callback identity tests")
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
    assert "FAIL" not in completed.stdout
    assert "PASS openai-completions wraps the leading system string once" in completed.stdout
    assert "PASS known APIs insert an instruction slot when the container admits one" in completed.stdout
    assert "PASS continuation block is kept once and not duplicated" in completed.stdout
    assert "PASS whole-string fixed point preserves unicode whitespace and repetitions" in completed.stdout
    assert "PASS actual Pi EventBus replies once synchronously for larva:resolve-system-prompt:v1" in completed.stdout


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
    if completed.returncode == 2 and "PI_0_85_UNAVAILABLE" in completed.stderr:
        assert "PASS" not in completed.stdout
        pytest.skip(completed.stderr.strip())
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "FAIL" not in completed.stdout
    assert "PASS idle custom callback identity on three real-read hops and admitted empty-system repair" in completed.stdout


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
    assert "FAIL" not in completed.stdout
    assert "PASS ready none cleans stale managed text and keeps pure base" in completed.stdout
    assert "PASS A-B-A restore deletes B blocks and equals current A composition" in completed.stdout
    assert "PASS pending ended and manually cleared continuation stay out of composition" in completed.stdout
    assert "PASS true post-resolution state change still projects" in completed.stdout
    assert "PASS synchronous invalid reply-throw and nested queries isolate one attempt each" in completed.stdout
    assert "PASS resolver reads do not mutate lease continuation counters or queues" in completed.stdout
    assert "PASS incomplete initialization replies unavailable then current state after commit" in completed.stdout
    assert "PASS shutdown unsubscribes before async cleanup and late init cannot revive" in completed.stdout
    assert "PASS idempotent setup keeps a single listener" in completed.stdout
    assert "PASS crossed identity and persona markers fail without swallowing foreign text" in completed.stdout
    assert "PASS no-persona known slot without stale content stays unchanged and does not insert empty slots" in completed.stdout
