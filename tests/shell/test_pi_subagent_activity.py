"""Run the behavioral activity assertions and native registration/lifecycle proof.

Assertions live in the Node entrypoints; successful process exit means those
assertions executed. Native proof uses a real held child and 120-second watchdog.
"""

from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    "entrypoint",
    [
        "contrib/pi-extension/test-subagent-activity-runtime.mjs",
        "scripts/pi-subagent-activity-native.mjs",
    ],
)
def test_activity_behavior(entrypoint: str) -> None:
    """Exercise real behavior rather than source tokens or printed PASS text."""
    node = shutil.which("node")
    assert node is not None, "Node is required for activity acceptance"
    completed = subprocess.run(
        [node, str(ROOT / entrypoint)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
