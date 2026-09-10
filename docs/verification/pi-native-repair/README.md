# Native capsule/runtime repair evidence

## Outcome and decision needed

**BLOCKED on the installed-dependency expectation.** Capsule defects are repaired;
actual missing-entry and combined explicit-preflight/stored-restore observations
are complete; the exact post-launcher-removal CLI full Invar scan passed. This
candidate does not claim the producer or repository gate passed.

Actual executor: `principal-engineer`, assigned branch
`vectl/pi-native-repair-capsule-runtime-proof`, post-claim base
`5ff197a76ae1473168bb5aa93f7a861809fad963`. Earlier native and Python producer
contributions remain intact. No Plan mutation, integration, rebase, user/global
installation, registry change, external model request or Pi source patch occurred.

The disputed expectation comes from the repair step: an unusable installed
runtime dependency with explicit persona input must yield a nonzero native
failure before any provider request. In `installed-loading.json`, actual locked
Pi **0.85.1** on Node **26.7.0** loads a scratch-installed extension normally.
After replacing that package's `@earendil-works/pi-tui` with a valid package whose
entry throws, Pi exits **0**, emits no diagnostic and sends **one persona-bearing**
loopback request. The successful control also sends one persona-bearing request.
The damaged local dependency is not the dependency Pi actually uses.

Source counterevidence: the supported Pi distribution's
`dist/core/extensions/loader.js:416-425` gives bundled Node extensions
`virtualModules: VIRTUAL_MODULES`; its map includes the host's imported Pi TUI
module. The unbundled path also aliases this import to the host dependency
(`getAliases`, lines 84-101). Larva uses the documented direct named import.
Changing a package-local TUI file therefore cannot make this host-provided module
unusable. The same native test removes the installed Larva entry and observes
exit **1**, `Error: Unknown option: --larva-persona`, and **zero requests**.

**Parent decision:** accept the observed host-supplied TUI behavior and adjust the
unusable-dependency proof obligation, or obtain authorization for a separate
package-integrity requirement. The latter would add rejection of an otherwise
usable native session; it is not a private repair of the existing loader.
Faulting the bundled host module by patching Pi would cross the stated boundary.
Recommendation: retain native host dependency ownership and the missing-entry
failure proof. The tracked `native-installed-loading` case currently retains the
assigned nonzero assertion and fails visibly; it has not been weakened or skipped.
Independent acceptance and any requirement decision remain parent/gate-owned.

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

Loading command exits **1** because the assigned unusable-dependency assertion
fails as described above. Its missing-entry subcase passed. Each process used the
real installed-package loader with viable loopback model settings and an explicit
`--larva-persona ok` print prompt. No `--no-extensions`, missing-preload substitution,
alternate launcher or environment workaround supplies this evidence.

Restore command exits **0**. A native session first activates `ok`, writes real
history and exits. Another native process reopens that saved session with
`--larva-persona startup`. Backend observations record successful `startup` ID
resolution before successful `ok` resolution. Both runtime model routes are made
unavailable: the unused explicit route is not activated, and the stored route
failure is nonfatal. RPC returns usable state and a visible
`larva: unavailable (LARVA_MODEL_UNAVAILABLE)` status. An actual subsequent
loopback request contains no active persona overlay, no false persona commit is
added, and the parent exits 0. Product restore/admission semantics are unchanged.

The tracked acceptance inventory adds `native-capsule-aging`,
`native-capsule-removal`, and `native-installed-loading`.
`resume-stored-restore-nonfatal` now routes to the stronger actual saved-session
journey; its old no-explicit-input branch was removed.

## Commands and integrated accounting

All commands below ran in the assigned worktree. Python pytest selections ran
through the existing tracked Invar wrapper, as required by the host tool policy.
The wrapper now quotes pytest argument values and distinguishes test paths from
`-k` expressions; the first attempt with an unquoted/misclassified expression
exited 1 with **zero collected tests** and supplied no coverage.

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

Exact full scan, after Python launcher removal and the capsule source repair:

```sh
env -u VIRTUAL_ENV -u UV_PROJECT_ENVIRONMENT -u PYTHONPATH \
  UV_PYTHON_DOWNLOADS=never uvx --python 3.12 invar-tools==1.20.3 guard --all
```

