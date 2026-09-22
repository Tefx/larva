"""Structural CI contracts; native execution is proved by the selected runtime tests.

The retired external-authority gate's field/typing/malformed/drift checks now
live in tests/core/test_schema_validation.py. This file checks the workflow that
runs those tests, without external checkouts, credentials or global installs.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import json
import os
import shlex
import subprocess

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
SCHEMA_TESTS = {
    "tests/core/test_schema_validation.py",
    "tests/core/test_validate.py",
    "tests/canonical_cutover/test_hard_cutover_readiness.py",
}
NATIVE_TESTS = {
    "tests/shell/test_pi_extension_real_runtime.py",
    "tests/shell/test_pi_extension_contract.py",
    "tests/shell/test_pi_extension_subagent_ux.py",
    "tests/shell/test_pi_extension_subagent_model_isolation.py",
    "tests/shell/test_pi_agent_persona_switch_policy_contract.py",
    "tests/shell/test_pi_idle_callback_identity.py",
    "tests/shell/test_pi_subagent_activity.py",
    "tests/shell/test_pi_launcher_contract.py",
    "tests/shell/test_pi_model_map_draft_contract.py",
    "tests/shell/test_repo_local_ci_gate.py",
}
PYTHON_SETUP = "uv sync --locked --python 3.12 --group dev"
NODE_SETUP = "npm --prefix contrib/pi-extension ci"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())


def _commands(step: dict) -> list[str]:
    return step.get("run", "").replace("\\\n", " ").splitlines()


def _assert_ci_contract(workflow: dict) -> None:
    jobs = workflow["jobs"]
    assert set(jobs) == {"local-schema", "pi-native-runtime"}
    assert jobs["pi-native-runtime"]["needs"] == "local-schema"
    assert jobs["pi-native-runtime"]["defaults"]["run"]["shell"] == "bash"
    selected = {}
    for job_id, job in jobs.items():
        assert not job.get("continue-on-error", False)
        assert "if" not in job
        steps = job["steps"]
        assert steps[0]["uses"] == "actions/checkout@v4"
        assert sum(step.get("uses") == "actions/checkout@v4" for step in steps) == 1
        python_action = next(i for i, s in enumerate(steps) if s.get("uses") == "actions/setup-python@v5")
        uv_action = next(i for i, s in enumerate(steps) if s.get("uses") == "astral-sh/setup-uv@v4")
        python_install = next(i for i, s in enumerate(steps) if PYTHON_SETUP in _commands(s))
        assert max(python_action, uv_action) < python_install
        if job_id == "pi-native-runtime":
            node_action = next(i for i, s in enumerate(steps) if s.get("uses") == "actions/setup-node@v4")
            node_install = next(i for i, s in enumerate(steps) if NODE_SETUP in _commands(s))
            assert node_action < node_install
        selected[job_id] = set()
        for index, step in enumerate(steps):
            assert not step.get("continue-on-error", False)
            assert "if" not in step
            assert step.get("shell", "bash") == "bash"
            if step.get("uses") == "actions/checkout@v4":
                assert not {"repository", "token", "ref", "path"} & set(step.get("with", {}))
            for command in _commands(step):
                tokens = shlex.split(command)
                assert "sudo" not in tokens
                assert not {"--global", "-g"} & set(tokens)
                assert "||" not in command and "set +e" not in command
                if "pytest" in tokens:
                    assert python_install < index
                    assert {"--locked", "--python", "--group"} <= set(tokens)
                    assert not {"-k", "--deselect", "--ignore"} & set(tokens)
                    files = {token for token in tokens if token.startswith("tests/")}
                    assert files and all((ROOT / name).is_file() for name in files)
                    selected[job_id].update(files)
                    if job_id == "pi-native-runtime":
                        assert node_install < index
                if "node" in tokens or "for f in contrib/pi-extension/test-*.mjs" in command:
                    assert job_id == "pi-native-runtime" and node_install < index
        # No credentials or retired upstream inputs can be hidden in env/expressions.
        text = yaml.safe_dump(job).lower()
        assert "secrets." not in text and "opifex" not in text
    assert selected["local-schema"] == SCHEMA_TESTS
    assert NATIVE_TESTS <= selected["pi-native-runtime"]
    native_commands = "\n".join(
        command for step in jobs["pi-native-runtime"]["steps"] for command in _commands(step)
    )
    assert 'for f in contrib/pi-extension/test-*.mjs; do node "$f"; done' in native_commands
    assert "node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates" in native_commands
    assert "uvx --python 3.12 invar-tools==1.20.3 guard --all" in native_commands
    env = jobs["pi-native-runtime"]["env"]
    for key, suffix in {
        "PI_BIN": "contrib/pi-extension/node_modules/.bin/pi",
        "LARVA_TEST_PI_CODING_AGENT": "contrib/pi-extension/node_modules/@earendil-works/pi-coding-agent",
    }.items():
        assert env[key] == "${{ github.workspace }}/" + suffix


def test_ci_runs_local_contracts_and_native_inventory_with_locked_setup() -> None:
    _assert_ci_contract(_workflow())


def test_ci_runner_local_launch_executes_declared_package(tmp_path: Path) -> None:
    env_config = _workflow()["jobs"]["pi-native-runtime"]["env"]
    binary = Path(env_config["PI_BIN"].replace("${{ github.workspace }}", str(ROOT)))
    package_root = Path(env_config["LARVA_TEST_PI_CODING_AGENT"].replace("${{ github.workspace }}", str(ROOT)))
    package = json.loads((package_root / "package.json").read_text())
    assert package["name"] == "@earendil-works/pi-coding-agent"
    assert binary.resolve(strict=True) == (package_root / package["bin"]["pi"]).resolve(strict=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith(("PI_", "LARVA_"))}
    env.update(HOME=str(tmp_path), PI_CODING_AGENT_DIR=str(tmp_path / "agent"), PI_OFFLINE="1")
    result = subprocess.run([str(binary), "--version"], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip()  # Observation only; no accepted-version range.


@pytest.mark.parametrize("defect", [
    "missing_schema", "missing_native", "setup_after_use", "soft_failure",
    "conditional_gate", "external_checkout", "global_install", "wrong_launch_path",
    "masked_failure", "missing_dependency_edge", "nonblocking_shell",
])
def test_ci_rejects_dropped_checks_and_external_or_nonblocking_prerequisites(defect: str) -> None:
    workflow = deepcopy(_workflow())
    schema = workflow["jobs"]["local-schema"]
    native = workflow["jobs"]["pi-native-runtime"]
    if defect == "missing_schema":
        schema["steps"][-1]["run"] = "echo schema omitted"
    elif defect == "missing_native":
        for step in native["steps"]:
            if "run" in step:
                step["run"] = step["run"].replace("tests/shell/test_pi_extension_real_runtime.py", "tests/core/test_schema_validation.py")
    elif defect == "setup_after_use":
        install = next(step for step in native["steps"] if NODE_SETUP in step.get("run", ""))
        native["steps"].remove(install)
        native["steps"].append(install)
    elif defect == "soft_failure":
        native["continue-on-error"] = True
    elif defect == "conditional_gate":
        schema["steps"][-1]["if"] = "false"
    elif defect == "external_checkout":
        schema["steps"][0]["with"] = {"repository": "other/authority", "token": "${{ secrets.EXTERNAL }}"}
    elif defect == "global_install":
        native["steps"].append({"run": "npm install --global pi"})
    elif defect == "wrong_launch_path":
        native["env"]["PI_BIN"] = "/global/bin/pi"
    elif defect == "masked_failure":
        schema["steps"][-1]["run"] += " || true"
    elif defect == "missing_dependency_edge":
        native["needs"] = []
    elif defect == "nonblocking_shell":
        native["steps"][-1]["shell"] = "bash {0}"
    with pytest.raises(AssertionError):
        _assert_ci_contract(workflow)
