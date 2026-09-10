# Native capsule/runtime repair evidence

## Outcome and observation-method correction

**Scoped repair verified.** Both capsule defects have red/green native proof;
missing-entry and actual dependency-import failures fail closed in launched Pi;
combined explicit preflight/stored restoration is proved; the exact
post-launcher-removal CLI full Invar scan passed. Final repository acceptance
remains the parent-owned terminal gate's decision.

Actual executor: `principal-engineer`, assigned branch
`vectl/pi-native-repair-capsule-runtime-proof`, post-claim base
`5ff197a76ae1473168bb5aa93f7a861809fad963`. Commit
`0331a7c1c608f9ca5b57f1f543d890fbbb3d6c28` retained the capsule repair and first
loading observations. This follow-through changes only the loading fixture and
evidence; earlier producer contributions and capsule red proof remain intact.
No Plan mutation, integration, rebase, user/global installation, registry change,
external model request, production import change or Pi source patch occurred.

The first loading fixture targeted unused package-local TUI bytes. Pi 0.85.1's
`dist/core/extensions/loader.js:416-425` supplies bundled Node extensions with
`virtualModules: VIRTUAL_MODULES`; the unbundled path aliases TUI to the host
module (`getAliases`, lines 84-101). A throwing package-local TUI therefore
leaves native Pi usable. `initial-installed-loading.json` preserves this valid
control and the original incorrect failure assertion without relabeling it.

The parent independently confirmed that ownership and corrected the observation
method within existing fixture authority. The binding requirement concerns an
actual installed dependency-load failure. The corrected fixture changes only
the exact TUI import specifier in a disposable installed Larva copy to a unique
absent package, then invokes normal Pi loading with an explicit persona and a
viable loopback prompt. Native Pi reports the failed import, exits 1 and issues
zero provider requests. The unused-local-TUI case remains a separate successful
host-ownership control. This proves a **broken installed dependency import**;
it makes no claim about corrupting the host's embedded TUI bytes. No package
integrity rule, host patch, contract change or outstanding user decision is needed.

## Red and green capsule proof

Commands run from this worktree:

```sh
node scripts/pi-native-journeys.mjs --scenario capsule-aging --output docs/verification/pi-native-repair/red-aging.json
node scripts/pi-native-journeys.mjs --scenario capsule-removal --output docs/verification/pi-native-repair/red-removal.json
# After the product correction:
node scripts/pi-native-journeys.mjs --scenario capsule-aging --output docs/verification/pi-native-repair/green-aging.json
node scripts/pi-native-journeys.mjs --scenario capsule-removal --output docs/verification/pi-native-repair/green-removal.json
```

| Observation | Red (exit 1) | Green (exit 0) |
|---|---|---|
| Aged active capsule | First native parent's child PID remained alive; creating a second actual parent's child deleted both its 25-hour-aged capsule and an unrelated aged runtime entry | Both entries survive second-parent startup. Normal shutdown reaps both children and removes their owned capsules only. Unrelated contents, base settings and saved child history survive until fixture teardown. |
| Removal failure | Injected `rmSync` EACCES reached actual native shutdown cleanup. Child exited and capsule remained, but stderr was empty | Actual cancellation cleanup receives `rmSync` and `lstatSync` EACCES in separate native parents. Both produce bounded stderr containing the retained exact capsule path and `EACCES`. `cleanup_end` retains that path and reports `running:false`; external PID checks agree. Base settings, linked model resource and child session remain. |

`cleanupStaleChildCapsules` and its startup call are removed. Directory age never
established termination, and the accepted native design does not require a sweep.
Known-owned terminal cleanup remains. Removal failure retains the environment's
capsule identity, emits stderr independently of optional tracing, and keeps
arbitrary filesystem exception text out of diagnostics. A root link/out-of-root
path is refused; a still-running child does not lose its capsule after the bounded
shutdown attempt. Creation-failure cleanup uses the same diagnostic path.

Fault injection uses `tests/fixtures/pi/native-cleanup-fault.mjs`: it intercepts
only the selected parent's exact `rmSync`/`lstatSync` filesystem operation. It
never replaces `cleanupChild`, Larva lifecycle handlers, native Pi, child launch
selection or the provider seam. Red used actual shutdown; green uses actual
cancellation so optional asynchronous trace writes can be observed before parent
exit. Initial green fixture attempts exposed trace-read timing and the valid
`cancelling` immediate result; the fixture now awaits the real terminal callback
and bounded trace completion. Those intermediate failures are not green proof.

Final self-review distinguished root absence from a recursive removal error:
only `lstatSync(root)` ENOENT clears an already-absent root identity. An ENOENT
thrown by `rmSync` must retain the still-existing root. The final green removal
journey also injects that error in a third native parent and passes. The targeted
`node contrib/pi-extension/test-native-capsule-spawn-error.mjs` rerun exits 0
with all six checks passing. This private cleanup refinement leaves the previously
verified non-error native and Node paths unchanged.