The scan covers original source and contracts. It is neither the old native
producer artifact nor a Python-stage MCP summary. Later edits were excluded
JavaScript runners and documentation; scanned source/configuration inputs remain
unchanged. CrossHair's existing unsupported-operation exclusion for
`core/pi_model_map.py` remains reported by the actual tool.

Fresh integrated selection (the report paths below are passed as absolute paths):

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

Exit **1**: **68 passed, 1 failed**, no skips/errors. Invar stops on the native
installed-loading assertion, before the last native mode observer and the other
five files. Those five files were then run separately with the same wrapper and
`--junitxml=$PWD/docs/verification/pi-native-repair/retained.xml`: exit **0**,
**259 passed**, no failures/errors/skips. `pi-regressions.log/xml` and
`retained.log/xml` retain actual output. No failing test was converted to xfail,
skipped or removed. The bounded fixture recovery has no live child/capsule leak.

Complete current inventory: **939** repository cases (predecessor 936 plus 3 new).
**327 fresh passes**, **1 current failure**, and **611 applicable reused passes**:
608 unchanged non-Pi cases and 3 unchanged native observations (watchdog timing,
backend A/B environment, final ctx.mode-only observer). This is an accounting of
coverage and one blocker, **not** a fresh all-green full-suite claim. No raw
`uv run ... pytest -q` full-suite rerun was performed by this worker.

The final root-absence refinement is in `contrib/pi-extension/larva.ts`, outside
this Python Invar scan's collected inputs. Its applicable verification is the
fresh three-fault native cleanup journey and six-check spawn-error regression.
The exact CLI full scan remains applicable to unchanged Python source/configuration;
it is not being relabeled as TypeScript behavioral coverage.

## Reuse applicability and retained state

The parent-validated Python-stage actual outputs are at:
`/var/folders/rs/6_0h1ssn5439q1yfqy4pykg00000gn/T/larva-native-gate-kbbymu7l/python-execution-evidence.json`.
They record the final **936 passed** full suite at 2026-09-10T18:20:39.939Z,
**5 passed** offline wheel/backend checks at 18:39:21.036Z, and the frozen gate
pass at 18:27:06.415Z against opifex
`d3603bf04b2e6021e98b5fa54efb8ff379ccc674`.

`git diff --name-only 7b04f08222f0a04fcf0c538b0768367cf100a523 -- src pyproject.toml uv.lock contracts scripts/ci design/opifex-frozen-authority-packet.json README.md docs/guides/USAGE.md docs/reference/INTERFACES.md contrib/pi-extension/package.json contrib/pi-extension/package-lock.json`
returned no paths. The frozen gate's three consumed docs and all its schema,
metadata, naming and pin inputs are unchanged. Wheel build/installation inputs,
Python backend and extension list/resolve behavior are unchanged. The offline
wheel observation uses the already established no-isolation build 1.6.1 / hatchling
1.32.0 fixture; it is reused without claiming a new wheel build.

Historical native traces remain in `../pi-native-delivery/`. Watchdog timing,
A/B environment and ctx.mode inputs are unchanged. Fresh capsule/cancellation and
native new/resume/parent-shutdown cases cover the modified cleanup path; there is
no reason to repeat the 120-second timer or Rust installation experiment just to
rebind their unaffected observations. Other native and retained Pi tests ran
against this repair. The old full Invar report is explicitly **not** reused.

Each native fixture reaps its owned parent/process group, checks child PIDs and
capsules, closes its loopback server and removes its disposable root. The red
removal proof intentionally observed one retained capsule with no live child;
fixture teardown then removed that owned scratch tree. Green removal fixtures
reconciled dead children, preserved settings/session evidence, disabled their
fault and removed only their retained owned capsule before normal final teardown.
Raw direct-journey evidence is retained at `/tmp/larva-native-repair-raw-5ff197a7`;
tracked JSON selects decisive actual request identity/counts and lifecycle
metadata to avoid repeating full provider schemas. The tracked runners reproduce
full evidence. Historical traces were not overwritten or relabeled.

Reusable helpers: /tmp/larva-env-audit.pSGsLZ/helpers

Self-review checked the product diff, caller-owned capsule identity, root-link
refusal, stderr bound, no change to base/session ownership, native fault seam,
saved-session route ordering and evidence reuse inputs. Remaining obligation:
resolve the supported-host dependency expectation, then supply its authorized
proof and final integrated acceptance. No external or protected effect needs
rollback; no user environment or global installation was changed.
