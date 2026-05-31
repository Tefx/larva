# Gate Review Report: pi_runtime_liveness_hardening_20260601

## refs Read Confirmation

- `contrib/pi-extension/larva.ts` — read. Key passages: lines 281-289 implement `completePersonaIds(prefix, ctx)` with exact `startsWith(prefix)` mapping to string `{value,label,description}` candidates; lines 316-349 parse only `/larva-persona <prefix>`, delegate non-matches to a base provider, return `null` on errors, and install via `ctx.ui.addAutocompleteProvider`; lines 352-377 preserve `pi.registerCommand("larva-persona", { getArgumentCompletions, handler })` and legacy `complete`; lines 927-943 initialize command and autocomplete registration.
- `contrib/pi-extension/README.md` — read. Key passages: lines 108-145 document `/larva-persona` Tab completion, forced/regular shared path, delegation, null-on-list-failure, troubleshooting commands, no prompt catalogue/cache/fuzzy; lines 147-170 document supplemental runtime gate and skip/xfail limitations that must not hide product failures.
- `README.md` — read. Key passages: lines 229-283 point to Pi integration and state `larva pi` uses Pi extension flags, adapter-local policy remains outside PersonaSpec, `/larva-persona` status behavior, narrow Tab provider semantics, exact `startsWith` matching, null-on-failure, delegation, and non-goals.
- `CONSTITUTION.md` — no workspace file found by `**/CONSTITUTION.md`; no constitution clause applied.

<pre_checklist_scan>

1. Highest-risk invariant: command visibility and direct command completer success must not be treated as editor Tab proof. Evidence separates real Pi RPC (`get_commands`, slash/startup/failure) from wrapper/provider runtime Tab harness (`tab-force`, `tab-regular`, delegation, failure).
2. Highest-risk side effect: a global autocomplete provider could steal non-Larva/file completion. Source review and runtime smoke prove non-`/larva-persona` input delegates to a base provider.
3. Highest-risk unwritten domain rule: list/JSON bridge failures must degrade to no suggestions rather than crash Pi. Source and runtime smoke prove `null` for both list exit and malformed JSON.

</pre_checklist_scan>

**Reviewer**: gate-reviewer (independent of phase implementation)  
**Phase**: pi_runtime_liveness_hardening_20260601

## Headline

PASS — supplemental Pi runtime liveness and `/larva-persona <prefix>` Tab wrapper evidence close the prior false-green risk for all automatable obligations, with true rendered TUI Tab observation explicitly limited by missing automation seam and not used as proof.

## Blocking Status

CLOSED

## Proof-Gap Status

NONE for required gate-opening obligations. Non-blocking environmental limitation remains for rendered TUI Tab visual observation; it is documented with closure path and is not conflated with command visibility.

## Verdict

[PASS]

## Positive Requirement Coverage Ledger

