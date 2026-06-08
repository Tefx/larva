import json
import subprocess
from pathlib import Path

import pytest


def _script_path() -> Path:
    return Path(__file__).parent.parent.parent / "scripts" / "intent_closure_gate.py"


def _run_gate(
    plan: Path,
    step: str,
    worktree: Path,
    base_sha: str,
    out_json: Path,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "python",
            str(_script_path()),
            "--plan",
            str(plan),
            "--step",
            step,
            "--worktree",
            str(worktree),
            "--base",
            base_sha,
            "--out",
            str(out_json),
        ],
        capture_output=True,
        text=True,
    )


@pytest.fixture
def fake_worktree(tmp_path):
    # Initialize a git repo and make a base commit
    subprocess.run(["git", "init"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True)

    (tmp_path / "baseline.txt").write_text("base")
    subprocess.run(["git", "add", "baseline.txt"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, check=True)

    # Store base sha
    base_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=tmp_path, capture_output=True, text=True).stdout.strip()

    # Make a modified workspace
    (tmp_path / "scripts" / "intent_closure_gate.py").parent.mkdir(parents=True)
    (tmp_path / "scripts" / "intent_closure_gate.py").write_text("python")
    subprocess.run(["git", "add", "scripts/intent_closure_gate.py"], cwd=tmp_path, check=True)

    return tmp_path, base_sha


@pytest.fixture
def plan_yaml(tmp_path):
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        description: |
          Some text.
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths:
            - "blocked/**"
          required_claims:
            - sidecar_gate_script_provided
          required_checks:
            - id: passing_check
              command: ["echo", "pass"]
              covers_claims:
                - sidecar_gate_script_provided
          </intent_closure_contract>
""")
    # plan.yaml is uncommitted in fake_worktree tests initially, which is fine,
    # but the script diffs worktree vs base. Let's make sure it doesn't fail on plan.yaml.
    subprocess.run(["git", "add", "plan.yaml"], cwd=tmp_path, check=False)
    return plan


def test_intent_closure_gate_conformant(fake_worktree, plan_yaml, tmp_path):
    worktree, base_sha = fake_worktree
    out_json = tmp_path / "out.json"

    result = _run_gate(plan_yaml, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 0
    assert out_json.exists()

    data = json.loads(out_json.read_text())
    assert data["status"] == "CONFORMANT"
    assert "scripts/intent_closure_gate.py" in data["changed_files"]
    assert len(data["checks"]) == 1
    assert data["checks"][0]["status"] == "PASS"


def test_intent_closure_gate_tainted(fake_worktree, plan_yaml, tmp_path):
    # Modify blocked path
    worktree, base_sha = fake_worktree
    (worktree / "blocked").mkdir(exist_ok=True)
    (worktree / "blocked" / "secret.txt").write_text("secret")
    subprocess.run(["git", "add", "blocked/secret.txt"], cwd=worktree, check=True)

    out_json = tmp_path / "out.json"

    result = _run_gate(plan_yaml, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 1  # TAINTED
    data = json.loads(out_json.read_text())
    assert data["status"] == "TAINTED"
    assert any("Blocked path matched" in r for r in data["reasons"])


def test_intent_closure_gate_rejected(fake_worktree, tmp_path):
    # Check failure
    worktree, base_sha = fake_worktree
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        description: |
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths: []
          required_claims:
            - sidecar_gate_script_provided
          required_checks:
            - id: failing_check
              command: ["ls", "/nonexistent_path_xyz"]
              covers_claims:
                - sidecar_gate_script_provided
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 2  # REJECTED
    data = json.loads(out_json.read_text())
    assert data["status"] == "REJECTED"
    assert data["checks"][0]["status"] == "FAIL"


def test_intent_closure_gate_invalid_coverage(fake_worktree, tmp_path):
    # Missing coverage
    worktree, base_sha = fake_worktree
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        description: |
          <intent_closure_contract>
          allowed_paths: []
          blocked_paths: []
          required_claims:
            - a_claim
          required_checks: []
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 3  # INVALID
    data = json.loads(out_json.read_text())
    assert data["status"] == "INVALID"
    assert any("Missing test coverage for required claims: a_claim" in r for r in data["reasons"])


def test_expected_red_checks_accept_declared_nonzero(fake_worktree, tmp_path):
    worktree, base_sha = fake_worktree
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        step_type: test
        step_intent: test_define_red
        expected_result: red
        description: |
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths: []
          required_claims:
            - expected_red_checks_accept_declared_nonzero
          required_checks:
            - id: expected_red_check
              command: ["python", "-c", "import sys; print('known async gap exposed'); sys.exit(7)"]
              expected_exit_codes: [7]
              expected_output_patterns_all:
                - "known async gap"
                - "exposed"
              covers_claims:
                - expected_red_checks_accept_declared_nonzero
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 0
    data = json.loads(out_json.read_text())
    assert data["status"] == "CONFORMANT"
    assert data["checks"][0]["status"] == "PASS"
    assert data["checks"][0]["exit_code"] == 7
    assert data["checks"][0]["expected_red"] is True


def test_expected_red_checks_reject_unmatched_failures(fake_worktree, tmp_path):
    worktree, base_sha = fake_worktree
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        step_type: test
        step_intent: test_define_red
        expected_result: red
        description: |
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths: []
          required_claims:
            - expected_red_checks_reject_unmatched_failures
          required_checks:
            - id: expected_red_check
              command: ["python", "-c", "import sys; print('different failure'); sys.exit(7)"]
              expected_exit_codes: [7]
              expected_output_patterns_all:
                - "known async gap"
              covers_claims:
                - expected_red_checks_reject_unmatched_failures
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 2
    data = json.loads(out_json.read_text())
    assert data["status"] == "REJECTED"
    assert data["checks"][0]["status"] == "FAIL"
    assert "expected output patterns not matched" in data["checks"][0]["failure_reason"]


def test_expected_red_checks_reject_missing_metadata_and_unrelated_exit(fake_worktree, tmp_path):
    worktree, base_sha = fake_worktree
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        step_type: test
        step_intent: test_define_red
        expected_result: red
        description: |
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths: []
          required_claims:
            - expected_red_checks_reject_unmatched_failures
          required_checks:
            - id: missing_metadata_check
              command: ["python", "-c", "import sys; print('known async gap exposed'); sys.exit(7)"]
              covers_claims:
                - expected_red_checks_reject_unmatched_failures
            - id: unrelated_exit_check
              command: ["python", "-c", "import sys; print('known async gap exposed'); sys.exit(8)"]
              expected_exit_codes: [7]
              expected_output_patterns_all:
                - "known async gap"
              covers_claims:
                - expected_red_checks_reject_unmatched_failures
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 2
    data = json.loads(out_json.read_text())
    checks = {check["id"]: check for check in data["checks"]}
    assert checks["missing_metadata_check"]["status"] == "FAIL"
    assert checks["missing_metadata_check"]["failure_reason"] == "exit code 7; expected 0"
    assert checks["unrelated_exit_check"]["status"] == "FAIL"
    assert "did not match expected_exit_codes" in checks["unrelated_exit_check"]["failure_reason"]


def test_non_expected_red_checks_still_require_zero(fake_worktree, tmp_path):
    worktree, base_sha = fake_worktree
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        step_type: implementation
        step_intent: implement
        expected_result: green
        description: |
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths: []
          required_claims:
            - non_expected_red_checks_still_require_zero
          required_checks:
            - id: non_red_check
              command: ["python", "-c", "import sys; print('known async gap exposed'); sys.exit(7)"]
              expected_exit_codes: [7]
              expected_output_patterns_all:
                - "known async gap"
              covers_claims:
                - non_expected_red_checks_still_require_zero
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 2
    data = json.loads(out_json.read_text())
    assert data["status"] == "REJECTED"
    assert data["checks"][0]["status"] == "FAIL"
    assert "expected-red metadata is only honored" in data["checks"][0]["failure_reason"]


def test_untracked_environment_bootstrap_noise_filtered(fake_worktree, tmp_path):
    worktree, base_sha = fake_worktree
    bootstrap_file = worktree / "contrib" / "pi-extension" / "node_modules" / "pkg" / "index.js"
    bootstrap_file.parent.mkdir(parents=True)
    bootstrap_file.write_text("environment bootstrap noise")
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        description: |
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths:
            - "contrib/pi-extension/larva.ts"
          required_claims:
            - untracked_environment_bootstrap_noise_filtered
          required_checks:
            - id: passing_check
              command: ["echo", "pass"]
              covers_claims:
                - untracked_environment_bootstrap_noise_filtered
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 0
    data = json.loads(out_json.read_text())
    assert data["status"] == "CONFORMANT"
    assert str(bootstrap_file.relative_to(worktree)) not in data["changed_files"]


def test_staged_bootstrap_changes_are_not_filtered(fake_worktree, tmp_path):
    worktree, base_sha = fake_worktree
    bootstrap_file = worktree / "contrib" / "pi-extension" / "node_modules" / "pkg" / "index.js"
    bootstrap_file.parent.mkdir(parents=True)
    bootstrap_file.write_text("staged change")
    subprocess.run(["git", "add", str(bootstrap_file.relative_to(worktree))], cwd=worktree, check=True)
    plan = tmp_path / "plan.yaml"
    plan.write_text("""
phases:
  - steps:
      - id: "test_step"
        description: |
          <intent_closure_contract>
          allowed_paths:
            - "scripts/intent_closure_gate.py"
            - "plan.yaml"
          blocked_paths: []
          required_claims:
            - path_and_claim_boundaries_preserved
          required_checks:
            - id: passing_check
              command: ["echo", "pass"]
              covers_claims:
                - path_and_claim_boundaries_preserved
          </intent_closure_contract>
""")
    out_json = tmp_path / "out.json"

    result = _run_gate(plan, "test_step", worktree, base_sha, out_json)

    assert result.returncode == 1
    data = json.loads(out_json.read_text())
    assert data["status"] == "TAINTED"
    assert any("Path not allowed: contrib/pi-extension/node_modules/pkg/index.js" in r for r in data["reasons"])
