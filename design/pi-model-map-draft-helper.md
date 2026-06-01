# Pi model-map draft helper

## Status

Proposed.

## Original request

Design a helper command that compares the models used by the current Larva
registry with models available to Pi, then generates a draft for
`~/.pi/larva/model-map.json`. When Pi evidence cannot uniquely identify the
right target, the command must ask the user instead of guessing.

## Decision

Add a Larva CLI helper command:

```text
larva pi-model-map draft
```

Do not place this under `larva pi ...` because `larva pi` is already a
pass-through launcher. `src/larva/shell/cli.py` intercepts `argv[0] == "pi"`
before normal argparse dispatch and forwards non-launcher arguments to the real
Pi process. Keeping the draft helper as a separate top-level command preserves
that boundary.

The helper is a setup-time Shell command. The Pi extension remains the runtime
consumer of the finished `model-map.json`; it must not become responsible for
inventory discovery, prompting, or file drafting.

Certainty: Proven for the `larva pi` pass-through boundary, because the launcher
intercept exists in `src/larva/shell/cli.py`. Likely for the top-level command
name, because it is the least disruptive CLI shape.

## Non-goals

- Do not read `/Users/tefx/dotfiles/agent/models.yaml` or any personal scaffold
  file. Other users do not have that file.
- Do not change `PersonaSpec`, opifex shared contracts, or Larva registry model
  meaning.
- Do not hard-code provider preferences such as "OpenAI means Codex first" or
  "Google means OpenRouter first".
- Do not write runtime config by default.
- Do not generate fuzzy, nearest, wildcard, or guessed runtime mappings.

## Source evidence and constraints
- `contrib/pi-extension/README.md` is evidence only for the adapter-local
  model-map runtime schema and runtime resolution rules: exact `models` entries
  first, then literal `prefix_rules`, then split fallback when no map hit exists.
  Its older "Runtime-map completion policy" text is not normative for this
  helper if it mentions personal scaffold files or provider-preference rules.
- `contrib/pi-extension/larva.ts` parses only `models` and `prefix_rules`, reads
  `~/.pi/larva/model-map.json` or `LARVA_PI_MODEL_MAP_FILE`, and validates the
  mapped target through `modelRegistry.find(provider, model_id)`.
- `src/larva/app/facade_types.py` exposes `PersonaSummary.model`, so the helper
  can collect current registry model usage through `facade.list()` without
  resolving every persona.
- `src/larva/shell/cli.py` intercepts `argv[0] == "pi"` before argparse dispatch,
  so the helper should not live under the `larva pi ...` pass-through namespace.
- `pi --list-models --offline` is the Pi inventory source. The helper should
  treat the first two columns as `provider` and `model_id` and should fail closed
  if the output is not parseable.

Implementation-plan note: update or supersede the conflicting README completion
policy during implementation so future maintainers do not reintroduce personal
`models.yaml` input or hard-coded provider preference rules.
## CLI contract
Recommended arguments:

```text
larva pi-model-map draft [--output PATH] [--write] [--non-interactive]
                          [--model-map PATH]
```

- `--output PATH`: destination path used when writing. Default:
  `~/.pi/larva/model-map.json`.
- `--model-map PATH`: existing model-map file to merge from. Default is the same
  path as `--output`. This is separate only so tests and local experiments can
  inspect one file while writing another.
- `--write`: write the final draft to `--output`. Without this flag, stdout must
  contain only the draft `model-map.json` payload.
- `--non-interactive`: never prompt. If any required model has ambiguous or no
  verified target, return a structured failure.

Output-channel rules:

- Default non-JSON mode: stdout contains only valid draft model-map JSON, suitable
  for shell redirection into a file. Human report lines, warnings, stale entries,
  invalid entries, and unresolved summaries go to stderr.
- `--write` non-JSON mode: stdout may be empty or contain the written path only;
  human report lines still go to stderr. The implementation must not mix human
  report text into a JSON payload advertised as redirect-safe.
