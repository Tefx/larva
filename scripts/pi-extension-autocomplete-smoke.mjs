import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key?.startsWith("--")) args.set(key.slice(2), process.argv[index + 1] ?? "");
}

const scenario = args.get("case");
const prefix = args.get("prefix") ?? "";
if (!scenario) throw new Error("missing --case");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionUrl = pathToFileURL(join(root, "contrib", "pi-extension", "larva.ts")).href;
const mod = await import(extensionUrl);
const fakeCli = join(root, "tests", "fixtures", "pi", "fake-larva-cli.mjs");
const cacheDir = await mkdtemp(join(tmpdir(), "larva-pi-autocomplete-cache-"));
const cacheFile = join(cacheDir, "persona-candidates-cache.json");

let installedFactory = null;
let registeredCommand = null;
const handlers = {};
const env = {
  LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
  LARVA_PI_INITIAL_PERSONA_ID: "",
  LARVA_PI_LAUNCHED: "0",
  LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE: cacheFile,
};
const ctx = {
  env,
  ui: {
    setStatus: async () => undefined,
    addAutocompleteProvider: (factory) => {
      installedFactory = factory;
    },
  },
};
const pi = {
  registerCommand: (name, options) => {
    registeredCommand = { name, options };
  },
  registerTool: () => undefined,
  on: (event, handler) => {
    handlers[event] = handler;
  },
};

await mod.initializeExtension(ctx, pi);
if (registeredCommand?.name !== "larva-persona") throw new Error("larva-persona command was not preserved");
if (typeof registeredCommand.options?.getArgumentCompletions !== "function") {
  throw new Error("command argument completer was not preserved");
}
if (typeof installedFactory === "function") throw new Error("autocomplete provider factory must not install during factory initialization");
if (typeof handlers.session_start !== "function") throw new Error("session_start handler was not registered");
await handlers.session_start({ reason: "runtime" }, ctx);
if (typeof installedFactory !== "function") throw new Error("autocomplete provider factory was not installed");
const baseProvider = {
  getSuggestions: async () => null,
  applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol, delegated: true }),
  shouldTriggerFileCompletion: () => false,
};
const installedProvider = installedFactory(baseProvider);
if (typeof installedProvider?.getSuggestions !== "function") throw new Error("autocomplete provider object was not installed");

async function getSuggestions(provider, line, options = { force: true }) {
  return provider.getSuggestions([line], 0, line.length, options);
}

async function runTab(force) {
  const editorLine = `/larva-persona ${prefix}`;
  const result = await getSuggestions(installedProvider, editorLine, { force });
  const items = result?.items ?? null;
  const values = items?.map((item) => item.value) ?? null;
  return {
    command: registeredCommand.name,
    force,
    prefix,
    editorLine,
    resultIsObject: result !== null && typeof result === "object" && !Array.isArray(result),
    prefixFromProvider: result?.prefix ?? null,
    items,
    values,
    allValuesAreStrings: Array.isArray(items) && items.every((item) => typeof item.value === "string"),
    valuesEqualPersonaIds: Array.isArray(items) && items.every((item) => item.value === item.label),
    provesArgumentPrefix: Array.isArray(values)
      && values.includes("vectl-planner")
      && values.every((value) => value.startsWith(prefix))
      && !values.some((value) => value.startsWith(editorLine)),
    exactShape: Array.isArray(items) && items.every((item) => (
      typeof item.value === "string"
      && item.label === item.value
      && Object.keys(item).every((key) => ["value", "label", "description"].includes(key))
    )),
  };
}

async function runMentionNamespace() {
  const editorLine = prefix || "@persona:";
  const result = await getSuggestions(installedProvider, editorLine);
  const items = result?.items ?? null;
  const values = items?.map((item) => item.value) ?? null;
  const applied = installedProvider.applyCompletion([editorLine], 0, editorLine.length, items[0], result.prefix);
  const expected = [
    "@persona:ok",
    "@persona:startup",
    "@persona:child",
    "@persona:vectl-planner",
    "@persona:vectl-reviewer",
    "@persona:qa-dev",
    "@persona:DevOps",
    "@persona:devrel",
    "@persona:backend-dev",
  ];
  return {
    command: registeredCommand.name,
    editorLine,
    resultIsObject: result !== null && typeof result === "object" && !Array.isArray(result),
    resultItemsIsArray: Array.isArray(result?.items),
    prefixFromProvider: result?.prefix ?? null,
    items,
    values,
    expected,
    allValuesAreStrings: Array.isArray(items) && items.every((item) => typeof item.value === "string"),
    allValuesArePersonaMentions: Array.isArray(values) && values.every((value) => value.startsWith("@persona:")),
    allEligiblePersonaMentionsReturned: JSON.stringify(values) === JSON.stringify(expected),
    applyCompletionInsertedMention: applied.lines?.[0] === "@persona:ok",
  };
}

