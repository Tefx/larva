# Owner Authorization Packet: `dead_export` exemption for `src/larva/shell/cli.py::main`

## Scope

- Request type: owner approval packet only.
- Requested action: authorize a `pyproject.toml` exemption for one non-suppressible `dead_export` finding.
- Explicit non-action: do not apply the exemption until owner approval is granted.

## Finding Under Review

- Rule: `dead_export`
- Symbol: `src/larva/shell/cli.py::main`
- Source line carrying the attempted inline allow: `src/larva/shell/cli.py:322`
- Symbol definition: `src/larva/shell/cli.py:323`

## Exact Symbol and Call-Path Evidence

### [Proven] Static symbol facts

1. `pyproject.toml:37-38` publishes the console script entrypoint:

   ```toml
   [project.scripts]
   larva = "larva.shell.cli:main"
   ```

2. `src/larva/shell/cli.py:323` defines the exported shell entrypoint:

   ```python
   def main(argv: Sequence[str] | None = None) -> int:
   ```

3. `src/larva/cli.py:15-17` is the only in-repo caller detected by `invar refs`:

   ```python
   def main(argv: Sequence[str] | None = None) -> int:
       return shell_cli.main(argv)
   ```

### [Proven] Observed call paths

- Packaging/runtime call path: generated console launcher for `larva` -> `larva.shell.cli:main` (declared in `pyproject.toml:38`).
- Legacy in-repo compatibility call path: `src/larva/cli.py::main` -> `src/larva/shell/cli.py::main`.

### [Proven] Command evidence

- `uv run invar refs src/larva/shell/cli.py::main`

  Returned exactly two references:

  1. definition at `src/larva/shell/cli.py:323`
  2. caller at `src/larva/cli.py:17` with context `return shell_cli.main(argv)`

## Why Inline Suppression Is Forbidden In 1.20.3

### [Proven] Tool behavior in `invar-tools` 1.20.3

The 1.20.3 wheel classifies `dead_export` as non-suppressible and routes approval to owner-managed config instead of source comments.

1. `invar/core/models.py` marks `dead_export` as `EscapeHatchTier.NON_SUPPRESSIBLE`.
2. `invar/core/entry_points.py` states:

   - `Non-suppressible rules (dead_export, stub_body, missing_contract, missing_doctest) always return False - inline markers cannot suppress them.`
   - `if rule in NON_SUPPRESSIBLE_INLINE_RULES: return False`

3. `invar/core/escape_budget.py` emits the governing instruction:

   - `dead_export cannot be suppressed inline. This rule requires human authorization. Ask the project owner to declare an exemption in pyproject.toml. Do NOT modify pyproject.toml yourself.`

4. `invar/shell/guard_output.py` renders blocked attempts as:

   - `Inline suppression attempt blocked`

### [Proven] Consequence for this file

The inline marker currently present at `src/larva/shell/cli.py:322` is not a valid remediation path under 1.20.3. Even if left in place, 1.20.3 treats it as an attempted suppression that requires owner approval in `pyproject.toml`.

## Alternatives Considered To Remove The Export Safely

### Option A: Remove `src/larva/shell/cli.py::main` and point packaging elsewhere

- Status: rejected for now.
- Why not: `pyproject.toml:38` currently binds the published `larva` console script to this symbol. Removing it changes the packaged CLI surface and requires coordinated packaging and compatibility review.
- Fails if: any installed launcher, docs, or downstream automation still resolves `larva.shell.cli:main`.

### Option B: Repoint `project.scripts.larva` to `src/larva/cli.py::main`

- Status: not recommended as the first remediation.
- Why not: it only moves the public export boundary; it does not eliminate the need for one externally reachable entrypoint. It also changes the authoritative entrypoint from shell code to a compatibility shim.
- Fails if: owners want `src/larva/shell/cli.py` to remain the canonical CLI implementation surface.

### Option C: Add an internal static caller solely to satisfy `dead_export`

- Status: rejected.
- Why not: this would create an artificial caller with no runtime value and would distort the code to satisfy a static rule rather than represent actual ownership.
- Fails if: the extra caller becomes dead indirection or obscures the real packaging entrypoint.

### Option D: Owner-approved config exemption for the one external entrypoint symbol

- Status: recommended.
- Why: the symbol is intentionally exported through packaging, the external caller exists outside `src/`, and 1.20.3 explicitly routes this case to owner-managed `pyproject.toml` authorization.
- Fails if: future code changes remove the external packaging dependency or add a normal in-repo call path, because then the exemption is no longer justified.

## Minimal `pyproject.toml` Exemption Scope Proposal

### [Likely] Narrowest supported shape

`invar` 1.20.3 parses owner exemptions from `[tool.invar.exempt.<rule>]` with `patterns = [...]`, and pattern matching supports `file::symbol` globs.

Proposed scope:

```toml
[tool.invar.exempt.dead_export]
patterns = ["src/larva/shell/cli.py::main"]
```

Why this is minimal:

- targets one rule: `dead_export`
- targets one file: `src/larva/shell/cli.py`
- targets one symbol: `main`
- does not exempt sibling functions, the whole file, or unrelated dead exports

## Expiry / Removal Condition

The exemption should be removed immediately when any one of these becomes true:

1. `invar` gains first-class recognition for packaged console-script entrypoints, so `larva.shell.cli:main` no longer trips `dead_export`.
2. the published script target changes away from `larva.shell.cli:main`.
3. a real, stable in-repo call path is introduced that makes the symbol statically referenced without relying on packaging metadata.
4. `src/larva/shell/cli.py::main` is removed or merged into another approved entrypoint surface.

Recommended review checkpoint: re-validate on the next `invar-tools` upgrade after 1.20.3.

## Owner Sign-Off Request Template

```text
Owner approval requested for one non-suppressible Invar exemption.

Request:
- Approve `[tool.invar.exempt.dead_export] patterns = ["src/larva/shell/cli.py::main"]`

Justification:
- `src/larva/shell/cli.py::main` is the published console-script entrypoint declared in `pyproject.toml`.
- Invar 1.20.3 marks `dead_export` as non-suppressible inline and requires owner authorization in `pyproject.toml`.
- The proposed exemption is scoped to one symbol and does not broaden coverage beyond the packaged CLI entrypoint.

Owner decision:
- [ ] Approved
- [ ] Rejected

Owner name:
- 

Date:
- 

Conditions / expiry notes:
- Remove when packaged console-script entrypoints are recognized natively or when `larva.shell.cli:main` is no longer the published script target.
```

## Approval State

- Current state: pending owner approval.
- No exemption has been applied in this branch.
