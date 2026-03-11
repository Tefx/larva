

<!--invar:critical-->
## ⚡ Critical Rules

| Always | Remember |
|--------|----------|
| **Verify** | `invar guard` — NOT pytest, NOT crosshair |
| **Core** | `@pre/@post` + doctests, NO I/O imports |
| **Shell** | Returns `Result[T, E]` from `returns` library |
| **Flow** | USBV: Understand → Specify → Build → Validate |

### Contract Rules (CRITICAL)

```python
# ❌ WRONG: Lambda must include ALL parameters
@pre(lambda x: x >= 0)
def calc(x: int, y: int = 0): ...

# ✅ CORRECT: Include defaults too
@pre(lambda x, y=0: x >= 0)
def calc(x: int, y: int = 0): ...

# ❌ WRONG: @post cannot access parameters
@post(lambda result: result > x)  # 'x' not available!

# ✅ CORRECT: @post only sees 'result'
@post(lambda result: result >= 0)
```

<!--/invar:critical-->



<!--invar:managed version="5.0"-->
# Project Development Guide

> **Protocol:** Follow [INVAR.md](./INVAR.md) — includes Check-In, USBV workflow, and Task Completion requirements.

## Check-In

> See [INVAR.md#check-in](./INVAR.md#check-in-required) for full protocol.

**Your first message MUST display:** `✓ Check-In: [project] | [branch] | [clean/dirty]`

**Actions:** Read `.invar/context.md`, then show status. Do NOT run guard at Check-In.

---

## Final

Your last message for an implementation task MUST display:

```
✓ Final: guard PASS | 0 errors, 2 warnings
```

Execute `invar guard` and show this one-line summary.


This is your sign-out. Completes the Check-In/Final pair.


---


## Project Structure

```
src/{project}/
├── core/    # Pure logic (@pre/@post, doctests, no I/O)
└── shell/   # I/O operations (Result[T, E] return type)
```

**Key insight:** Core receives data (strings), Shell handles I/O (paths, files).

## Quick Reference

| Zone | Requirements |
|------|-------------|
| Core | `@pre`/`@post` + doctests, pure (no I/O) |
| Shell | Returns `Result[T, E]` from `returns` library |

### Core vs Shell (Edge Cases)

- File/network/env vars → **Shell**
- `datetime.now()`, `random` → **Inject param** OR Shell
- Pure logic → **Core**

> Full decision tree: [INVAR.md#core-shell](./INVAR.md#decision-tree-core-vs-shell)



### Document Tools (DX-76)

| I want to... | Use |
|--------------|-----|
| View document structure | `invar doc toc <file> [--format text]` |
| Read specific section | `invar doc read <file> <section>` |
| Search sections by title | `invar doc find <pattern> <files...>` |
| Replace section content | `invar doc replace <file> <section>` |
| Insert new section | `invar doc insert <file> <anchor>` |
| Delete section | `invar doc delete <file> <section>` |

**Section addressing:** slug path (`requirements/auth`), fuzzy (`auth`), index (`#0/#1`), line (`@48`)

## Tool Selection

### Calling Methods (Priority Order)

Invar tools can be called in 3 ways. **Try in order:**

1. **MCP tools** (Claude Code with MCP enabled)
   - Direct function calls: `invar_guard()`, `invar_sig()`, etc.
   - No Bash wrapper needed

2. **CLI command** (if `invar` installed in PATH)
   - Via Bash: `invar guard`, `invar sig`, etc.
   - Install: `pip install invar-tools`

3. **uvx fallback** (always available, no install needed)
   - Via Bash: `uvx invar-tools guard`, `uvx invar-tools sig`, etc.

---

### Parameter Reference

**guard** - Verify code quality
```bash
# CLI
invar guard                      # Check changed files (default)
invar guard --all                # Check all files
```

**sig** - Show function signatures and contracts
```bash
# CLI
invar sig src/foo.py
invar sig src/foo.py::function_name
```

**map** - Find entry points
```bash
# CLI
invar map [path] --top 10
```

**refs** - Find all references to a symbol
```bash
# CLI
invar refs src/foo.py::MyClass
```

**doc*** - Document tools
```bash
# CLI
invar doc toc docs/spec.md
invar doc read docs/spec.md intro
```

---

### Quick Examples

```bash
# Verify after changes (all three methods identical)
invar guard                          # CLI
uvx invar-tools guard                # uvx

# Full project check
invar guard --all                    # CLI
uvx invar-tools guard --all          # uvx

# See function contracts
invar sig src/core/parser.py
uvx invar-tools sig src/core/parser.py
```

**Note**: All three methods now have identical default behavior.


## Documentation Structure

| File | Owner | Edit? | Purpose |
|------|-------|-------|---------|
| INVAR.md | Invar | No | Protocol (`invar update` to sync) |
| CLAUDE.md | User | Yes | Project customization (this file) |
| .invar/context.md | User | Yes | Project state, lessons learned |
| .invar/project-additions.md | User | Yes | Project rules → injected into CLAUDE.md |
| .invar/examples/ | Invar | No | **Must read:** Core/Shell patterns, workflow |

> **Before writing code:** Check Task Router in `.invar/context.md`

## Visible Workflow (DX-30)

For complex tasks (3+ functions), show 3 checkpoints in TodoList:

```
□ [UNDERSTAND] Task description, codebase context, constraints
□ [SPECIFY] Contracts and design decomposition
□ [VALIDATE] Guard results, Review Gate status, integration status
```

**BUILD is internal work** — not shown in TodoList.

**Show contracts before code.** See `.invar/examples/workflow.md` for full example.

## Phase Visibility (DX-51)

Each USBV phase transition requires a visible header:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 /develop → SPECIFY (2/4)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Three-layer visibility:**
- **Skill** (`/develop`) — Routing announcement
- **Phase** (`SPECIFY 2/4`) — Phase header (this section)
- **Tasks** — TodoWrite items

Phase headers are SEPARATE from TodoWrite. Phase = where you are; TodoWrite = what to do.

---

## Context Management (DX-54)

Re-read `.invar/context.md` when:
1. Entering any workflow (/develop, /review, etc.)
2. Completing a TodoWrite task (before moving to next)
3. Conversation exceeds ~15-20 exchanges
4. Unsure about project rules or patterns

**Refresh is transparent** — do not announce "I'm refreshing context."
Only show routing announcements when entering workflows.


---

## Commands (User-Invokable)

| Command | Purpose |
|---------|---------|
| `/audit` | Read-only code review (reports issues, no fixes) |
| `/guard` | Run Invar verification (reports results) |

## Skills (Agent-Invoked)

| Skill | Triggers | Purpose |
|-------|----------|---------|
| `/investigate` | "why", "explain", vague tasks | Research mode, no code changes |
| `/propose` | "should we", "compare" | Decision facilitation |
| `/develop` | "add", "fix", "implement" | USBV implementation workflow |
| `/review` | After /develop, `review_suggested` | Adversarial review with fix loop |

**Note:** Skills are invoked by agent based on context. Use `/audit` for user-initiated review.

Guard triggers `review_suggested` for: security-sensitive files, escape hatches >= 3, contract coverage < 50%.

---

## Workflow Routing (MANDATORY)

When user message contains these triggers, you MUST use the **Skill tool** to invoke the skill:

| Trigger Words | Skill Tool Call | Notes |
|---------------|-----------------|-------|
| "review", "review and fix" | `Skill(skill="review")` | Adversarial review with fix loop |
| "implement", "add", "fix", "update" | `Skill(skill="develop")` | Unless in review context |
| "why", "explain", "investigate" | `Skill(skill="investigate")` | Research mode, no code changes |
| "compare", "should we", "design" | `Skill(skill="propose")` | Decision facilitation |

**CRITICAL: You must call the Skill tool, not just follow the workflow mentally.**

The Skill tool reads `.claude/skills/<skill>/SKILL.md` which contains:
- Detailed phase instructions (USBV breakdown)
- Error handling rules
- Timeout policies
- Incremental development patterns (DX-63)

**Violation check (before writing ANY code):**
- "Did I call `Skill(skill="...")`?"
- "Am I following the SKILL.md instructions?"

---

## Routing Control (DX-42)

Agent announces routing decision before entering any workflow:

```
📍 Routing: /[skill] — [trigger or reason]
   Task: [summary]
```

**User can redirect with natural language:**
- "wait" / "stop" — pause and ask for direction
- "just do it" — proceed with /develop
- "let's discuss" — switch to /propose
- "explain first" — switch to /investigate

**Simple task optimization:** For simple tasks (single file, clear target, <50 lines), agent may offer:

```
📊 Simple task. Auto-orchestrate? [Y/N]
```

- Y → Full cycle without intermediate confirmations
- N → Normal step-by-step workflow

**Auto-review (DX-41):** When Guard outputs `review_suggested`, agent automatically
enters /review. Say "skip" to bypass.

<!--/invar:managed-->

<!--invar:project-->
<!-- ========================================================================
     PROJECT REGION - INVAR PROJECT ONLY
     This section is populated by .invar/project-additions.md via `invar dev sync`.
     For other projects, this region remains empty.
     ======================================================================== -->
<!--/invar:project-->

<!--invar:user-->
<!-- ========================================================================
     USER REGION - EDITABLE
     Add your team conventions and project-specific rules below.
     This section is preserved across `invar update` and `invar dev sync`.
     ======================================================================== -->
<!--/invar:user-->

---

*Generated by `invar init` v5.0. Customize the user section freely.*


<!-- VECTL:AGENTS:BEGIN -->
## Plan Tracking (vectl)

vectl tracks this repo's implementation plan as a structured `plan.yaml`:
what to do next, who claimed it, and what counts as done (with verification evidence).

Full guide: `uvx vectl guide`
Quick view: `uvx vectl status`

### Claim-time Guidance
- `uvx vectl claim` may emit a bounded Guidance block delimited by:
  - `--- VECTL:GUIDANCE:BEGIN ---`
  - `--- VECTL:GUIDANCE:END ---`
- For automation/CI: use `uvx vectl claim --no-guidance` to keep stdout clean.

### CLI vs MCP
- Source of truth: `plan.yaml` (channel-agnostic).
- If MCP is available (IDE / Claude host), prefer MCP tools for plan operations.
- Otherwise use CLI (`uvx vectl ...`).
- Evidence requirements are identical across CLI and MCP.

### plan.yaml — Managed File (DO NOT EDIT DIRECTLY)

`plan.yaml` is exclusively owned by vectl. Direct edits (Edit, Write, sed, or
any file tool) **will** corrupt plan state — vectl performs CAS writes, lock
recalculation, and schema validation on every save, none of which run on direct
edits.

**To modify plan state, ONLY use:**
- CLI: `uvx vectl claim`, `uvx vectl complete`, `uvx vectl mutate`, etc.
- MCP: `vectl_claim`, `vectl_complete`, `vectl_mutate`, etc.

If a vectl command fails, report the error — do **not** edit `plan.yaml`
directly as a workaround. Use `uvx vectl guide stuck` for troubleshooting.

### Rules
- One claimed step at a time.
- Evidence is mandatory when completing (commands run + outputs + gaps).
- Spec uncertainty: leave `# SPEC QUESTION: ...` in code, do not guess.

### For Architects / Planners
- **Design Mode**: Run `uvx vectl guide --on planning` to learn the Architect Protocol.
- **Ambiguity = Failure**: Workers will hallucinate if steps are vague.
- **Constraint Tools**:
  - `--evidence-template`: Force workers to provide specific proof (e.g., "Paste logs here").
  - `--refs`: Pin specific files (e.g., "src/auth.py") to the worker's context.
<!-- VECTL:AGENTS:END -->
