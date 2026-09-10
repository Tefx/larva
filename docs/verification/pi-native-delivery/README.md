# Native Pi delivery evidence

## Result and ownership
This is the **historical native-producer report**. The Python launcher was later
removed. Its final repository scan and new capsule/loading/restore observations
are recorded in [native repair evidence](../pi-native-repair/README.md). That
repair remains blocked on the installed-dependency expectation described there;
this predecessor report does not establish final project acceptance.


The native extension candidate preserves the package, admission, capsule and
runtime work retained at `513f7928`. `node-typescript-engineer` remains the
claimed implementation owner. `principal-engineer` performed this follow-through
in `vectl/pi-native-deliver-extension`; no Plan/claim change or integration occurred.
Python launcher/wheel retirement remains the next producer's work.

Supported observed host: macOS, Node **26.7.0**, Pi **0.85.1**, Python **3.12**.
The A/B fixture used actual maturin **1.15.0** and compiled dependency-free Rust
binary projects offline. All model responses came from owned loopback providers.
These tests establish protocol/runtime behavior, not model reasoning or persona
compliance.

## Corrections with distinguishing evidence

| Defect | Pre-correction observation | Correction and green proof |
|---|---|---|
| Mutable/ambient child launch selection | `test-native-launch-context.mjs` failed when parent argv changed after loading; the old helper also accepted an ambient executable override | Capture absolute Node/Pi identity once; validate package name, version and declared `bin.pi`; remove the published test override. The test now passes all three checks; native children launch without the test loader. |
| Canonical retained receipt rejected in a later parent | `red-resume-canonical-root.json`: a real retained `/private/var/...jsonl` receipt failed against configured `/var/...` with `LARVA_BAD_INPUT` | Preserve lexical validation before filesystem access, then admit the physical configured root without modifying the handle. `failures.json` resumes the retained session in another native parent. Observer tools keep their no-I/O path. |
| Typed child startup failure masked by frame diagnosis | `red-native-startup-error.json`: child-only backend resolution failure projected as `LARVA_CHILD_PROTOCOL_FAILED` | Return the existing startup error before checking a successful response's frame marker. `failures.json` observes `LARVA_PERSONA_NOT_FOUND`, no prompt, and capsule cleanup. |
| RPC confirmation waited for a UI response | `red-rpc-confirmation.json`: native RPC advertised UI proxies and the confirm borrow timed out | Require actual TUI mode for confirmation. `state.json` and `print.json` show bounded denial and unchanged origin; `tui.json` exercises all four rendered choices and selects Borrow once. |
| Temporary identity reactivated after restoration | `red-temporary-persona-restoration.json`: after the model restored, the next switch reported the borrowed identity already active | Temporary leases no longer persist a primary-persona commit. Native borrow/continuation restore the original persona, manual model and thinking; free/manual switches still persist their ordinary commits. |

The environment fixture's inherited-A case is a **negative control**, not a claim
that native Pi sanitizes a polluted caller. It demonstrates that invoking B's
interpreter while A remains activated still installs into A. The B and absent-venv
cases distinguish the required native boundary.

## Commands and verification

Commands ran from the assigned worktree. Local Python inventories used
`scripts/pi-guard-checks.mjs` through Invar rather than invoking the declared raw
`uv run ... pytest` argv verbatim. The runner uses the locked project interpreter
and an unchanged source snapshot with a disposable 600-second Invar deadline.
It uses pytest importlib collection for repository tests. Duplicate shadow-source
doctests are deselected because their module names differ; the separate exact
full Invar command below verifies the original source/doctests/contracts. No
repository test, native case, assertion, or Invar rule is disabled.

