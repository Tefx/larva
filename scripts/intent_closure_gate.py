import argparse
import glob
import json
import logging
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

UNTRACKED_ENVIRONMENT_BOOTSTRAP_PREFIXES = ("contrib/pi-extension/node_modules/",)

class IntentClosureError(Exception):
    def __init__(self, message: str, exit_code: int):
        super().__init__(message)
        self.exit_code = exit_code

def load_plan(plan_path: Path) -> Dict[str, Any]:
    try:
        with open(plan_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception as e:
        raise IntentClosureError(f"Failed to load plan {plan_path}: {e}", 3)

def find_step_in_plan(plan: Dict[str, Any], step_id: str) -> Optional[Dict[str, Any]]:
    for phase in plan.get("phases", []):
        for step in phase.get("steps", []):
            if step.get("id") == step_id:
                return step
    return None

def extract_contract(step_desc: str) -> Dict[str, Any]:
    start_tag = "<intent_closure_contract>"
    end_tag = "</intent_closure_contract>"
    start_idx = step_desc.rfind(start_tag)
    end_idx = step_desc.find(end_tag)

    if start_idx == -1 or end_idx == -1 or end_idx < start_idx:
        raise IntentClosureError("Could not find <intent_closure_contract> in step description.", 3)

    yaml_block = step_desc[start_idx + len(start_tag) : end_idx].strip()
    try:
        return yaml.safe_load(yaml_block)
    except Exception as e:
        raise IntentClosureError(f"Failed to parse contract YAML: {e}", 3)

def get_changed_files(worktree_dir: Path, base_ref: str) -> List[str]:
    try:
        # Check standard diff (committed after base_ref, or in index)
        # Using git diff --name-only <base_ref>
        # Note: HEAD might not include untracked/unstaged. We diff against worktree by omitting HEAD.
        result = subprocess.run(
            ["git", "diff", "--name-only", base_ref],
            cwd=worktree_dir,
            capture_output=True,
            text=True,
            check=True
        )
        files = {line.strip() for line in result.stdout.splitlines() if line.strip()}
        
        # Also check untracked but tracked in index (git status --porcelain)
        status_res = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=worktree_dir,
            capture_output=True,
            text=True,
            check=True
        )
        for line in status_res.stdout.splitlines():
            if line:
                status_code = line[:2]
                path = line[3:].strip()
                if status_code == "??" and is_untracked_environment_bootstrap_path(path):
                    continue
                files.add(path)

        return sorted(list(files))
    except subprocess.CalledProcessError as e:
        raise IntentClosureError(f"Failed to compute changed files: git commands returned {e.returncode}\n{e.stderr}", 3)
    except FileNotFoundError:
         raise IntentClosureError("git command not found", 3)

def check_path_boundaries(changed_files: List[str], allowed_paths: List[str], blocked_paths: List[str]) -> Tuple[bool, List[str]]:
    violations = []
    
    def match_glob(path: str, patterns: List[str]) -> bool:
        # Simple glob match
        # Using pathlib globs against the actual paths might not work if files are deleted or just strings.
        # We'll use fnmatch or simple pathlib matching. Pathlib match works differently for **
        from fnmatch import fnmatch
        for p in patterns:
            if p.endswith("/**"):
                base = p[:-3]
                if path == base or path.startswith(base + "/"):
                    return True
            else:
                 if fnmatch(path, p):
                     return True
        return False
        
    for f in changed_files:
        if blocked_paths and match_glob(f, blocked_paths):
            violations.append(f"Blocked path matched: {f}")
            continue
            
        if allowed_paths and not match_glob(f, allowed_paths):
             violations.append(f"Path not allowed: {f}")
             
    return len(violations) == 0, violations

def is_untracked_environment_bootstrap_path(path: str) -> bool:
    normalized = path.rstrip("/") + "/"
    return any(normalized.startswith(prefix) for prefix in UNTRACKED_ENVIRONMENT_BOOTSTRAP_PREFIXES)

