# Native Pi extension cutover

## Status and authority

Accepted direction. Native Pi 0.85.1 is the session entry point; this package
implements normal discovery, CLI binding, admission, main preference persistence,
and retained child capsules. Operator installation onto a user agent directory
remains a separate persistent-config action. Python `larva pi` retirement is the
next producer.

This document supersedes launcher ownership, parent settings capsules,
launcher-marker admission, old-Pi compatibility, and launcher maintenance work in
[Pi integration](pi-coding-agent-integration.md) and
[thinking isolation](pi-thinking-level-isolation.md). Their unaffected business
contracts remain applicable. In particular, retain:

- [persona-switch policy](../docs/reference/PI_AGENT_PERSONA_SWITCH_POLICY.md);
- [async subagent contracts](../docs/reference/PI_EXTENSION_ASYNC_SUBAGENTS.md);
- [persona invocation](../docs/reference/PI_EXTENSION_PERSONA_INVOCATION.md);
- [compaction focus](../docs/reference/PI_EXTENSION_COMPACTION_FOCUS.md).

No PersonaSpec, registry, shared opifex contract, public subagent result, or
session-record schema changes are part of this cutover. Shared meaning remains
owned by opifex. This document supplies implementation boundaries, without
requiring an additional architecture-basis artifact or a particular private
class layout, helper module, or serialization format.

## Decision and scope

Use native `pi` with one normally installed Larva extension. Retain the Python
Larva CLI as an on-demand data backend. Remove the Python `larva pi` command and
its launcher-specific implementation once the native target passes acceptance.
Do not maintain two runtime entry points, add a replacement Node launcher, patch
Pi, or install a shell alias that disguises another wrapper as `pi`.

The first acceptance target is the standard Node-installed Pi 0.85.1 CLI, tested
on macOS with Node v26.7.0. The implementation uses that host's public extension
API, including `ctx.mode` and session-local model/thinking setters. Older Pi
compatibility is outside scope. Newer Pi releases and Bun, standalone-binary,
embedded-SDK, or other launch forms require their own applicable evidence;
version ordering alone does not establish compatibility.

Preserve the currently supported TUI, RPC, and print/JSON behaviors within this
host target. The change does not grant new UI capabilities to headless modes.

### Accepted behavior changes

| Surface | Native target |
|---|---|
| Main global settings | Pi saves ordinary preferences normally; there is no private main settings copy or exit-time restoration |
| Initial failure timing | Larva can validate after its extension loads and before the first model request; it cannot validate before Pi starts or before Pi's earlier setup |
| Extension disabling | `pi --no-extensions` disables automatic Larva loading; explicit `-e` loading remains available |
| CLI entry | Scripts using `larva pi` must move to native `pi`; no forwarding compatibility command is required |
| Host compatibility | Old-Pi fallbacks are removed where no supported-host consumer remains |

Pi owns discovery and load-error handling before Larva can execute. If Larva is
disabled or fails to load, it cannot enforce a startup policy or claim to be
active. Native Pi diagnostics apply. The startup guarantees below apply to the
loaded extension; acceptance must also exercise missing/broken installation with
an explicit persona argument so an intended persona request cannot silently run
as a vanilla model request.

### Explicit non-goals

- No general environment sanitizer, project-venv selector, or reconstruction of
  an environment already overwritten by `uv`.
- No automatic cleanup of previously misinstalled Python dependencies.
- No main whole-settings isolation, exit-time global-settings rollback, or
  isolation of arbitrary project files, credentials, or tool I/O.
- No replacement persona registry, persistent bridge daemon, scheduler, or
  duplicate native-specific persona/subagent state machine.
- No rewriting persona prompts or introducing agent-system policy artifacts.

## Ownership and dependency boundaries

```text
Project shell
  └─ Native Pi + Larva extension
       ├─ Project tools, using the caller's project environment
       ├─ Bound Larva CLI, using its own interpreter in a subprocess
       └─ Native child Pi, with explicit extensions and a private settings capsule
```