async function runMentionRawQuery() {
  const editorLine = prefix || "@vectl";
  const baseItems = [
    { value: "./docs/vectl.md", label: "./docs/vectl.md", description: "Pi file reference" },
    { value: "@persona:vectl-planner", label: "Pi duplicate wins", description: "Pi-provided duplicate" },
  ];
  const baseCalls = [];
  const rawProvider = installedFactory({
    getSuggestions: async (lines, cursorLine, cursorCol) => {
      const line = Array.isArray(lines) ? (lines[cursorLine] ?? "").slice(0, cursorCol) : String(lines ?? "");
      baseCalls.push(line);
      return baseItems;
    },
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol, delegated: true }),
    shouldTriggerFileCompletion: () => true,
  });
  const raw = await getSuggestions(rawProvider, editorLine);
  const personaOnly = await getSuggestions(rawProvider, "@persona:vectl");
  const rawItems = raw?.items ?? [];
  const personaOnlyItems = personaOnly?.items ?? [];
  const applied = rawProvider.applyCompletion([editorLine], 0, editorLine.length, rawItems[1], raw?.prefix);
  return {
    command: registeredCommand.name,
    editorLine,
    rawPrefix: raw?.prefix ?? null,
    personaOnlyPrefix: personaOnly?.prefix ?? null,
    rawValues: rawItems.map((item) => item.value),
    rawLabels: rawItems.map((item) => item.label),
    personaOnlyValues: personaOnlyItems.map((item) => item.value),
    baseCalls,
    rawMergesFileFirst: JSON.stringify(rawItems.map((item) => item.value)) === JSON.stringify([
      "./docs/vectl.md",
      "@persona:vectl-planner",
      "@persona:vectl-reviewer",
    ]),
    rawKeepsBaseDuplicateFirst: rawItems[1]?.label === "Pi duplicate wins",
    personaOnlyStaysPersonaOnly: JSON.stringify(personaOnlyItems.map((item) => item.value)) === JSON.stringify([
      "@persona:vectl-planner",
      "@persona:vectl-reviewer",
    ]),
    appliedCanonicalMention: applied.lines?.[0] === "@persona:vectl-planner",
  };
}

let output;
if (scenario === "tab-force") {
  output = await runTab(true);
} else if (scenario === "tab-regular") {
  output = await runTab(false);
} else if (scenario === "delegate-other-input") {
  const calls = [];
  const baseResult = [{ value: "file.txt", label: "file.txt", description: "base file completion" }];
  const provider = mod.createLarvaPersonaAutocompleteProvider(ctx, (...providerArgs) => {
    calls.push(providerArgs.map((arg) => (typeof arg === "string" ? arg : typeof arg)));
    return baseResult;
  });
  const items = await provider("/not-larva vectl", { force: true });
  output = { calls, items, delegated: items === baseResult };
} else if (scenario === "list-failure") {
  process.env.FAKE_LARVA_SCENARIO = "list-exit";
  const failed = await getSuggestions(installedProvider, `/larva-persona ${prefix || "vectl"}`);
  process.env.FAKE_LARVA_SCENARIO = "list-malformed";
  const malformed = await getSuggestions(installedProvider, `/larva-persona ${prefix || "vectl"}`, { force: false });
  output = { failed, malformed, noCrash: failed === null && malformed === null };
} else if (scenario === "mention-namespace") {
  output = await runMentionNamespace();
} else if (scenario === "mention-raw-query") {
  output = await runMentionRawQuery();
} else {
  throw new Error(`unknown --case ${scenario}`);
}

console.log(JSON.stringify({ case: scenario, ...output }, null, 2));