def validate_claims_coverage(contract: Dict[str, Any]) -> Tuple[bool, List[str]]:
    required_claims = set(contract.get("required_claims", []))
    covered_claims = set()
    errors = []
    
    for check in contract.get("required_checks", []):
         if "covers_claims" in check:
              for c in check["covers_claims"]:
                  covered_claims.add(c)
                  
    missing = required_claims - covered_claims
    if missing:
         errors.append(f"Missing test coverage for required claims: {', '.join(missing)}")
         
    return len(errors) == 0, errors

def step_allows_expected_red(step: Dict[str, Any]) -> bool:
    return (
        step.get("step_type") == "test"
        and step.get("step_intent") == "test_define_red"
        and step.get("expected_result") == "red"
    )

def expected_patterns(check: Dict[str, Any]) -> List[str]:
    patterns: List[str] = []
    for key in ("expected_output_patterns_all", "expected_failure_patterns_all"):
        value = check.get(key) or []
        if isinstance(value, list):
            patterns.extend(str(pattern) for pattern in value)
        else:
            patterns.append(str(value))
    return patterns

def evaluate_check_result(
    check: Dict[str, Any],
    returncode: int,
    stdout: str,
    stderr: str,
    owner_allows_expected_red: bool,
) -> Tuple[bool, bool, Optional[str]]:
    expected_exit_codes = check.get("expected_exit_codes")
    if expected_exit_codes is None:
        if returncode == 0:
            return True, False, None
        return False, False, f"exit code {returncode}; expected 0"

    if not isinstance(expected_exit_codes, list) or not all(isinstance(code, int) for code in expected_exit_codes):
        return False, False, "expected_exit_codes must be a list of integer exit codes"

    if not owner_allows_expected_red:
        return False, False, (
            "expected-red metadata is only honored for owner steps with "
            "step_type=test, step_intent=test_define_red, expected_result=red"
        )

    if returncode == 0:
        return False, False, "expected-red check returned zero; expected a declared non-zero exit code"

    if returncode not in expected_exit_codes:
        return False, False, f"exit code {returncode} did not match expected_exit_codes {expected_exit_codes}"

    patterns = expected_patterns(check)
    if not patterns:
        return False, False, "expected-red metadata requires expected output/failure patterns"

    combined_output = f"{stdout}\n{stderr}"
    missing_patterns = []
    for pattern in patterns:
        try:
            if re.search(pattern, combined_output, flags=re.MULTILINE) is None:
                missing_patterns.append(pattern)
        except re.error as exc:
            return False, False, f"invalid expected output pattern {pattern!r}: {exc}"

    if missing_patterns:
        return False, False, f"expected output patterns not matched: {missing_patterns}"

    return True, True, None

def run_checks(contract: Dict[str, Any], worktree_dir: Path, step: Dict[str, Any]) -> Tuple[bool, List[Dict[str, Any]]]:
    checks_results = []
    all_passed = True
    owner_allows_expected_red = step_allows_expected_red(step)
    
    for check in contract.get("required_checks", []):
        cmd = check.get("command", [])
        if not cmd:
             continue
        
        logging.info(f"Running check: {check.get('id', 'unknown')} - {shlex.join(cmd)}")
        try:
             result = subprocess.run(
                 cmd,
                 cwd=worktree_dir,
                 capture_output=True,
                 text=True,
                 timeout=300
             )
             passed, expected_red, failure_reason = evaluate_check_result(
                 check,
                 result.returncode,
                 result.stdout,
                 result.stderr,
                 owner_allows_expected_red,
             )
             check_result = {
                 "id": check.get("id"),
                 "command": shlex.join(cmd),
                 "exit_code": result.returncode,
                 "stdout": result.stdout[-2000:], # keep reasonable bounds
                 "stderr": result.stderr[-2000:],
                 "status": "PASS" if passed else "FAIL"
             }
             if expected_red:
                 check_result["expected_red"] = True
             if failure_reason:
                 check_result["failure_reason"] = failure_reason
             checks_results.append(check_result)
             if not passed:
                  all_passed = False
                  logging.error(f"Check failed: {check.get('id')}: {failure_reason}\nstderr: {result.stderr}")
        except Exception as e:
             all_passed = False
             checks_results.append({
                 "id": check.get("id"),
                 "command": shlex.join(cmd),
                 "status": "ERROR",
                 "error": str(e)
             })
             logging.error(f"Failed to execute check {check.get('id')}: {e}")
             
    return all_passed, checks_results