| State or service | Canonical owner | Consumers and write rule |
|---|---|---|
| Persona content | Existing Larva CLI/registry | Extension uses `list`/`resolve`; no private-registry parsing |
| Active persona, tool policy, temporary lease | Existing extension runtime | Reuse commit/rollback, invocation, and restore boundaries |
| Main global/project Pi settings | Pi | Normal native behavior; Larva persona setters do not save global defaults |
| Pi session history and custom entries | Pi session manager | Durable, outside temporary capsules; keep existing formats |
| Child global settings | One capsule per child process | Copy from the base agent directory; never merge into base |
| Model-map, thinking/tool policy, cache/config roots | Existing Larva configuration owners | Keep existing paths and override semantics |
| Live child status, terminal result and callback authority | Parent extension process | Retain exact-handle APIs; presentation caches remain view-only |
| Shell activation environment | Caller/project | Extension must not activate its Python backend in the parent |
| Pi launch identity and CLI binding | Extension startup context | Fixed command inputs for child launch and backend calls |

The extension depends on Pi APIs for session behavior and on the CLI protocol for
persona data. The Python CLI has no dependency on a Pi launcher. Parent and child
use the same extension implementation; only their explicit role/startup inputs
and settings ownership differ.

## Distribution and operator setup

### One extension package

Make `contrib/pi-extension` a normal Pi package with an explicit `pi.extensions`
entry. Ship `larva.ts`, its adjacent `child-rpc-frame-preload.mjs`, and required
runtime dependencies together. A local package install is sufficient for the
first delivery; publishing to npm is not required by this design.

The Pi package becomes the extension distribution owner. Remove launcher-only
Pi resource inclusion from the Python wheel when its launcher consumer is
removed. Preserve unrelated wheel resources and Python CLI/API functionality.
Do not maintain a second installed Larva extension copy inside the wheel as a
parallel native entry point.

Use the supported host in the extension development dependency and runtime gates.
The extension development dependency is Pi 0.85.1. Direct `@earendil-works/pi-tui`
is pinned to exact `0.85.1` from that host's installed UI package and the imported
custom-component primitives (`Input`, `Key`, `Markdown`, `SelectList`, `matchesKey`,
`truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`).

Exactly one intended Larva instance may register tools and own session state.
Pi's canonical-path deduplication is insufficient for two different copies.
Installation must remove obsolete loading references with operator approval;
runtime duplicate detection must diagnose the conflict before the second copy
registers stateful handlers. No global registry service is needed.

### CLI binding

Retain `LARVA_CLI_ARGV_JSON` as the single explicit backend-command input for this
target. It is a nonempty JSON argv array with an absolute executable as its first
item and string arguments. Invoke it without shell evaluation. Installation
instructions must establish this binding once; a new configuration file or
bridge daemon is unnecessary.

For example, an operator may bind an independently installed console script:

```sh
export LARVA_CLI_ARGV_JSON='["/absolute/path/to/larva"]'
```

The executable may be backed by its own venv shebang. This does not require that
venv's activation or its entire `bin` directory on the project PATH. Do not assume
`python -m larva` works: the current package has no `__main__.py`.

A configured binding that fails must not silently switch to another installation.
The native target does not automatically try ambient `larva`, download through
`uvx`, or create an environment when this binding is missing. Report the missing
or invalid binding and the setup requirement. An unselected `larva:none` session
can remain usable; persona operations are unavailable until their backend is
usable. An explicit initial persona request must fail admission in that case.

The backend still receives the existing command suffixes `list --json` and
`resolve <id> --json`, existing configuration/registry context, ten-second timeout,
JSON validation and error mapping. Stderr remains diagnostic. The extension does
not adopt an environment emitted by the CLI or source an activation script.

### Setup and disable workflow

After implementation, the supported workflow is to install the extension through
Pi's normal package mechanism, configure the CLI binding, and launch native Pi
from a normal project shell. A local-package example is
`pi install /absolute/path/to/larva/contrib/pi-extension`; it becomes an operator
instruction only after the package-discovery gate passes.

Setup must target the real base Pi agent directory. Do not install from a shell
that still points `PI_CODING_AGENT_DIR` at an old launcher capsule. Verify that
`pi` resolves to the native executable rather than an old alias or wrapper.

Pi's ordinary package removal/disable workflow disables Larva. To disable other
automatically discovered extensions while keeping Larva, explicitly load the
installed entry with `pi --no-extensions -e /absolute/path/to/larva.ts`.

## Native startup interface and admission

The following extension flags are target interfaces; they are not implemented at
the time this design is written:

| Flag | Type and meaning |
|---|---|
| `--larva-persona <id>` | Optional persona ID using existing Larva ID validation |
| `--larva-agent-persona-switch <mode>` | Optional `manual`, `confirm`, `auto`, or `free`; same policy as `/larva-mode` |