| Declared check | Executed command / modality | Observed result / evidence |
|---|---|---|
| node-host | `node --version` | `v26.7.0` |
| locked-extension-dependencies | `npm --prefix contrib/pi-extension ci` | Exit 0; `npm-ci.log` |
| native-runtime-inventory | `node scripts/pi-guard-checks.mjs tests/shell/test_pi_extension_real_runtime.py --junitxml=<native-runtime.xml>` | **69 passed, 0 failures/errors/skips**; `native-inventory-guard.json`, `native-runtime.xml` |
| retained-python-pi-contracts | Same runner with `test_pi_extension_contract.py`, `test_pi_extension_subagent_ux.py`, `test_pi_extension_subagent_model_isolation.py`, `test_pi_agent_persona_switch_policy_contract.py`, `test_pi_idle_callback_identity.py` | **259 passed, 0 failures/errors/skips**; `retained-guard.json`, `retained.xml` |
| applicable remaining repository tests | Same runner with `tests`, excluding exactly those six already-verified files using absolute `--ignore=` paths | **649 passed, 0 failures/errors/skips**; `remaining-repo-guard.json`, `remaining-repo.xml` |
| all-node-pi-regressions | `set -euo pipefail; for f in contrib/pi-extension/test-*.mjs; do node "$f"; done` | All **17 scripts** passed; `all-node.log`. The subsequently expanded OS/capsule failure test also passed its six checks (`capsule-failures.json`). |
| capability-smoke | `node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates` | Exit 0; `capability.json`; supplemental capability evidence only |
| full-invar | `env -u VIRTUAL_ENV -u UV_PROJECT_ENVIRONMENT -u PYTHONPATH UV_PYTHON_DOWNLOADS=never uvx --python 3.12 invar-tools==1.20.3 guard --all` | Exit 0; 43 files, 0 errors, 5 existing warnings, 9 infos; doctest passed, CrossHair verified, property tests passed (`full-invar.json`) |
| whitespace | `git diff --check` | Exit 0 |
| CI definition | Parse `.github/workflows/ci.yml`; contract checks require dependency setup before gates and native execution on macOS with Node 26.7.0 | Passed locally. The new remote workflow was not dispatched. It retains the declared raw pytest commands. |

Total repository pytest inventory: **977 passing cases**, with no skips or
xfails. The state journey was rerun after strengthening its saved-mode assertion:
it now observes a temporary automatic borrow immediately after resume/reload,
before any mode write. Its other inventory inputs and product code were unchanged.

Earlier harness failures were repaired: test-only launch injection rejected empty
JSON; the old installed-child transport proxy needed a disposable adapter copy
instead of an ambient PATH override; large JSON output needed natural stdout
drain; the initial PTY exit observer had a double-poll race. The Invar wrapper
also needed project-interpreter execution for MCP subprocess imports and separate
original-source doctest verification. These failures are not green evidence.

## Native acceptance and applicability matrix
Direct journey command:

```bash
node scripts/pi-native-journeys.mjs --scenario SCENARIO \
  --output docs/verification/pi-native-delivery/SCENARIO.json
```

Historical `SCENARIO` values are `state`, `children`, `invocation`, `environment`,
`tui`, `consumers`, `watchdog`, `failures`, `admission`, and `print`.
`pi-native-acceptance.mjs` invokes these through `native-*` cases;
`backend-a-project-b` invokes `environment`. New repair cases and their current
results are in [native repair evidence](../pi-native-repair/README.md).

