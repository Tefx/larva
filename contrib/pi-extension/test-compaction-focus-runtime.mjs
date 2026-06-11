import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourcePath = fileURLToPath(new URL("./larva.ts", import.meta.url));

async function writePiTuiMock(root) {
  const moduleDir = join(root, "node_modules", "@earendil-works", "pi-tui");
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    join(moduleDir, "package.json"),
    JSON.stringify({ type: "module", main: "index.js", exports: "./index.js" }),
    "utf8",
  );
  await writeFile(
    join(moduleDir, "index.js"),
    `export class Input { focused = false; getValue() { return ""; } handleInput() {} invalidate() {} render(width) { return ["".padEnd(Math.max(0, width), " ")]; } }
export const Key = { escape: "escape", enter: "enter", down: "down", up: "up", pageDown: "pagedown", pageUp: "pageup", home: "home", end: "end", ctrl: (key) => "ctrl+" + key, ctrlAlt: (key) => "ctrl+alt+" + key };
export class Markdown { constructor(text) { this.text = text; } render(width) { return String(this.text).split(/\\r?\\n/).map((line) => line.slice(0, Math.max(0, width))); } }
export class SelectList { constructor(items) { this.items = items; this.index = 0; } setSelectedIndex(index) { this.index = index; } getSelectedItem() { return this.items[this.index] ?? null; } invalidate() {} render(width) { return this.items.map((item) => String(item.label ?? item.value).slice(0, Math.max(0, width))); } }
export function matchesKey(data, key) { return data === key; }
export function truncateToWidth(value, width, _ellipsis = "", pad = false) { const text = String(value).slice(0, Math.max(0, width)); return pad ? text.padEnd(Math.max(0, width), " ") : text; }
export function visibleWidth(value) { return String(value).replace(/\\x1b\\[[0-9;]*m/g, "").length; }
export function wrapTextWithAnsi(value, width = 80) { const text = String(value); if (text.length === 0) return [""]; const out = []; for (let i = 0; i < text.length; i += Math.max(1, width)) out.push(text.slice(i, i + Math.max(1, width))); return out; }
`,
    "utf8",
  );
}

async function runtimeModule() {
  const root = await mkdtemp(join(tmpdir(), "larva-compaction-focus-runtime-"));
  await writePiTuiMock(root);
  const modulePath = join(root, "larva-runtime.ts");
  const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf8"));
  await writeFile(modulePath, source, "utf8");
  return { root, mod: await import(pathToFileURL(modulePath).href) };
}

function preparation() {
  return {
    firstKeptEntryId: "kept-entry",
    messagesToSummarize: [{ role: "user", content: "old work" }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 777,
    fileOps: { read: [], written: [], edited: [] },
    settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 512 },
  };
}

function standardSummary() {
  return [
    "## Goal",
    "Retain Pi's summary shape.",
    "",
    "## Progress",
    "### In Progress",
    "- focused compaction invoked native helper adapter",
    "",
    "## Next Steps",
    "1. Resume from kept-entry.",
    "",
    "## Critical Context",
    "- Larva supplied only Additional focus via customInstructions.",
  ].join("\n");
}

test("compaction_focus registered hook uses runtime model/auth/signal/preparation and preserves Pi result shape", async () => {
  const { root, mod } = await runtimeModule();
  const fakeCli = join(root, "fake-larva-cli.mjs");
  await writeFile(
    fakeCli,
    `const [, , command, personaId, jsonFlag] = process.argv;
if (command === "resolve" && jsonFlag === "--json" && personaId === "compact") {
  process.stdout.write(JSON.stringify({ data: { id: "compact", description: "Compaction persona", prompt: "FULL_PROMPT_MUST_NOT_BE_FOCUS", model: "provider/model", capabilities: {}, spec_version: "0.1.0", spec_digest: "sha256:compact", compaction_prompt: "PERSONA_COMPACTION_FOCUS" } }));
  process.exit(0);
}
process.exit(7);
`,
    { mode: 0o755 },
  );
  const calls = [];
  const handlers = new Map();
  const headers = { "X-Test-Header": "SECRET_HEADER_VALUE" };
  const model = { provider: "provider", id: "model" };
  const ctx = {
    env: { HOME: root, LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]), LARVA_PI_INTERACTIVE_TUI: "0", LARVA_PI_INITIAL_PERSONA_ID: "", LARVA_PI_LAUNCHED: "0" },
    model,
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async (receivedModel) => {
        calls.push({ authModelIsRuntimeModel: receivedModel === model });
        return { ok: true, apiKey: "SECRET_API_KEY_VALUE", headers };
      },
    },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };
  const compactResult = { summary: standardSummary(), firstKeptEntryId: "kept-entry", tokensBefore: 777, details: { readFiles: [], modifiedFiles: [] } };
  const adapter = async (...args) => {
    calls.push({
      preparationIsOriginal: args[0] === prep,
      modelIsRuntimeModel: args[1] === model,
      apiKey: args[2],
      headersAreOriginal: args[3] === headers,
      customInstructions: args[4],
      signalIsOriginal: args[5] === signal,
      thinkingLevel: args[6],
    });
    return compactResult;
  };
  const pi = {
    compactAdapter: adapter,
    getThinkingLevel: () => "low",
    getAllTools: () => ["read"],
    setActiveTools: () => true,
    setModel: () => true,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: (event, handler) => handlers.set(event, handler),
  };
  await mod.initializeExtension(ctx, pi);
  await mod.commitPersona("compact", ctx, pi);
  const prep = preparation();
  const signal = new AbortController().signal;
  const result = await handlers.get("session_before_compact")({ preparation: prep, customInstructions: "Manual focus", signal }, ctx);

  assert.equal(result.compaction, compactResult);
  assert.deepEqual(Object.keys(result.compaction).sort(), ["details", "firstKeptEntryId", "summary", "tokensBefore"]);
  for (const section of ["## Goal", "## Progress", "## Next Steps", "## Critical Context"]) {
    assert.match(result.compaction.summary, new RegExp(section.replace("#", "\\#")));
  }
  assert.deepEqual(calls[0], { authModelIsRuntimeModel: true });
  assert.equal(calls[1].preparationIsOriginal, true);
  assert.equal(calls[1].modelIsRuntimeModel, true);
  assert.equal(calls[1].apiKey, "SECRET_API_KEY_VALUE");
  assert.equal(calls[1].headersAreOriginal, true);
  assert.equal(calls[1].signalIsOriginal, true);
  assert.equal(calls[1].thinkingLevel, "low");
  assert.match(calls[1].customInstructions, /^Manual compact focus:\nManual focus/);
  assert.match(calls[1].customInstructions, /Active Larva persona compaction focus:\nPERSONA_COMPACTION_FOCUS/);
  assert.match(calls[1].customInstructions, /Larva carry-forward rule:/);
});