## Actual loading and restore observations
```sh
node scripts/pi-native-journeys.mjs --scenario installed-loading --output docs/verification/pi-native-repair/installed-loading.json
node scripts/pi-native-journeys.mjs --scenario stored-restore --output docs/verification/pi-native-repair/stored-restore.json
```

Both commands exit **0**. Loading uses the real installed-package loader and
`-p --offline --approve --larva-persona ok "Viable loopback prompt"`, with viable
loopback model settings. `installed-loading.json` records four separate outcomes:

| Installed state | Native exit | Provider requests | Observation |
|---|---|---|---|
| Healthy copied package | 0 | 1 | Successful control |
| Missing Larva entry | 1 | 0 | `Error: Unknown option: --larva-persona` |
| Throwing package-local TUI, unchanged import | 0 | 1 | Requested `ok` persona remains active; host supplies TUI |
| Actual TUI import changed to absent package in disposable copy | 1 | 0 | `Error: Failed to load extension ... Cannot find module '@larva-native-fixture/absent-tui-77662d54-5b1d-4e0e-a9de-5631884a5d2d'`; Pi also rejects the now-unregistered persona flag |

No case times out. The absent package name is generated per run, and the assertion
requires the native diagnostic to identify it. Only the single import specifier
in the disposable copy changes. No `--no-extensions`, preload substitution,
alternate launcher or patched host supplies the failure evidence.

The stored-restore observation remains applicable unchanged: a native session
activates `ok`, writes history and exits. Another native process reopens it with
`--larva-persona startup`. Backend records show successful `startup` ID resolution
before `ok` resolution. Both runtime routes are unavailable; the unused explicit
route is not activated, and the stored route failure is nonfatal. RPC returns
usable state and `larva: unavailable (LARVA_MODEL_UNAVAILABLE)`. A subsequent
loopback request has no active persona overlay, no false commit is added, and
the parent exits 0. Product restore/admission semantics remain unchanged.

The tracked inventory includes `native-capsule-aging`, `native-capsule-removal`
and `native-installed-loading`. `resume-stored-restore-nonfatal` uses the stronger
actual saved-session journey; its old no-explicit-input branch was removed.

## Commands and integrated accounting
All commands below ran in the assigned worktree. Python pytest selections ran
through the tracked Invar wrapper, as required by host policy. The wrapper quotes
pytest argument values and distinguishes test paths from `-k` expressions. Its
first unquoted/misclassified-expression attempt exited 1 with zero collected tests
and supplied no coverage.

| Command | Exit / actual observation |
|---|---|
| `node --version` | 0; v26.7.0 |
| `/opt/homebrew/bin/pi --version` | 0; 0.85.1 |
| `npm --prefix contrib/pi-extension ci` | 0; `npm-ci.log` |
| `env -u VIRTUAL_ENV -u UV_PROJECT_ENVIRONMENT -u PYTHONPATH UV_PYTHON_DOWNLOADS=never uv sync --locked --python 3.12 --group dev` | 0; `uv-sync.log` |
| `set -euo pipefail; for f in contrib/pi-extension/test-*.mjs; do node "$f"; done` | 0; all 17 scripts, `all-node.log` (runner also prints each filename) |
| `node scripts/pi-extension-runtime-smoke.mjs --scenario capability-gates` | 0; `capability.json` |
| Exact pinned CLI command below | 0; `full-invar.log`: 42 files, 0 errors, 5 existing warnings, 7 infos; doctest passed, CrossHair verified, property tests passed |
| `git diff --check` | 0 |

Exact full scan, after Python launcher removal and capsule repair:

```sh
env -u VIRTUAL_ENV -u UV_PROJECT_ENVIRONMENT -u PYTHONPATH \
  UV_PYTHON_DOWNLOADS=never uvx --python 3.12 invar-tools==1.20.3 guard --all
```

This is the actual CLI scan of original Python source/contracts. Scanned inputs
remain unchanged; the observation-method correction changes only the JavaScript
loading fixture and evidence. It reuses this scan without presenting an old
native-producer artifact or Python-stage MCP summary as new CLI evidence.
CrossHair's existing unsupported-operation exclusion for `core/pi_model_map.py`
remains reported. TypeScript cleanup behavior is covered by native/Node checks,
including the final three-fault removal journey and six-check spawn-error rerun.

Initial integrated selection (report paths were passed as absolute paths):

```sh
node scripts/pi-guard-checks.mjs \
  tests/shell/test_pi_extension_real_runtime.py \
  tests/shell/test_pi_extension_contract.py \
  tests/shell/test_pi_extension_subagent_ux.py \
  tests/shell/test_pi_extension_subagent_model_isolation.py \
  tests/shell/test_pi_agent_persona_switch_policy_contract.py \
  tests/shell/test_pi_idle_callback_identity.py \
  -k 'not native-watchdog and not backend-a-project-b' \
  --junitxml=$PWD/docs/verification/pi-native-repair/pi-regressions.xml
```