| requirement_id | source_ref/key passage | required proof | evidence reviewed | status | blocker_if_unproven |
| --- | --- | --- | --- | --- | --- |
| PI-LIVE-001 | Gate criterion 1/2: Pi availability/version or explicit skip | Real Pi availability command shows binary availability and extension flag, or explicit skip | `node scripts/pi-extension-runtime-smoke.mjs --scenario availability --json` exit 0: `available: true`, `helpExitCode: 0`, `extensionFlag: "-e"` | PROVEN | YES |
| PI-LIVE-002 | Gate criterion 2: plugin load and `get_commands` visibility | Real Pi RPC get_commands includes `larva-persona` and UI/status evidence | `node scripts/pi-extension-runtime-smoke.mjs --scenario get-commands --json` exit 0: RPC `supported: true`, response `success: true`, commands include `larva-persona`, stderr empty | PROVEN | YES |
| PI-LIVE-003 | Gate criterion 2: slash persona status | Real Pi RPC slash command execution commits selected persona/status | `node scripts/pi-extension-runtime-smoke.mjs --scenario slash-status --persona vectl-planner --json` exit 0: prompt `success: true`, status `larva: vectl-planner`, notify `Larva persona active: vectl-planner` | PROVEN | YES |
| PI-LIVE-004 | Gate criterion 2: startup status | Real Pi startup/session status keyed to initial persona | `node scripts/pi-extension-runtime-smoke.mjs --scenario startup-status --persona startup --json` exit 0: statusKey `larva`, statusText `larva: startup`, `get_state` success | PROVEN | YES |
| PI-LIVE-005 | Gate criterion 2: failure path | Real Pi RPC failure emits non-silent observable error | `node scripts/pi-extension-runtime-smoke.mjs --scenario failure-path --persona missing --json` exit 0: notify errors for missing and unparseable personas; prompt responses success; stderr empty | PROVEN | YES |
| PI-LIVE-006 | Gate criterion 6: command visibility not Tab proof | Evidence class separation and limitation record | Source and report distinguish RPC command visibility from wrapper provider Tab; `test-output/pi_tab_autocomplete_real_tui_smoke_or_limit.md` lines 27-40 states `--real-pi-tui` is harness-only and true rendered TUI observation is excluded/deferred pending PTY/API | PROVEN | YES |
| PI-LIVE-007 | Gate criterion 8: CI/local runtime gate cannot silently pass product failures | Pytest must fail plugin/RPC load failure and execute real runtime smoke where available | `uv run pytest tests/shell/test_pi_extension_real_runtime.py -v` exit 0: 16 passed, includes `test_rpc_skip_xfail_policy_does_not_hide_plugin_load_failure` and real Pi RPC scenarios all PASSED, not skipped/xfail | PROVEN | YES |
| PI-LIVE-008 | Gate criterion 8: legacy contract and supplemental runtime coverage both run | Combined command exact output | `uv run pytest tests/shell/test_pi_extension_contract.py tests/shell/test_pi_extension_real_runtime.py -v` exit 0: 63 passed | PROVEN | YES |
| PI-LIVE-009 | Gate criterion 7/non-goals: docs do not redefine PersonaSpec | Docs preserve opifex authority and Pi non-goals | `contrib/pi-extension/README.md` lines 3-7, 226-240; `README.md` lines 10-11, 244-248, 280-283 | PROVEN | YES |
| PI-TAB-001 | Gate criterion 3: command registration path preserved | Source and harness show `pi.registerCommand("larva-persona", { getArgumentCompletions, handler })` path | `contrib/pi-extension/larva.ts` lines 352-377; autocomplete smoke output `command: "larva-persona"`; `uv run pytest ... -k autocomplete -v` exit 0 | PROVEN | YES |
| PI-TAB-002 | Gate criterion 4: `ctx.ui.addAutocompleteProvider` wrapper present | Source installs provider if available | `contrib/pi-extension/larva.ts` lines 341-349 and 927-943 | PROVEN | YES |
| PI-TAB-003 | Gate criterion 4: intercepts only `/larva-persona <prefix>` | Source parser and delegation runtime proof | `larva.ts` lines 316-330; `node scripts/pi-extension-autocomplete-smoke.mjs --case delegate-other-input` exit 0: `delegated: true`, base item returned | PROVEN | YES |
| PI-TAB-004 | Gate criterion 4/5: Tab force uses argument prefix | Runtime wrapper harness, not direct completer/source token | `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl` exit 0: editorLine `/larva-persona vectl`, values `vectl-planner`, `vectl-reviewer`, `provesArgumentPrefix: true` | PROVEN | YES |
| PI-TAB-005 | Gate criterion 4/5: regular completion same path | Runtime wrapper harness, not direct completer/source token | `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-regular --prefix vectl` exit 0: `force: false`, same values and `provesArgumentPrefix: true` | PROVEN | YES |
| PI-TAB-006 | Gate criterion 4: uses `completePersonaIds(prefix, ctx)` and candidate shape | Source and runtime output prove exact string item shape | `larva.ts` lines 281-289 and 332-334; both tab smokes show `allValuesAreStrings: true`, `valuesEqualPersonaIds: true`, `exactShape: true` | PROVEN | YES |
| PI-TAB-007 | Gate criterion 4/5: delegates all other input | Runtime wrapper harness exercises base provider | `node scripts/pi-extension-autocomplete-smoke.mjs --case delegate-other-input` exit 0: calls include `/not-larva vectl`; `delegated: true`; base `file.txt` item preserved | PROVEN | YES |
| PI-TAB-008 | Gate criterion 5: list failure/malformed JSON returns null/no crash | Runtime wrapper harness exercises failure modes | `node scripts/pi-extension-autocomplete-smoke.mjs --case list-failure` exit 0: `failed: null`, `malformed: null`, `noCrash: true` | PROVEN | YES |
| PI-TAB-009 | Gate criterion 5: pytest exercises wrapper runtime cases | Test source and executed pytest prove wrapper harness, not direct completer only | `tests/shell/test_pi_extension_real_runtime.py` lines 28-61; `uv run pytest tests/shell/test_pi_extension_real_runtime.py -k autocomplete -v` exit 0: 4 passed | PROVEN | YES |
| PI-TAB-010 | Gate criterion 6: real TUI attempt/limitation has closure path | `--real-pi-tui` attempt recorded as harness-only; limitation explicit | `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl --real-pi-tui` exit 0 but output lacks live TUI markers; `test-output/pi_tab_autocomplete_real_tui_smoke_or_limit.md` lines 27-40 documents missing PTY/API and future closure path | PROVEN | NO |
| PI-TAB-011 | Gate criterion 7: docs explain behavior/troubleshooting/failure/non-goals | Documentation reviewed | `contrib/pi-extension/README.md` lines 108-145; `README.md` lines 255-272 | PROVEN | YES |