def main():
    parser = argparse.ArgumentParser(description="Intent-Closure Gate Sidecar")
    parser.add_argument("--plan", required=True, help="Path to plan.yaml")
    parser.add_argument("--step", required=True, help="Step ID to validate")
    parser.add_argument("--worktree", required=True, help="Path to worktree root")
    parser.add_argument("--base", required=True, help="Git base ref for diff")
    parser.add_argument("--out", required=True, help="Output JSON path")
    args = parser.parse_args()

    plan_path = Path(args.plan).resolve()
    worktree_dir = Path(args.worktree).resolve()
    out_path = Path(args.out).resolve()
    
    verdict = {
        "status": "INVALID",
        "reasons": [],
        "changed_files": [],
        "checks": []
    }
    
    def write_output_and_exit(status: str, exit_code: int):
         verdict["status"] = status
         try:
             out_path.parent.mkdir(parents=True, exist_ok=True)
             with open(out_path, "w", encoding="utf-8") as f:
                 json.dump(verdict, f, indent=2)
         except Exception as e:
             logging.error(f"Failed to write output to {out_path}: {e}")
             sys.exit(3)
         sys.exit(exit_code)

    try:
        plan = load_plan(plan_path)
        step = find_step_in_plan(plan, args.step)
        
        if not step:
            raise IntentClosureError(f"Step '{args.step}' not found in plan.", 3)
            
        desc = step.get("description", "")
        if not desc:
            raise IntentClosureError(f"Step '{args.step}' has no description.", 3)
            
        try:
             contract = extract_contract(desc)
        except IntentClosureError as e:
             # Just invalid contract, fail parsing
             verdict["reasons"].append(str(e))
             write_output_and_exit("INVALID", 3)

        changed_files = get_changed_files(worktree_dir, args.base)
        verdict["changed_files"] = changed_files
        
        path_ok, path_violations = check_path_boundaries(
            changed_files, 
            contract.get("allowed_paths", []), 
            contract.get("blocked_paths", [])
        )
        
        if not path_ok:
             verdict["reasons"].extend(path_violations)
             write_output_and_exit("TAINTED", 1)
             
        claims_ok, claims_violations = validate_claims_coverage(contract)
        if not claims_ok:
             verdict["reasons"].extend(claims_violations)
             write_output_and_exit("INVALID", 3)
             
        checks_ok, checks_results = run_checks(contract, worktree_dir, step)
        verdict["checks"] = checks_results
        
        if not checks_ok:
             verdict["reasons"].append("One or more required checks failed.")
             for check_result in checks_results:
                 if check_result.get("status") != "PASS" and check_result.get("failure_reason"):
                     verdict["reasons"].append(
                         f"Check {check_result.get('id')} failed: {check_result.get('failure_reason')}"
                     )
             write_output_and_exit("REJECTED", 2)
             
        write_output_and_exit("CONFORMANT", 0)

    except IntentClosureError as e:
        logging.error(str(e))
        verdict["reasons"].append(str(e))
        write_output_and_exit("INVALID", e.exit_code)
    except Exception as e:
        logging.exception("Unexpected error")
        verdict["reasons"].append(f"Unexpected internal error: {e}")
        write_output_and_exit("INVALID", 3)

if __name__ == "__main__":
    main()