That historical invocation exited **1**: **68 passed, 1 failed**, no skips/errors.
It stopped at the incorrect installed-loading assertion before the last native
mode observer and the other five files. Those five files then ran separately
through the same wrapper with
`--junitxml=$PWD/docs/verification/pi-native-repair/retained.xml`: exit **0**,
**259 passed**, no failures/errors/skips. These actual outputs remain unchanged
in `pi-regressions.log/xml` and `retained.log/xml`.

After correcting the loading observation method, this targeted inventory command
ran with the absolute report path:

```sh
node scripts/pi-guard-checks.mjs \
  'tests/shell/test_pi_extension_real_runtime.py::test_native_pi_acceptance_matrix[native-installed-loading]' \
  --junitxml=$PWD/docs/verification/pi-native-repair/installed-loading.xml
```

Exit **0**, **1 passed**, no failures/errors/skips; actual output is in
`installed-loading-guard.log` and `installed-loading.xml`. Its separate direct
journey also exited 0 and retains native diagnostics/request observations in
`installed-loading.json`. The prior invalid assertion was replaced by a truthful
successful control **and** the required real dependency-import failure; no
obligation was removed, skipped or converted to xfail.

Complete current inventory: **939** repository cases (predecessor 936 plus 3 new).
**328 repair-stage passes** plus **611 applicable prior passes**, with **zero
remaining failures**: 608 unchanged non-Pi cases and 3 unchanged native observations
(watchdog timing, backend A/B environment, final ctx.mode-only observer) are reused.
The observation-method correction leaves all 327 earlier repair-stage passing
cases' behavior and inputs unchanged. This combines applicable results rather
than claiming one freshly rerun 939-test process; no raw full-suite
`uv run ... pytest -q` rerun was performed by this worker.

## Reuse applicability and retained state
The parent-validated Python-stage actual outputs are at:
`/var/folders/rs/6_0h1ssn5439q1yfqy4pykg00000gn/T/larva-native-gate-kbbymu7l/python-execution-evidence.json`.
They record the final **936 passed** full suite at 2026-09-10T18:20:39.939Z,
**5 passed** offline wheel/backend checks at 18:39:21.036Z, and the frozen gate
pass at 18:27:06.415Z against opifex
`d3603bf04b2e6021e98b5fa54efb8ff379ccc674`.

`git diff --name-only 7b04f08222f0a04fcf0c538b0768367cf100a523 -- src pyproject.toml uv.lock contracts scripts/ci design/opifex-frozen-authority-packet.json README.md docs/guides/USAGE.md docs/reference/INTERFACES.md contrib/pi-extension/package.json contrib/pi-extension/package-lock.json`
returned no paths. The frozen gate's three consumed docs and all its schema,
metadata, naming and pin inputs remain unchanged. Wheel build/installation inputs,
Python backend and extension list/resolve behavior remain unchanged. The offline
wheel observation uses the established no-isolation build 1.6.1 / hatchling 1.32.0
fixture; it is reused without claiming a new wheel build.

Historical native traces remain in `../pi-native-delivery/`. Watchdog timing,
A/B environment and ctx.mode inputs are unchanged. Repair-stage capsule,
cancellation, native new/resume and parent-shutdown cases cover modified cleanup.
The observation-method correction changes only `runInstalledLoading` and evidence;
other journey functions, shared support, production code and locks are unchanged
from `0331a7c1`. The 327 previous repair-stage passes, 611 prior applicable passes,
17 Node scripts, capability smoke and exact repair-stage CLI Invar scan therefore
remain applicable. No unchanged 120-second watchdog, Rust installation experiment
or full expensive suite was replayed. The old native-producer full Invar report
is explicitly **not** reused.

Each native fixture reaps its owned parents/process groups, checks child PIDs and
capsules, closes its loopback server and removes its disposable root. The red
removal proof intentionally observed a retained capsule with no live child;
fixture teardown then removed that owned scratch tree. Green removal fixtures
preserved settings/session evidence and reconciled dead children before removing
only their retained owned capsules. The corrected loading journey's native
processes exited naturally (0/1 as expected), with no spawned Larva children,
no capsules, a closed loopback server and a removed scratch root.

Raw direct-journey evidence remains at `/tmp/larva-native-repair-raw-5ff197a7`.
`initial-installed-loading.json` preserves the first observation; the new
`installed-loading.json` contains the corrected method's actual outcomes.
Tracked JSON selects decisive request identity/counts and lifecycle metadata to
avoid repeating provider schemas. Tracked runners reproduce full evidence;
historical traces and failing invocation outputs were not relabeled.

Reusable helpers: /tmp/larva-env-audit.pSGsLZ/helpers

Self-review checked capsule ownership/root-link refusal, bounded diagnostics,
base/session persistence, actual native fault seams, stored-route ordering,
single-specifier fixture mutation and evidence reuse inputs. All admitted repair
obligations have implementation/proof evidence. Remaining work belongs to the
parent: candidate integration and terminal Delta acceptance. No external or
protected effect needs rollback; no user environment/global installation changed.

Open Problems: none.
Residual Risk within this repair scope: none.