## Orphan Requirements

None. PI-LIVE-001..009 and PI-TAB-001..011 are mapped above.

## Runtime Evidence Reviewed

- availability: command `node scripts/pi-extension-runtime-smoke.mjs --scenario availability --json`, exit 0. Raw facts: Pi `available: true`, `helpExitCode: 0`, `extensionFlag: "-e"`.
- get_commands: command `node scripts/pi-extension-runtime-smoke.mjs --scenario get-commands --json`, exit 0. Raw facts: RPC `attempted: true`, `supported: true`, response `command: "get_commands"`, `success: true`, commands include `larva-persona`, stderr empty.
- slash_status: command `node scripts/pi-extension-runtime-smoke.mjs --scenario slash-status --persona vectl-planner --json`, exit 0. Raw facts: response `command: "prompt"`, `success: true`; UI status `larva: vectl-planner`; notify `Larva persona active: vectl-planner`.
- startup_status: command `node scripts/pi-extension-runtime-smoke.mjs --scenario startup-status --persona startup --json`, exit 0. Raw facts: UI statusKey `larva`, statusText `larva: startup`; `get_state` response success.
- failure_path: command `node scripts/pi-extension-runtime-smoke.mjs --scenario failure-path --persona missing --json`, exit 0. Raw facts: error notifications for `Unable to resolve persona missing` and `Invalid persona payload for unparseable`; stderr empty.
- autocomplete_force: command `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl`, exit 0. Raw facts: `force: true`, `editorLine: "/larva-persona vectl"`, values `vectl-planner`, `vectl-reviewer`, `provesArgumentPrefix: true`, `exactShape: true`.
- autocomplete_regular: command `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-regular --prefix vectl`, exit 0. Raw facts: `force: false`, same values, `provesArgumentPrefix: true`, `exactShape: true`.
- autocomplete_delegate: command `node scripts/pi-extension-autocomplete-smoke.mjs --case delegate-other-input`, exit 0. Raw facts: base provider called for `/not-larva vectl`; `delegated: true`; base item returned unchanged.
- autocomplete_list_failure: command `node scripts/pi-extension-autocomplete-smoke.mjs --case list-failure`, exit 0. Raw facts: `failed: null`, `malformed: null`, `noCrash: true`.
- autocomplete_pytest: command `uv run pytest tests/shell/test_pi_extension_real_runtime.py -k autocomplete -v`, exit 0. Raw facts: 4 selected tests passed, covering force, regular, delegation, list-failure wrapper runtime cases.
- real_tui_attempt_or_limit: command `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl --real-pi-tui`, exit 0 but raw output is the same provider harness JSON and does not launch/observe a real TUI. Limitation artifact: `test-output/pi_tab_autocomplete_real_tui_smoke_or_limit.md` lines 27-40.
- full_runtime_gate: command `uv run pytest tests/shell/test_pi_extension_real_runtime.py -v`, exit 0. Raw facts: 16 passed.
- combined_ci_gate: command `uv run pytest tests/shell/test_pi_extension_contract.py tests/shell/test_pi_extension_real_runtime.py -v`, exit 0. Raw facts: 63 passed.
- invar_guard_changed: tool `invar_guard(path=/Users/tefx/Projects/larva/.vectl/worktrees/gate, changed=true)`, status passed; no changed source files at time run.