- `--json` mode, if wired into the surrounding CLI pattern: stdout contains one
  structured Larva success/failure envelope whose `data` is `PiModelMapDraftResult`.
  In this mode, the draft is inside the envelope rather than raw top-level
  `model-map.json` content.
## Data sources

### Registry model usage

Source: `facade.list()`.

The helper needs only these fields from each `PersonaSummary`:

```python
class RegistryModelUse(TypedDict):
    model: str
    used_by: list[str]
```

Rules:

- Group by exact `model` string.
- Preserve the list of persona ids using each model for prompts and reports.
- Process each distinct model once.

### Pi model inventory

Source: `pi --list-models --offline`.

Minimal item contract:

```python
class PiModelInventoryItem(TypedDict):
    provider: str
    model_id: str
```

Rules:

- Parse only evidence present in the Pi command output.
- Do not infer hidden provider aliases.
- Treat duplicate inventory rows as one provider/model pair.
- If the Pi command fails or the output cannot be parsed, fail the helper rather
  than generating a speculative draft.

### Existing model-map
Source: `--model-map`, defaulting to `~/.pi/larva/model-map.json`.

Rules:

- If the file is missing, start from an empty map.
- If the file exists but is invalid JSON or violates the Pi extension model-map
  shape, fail closed unless the implementer adds an explicit user-confirmed
  replacement mode later.
- Preserve existing exact mappings only when their target provider/model pair is
  present in the current Pi inventory.
- Mark exact mappings whose source model is no longer used by the registry as
  stale in the report. Do not keep them in the draft unless a later explicit
  `--keep-stale` feature is requested.
- Mark exact mappings whose target no longer exists in Pi inventory as invalid
  and require a new target choice if the source model is still used.
- Preserve existing prefix rules only when they are valid by the Pi extension
  schema and do not create same-length matching conflicts with another preserved
  or newly selected prefix rule.
- Collapse exact duplicate prefix rules.
- If an existing prefix rule is syntactically valid but covers no current
  registry model, report it as stale and drop it from the draft unless a future
  explicit `--keep-stale-prefix-rules` option is requested.
- If an existing prefix rule maps at least one current registry model to a target
  provider/model pair that is absent from Pi inventory, report it as invalid and
  do not use it to claim coverage for that source model.
- The helper may preserve valid existing prefix rules; it must not invent broad
  new prefix rules by default. New prefix rules require explicit user choice or a
  later separate design decision, because broad rules can hide future ambiguity.
## Deduplication and merge policy

The helper must produce a stable merged draft, not a fresh pile of duplicate
entries.

Rules:

- One distinct registry model produces at most one exact `models` entry.
- A registry model already covered by a valid existing exact mapping does not get
  a duplicate entry.
- A registry model already covered by a valid preserved literal prefix rule does
  not need an exact entry unless the user explicitly chooses one during ambiguity
  resolution.
- Duplicate prefix rules are collapsed only when all fields are identical.
- Same-length prefix conflicts are invalid for the draft. If the conflict comes
  from existing config, report the conflicting rules and fail unless the user
  removes or skips the conflict during an explicit future repair flow.
- The helper must not introduce a new prefix rule that can make the Pi extension's
  longest-prefix resolution ambiguous.
- Prefix-rule stale/invalid/conflict findings must be reported separately from
  stale/invalid exact mappings.
- Output ordering must be stable: sort exact model keys and prefix rules by their
  literal fields.

A model is considered covered only when the final draft contains either a valid
exact entry for that model or a preserved prefix rule that maps it to a
provider/model pair present in the current Pi inventory.
## Candidate discovery policy
The helper may automatically choose a target only when Pi evidence leaves exactly
one reasonable target.

For each source model, first validate the source string:

- A source model with no `/`, an empty provider segment, or an empty model-id
  segment is malformed for this helper's automatic candidate discovery.
- In interactive mode, malformed source models are shown to the user with the
  persona ids that use them; the user may manually choose a Pi inventory row or
  leave the model unresolved.