Fresh `pi` without an initial persona starts with `larva:none`. Fresh main mode
defaults to `confirm`. Invalid flag values delivered to Larva fail with
`LARVA_BAD_INPUT`. Pi-owned syntax failures, including missing string values and
unknown flags, retain Pi's own diagnostics and nonzero exit; Larva cannot replace
errors emitted before its session hooks. Unknown stored/environment mode values
retain the existing warn-and-`confirm` behavior. The extension flag supplies the
startup mode ahead of the existing `LARVA_PI_AGENT_PERSONA_SWITCH` environment
input; session mode records retain their existing precedence. Native mode flags
do not override later manual session choices on every hook or reload.

Register flags during extension loading, then consume final values during a
lifecycle stage where Pi has applied them. Do not read them as final values from
the module factory. Startup persona inputs are admission inputs, not authority
markers proving that a Python launcher ran.

Admission separates unconditional explicit-ID preflight from runtime activation.
An explicit initial persona ID must resolve through the backend even when a
stored main-session selection will win. Model-map, thinking and tool enforcement
are validated for the persona actually selected for activation/restoration. Do
not reject a valid stored selection merely because an unused, resolvable explicit
persona has an unavailable runtime model. Existing global configuration-override
path validation retains its scope.

An explicit-ID resolution failure, or a runtime admission failure when activating
the explicit persona in a fresh session, must exit nonzero before any model
request, with no false active-persona state. Stored-persona restore failures keep
their existing nonfatal handling, including when explicit-ID preflight succeeded.
If the extension controls a fatal exit status, use `2`. A thrown
`before_agent_start` hook error or an unverified shutdown call alone is
insufficient. Real TUI/RPC/print tests must prove the no-request boundary, nonzero
exit and terminal cleanup; the current feasibility probe does not establish them.

Keep existing Larva error codes for missing persona, unavailable model, invalid
policy and tool-enforcement failures. Keep the existing recognized
`larva pi: <ERROR_CODE>: <message>` fatal diagnostic framing during the cutover:
current child error classification consumes it. That diagnostic prefix grants no
launcher authority and does not require retaining the command. Renaming this
protocol is outside the cutover.

Ordinary list/completion failure and in-session switch failure retain their
existing nonfatal/error-result behavior. Do not turn a failed manual switch into
a successful switch to `larva:none`. Initialization must remain idempotent across
factory setup, session start, reload and subsequent model hooks.

### Session restoration

These rules concern main-session restoration. Child resume retains its existing
explicit invocation and verified-route contract described below.

Preserve current implemented and behavior-tested restoration semantics:

- A valid stored persona selection takes precedence over the initial persona
  input on resume/reinitialization. A fresh session uses the explicit input.
- Unconditional explicit startup preflight resolves the requested ID; it does not
  test an unused persona's runtime model/thinking/tool route. Do not bypass that
  ID resolution through an early stored-state return.
- Resolve stored persona IDs through the current registry and the existing commit
  pipeline. Preserve digest-drift and nonfatal restore-unavailable behavior.
- Preserve later manual model selections and session thinking. Do not repeatedly
  reapply a startup default after restoration.
- Keep mode records, new/fork behavior, temporary-lease restoration and
  continuation handling distinct from initial persona admission.

The old integration document's restore subsection says explicit persona wins.
`initializeSession` and
`test_active_persona_session_restore_session_commit_wins_over_explicit_startup_persona_behavior`
implement the opposite. The choice here follows the user's request to preserve
current session experience; the native cutover must not silently reverse it.
That old prose is superseded, not a second acceptance requirement.


### Session restoration

Preserve current implemented and behavior-tested restoration semantics:

- A valid stored persona selection takes precedence over the initial persona
  input on resume/reinitialization. A fresh session uses the explicit input.
- Explicit startup persona validation is still required, even when stored state
  will determine the restored persona. Do not bypass preflight through an early
  stored-state return.
- Resolve stored persona IDs through the current registry and the existing commit
  pipeline. Preserve the existing digest-drift and restore-unavailable behavior.
- Preserve later manual model selections and session thinking. Do not repeatedly
  reapply a startup default after restoration.
- Keep mode records, new/fork behavior, temporary-lease restoration and
  continuation handling distinct from initial persona admission.