| Acceptance row | Actual observation and evidence | Modality / applicability |
|---|---|---|
| Package/setup | Disposable package discovery, explicit `-e`, disable, duplicate copies and unusable CLI binding | Historical native inventory. **Correction:** `--no-extensions` and child missing-preload did not exercise a damaged installed main entry or unusable runtime dependency. See the repair's actual missing-entry and host-supplied dependency observations. |
| Admission | Fresh explicit success; missing ID/model/policy/binding, invalid mode, unknown flag and missing value. Queued RPC/print/TTY inputs produce zero provider requests. Larva exits 2; Pi syntax errors exit 1 | `admission.json`: 21 launched cases. SDK enumeration/setter failures retain controlled API tests; native tool-policy enforcement is independently observed. |
| Restore | Saved-session reopen, stored/explicit precedence, unused unavailable explicit route, digest drift, manual model/thinking, restored auto mode, fork/new/reload and commit idempotence | `state.json` and historical inventory. **Correction:** the old stored-failure case omitted explicit input. The repair now observes successful explicit-ID preflight followed by nonfatal failed stored restoration and an actual usable request without active identity. |
| Persona policy | Manual tool denial; RPC/print confirmation denial; native TUI confirmation; automatic temporary borrow, continuation and free persistence | `state.json`, `tui.json`, `print.json`; detailed rollback, manual precedence and race branches retain controlled tests. |
| Main settings | Native theme save survives restart; persona/profile/borrow preserve global model/thinking defaults; main has no capsule | `tui.json`, `state.json`; public Pi settings/UI APIs, with no patching behind Pi. |
| UI | Filtered selector, Ctrl+Alt+P, Escape, Tab completion, canonical mention, four-choice confirmation, console metadata and confirmed cancellation | PTY evidence in `tui.json`; RPC/print in other journeys. The older ctx.mode-only observer is not interaction parity. |
| Child route | Native new/resume, parent isolation, explicit route and thinking, xhigh→high clamping, profile generations/fences/fanout | `children.json` and installed-child profile test. `profile-child.json` uses controlled transport with actual Pi children; it is not launch-identity proof. |
| Child transport | Captured native Node/CLI, explicit allowlist, base-derived 0700/0600 capsules, pre-start frame marker, no control-extension leakage, oversized manifest | `children.json`; frame/memory tests in `all-node.log` remain supporting evidence. |
| Async lifecycle | Accepted held child, callbacks/continuation, exact status/events/wait/select, concurrent targeted cancellation, actual 120-second watchdog | `children.json`, `watchdog.json`, `tui.json`; controlled tests cover deduplication, stale suppression and progress-clock edges. |
| Cleanup | Success, typed startup failure, native provider error, stdout corruption, missing preload, asynchronous EACCES at spawn, capsule creation failure, cancellation, timeout, watchdog and live-child parent shutdown | Historical `children.json`, `failures.json`, `invocation.json`, `watchdog.json`, `tui.json`, `capsule-failures.json`. **Correction:** these did not prove aged active/unrelated capsule preservation or removal-failure diagnostics. Both source defects are repaired with new red/green proof. |
| Persistence | New/resumed history, canonical receipt resumed in a later parent, failure retains history, output artifact survives cleanup | `children.json`, `failures.json`; cache/authority tests remain controlled evidence. |
| Environment/backend | Actual backend A serves list/resolve with A interpreter; native main/child bash tools compile/install into activated B; absent VIRTUAL_ENV stays absent | `environment.json`; inherited-A is a negative control. No product sanitizer, PATH reconstruction or backend activation. |
| Extension consumers | Actual invocation success/timeout, focused compaction/native fallback, single identity overlay preserving co-loaded content, effective tool policy | `invocation.json`, `consumers.json`; co-loaded fixtures use public SDK surfaces. |
| Repo/cutover | Historical 977-test inventory and full Invar preceded Python launcher/wheel retirement | The repair report accounts for the later 936-test Python-stage inventory, fresh affected regressions and exact post-removal CLI full scan. Historical `full-invar.json` cannot establish that later scan. |

## Cleanup, evidence reuse, and self-review

Successful RPC parents exited 0. PTY helpers waited/reaped their real parents.
Native fixture cleanup inspected child PIDs and capsules before removing scratch
roots. Concurrent cancellation left the first child running and removed only the
second capsule; parent shutdown then removed the final child/capsule. Persistent
sessions and output artifacts were inspected before the owning fixture's final
scratch deletion. Base settings were not merged or rolled back.

The strengthened original `parent-shutdown-active-child` case requires an actual
accepted task, in-flight provider request, live PID/nonempty capsule, configured
preload, normal parent exit, retained session, and empty final child/capsule
state. Its exception path owns and reaps the parent process group.

`cleanup-reconciliation.json` records removal of the one retained scratch root
from the initial provider-harness crash after confirming its recorded parent was
gone and no capsule remained. The final process inventory found no remaining
owned native/controlled test processes. Test providers and roots were closed by
their owning runners; no user/global Pi configuration was changed.

Fresh self-review inspected the product diff, launch identity checks, lexical
validation ordering, typed startup propagation, temporary commit behavior,
mode-specific confirmation, failure cleanup, fixture boundaries, CI setup order,
and this complete matrix. No additional unresolved implementation defect was
found. Earlier source contributions and applicable observations were retained;
raw profile transport evidence is explicitly distinguished from native launch
proof. No Plan mutation, rebase, integration, Python retirement, Pi patch,
external-model call, publication or shared-contract redesign occurred.

Open Problems: none.
Residual Risk within the declared implementation boundary: none.