test("compaction_focus abort and fallback do not start duplicate native compaction", async () => {
  const { root, mod } = await runtimeModule();
  const prep = preparation();
  let calls = 0;
  const ctx = {
    env: { HOME: root, LARVA_PI_INITIAL_PERSONA_ID: "", LARVA_PI_LAUNCHED: "0" },
    model: { id: "model" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
    ui: { notify: () => undefined, setStatus: () => undefined },
  };
  const aborted = new AbortController();
  aborted.abort();
  const already = await mod.handleLarvaSessionBeforeCompact({ preparation: prep, customInstructions: "manual", signal: aborted.signal }, ctx, {}, async () => {
    calls += 1;
    return { summary: "should not run", firstKeptEntryId: "kept-entry", tokensBefore: 777 };
  });
  assert.deepEqual(already, { cancel: true });
  assert.equal(calls, 0);

  const disabledConfig = join(root, "disabled-compaction.json");
  await writeFile(disabledConfig, JSON.stringify({ enabled: false, carry_forward_rule: { text: "" } }), "utf8");
  const disabledAbort = new AbortController();
  disabledAbort.abort();
  const alreadyDisabled = await mod.handleLarvaSessionBeforeCompact(
    { preparation: prep, customInstructions: "manual", signal: disabledAbort.signal },
    { ...ctx, env: { HOME: root, LARVA_PI_COMPACTION_CONFIG_FILE: disabledConfig } },
    {},
    async () => {
      calls += 1;
      return { summary: "should not run", firstKeptEntryId: "kept-entry", tokensBefore: 777 };
    },
  );
  assert.deepEqual(alreadyDisabled, { cancel: true });
  assert.equal(calls, 0);

  const emptyFocusConfig = join(root, "empty-focus-compaction.json");
  await writeFile(emptyFocusConfig, JSON.stringify({ enabled: true, carry_forward_rule: { enabled: false, text: "" } }), "utf8");
  const emptyFocusAbort = new AbortController();
  emptyFocusAbort.abort();
  const alreadyEmptyFocus = await mod.handleLarvaSessionBeforeCompact(
    { preparation: prep, signal: emptyFocusAbort.signal },
    { ...ctx, env: { HOME: root, LARVA_PI_COMPACTION_CONFIG_FILE: emptyFocusConfig } },
    {},
    async () => {
      calls += 1;
      return { summary: "should not run", firstKeptEntryId: "kept-entry", tokensBefore: 777 };
    },
  );
  assert.deepEqual(alreadyEmptyFocus, { cancel: true });
  assert.equal(calls, 0);

  const invalidConfig = join(root, "invalid-compaction.json");
  await writeFile(invalidConfig, "{not-json", "utf8");
  const invalidConfigAbort = new AbortController();
  invalidConfigAbort.abort();
  const alreadyInvalidConfig = await mod.handleLarvaSessionBeforeCompact(
    { preparation: prep, customInstructions: "manual", signal: invalidConfigAbort.signal },
    { ...ctx, env: { HOME: root, LARVA_PI_COMPACTION_CONFIG_FILE: invalidConfig } },
    {},
    async () => {
      calls += 1;
      return { summary: "should not run", firstKeptEntryId: "kept-entry", tokensBefore: 777 };
    },
  );
  assert.deepEqual(alreadyInvalidConfig, { cancel: true });
  assert.equal(calls, 0);

  const thrown = await mod.handleLarvaSessionBeforeCompact({ preparation: prep, customInstructions: "manual", signal: new AbortController().signal }, ctx, {}, async () => {
    calls += 1;
    const error = new Error("Compaction cancelled");
    throw error;
  });
  assert.deepEqual(thrown, { cancel: true });
  assert.equal(calls, 1);

  const fallback = await mod.handleLarvaSessionBeforeCompact({ preparation: { ...prep, fileOps: null }, customInstructions: "manual", signal: new AbortController().signal }, ctx, {}, async () => {
    calls += 1;
    return { summary: "should not run", firstKeptEntryId: "kept-entry", tokensBefore: 777 };
  });
  assert.equal(fallback, undefined);
  assert.equal(calls, 1);
});