The old integration document's restore subsection says explicit persona wins.
`initializeSession` and
`test_active_persona_session_restore_session_commit_wins_over_explicit_startup_persona_behavior`
implement the opposite. The choice here follows the user's request to preserve
current session experience; the native cutover must not silently reverse it.
That old prose is superseded, not a second acceptance requirement.

## Main settings and persona-local state

Native main uses Pi's real agent directory and normal settings storage. Larva
must not create a parent capsule, redirect that storage after initialization, or
restore an old global settings snapshot on exit. This permits normal preference
writes and avoids overwriting another session's legitimate changes.

Larva's automatic persona/model-map/borrow operations use Pi's public
session-local model and thinking APIs. They may record changes in the current
session transcript; they must not write `defaultProvider`, `defaultModel` or
`defaultThinkingLevel` as a side effect of persona selection. The session record
may survive exit and participate in resume without becoming a default for a new
unrelated session.

User actions that explicitly save defaults remain native Pi actions. Larva does
not prevent the user from deliberately saving a model or thinking default.
Ordinary settings preserve Pi's own semantics rather than forcing every UI action
to become global.

A temporary borrow captures the actual pre-borrow runtime model and thinking,
including manual choices, and restores them through the existing lease boundary.
Retain continuation-aware restoration and manual-switch precedence. Existing
commit/rollback and visible restore-failure behavior remain required; do not
announce a successful persona while model, tools or restoration failed.

## Runtime identity and process environment

### Fixed launch information

The extension supplies the information formerly produced by the launcher:

| Information | Source and invariant |
|---|---|
| Pi executable/argv prefix | The supported current Node/Pi installation, resolved to absolute command inputs; never a later bare-PATH `pi` lookup |
| Extension entry and frame preload | The actual installed package entry and its paired resource |
| Larva backend argv | The explicit CLI binding above |
| Base agent directory | Pi's effective base directory for main; explicitly carried to child startup |
| Project cwd and environment | Parent session/project context, excluding child-only launch inputs when constructing another child |

On the first supported install form, a validated absolute Node executable and Pi
CLI script can represent the launch prefix. Capture only runtime launch identity,
not the parent's whole user argv, prompts or resume flags. Do not derive the
extension path from unrelated main CLI arguments.

If the supported runtime or entry/preload pair cannot be established, report a
bounded diagnostic and reject affected child startup with
`LARVA_CHILD_START_FAILED` before spawning or prompting. Unsupported hosts must
not be presented as full-capability Larva sessions. No recursive launcher fallback
or old-Pi probing path is allowed.

The internal context type and parent-to-child serialization remain implementation
choices. Remove reliance on `LARVA_PI_LAUNCHED`,
`LARVA_PI_INTERACTIVE_TUI`, and launcher-owned `REAL_BIN`/extension metadata as
external prerequisites. Retain or replace child-specific route/frame inputs as
needed by their existing consumers; deleting the launcher does not imply deleting
all `LARVA_PI_*` configuration overrides.

### Environment guarantee

Main starts in the caller's environment. Larva must not prepend the backend's
venv `bin`, set main `VIRTUAL_ENV`, or import backend activation into
`process.env`. CLI subprocesses use their own interpreter without changing the
parent environment. Child Pi inherits the same project environment contract,
with explicit child-only Pi configuration layered onto it.

All subprocess seams must preserve this boundary. Inspect `currentEnv`,
`spawnJsonCommand`, and `startChild`; stale launch-context merges must not bring
back old launcher activation or copy another child's capsule/role into a new
child. This does not call for a blanket blacklist of environment variables.

If the caller already activated the wrong venv or runs native Pi through
`uv run --project Larva`, native Pi can still inherit that environment. Existing
processes do not become clean when the command is removed, and historical wrong
installations remain separate cleanup work. There is no attempt to reconstruct
the original venv from PATH fragments.

## Child startup and lifecycle

The parent extension starts native child Pi directly. Preserve these boundaries:

- An explicit extension allowlist and Larva entry; do not copy the parent's entire
  automatically loaded extension set.
- A private settings capsule for every new or resumed child process, populated
  from the base agent directory, not the main session's temporary runtime model.
- Directory mode `0700`, settings mode `0600`, persistent sessions outside the
  capsule, bounded cleanup on terminal paths, and no merge into base settings.
  Cleanup must not follow links into base resources.