- In `--non-interactive` mode, malformed source models become
  `LARVA_PI_MODEL_MAP_UNRESOLVED` entries, not guessed mappings.

For a well-formed source model, parse the first slash into:

```text
source_provider/source_model_id
```

Candidate categories:

1. Direct Pi match:
   - `provider == source_provider`
   - `model_id == source_model_id`
2. Wrapped Pi match:
   - `model_id == source_provider + "/" + source_model_id`
3. Suffix Pi match:
   - `model_id` basename equals the source model basename.

The categories are evidence filters, not provider preferences.

Rules:

- If exactly one candidate remains, the helper may use it.
- If more than one candidate remains, the helper must ask the user in
  interactive mode.
- If no candidate remains, interactive mode may let the user manually select from
  the full Pi inventory or leave the model unresolved.
- In `--non-interactive` mode, ambiguous, missing, or malformed candidates are
  failures.
- Provider-family rules must not be hard-coded. OpenAI, Google, Anthropic,
  OpenRouter, Codex, local providers, and unknown providers all follow the same
  candidate process.

Failure condition: this policy is wrong if Pi later provides a canonical alias
API that can identify equivalence directly. In that case, the helper should use
that API instead of text-based candidate discovery.
## Interactive choice contract

When prompting, show:

- source registry model;
- persona ids using it;
- existing mapping status, if any;
- candidate provider/model pairs from Pi;
- options to skip unresolved or manually choose a Pi inventory row.

The prompt should ask once per distinct registry model, not once per persona.

Example prompt shape:

```text
Registry model: openai/gpt-5.5
Used by: python-senior, blind-tester

Pi has multiple plausible targets:
  1. openai-codex / gpt-5.5
  2. openrouter / openai/gpt-5.5
  3. skip unresolved
  4. manual provider/model from Pi list

Choose target:
```

## Draft output contract
The written file must remain exactly compatible with the Pi extension's current
runtime parser:

```json
{
  "models": {
    "<registry-model>": { "provider": "<pi-provider>", "model_id": "<pi-model-id>" }
  },
  "prefix_rules": [
    { "from_prefix": "openrouter/", "to_provider": "openrouter", "to_model_id_prefix": "" }
  ]
}
```

Human or machine report metadata must not be written into `model-map.json`.
Default stdout must be raw draft JSON only; report metadata goes to stderr. If
`--json` is supported, stdout is the structured Larva envelope instead of raw
`model-map.json`.

Suggested result contract:

```python
class ModelMapEntry(TypedDict):
    provider: str
    model_id: str

class PrefixRule(TypedDict):
    from_prefix: str
    to_provider: str
    to_model_id_prefix: str

class PiModelMapDraft(TypedDict):
    models: dict[str, ModelMapEntry]
    prefix_rules: list[PrefixRule]

class UnresolvedModel(TypedDict):
    source_model: str
    used_by: list[str]
    reason: str
    candidates: list[ModelMapEntry]

class PrefixRuleFinding(TypedDict):
    rule: PrefixRule
    reason: str
    affected_models: list[str]

class PiModelMapDraftResult(TypedDict):
    draft: PiModelMapDraft
    covered_models: list[str]
    stale_models: list[str]
    invalid_existing_models: list[str]
    stale_prefix_rules: list[PrefixRuleFinding]
    invalid_prefix_rules: list[PrefixRuleFinding]
    conflicting_prefix_rules: list[PrefixRuleFinding]
    unresolved: list[UnresolvedModel]
    output_path: str | None
    wrote_file: bool
```

## Error model

Recommended error codes:

- `LARVA_PI_MODELS_UNAVAILABLE`: Pi model inventory command failed or its output
  could not be parsed.
- `LARVA_PI_MODEL_MAP_INVALID`: existing model-map JSON is present but invalid.
- `LARVA_PI_MODEL_MAP_UNRESOLVED`: `--non-interactive` was requested and at least
  one registry model has no unique verified target.