## Real-Integration-vs-Fixture Distinction

- Real Pi integration evidence: runtime smoke commands for availability, get_commands, slash-status, startup-status, and failure-path launched the installed `pi` binary with extension flag `-e`; RPC was `supported: true` and produced UI/status/command responses.
- Fixture/harness evidence: autocomplete smoke uses the real extension module and deterministic fake Larva CLI but does not launch a rendered Pi TUI. This is valid for wrapper/provider behavior only; it is not counted as live rendered Tab UI proof.
- Explicit limitation: the `--real-pi-tui` flag is syntactically accepted by the script argument parser but is not implemented as PTY/TUI automation. The limitation record provides a future closure path requiring a PTY or Pi test API.

## E1-E5 Review Notes

- E1 Spec Alignment: PASS. Required PI-LIVE/PI-TAB rows have positive proof or non-blocking explicit limitation; no PersonaSpec redefinition in docs.
- E2 Architecture/Runtime Boundary: PASS. Shell/runtime integration remains in Pi extension; no new core/I/O boundary issue observed in reviewed source.
- E3 DX/Maintainability: PASS. Troubleshooting commands are documented; failure modes return `null`/observable notifications instead of silent crash.
- E4 SE/Production Quality: PASS. Runtime failure path, malformed list behavior, full runtime pytest, and combined contract/runtime pytest pass.
- E5 User-Facing Surface Conformance: PASS with explicit limitation. Real Pi RPC proves extension/slash/status liveness; wrapper harness proves provider behavior; rendered TUI Tab remains not directly automated and is not misrepresented as proven.

## Blocker Ledger

- blockers: []
- should_fix: []
- suggestions:
  - Add a true PTY/Pi TUI automation seam for rendered Tab completion when Pi exposes a stable test interface; current gate explicitly excludes this as non-blocking tooling limitation.
- tech_debt:
  - `scripts/pi-extension-autocomplete-smoke.mjs --real-pi-tui` accepts the flag without implementing real TUI behavior; keep limitation artifact until the script rejects unsupported flags or implements PTY automation.

## Closure Fields

- headline: PASS
- verdict: PASS
- blockers: []
- proof_gap_status: NONE
- blocking_status: CLOSED
- gate_open_allowed: true
- orchestrator_action_hint: COMPLETE
- uncertainty_sources:
  - True rendered Pi TUI Tab UI was not observed; limitation is explicit and non-product/non-blocking because real Pi RPC liveness and wrapper provider behavior are independently proven.
- DO_NOT_COMPLETE: false

## checklist_receipt

