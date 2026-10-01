"""Behavioral policy/declaration regressions using the existing Node harness.

Former implementation-token assertions could pass from comments alone. These
checks execute policy, live exposure and transaction failures; native dispatch
and MCP transport coverage lives in test_pi_extension_real_runtime.py.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("case", ["all"])
def test_tool_policy_live_declarations_and_rollback(case: str) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi tool-policy behavior checks")
    result = subprocess.run(
        [node, "--import", "./scripts/pi-test-child-loader.mjs",
         "contrib/pi-extension/test-tool-policy-paths.mjs", "--case", case],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