- `LARVA_PI_MODEL_MAP_WRITE_FAILED`: `--write` could not create the destination
  directory or write the JSON file.
- `LARVA_PI_MODEL_MAP_BAD_ARGS`: incompatible or invalid command arguments.

## Architecture basis

```yaml
architecture_basis:
  system_layers:
    core: "Add a small pure model-map planning module only if implementation needs deterministic merge/candidate helpers outside shell I/O. Core functions require @pre/@post contracts and doctests per repo invariant."
    shell: "Add CLI parser/dispatcher wiring and a Shell command that reads registry summaries, runs Pi inventory, prompts users, and writes optional output."
    external_runtime: "Pi CLI provides offline model inventory; Pi extension consumes the finished model-map file at runtime."

  source_of_truth_matrix:
    registry_models: "Larva facade.list PersonaSummary.model grouped by exact model string."
    pi_available_models: "pi --list-models --offline output, provider/model_id columns only."
    existing_runtime_map: "~/.pi/larva/model-map.json or explicit --model-map path."
    final_runtime_map: "--output path when --write is set; otherwise raw draft JSON on stdout in non-json mode."
    report_metadata: "stderr in default mode; structured data envelope in --json mode if implemented."
    model_equivalence: "User choice when Pi inventory evidence is ambiguous."

  service_catalog:
    pi_model_map_draft_command:
      owner: "larva.shell"
      responsibility: "Generate a reviewed draft runtime model map from registry usage and Pi inventory evidence."
    pi_model_map_planner:
      owner: "larva.core if extracted; otherwise shell-local pure helpers"
      responsibility: "Deduplicate registry usage, preserve valid existing mappings and prefix rules, mark stale/invalid/conflicting entries, and produce candidate choices without I/O."
    pi_extension_runtime_resolver:
      owner: "contrib/pi-extension"
      responsibility: "Consume the finished model-map file at runtime without discovering inventory or prompting."

  runtime_contract:
    command: "larva pi-model-map draft [--output PATH] [--write] [--non-interactive] [--model-map PATH]"
    default_behavior: "Print only raw draft model-map JSON to stdout; print reports/warnings to stderr; do not write files unless --write is set."
    json_behavior: "If --json is supported, stdout is a Larva envelope containing PiModelMapDraftResult rather than raw model-map JSON."
    inventory: "Run pi --list-models --offline and fail closed when unavailable."
    prompting: "Ask only when Pi evidence produces zero or multiple viable targets and interactive mode is allowed."

  state_strata:
    canonical_state: "Larva registry PersonaSpec.model values."
    observed_external_state: "Pi offline model inventory for the current machine."
    adapter_config_state: "Existing and generated model-map JSON."
    transient_decision_state: "Per-run user choices for ambiguous mappings; not persisted outside the generated draft."

  transport_boundary_rules:
    - "The helper may call Pi CLI for inventory; the Pi extension must not call the helper."
    - "The helper may read Larva registry through facade.list; it must not read private registry files directly."
    - "The helper must not read personal dotfiles scaffolds."
    - "Generated JSON must match the existing Pi extension model-map schema exactly."
    - "Report metadata must not be embedded in model-map JSON."
    - "No PersonaSpec or opifex shared contract changes."

  cross_cutting_governance:
    registries:
      - "Larva registry remains owned by Larva facade."
      - "Pi inventory remains owned by Pi CLI."
      - "Model-map JSON remains adapter-local config."
    lifecycle_ordering:
      - "Collect registry usage."
      - "Collect Pi inventory."
      - "Read and validate existing model-map if present."
      - "Plan merged draft, including exact mappings and prefix-rule findings."
      - "Prompt for ambiguous choices only when allowed."
      - "Print or write final draft with redirect-safe output channels."
    coordination_mechanisms:
      - "Explicit CLI invocation and optional stdin prompt."
      - "No background watcher, daemon, cache, or global mutable registry."
    wiring_strategy: "Normal Larva CLI parser and dispatch wiring; Shell command receives facade explicitly."
    governance_owner: "larva.shell"

  shared_abstractions:
    shared_types:
      - name: "PiModelMapDraft"
        owner_module: "core planner if extracted; otherwise shell command module"
        consumers: ["CLI renderer", "file writer", "tests"]
        rationale: "The same exact runtime schema must be printed and optionally written."
      - name: "PiModelInventoryItem"
        owner_module: "shell command module"
        consumers: ["inventory parser", "candidate planner"]
        rationale: "Only provider/model_id columns cross the Pi CLI boundary."
      - name: "UnresolvedModel"
        owner_module: "core planner if extracted; otherwise shell command module"
        consumers: ["interactive prompt", "non-interactive failure", "JSON report"]
        rationale: "Ambiguity must be explicit and machine-readable."
      - name: "PrefixRuleFinding"
        owner_module: "core planner if extracted; otherwise shell command module"
        consumers: ["merge report", "tests", "JSON report"]
        rationale: "Prefix-rule stale, invalid, and conflict cases must not be hidden inside exact mapping status."
    shared_protocols: []
    shared_utilities: "N/A: no utility should be shared until duplication appears."
    decision: "Share only types that cross planning/rendering/writing boundaries; keep parsing and prompting local."

  module_split_recommendations:
    - module: "src/larva/core/pi_model_map.py"
      owner: "larva core"
      reason_to_split: "Only if merge/candidate planning is non-trivial enough to deserve side-effect-free contract tests."
    - module: "src/larva/shell/pi_model_map.py"
      owner: "larva shell"
      reason_to_split: "Pi subprocess, filesystem, CLI rendering, and prompts are shell-side effects."
    - module: "src/larva/shell/cli_parser.py and src/larva/shell/cli.py"
      owner: "larva shell"
      reason_to_split: "Existing CLI wiring location for new top-level commands."

  ux_surfaces:
    - surface: "CLI command"
      scope: "arguments, raw stdout draft, stderr report messages, JSON envelope, interactive ambiguity prompt"

  runtime_surfaces:
    - surface: "CLI"
      launch_or_entrypoint: "larva pi-model-map draft"
      minimum_liveness_proof: "Command runs against real pi --list-models --offline and current Larva registry without writing by default."

  open_questions: []

  readiness: "READY_FOR_PLANNING"
```