- Independently resolved persona, active model-map route and thinking policy for
  each invocation/resume. Pass explicit model/thinking and verify the observed
  state before sending the task prompt; retain requested/effective clamping and
  route-generation fencing.
- Startup/resume persona and preselected route inputs remain child-specific.
  Preserve the existing child switch-policy/session semantics, including the
  initial `manual` setting; do not accidentally inherit the main mode flag.
- Frame preload executes before Pi captures its stdout writer. The existing
  preload remains necessary on the tested current runtime; its old-version
  filename/document history does not make it removable compatibility code.
- Preserve accepted receipts, exact task handles, readiness APIs, terminal
  authority, bounded result/artifact delivery, callback deduplication and stale
  suppression, cancellation precedence and the consecutive no-progress watchdog.
- Preserve new/resumed session history, callback continuation through real Pi,
  and parent state isolation. Resume reuses the existing public task/session
  semantics; no new task-handle or result schema is introduced.

Capsules isolate Pi's normal global-settings path. Other linked agent resources,
project settings and tool filesystem effects retain their existing ownership;
this is not a new filesystem or credential isolation guarantee.

## UI, hooks and extension consumers

Use `ctx.mode` to distinguish TUI from RPC/print; `hasUI` alone is insufficient
because Pi 0.85.1 RPC also reports it as true. Preserve selector, shortcut,
autocomplete, mentions, status, Subagent Console and log rendering behavior in
supported modes. Confirm mode without a usable confirmation interface still
refuses safely.

Normal package discovery can change extension hook ordering relative to explicit
CLI extensions. Test the existing consumers' actual contracts: one primary
persona overlay, retention of non-Larva system content, effective tool-call
policy, and the invocation/compaction event interfaces. Do not promise identical
ordering with arbitrary third-party extensions.

Preserve current persona invocation inputs/results, model/auth/signal ownership,
compaction focus and native fallback behavior. Reuse the existing implementation;
no migration-specific event bus or alternate compaction service is required.

Use the current host's real lifecycle events for session changes, turn/continuation
boundaries and shutdown. Verify active-child shutdown cleanup in the launched
host. Existing cleanup checks performed only after children finish cannot prove
parent shutdown behavior with a child still running. Remove dead compatibility
handlers only after preserving the events and terminal behavior current consumers
need.

## Failure contract

| Failure | Required visible outcome |
|---|---|
| Larva disabled or load fails before it executes | Pi's native behavior/diagnostics; no claim that Larva enforced admission or is active |
| Pi rejects flag syntax, missing values or unknown flags | Native diagnostic and nonzero exit; no requirement to rewrite it as a Larva error |
| Invalid flag value reaches Larva validation | `LARVA_BAD_INPUT`, nonzero admission failure, no first model request |
| CLI binding absent/malformed/unusable | Setup diagnostic; existing list/resolve error projection; fatal if explicit-ID preflight depends on it; no alternate install/download |
| Explicit-ID resolution fails | Existing `LARVA_PERSONA_NOT_FOUND` fatal diagnostic, nonzero exit before first model request, even if a stored selection exists |
| Fresh explicit persona model/policy/tool admission fails | Existing Larva error code and fatal framing; nonzero exit before first model request |
| Stored persona restore fails | Existing nonfatal restore-unavailable status, including after successful explicit-ID preflight; no false active persona |
| In-session switch/profile/borrow restore fails | Existing unchanged/rollback/partial-failure outcome as applicable, with visible failure |
| Duplicate extension copies | Installation conflict diagnostic; no second stateful registration |
| Unsupported/ambiguous child runtime or missing preload | `LARVA_CHILD_START_FAILED` before task prompt; no bare-PATH or launcher fallback |
| Capsule creation/permission failure | Fail child startup; never silently use base settings |
| Child route cannot be verified | Existing route/startup failure before task prompt |
| Child RPC/runtime/cancel failure | Existing `LARVA_CHILD_PROTOCOL_FAILED`, `LARVA_CHILD_RUNTIME_FAILED`, or `LARVA_CHILD_CANCELLED` mapping |
| Capsule cleanup failure | Bounded diagnostic; never remove base targets or conceal an active process |

The inspected Pi 0.85.1 CLI records missing-value/unknown-flag and extension-load
errors in startup diagnostics and exits `1` on those errors before normal mode
execution. This is source evidence from `applyExtensionFlagValues` and `main`,
not a fresh runtime result. Keep the launched acceptance cases for these paths.


