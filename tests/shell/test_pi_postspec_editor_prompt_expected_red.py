"""Green regression tests for Pi editor autocomplete and prompt overlay contracts.

These tests verify the post-commit-4616008 UX contract against the implemented
Pi extension runtime.  They intentionally exercise only public/test-facing
runtime surfaces and fixtures; production extension logic is not changed here.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Any, Final

import pytest

ROOT: Final = Path(__file__).resolve().parents[2]
EXTENSION: Final = ROOT / "contrib" / "pi-extension" / "larva.ts"
FAKE_CLI: Final = ROOT / "tests" / "fixtures" / "pi" / "fake-larva-cli.mjs"


def _run_node(tmp_path: Path, script: str, *, timeout: float = 8.0) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for Pi extension runtime regression tests")
    script_path = tmp_path / "scenario.mjs"
    script_path.write_text(textwrap.dedent(script), encoding="utf-8")
    completed = subprocess.run(
        [node, str(script_path)],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


def _node_prelude(tmp_path: Path) -> str:
    return f"""
        import {{ mkdtemp, readFile }} from "node:fs/promises";
        import {{ tmpdir }} from "node:os";
        import {{ join }} from "node:path";
        const mod = await import({json.dumps(EXTENSION.as_uri())});
        const fakeCli = {json.dumps(str(FAKE_CLI))};
        const baseEnv = (extra = {{}}) => ({{
          LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
          LARVA_PI_INITIAL_PERSONA_ID: "",
          LARVA_PI_LAUNCHED: "0",
          HOME: {json.dumps(str(tmp_path))},
          ...extra,
        }});
        const modelRegistry = {{ find: () => ({{ provider: "openai-codex", model: "gpt-5.5" }}) }};
        const pi = {{
          setModel: () => true,
          getAllTools: () => ["read", "grep", "larva_subagent"],
          setActiveTools: () => true,
          registerTool: () => undefined,
          on: () => undefined,
        }};
        const readCount = async (path) => {{
          try {{ return Number.parseInt(await readFile(path, "utf8"), 10) || 0; }}
          catch {{ return 0; }}
        }};
    """


def test_larva_persona_completion_cache_expiry_inflight_failure_and_no_catalogue_injection(tmp_path: Path) -> None:
    """Pin /larva-persona cache semantics, failure close, and prompt catalogue budget."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        const failures = [];
        const clockHooks = {
          setClock: typeof mod.setPersonaCompletionClock === "function",
          advanceClock: typeof mod.advancePersonaCompletionClock === "function",
          resetClock: typeof mod.resetPersonaCompletionClock === "function",
        };
        if (!clockHooks.setClock || !clockHooks.advanceClock || !clockHooks.resetClock) {
          failures.push("missing deterministic injectable completion clock/test hook");
        }

        const dir = await mkdtemp(join(tmpdir(), "larva-postspec-cache-"));
        const countFile = join(dir, "list-count.txt");
        mod.resetPersonaCompletionCache();
        if (clockHooks.setClock) mod.setPersonaCompletionClock(() => 1_000);
        const ctx = { env: baseEnv({ FAKE_LARVA_COUNT_FILE: countFile, FAKE_LARVA_LIST_DELAY_MS: "80" }) };
        const [first, second] = await Promise.all([
          mod.completePersonaIds("vectl", ctx),
          mod.completePersonaIds("vectl", ctx),
        ]);
        const afterInflight = await readCount(countFile);
        const cached = await mod.completePersonaIds("vectl", ctx);
        const afterCache = await readCount(countFile);
        if (clockHooks.advanceClock) mod.advancePersonaCompletionClock(10_000);
        const expired = await mod.completePersonaIds("vectl", ctx);
        const afterExpiry = await readCount(countFile);
        if (clockHooks.resetClock) mod.resetPersonaCompletionClock();

        process.env.FAKE_LARVA_SCENARIO = "list-exit";
        mod.resetPersonaCompletionCache();
        const failedCommand = await mod.completePersonaIds("vectl", { env: baseEnv() });
        const provider = mod.createLarvaPersonaAutocompleteProvider({ env: baseEnv() }, () => [
          { value: "pi-file.ts", label: "pi-file.ts" },
        ]);
        const failedEditor = await provider("/larva-persona vectl", { force: true });
        delete process.env.FAKE_LARVA_SCENARIO;

        mod.resetPersonaCompletionCache();
        await mod.commitPersona("ok", { env: baseEnv(), modelRegistry }, pi);
        const prompt = mod.before_agent_start({ systemPrompt: "Pi operational context" })?.systemPrompt ?? "";
        const catalogueLeaks = ["vectl-planner", "vectl-reviewer", "qa-dev", "backend-dev"].filter((id) => prompt.includes(id));

        console.log(JSON.stringify({
          clockHooks,
          failures,
          first: first.map((item) => item.value),
          second: second.map((item) => item.value),
          cached: cached.map((item) => item.value),
          expired: expired.map((item) => item.value),
          afterInflight,
          afterCache,
          afterExpiry,
          failedCommand,
          failedEditor,
          catalogueLeaks,
          promptHasDiscoveryInstructionOnly: prompt.includes("Use Larva MCP or the larva CLI") && catalogueLeaks.length === 0,
        }, null, 2));
        """,
    )

    assert payload["clockHooks"] == {"setClock": True, "advanceClock": True, "resetClock": True}
    assert payload["afterInflight"] == 1
    assert payload["afterCache"] == 1
    assert payload["afterExpiry"] == 2
    assert payload["first"] == payload["second"] == payload["cached"] == payload["expired"]
    assert payload["failedCommand"] is None
    assert payload["failedEditor"] is None
    assert payload["catalogueLeaks"] == []
    assert payload["promptHasDiscoveryInstructionOnly"] is True


def test_editor_provider_installation_degrades_without_ui_hook_but_keeps_command_completion(tmp_path: Path) -> None:
    """Unsupported ctx.ui.addAutocompleteProvider must not break command-level completion."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        mod.resetPersonaCompletionCache();
        let registered = null;
        const handlers = {};
        const ctx = { env: baseEnv(), ui: { setStatus: () => undefined }, modelRegistry };
        await mod.initializeExtension(ctx, {
          ...pi,
          registerCommand: (name, options) => { registered = { name, options }; },
          on: (event, handler) => { handlers[event] = handler; },
        });
        await handlers.session_start({ reason: "runtime" }, ctx);
        const completions = await registered.options.getArgumentCompletions("vectl");
        console.log(JSON.stringify({
          registeredName: registered?.name,
          hasCommandCompleter: typeof registered?.options?.getArgumentCompletions === "function",
          commandValues: completions?.map((item) => item.value) ?? null,
          addAutocompleteProviderType: typeof ctx.ui.addAutocompleteProvider,
          hasSessionStart: typeof handlers.session_start === "function",
        }, null, 2));
        """,
    )

    assert payload == {
        "registeredName": "larva-persona",
        "hasCommandCompleter": True,
        "commandValues": ["vectl-planner", "vectl-reviewer"],
        "addAutocompleteProviderType": "undefined",
        "hasSessionStart": True,
    }


def test_persona_mentions_autocomplete_tokens_merge_dedupe_and_no_side_effects(tmp_path: Path) -> None:
    """Pin canonical @persona:<id> mention-only editor autocomplete behavior."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        mod.resetPersonaCompletionCache();
        const calls = [];
        let installedFactory = null;
        const handlers = {};
        const status = [];
        const ctx = {
          env: baseEnv(),
          modelRegistry,
          ui: {
            setStatus: (key, value) => status.push([key, value]),
            addAutocompleteProvider: (factory) => { installedFactory = factory; },
            notify: () => undefined,
          },
        };
        await mod.initializeExtension(ctx, {
          ...pi,
          registerCommand: () => undefined,
          on: (event, handler) => { handlers[event] = handler; },
        });
        const installedAfterFactory = typeof installedFactory;
        await handlers.session_start({ reason: "runtime" }, ctx);
        const sessionStartStatus = [...status];
        status.length = 0;
        const baseItems = [
          { value: "./src/app.ts", label: "./src/app.ts", description: "Pi file reference" },
          { value: "@persona:vectl-planner", label: "Pi duplicate wins" },
        ];
        const baseProvider = {
          getSuggestions: (...args) => { calls.push(args.map((arg) => Array.isArray(arg) ? "array" : typeof arg)); return baseItems; },
          applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => ({ lines, cursorLine, cursorCol, item, prefix, delegated: true }),
          shouldTriggerFileCompletion: () => false,
        };
        const mentionProvider = installedFactory ? installedFactory(baseProvider) : null;
        const suggest = (line) => mentionProvider ? mentionProvider.getSuggestions([line], 0, line.length, { force: true }) : null;
        const rawAt = await suggest("@");
        const namespacePartial = await suggest("@p");
        const literalPartial = await suggest("@persona");
        const bareNamespace = await suggest("@persona:");
        const query = await suggest("please ask @persona:review");
        const rawShort = await suggest("@vectl");
        const fileLike = await suggest("@foo/bar");
        const spacedText = await suggest("@ persona:dev");
        const applied = mentionProvider ? mentionProvider.applyCompletion(["please ask @persona:"], 0, "please ask @persona:".length, bareNamespace.items[1], bareNamespace.prefix) : null;
        const beforeEnvelope = mod.getActiveEnvelope();
        if (mentionProvider) await mentionProvider.getSuggestions(["@persona:ok"], 0, "@persona:ok".length, { force: true });
        const afterEnvelope = mod.getActiveEnvelope();
        const promptAfterMention = mod.before_agent_start({ systemPrompt: "Pi prompt" });

        console.log(JSON.stringify({
          installedProviderFactory: typeof installedFactory,
          installedAfterFactory,
          installedProviderObject: typeof mentionProvider?.getSuggestions,
          hasSessionStart: typeof handlers.session_start,
          hasMentionFactory: typeof mod.createLarvaPersonaMentionAutocompleteProvider,
          providerResultsAreObjects: [rawAt, namespacePartial, literalPartial, bareNamespace, query, rawShort, fileLike, spacedText]
            .every((result) => result === null || (typeof result === "object" && !Array.isArray(result))),
          resultItemsAreArrays: [rawAt, namespacePartial, literalPartial, bareNamespace, query, rawShort, fileLike, spacedText]
            .every((result) => result === null || Array.isArray(result.items)),
          prefixes: {
            rawAt: rawAt?.prefix ?? null,
            namespacePartial: namespacePartial?.prefix ?? null,
            literalPartial: literalPartial?.prefix ?? null,
            bareNamespace: bareNamespace?.prefix ?? null,
            query: query?.prefix ?? null,
          },
          rawAt: rawAt?.items ?? null,
          namespacePartial: namespacePartial?.items ?? null,
          literalPartial: literalPartial?.items ?? null,
          bareNamespace: bareNamespace?.items ?? null,
          query: query?.items ?? null,
          rawShort: rawShort?.items ?? null,
          fileLike: fileLike?.items ?? null,
          spacedText: spacedText?.items ?? null,
          applied,
          calls,
          beforeEnvelope,
          afterEnvelope,
          promptAfterMention,
          sessionStartStatus,
          mentionStatus: status,
        }, null, 2));
        """,
    )

    assert payload["hasMentionFactory"] == "function"
    assert payload["hasSessionStart"] == "function"
    assert payload["installedAfterFactory"] == "object"
    assert payload["installedProviderFactory"] == "function"
    assert payload["installedProviderObject"] == "function"
    assert payload["providerResultsAreObjects"] is True
    assert payload["resultItemsAreArrays"] is True
    assert payload["prefixes"] == {
        "rawAt": "@",
        "namespacePartial": "@p",
        "literalPartial": "@persona",
        "bareNamespace": "@persona:",
        "query": "@persona:review",
    }
    assert [item["value"] for item in payload["rawAt"]] == [
        "./src/app.ts",
        "@persona:vectl-planner",
        "@persona:ok",
        "@persona:startup",
        "@persona:child",
        "@persona:vectl-reviewer",
        "@persona:qa-dev",
        "@persona:DevOps",
        "@persona:devrel",
        "@persona:backend-dev",
    ]
    expected_merged_empty_namespace = [
        "./src/app.ts",
        "@persona:vectl-planner",
        "@persona:ok",
        "@persona:startup",
        "@persona:child",
        "@persona:vectl-reviewer",
        "@persona:qa-dev",
        "@persona:DevOps",
        "@persona:devrel",
        "@persona:backend-dev",
    ]
    assert [item["value"] for item in payload["namespacePartial"]] == expected_merged_empty_namespace
    assert [item["value"] for item in payload["literalPartial"]] == expected_merged_empty_namespace
    assert [item["value"] for item in payload["bareNamespace"]] == expected_merged_empty_namespace
    assert [item["value"] for item in payload["query"]] == ["@persona:vectl-reviewer"]
    assert payload["rawShort"] == [
        {"value": "./src/app.ts", "label": "./src/app.ts", "description": "Pi file reference"},
        {"value": "@persona:vectl-planner", "label": "Pi duplicate wins"},
    ]
    assert payload["fileLike"] == payload["rawShort"]
    assert payload["spacedText"] == payload["rawShort"]
    assert payload["applied"] == {
        "lines": ["please ask @persona:vectl-planner"],
        "cursorLine": 0,
        "cursorCol": len("please ask @persona:vectl-planner"),
    }
    assert payload["beforeEnvelope"] is None
    assert payload["afterEnvelope"] is None
    assert payload["promptAfterMention"] is None
    assert ["larva", "larva: none"] in payload["sessionStartStatus"]
    assert payload["mentionStatus"] == []


def test_prompt_overlay_marker_blocks_idempotence_and_pi_prompt_byte_preservation(tmp_path: Path) -> None:
    """Pin marker-bounded Larva sandwich overlay without Pi prompt rewriting."""

    payload = _run_node(
        tmp_path,
        _node_prelude(tmp_path)
        + """
        mod.resetPersonaCompletionCache();
        await mod.commitPersona("ok", { env: baseEnv(), modelRegistry }, pi);
        const piPrompt = [
          "You are Pi, an agentic coding assistant.",
          "TOOLS: read write bash",
          "Working directory: /repo",
          "Provider payload sentinel: {\\\"doNotRewrite\\\":true}",
        ].join("\\n");
        const stale = [
          "<!-- larva:identity-policy:begin -->",
          "stale identity policy",
          "<!-- larva:identity-policy:end -->",
          piPrompt,
          "<!-- larva:active-persona:begin -->",
          "<!-- larva-spec: old@digest -->",
          "stale prompt",
          "<!-- larva:active-persona:end -->",
        ].join("\\n");
        const first = mod.before_agent_start({ systemPrompt: piPrompt })?.systemPrompt ?? "";
        const second = mod.before_agent_start({ systemPrompt: first })?.systemPrompt ?? "";
        const fromStale = mod.before_agent_start({ systemPrompt: stale })?.systemPrompt ?? "";
        const betweenMarkers = (text, begin, end) => text.slice(text.indexOf(begin) + begin.length, text.indexOf(end));
        const piSlice = betweenMarkers(
          fromStale,
          "<!-- larva:identity-policy:end -->\\n\\n",
          "\\n\\n<!-- larva:active-persona:begin -->",
        );
        console.log(JSON.stringify({
          first,
          second,
          fromStale,
          identityBeginCount: (fromStale.match(/<!-- larva:identity-policy:begin -->/g) ?? []).length,
          activeBeginCount: (fromStale.match(/<!-- larva:active-persona:begin -->/g) ?? []).length,
          containsStaleIdentity: fromStale.includes("stale identity policy"),
          containsStalePrompt: fromStale.includes("stale prompt"),
          piSlice,
          piPrompt,
          piIdentitySentencePreserved: fromStale.includes("You are Pi, an agentic coding assistant."),
          providerPayloadPreserved: fromStale.includes("Provider payload sentinel: {\\\"doNotRewrite\\\":true}"),
          idempotent: first === second,
          hasIdentityPolicyBlock: first.includes("<!-- larva:identity-policy:begin -->") && first.includes("<!-- larva:identity-policy:end -->"),
          hasActivePersonaBlock: first.includes("<!-- larva:active-persona:begin -->") && first.includes("<!-- larva:active-persona:end -->"),
          watermarkInActiveBlock: /<!-- larva:active-persona:begin -->[\\s\\S]*<!-- larva-spec: ok@digest-ok -->[\\s\\S]*<!-- larva:active-persona:end -->/.test(first),
        }, null, 2));
        """,
    )

    assert payload["hasIdentityPolicyBlock"] is True
    assert payload["hasActivePersonaBlock"] is True
    assert payload["watermarkInActiveBlock"] is True
    assert payload["idempotent"] is True
    assert payload["identityBeginCount"] == 1
    assert payload["activeBeginCount"] == 1
    assert payload["containsStaleIdentity"] is False
    assert payload["containsStalePrompt"] is False
    assert payload["piSlice"] == payload["piPrompt"]
    assert payload["piIdentitySentencePreserved"] is True
    assert payload["providerPayloadPreserved"] is True


def test_prompt_overlay_does_not_rebuild_builder_or_rewrite_provider_payloads_source_guard() -> None:
    """Source guard for forbidden implementation shortcuts around Pi prompt ownership."""

    source = EXTENSION.read_text(encoding="utf-8")
    prompt_slice = source[source.index("export function before_agent_start") : source.index("export function decideToolCall")]

    forbidden_tokens = [
        "systemPromptOptions",
        "buildSystemPrompt",
        "providerPayload",
        "request.body",
        "messages[0]",
        "You are Pi, an agentic coding assistant.",
    ]
    assert not [token for token in forbidden_tokens if token in prompt_slice]
