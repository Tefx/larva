import json
import os
import subprocess
from pathlib import Path

import pytest

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
    
    # Assuming intent_closure_gate.py is in the root scripts/
    script_path = Path(__file__).parent.parent.parent / "scripts" / "intent_closure_gate.py"
    
    result = subprocess.run(
        [
            "python", 
            str(script_path), 
            "--plan", str(plan_yaml),
            "--step", "test_step",
            "--worktree", str(worktree),
            "--base", base_sha,
            "--out", str(out_json)
        ],
        capture_output=True,
        text=True
    )
    
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
    script_path = Path(__file__).parent.parent.parent / "scripts" / "intent_closure_gate.py"
    
    result = subprocess.run(
        [
            "python", 
            str(script_path), 
            "--plan", str(plan_yaml),
            "--step", "test_step",
            "--worktree", str(worktree),
            "--base", base_sha,
            "--out", str(out_json)
        ],
        capture_output=True,
        text=True
    )
    
    assert result.returncode == 1 # TAINTED
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
    script_path = Path(__file__).parent.parent.parent / "scripts" / "intent_closure_gate.py"
    
    result = subprocess.run(
        [
            "python", str(script_path), 
            "--plan", str(plan), "--step", "test_step",
            "--worktree", str(worktree), "--base", base_sha, "--out", str(out_json)
        ],
        capture_output=True, text=True
    )
    
    assert result.returncode == 2 # REJECTED
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
    script_path = Path(__file__).parent.parent.parent / "scripts" / "intent_closure_gate.py"
    
    result = subprocess.run(
        [
            "python", str(script_path), "--plan", str(plan), "--step", "test_step",
            "--worktree", str(worktree), "--base", base_sha, "--out", str(out_json)
        ],
        capture_output=True, text=True
    )
    
    assert result.returncode == 3 # INVALID
    data = json.loads(out_json.read_text())
    assert data["status"] == "INVALID"
    assert any("Missing test coverage for required claims: a_claim" in r for r in data["reasons"])