## Implementation and cutover sequence

This is a dependency outline for implementation owners, not an execution Plan.

1. Establish expected-red native startup, UI and child-bootstrap tests against the
   supported host. Freeze the retained behavior matrix below and the accepted
   settings/error-timing/disable differences.
2. Add normal package discovery, fixed CLI/runtime binding, native flags and
   lifecycle admission. Reuse existing persona, route, child and UI state owners.
3. Remove launcher-marker gates, parent capsule setup, old-host fallbacks with no
   remaining consumer, and implicit CLI-install fallbacks. Keep current child
   framing and capsule mechanisms.
4. Once native behavior passes, remove `larva pi`, its CLI registration and shell
   implementation, wheel-owned Pi resources, and launcher-only tests/helpers.
   Retarget meaningful behavior tests to native entry; do not delete retained
   policy/session/child assertions just because their old harness used a launcher.
5. Update user guides, reference entrypoint examples, package/dependency metadata,
   and affected CI/runtime harnesses. Then perform the explicitly authorized
   installation and cutover on the intended base agent directory.

Implementation scope includes `contrib/pi-extension/larva.ts`, its package and
lock metadata, the paired preload when necessary, `src/larva/shell/pi.py`, the
`pi` registration in `src/larva/shell/cli.py`, Python wheel inclusion in
`pyproject.toml`, relevant tests/scripts, and Pi-facing documentation. This is a
removal/adapter change; it does not require broad private-module reorganization.

No separately maintained compatible launcher release is required. Until native
acceptance, the repository still contains the old implementation; documentation
must distinguish target commands from currently usable commands.

### Installation, upgrade and rollback

Installation is a persistent user-config operation and needs the corresponding
execution authorization. Record the specific package/config references changed;
do not rewrite unrelated settings. Settle or explicitly stop affected live child
work before changing installed resources used by those sessions. Start native Pi
from a clean project shell and validate it with no launcher markers.

Upgrade must not silently select another CLI installation for an already running
parent. Prefer a fresh process after package replacement; validate explicit reload
for idempotence separately. Uninstall removes only Larva loading/configuration
that the operation owns, not registry data, session history or unrelated Pi files.

Rollback may disable the new extension or restore the previously installed
release/configuration. It does not require maintaining a second launcher in the
new code. Preserve sessions and user settings. Ordinary settings intentionally
saved under native Pi must not be overwritten with an old capsule snapshot.

## Acceptance matrix

Startup regression cases must distinguish Pi-owned syntax failures from Larva
value validation. For main resume, a valid stored persona plus a resolvable but
unused explicit persona with an unavailable model must still restore the stored
selection; an unresolvable explicit ID must fail preflight. A stored-persona
restore failure remains nonfatal after successful explicit-ID preflight. These
cases prevent broadening preflight into validation of a route that will not run.


The retained requirement is behavior, not identical source structure or old
launcher argv. Run interface/state-transition tests and launched-surface tests
where the host boundary matters.

| Area | Required observation |
|---|---|
| Package/setup | Clean scratch installation automatically loads exactly one Larva and its dependencies; disable, explicit `-e`, duplicate copies and missing resources behave as specified |
| Native admission | No launcher markers; fresh persona success; invalid ID/model/policy/tools/flags produce the specified outcome before any first request, in relevant TUI/RPC/print modes |
| Restore | Real saved session reopening, stored/initial precedence and preflight, manual model/thinking preservation, mode restore, new/fork and reload without duplicate commits |
| Persona policy | manual/confirm/auto/free, denial without UI, temporary borrow, continuation boundary, actual origin model/thinking restoration and visible restore failures |
| Main settings | Ordinary theme save survives restart; automatic persona/profile/borrow operations leave global model/thinking defaults unchanged; explicit user save remains possible |
| UI | Real TUI selector, shortcut, mentions/completion, console/log view and cancellation; RPC/print do not attempt unsupported overlays |
| Child route | New/resume independently resolves and verifies model/thinking, permitted clamping, route fencing and unchanged parent state |
| Child transport | Actual native Pi, explicit extension allowlist, pre-start frame binding and oversized-output handling |
| Async lifecycle | Accepted vs terminal result, exact-handle status/events/wait/select, callback continuation, cancellation, watchdog, duplicate/stale suppression and output artifacts |
| Cleanup | Success, startup failure, RPC/runtime failure, cancellation, timeout and parent shutdown with a live child; no remaining owned processes or capsule deletion outside the owned root |
| Persistence | Child session history survives process/capsule cleanup and resume; presentation caches cannot become execution authority |
| Environment/backend | With independent scratch backend A and project B, main and child tools retain B; actual native-tool installation targets B; bound CLI list/resolve still works; no venv remains absent rather than becoming A |
| Extension consumers | Actual persona invocation and compaction focus/fallback interfaces; prompt/tool-policy composition with representative co-loaded extensions |
| Repo/cutover | Applicable full repository tests and `invar guard`; Python CLI/API remain usable after launcher removal; no documentation-only token test counted as behavior evidence |

