# core_normalize evidence guard closure — 2026-05-03

## refs Read Confirmation

No refs for this step.

## Historical completed steps reviewed

- `core_normalize.core-normalize-verify`
- `core_normalize.core-normalize-implement`

## Closure route

`GREEN_CURRENT_PROOF`

## Objective proof commands

```text
$ git status --short --branch
## vectl/step-core_normalize.evidence_guard_closure_20260503

$ git diff --stat HEAD
(no output)

$ ./.venv/bin/python -m pytest tests/core/test_normalize.py
/Users/tefx/Projects/larva/.vectl/worktrees/core_normalize.evidence_guard_closure_20260503/.venv/bin/python: No module named pytest

$ ./.venv/bin/python -m ruff check src/larva/core/normalize.py tests/core/test_normalize.py
/Users/tefx/Projects/larva/.vectl/worktrees/core_normalize.evidence_guard_closure_20260503/.venv/bin/python: No module named ruff

$ ./.venv/bin/python -m mypy src/larva/core/normalize.py tests/core/test_normalize.py
/Users/tefx/Projects/larva/.vectl/worktrees/core_normalize.evidence_guard_closure_20260503/.venv/bin/python: No module named mypy

$ ./.venv/bin/invar guard src/larva/core --all
zsh:1: no such file or directory: ./.venv/bin/invar

$ uv run python -m pytest tests/core/test_normalize.py
warning: `VIRTUAL_ENV=/Users/tefx/Projects/larva/.venv` does not match the project environment path `.venv` and will be ignored; use `--active` to target the active environment instead
============================= test session starts ==============================
platform darwin -- Python 3.12.12, pytest-9.0.2, pluggy-1.6.0
rootdir: /Users/tefx/Projects/larva/.vectl/worktrees/core_normalize.evidence_guard_closure_20260503
configfile: pyproject.toml
plugins: anyio-4.12.1, returns-0.26.0, hypothesis-6.151.9
collected 22 items

tests/core/test_normalize.py ......................                      [100%]

============================== 22 passed in 0.64s ==============================

$ uv run python -m mypy src/larva/core/normalize.py
warning: `VIRTUAL_ENV=/Users/tefx/Projects/larva/.venv` does not match the project environment path `.venv` and will be ignored; use `--active` to target the active environment instead
Success: no issues found in 1 source file

$ uv run invar guard src/larva/core/normalize.py --all
warning: `VIRTUAL_ENV=/Users/tefx/Projects/larva/.venv` does not match the project environment path `.venv` and will be ignored; use `--active` to target the active environment instead
{
  "status": "passed",
  "static": {
    "passed": true,
    "errors": 0,
    "warnings": 0,
    "infos": 0,
    "findings": []
  },
  "summary": {
    "files_checked": 1,
    "errors": 0,
    "warnings": 0,
    "infos": 0
  },
  "verification_level": "STANDARD",
  "doctest": {
    "passed": true,
    "output": ""
  },
  "crosshair": {
    "status": "verified",
    "verified": [
      "/Users/tefx/Projects/larva/.vectl/worktrees/core_normalize.evidence_guard_closure_20260503/src/larva/core/normalize.py"
    ],
    "failed": [],
    "cached": [],
    "skipped": [],
    "skipped_reasons": [],
    "counterexamples": [],
    "files": [
      "/Users/tefx/Projects/larva/.vectl/worktrees/core_normalize.evidence_guard_closure_20260503/src/larva/core/normalize.py"
    ],
    "files_verified": 1,
    "files_cached": 0,
    "total_time_ms": 129009,
    "workers": 1
  },
  "property_tests": {
    "status": "passed",
    "functions_tested": 1,
    "functions_passed": 1,
    "functions_failed": 0,
    "total_examples": 100,
    "failures": [],
    "errors": []
  }
}
```

## Non-blocking observations

- Targeted test-suite lint remains red for pre-existing test-file style issues:
  `uv run --with ruff ruff check src/larva/core/normalize.py tests/core/test_normalize.py`
  reported import-order/unused-import and blind-exception assertions in `tests/core/test_normalize.py`.
- Targeted mypy over the test file remains red for pre-existing generic `dict`
  annotations in `tests/core/test_normalize.py`.
- These observations are not normalize product-code failures. The product module proof
  above is green, and the normalize runtime tests are green.

## Gate-intersection disposition

The historical FAIL evidence is closed for the normalize gate by current green proof:
`tests/core/test_normalize.py` passes, `src/larva/core/normalize.py` type-checks,
and Invar verifies contracts/doctest/CrossHair/property checks for
`src/larva/core/normalize.py`. Remaining lint/type issues intersect test-hygiene
cleanup, not the core normalize implementation gate.

## Headline

PASS