- Review evidence from `node scripts/pi-extension-runtime-smoke.mjs --scenario availability --json` and verify Pi availability/version or explicit skip condition: PROVEN — command exit 0; Pi available true, helpExitCode 0, extensionFlag `-e`.
- Review evidence from `node scripts/pi-extension-runtime-smoke.mjs --scenario get-commands --json` and verify plugin load plus `larva-persona` command visibility: PROVEN — command exit 0; RPC supported true; get_commands success true; commands include `larva-persona`.
- Review evidence from `node scripts/pi-extension-runtime-smoke.mjs --scenario slash-status --persona vectl-planner --json` (or documented fixture persona) and verify persona command execution/status: PROVEN — command exit 0; prompt success true; status `larva: vectl-planner`; notify active.
- Review evidence from `node scripts/pi-extension-runtime-smoke.mjs --scenario startup-status --persona startup --json` and verify startup `session_start` keyed status: PROVEN — command exit 0; statusKey `larva`; statusText `larva: startup`; get_state success.
- Review evidence from `node scripts/pi-extension-runtime-smoke.mjs --scenario failure-path --persona missing --json` and verify non-silent failure observation: PROVEN — command exit 0; notify errors for missing and unparseable personas.
- Review `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl` raw output and verify wrapper force mode returns persona candidates through argument prefix `vectl`: PROVEN — command exit 0; `force: true`; values `vectl-planner`, `vectl-reviewer`; `provesArgumentPrefix: true`.
- Review `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-regular --prefix vectl` raw output and verify wrapper regular mode returns the same candidate path: PROVEN — command exit 0; `force: false`; same values; `provesArgumentPrefix: true`.
- Review `node scripts/pi-extension-autocomplete-smoke.mjs --case delegate-other-input` raw output and verify unrelated input delegates to base provider: PROVEN — command exit 0; `delegated: true`; base provider item returned unchanged.
- Review `node scripts/pi-extension-autocomplete-smoke.mjs --case list-failure` raw output and verify provider returns `null`/no crash for list failure or malformed JSON: PROVEN — command exit 0; `failed: null`, `malformed: null`, `noCrash: true`.
- Review `uv run pytest tests/shell/test_pi_extension_real_runtime.py -k autocomplete -v` and confirm it exercises wrapper runtime cases, not only direct command completer calls: PROVEN — command exit 0; 4 wrapper-harness tests passed; test source calls `scripts/pi-extension-autocomplete-smoke.mjs` cases, not direct source-token assertions.
- Review real TUI attempt or limitation record from `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl --real-pi-tui`; unresolved live TUI evidence has explicit closure path: PROVEN — command exit 0 but output is harness-only; limitation artifact lines 27-40 documents missing PTY/Pi TUI automation and future closure path.
- Review documentation updates for `/larva-persona` Tab completion behavior, troubleshooting, delegation, failure behavior, and no prompt catalogue/cache/fuzzy: PROVEN — `contrib/pi-extension/README.md` lines 108-145 and `README.md` lines 255-272.
- Gate decision basis maps every PI-LIVE and PI-TAB row to PROVEN/BLOCKED/SKIPPED with closure path; no orphan requirements remain: PROVEN — ledger maps PI-LIVE-001..009 and PI-TAB-001..011; all PROVEN, no orphan requirements.

## Action Summary

Independent gate review completed. No product code modified. Gate report artifact added under `test-output/`.

## Verification Run (Command + Exit Code)

- `node scripts/pi-extension-runtime-smoke.mjs --scenario availability --json` — exit 0.
- `node scripts/pi-extension-runtime-smoke.mjs --scenario get-commands --json` — exit 0.
- `node scripts/pi-extension-runtime-smoke.mjs --scenario slash-status --persona vectl-planner --json` — exit 0.
- `node scripts/pi-extension-runtime-smoke.mjs --scenario startup-status --persona startup --json` — exit 0.
- `node scripts/pi-extension-runtime-smoke.mjs --scenario failure-path --persona missing --json` — exit 0.
- `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl` — exit 0.
- `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-regular --prefix vectl` — exit 0.
- `node scripts/pi-extension-autocomplete-smoke.mjs --case delegate-other-input` — exit 0.
- `node scripts/pi-extension-autocomplete-smoke.mjs --case list-failure` — exit 0.
- `uv run pytest tests/shell/test_pi_extension_real_runtime.py -k autocomplete -v` — exit 0, 4 passed.
- `node scripts/pi-extension-autocomplete-smoke.mjs --case tab-force --prefix vectl --real-pi-tui` — exit 0, harness-only; limitation recorded.
- `uv run pytest tests/shell/test_pi_extension_real_runtime.py -v` — exit 0, 16 passed.
- `uv run pytest tests/shell/test_pi_extension_contract.py tests/shell/test_pi_extension_real_runtime.py -v` — exit 0, 63 passed.
- `invar_guard changed=true` — passed.

## Artifacts Modified

- Added `test-output/gate_pi_runtime_liveness_hardening_20260601.md`.