Use disposable environments and fixtures for installation-target tests. Use an
owned loopback provider for deterministic protocol/lifecycle observations; this
establishes no model-reasoning or persona-compliance claim. Do not weaken retained
assertions or mock the seam under test to make migration tests pass. Old
launcher-only and phrase-presence assertions are not native acceptance criteria.

## Observed evidence and remaining verification

Inspection baseline: Larva commit `bfe62119426111da232253d97f942e2cf42a1e59`, Pi
0.85.1 and Node v26.7.0. No implementation change is included in this document.

### Environment counterexample

In disposable A/B venvs, `B/bin/python -m maturin develop --bindings bin --offline`
with `VIRTUAL_ENV=A` and A/bin on PATH installed the native binary into A, not B.
With A activation removed, it failed to find an active venv; explicit B activation
installed into B. Actual launcher environment construction preserved A activation.
Absolute Larva CLI invocation worked without activating A or exposing its bin.

### Main settings distinction

Actual native TUI/RPC extension setters changed model/thinking without modifying
`defaultProvider`, `defaultModel`, or `defaultThinkingLevel`. This is a scoped
observation, not an all-settings claim. A separate real TUI experiment used
`ctx.ui.setTheme("light")` from a dark baseline:

| Launch | Current theme | Base theme after exit | Relaunch theme |
|---|---|---|---|
| Native Pi | light | light | light |
| Actual `larva pi` | light | dark | dark |

All four launches exited zero and wrapper capsules were removed. Pi source
supports the distinction: `AgentSession.setModel`/`setThinkingLevel` save global
defaults only with explicit persistence; extension bindings omit it, while theme
settings have a normal persistent path. Settings storage is constructed before
extension loading.

### Child feasibility

A Node driver started the installed main Pi directly, with explicit bootstrap
information and a synthetic CLI. Unchanged Larva spawned actual Pi children for
new/resume, delivered two successful callbacks through real `pi.sendMessage`,
retained both child turns in one session, and recorded callbacks in the parent.
Four requests went only to the owned loopback provider. No observed driver/main/
child process or capsule remained after reconciliation.

The main fixture called the real registered tool executor; it did not evaluate a
model's decision to call that tool. These observations prove the explicit
bootstrap seam. They do not prove native automatic discovery, complete UI,
initial-failure admission, active-child parent shutdown, every cancellation/error
branch, or the unimplemented native package's full parity.

Relevant source anchors include `pi.py::_build_child_env` and
`_create_pi_capsule`; `larva.ts::initializeSession`, `handlePersonaCommand`,
`launcherArgs`, `startChild`, `currentEnv` and `spawnJsonCommand`; and the existing
session-restore behavior tests in `tests/shell/test_pi_extension_contract.py`.

Supplemental local investigation artifacts are ephemeral and are not required CI
inputs or substitutes for the acceptance matrix:

- `/tmp/larva-env-audit.pSGsLZ/logs/results.json`
- `/tmp/larva-env-audit.pSGsLZ/logs/cli-seam.json`
- `/tmp/larva-env-audit.pSGsLZ/native-pi-check/summary.json`
- `/tmp/larva-env-audit.pSGsLZ/parity-check/summary.json`
- `/tmp/larva-env-audit.pSGsLZ/parity-check/theme/summary.json`
- `/tmp/larva-env-audit.pSGsLZ/parity-check/child/result.json`

Reusable helpers: /tmp/larva-env-audit.pSGsLZ/helpers

The earlier scratch proposal that retained a compatible launcher and marked
ordinary-settings persistence undecided is superseded by this document. No
product decision remains open within the target above; implementation and
installation acceptance remain outstanding.