## Verification targets
- Unit tests should use fixed fixtures for registry summaries, Pi inventory text,
  and existing model-map JSON. These tests prove deterministic logic such as
  deduplication, merge behavior, ambiguity handling, stable output ordering, and
  non-interactive failures. They are intentionally not proof that a local Pi
  installation has a model.
- Integration or runtime proof should run the real
  `pi --list-models --offline` command and the real Larva registry to prove that
  generated targets exist in the current environment.
- Add tests for: duplicate registry models, valid existing mapping preservation,
  stale mapping removal/reporting, invalid mapping target, valid existing prefix
  rule preservation, stale prefix rule reporting/removal, invalid prefix target
  reporting, same-length prefix conflict rejection, ambiguous OpenAI-like
  candidates, ambiguous Google-like candidates, malformed source model handling,
  no-candidate manual/skip path, `--non-interactive` unresolved failure,
  redirect-safe stdout, `--json` envelope behavior if implemented, and `--write`
  filesystem behavior.
- Run the repository's normal Python checks and `invar guard` after
  implementation.
## Implementation handoff

Suggested order:

1. Add pure planning types/helpers if needed, with contracts and doctests if
   placed under `core`.
2. Add Shell inventory parsing and existing model-map reading/writing.
3. Add CLI parser and dispatch wiring for `larva pi-model-map draft`.
4. Add interactive prompt behavior for ambiguous choices.
5. Add fixture-based unit tests and a real-Pi smoke/integration proof.

Watch for:

- Do not reuse the `larva pi` pass-through command namespace.
- Do not read personal dotfiles.
- Do not write hidden provider preference rules.
- Do not store report metadata inside `model-map.json`.
- Do not silently accept invalid existing model-map JSON.
