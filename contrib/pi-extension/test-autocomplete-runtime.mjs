import { mkdtemp, readFile } from "node:fs/promises";
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

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const extensionUrl = pathToFileURL(join(root, "contrib", "pi-extension", "larva.ts")).href;
const fakeCli = join(root, "tests", "fixtures", "pi", "fake-larva-cli.mjs");
const mod = await import(extensionUrl);

function baseEnv(overrides = {}) {
  return {
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
    ...overrides,
  };
}

async function makeRuntime(env = baseEnv()) {
  mod.resetPersonaCompletionCache();
  let installedFactory = null;
  let registeredCommand = null;
  const ctx = {
    env,
    ui: {
      setStatus: async () => undefined,
      addAutocompleteProvider: (factory) => { installedFactory = factory; },
    },
  };
  const pi = {
    registerCommand: (name, options) => { registeredCommand = { name, options }; },
    registerTool: () => undefined,
    on: () => undefined,
  };
  await mod.initializeExtension(ctx, pi);
  if (registeredCommand?.name !== "larva-persona") throw new Error("larva-persona command was not preserved");
  if (typeof registeredCommand.options?.getArgumentCompletions !== "function") throw new Error("command completer missing");
  if (typeof installedFactory !== "function") throw new Error("autocomplete provider factory missing");
  const baseProvider = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol, delegated: true }),
    shouldTriggerFileCompletion: () => false,
  };
  const installedProvider = installedFactory(baseProvider);
  if (typeof installedProvider?.getSuggestions !== "function") throw new Error("autocomplete provider object missing getSuggestions");
  if (typeof installedProvider?.applyCompletion !== "function") throw new Error("autocomplete provider object missing applyCompletion");
  return { ctx, installedProvider, registeredCommand };
}

async function getSuggestions(provider, line, options = { force: true }) {
  return provider.getSuggestions([line], 0, line.length, options);
}

async function readCount(path) {
  try {
    return Number.parseInt(await readFile(path, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

async function listFixtureEvidence() {
  const { installedProvider } = await makeRuntime();
  const items = await getSuggestions(installedProvider, "/larva-persona vectl");
  return {
    exactDocumentedShape: {
      data: items.map((item) => ({
        id: item.value,
        description: item.description,
        spec_digest: `sha256:${item.value}`,
        model: "openai/gpt-5.5",
      })),
    },
    candidateKeys: items.map((item) => Object.keys(item).sort()),
    noAliasFuzzyRegexWildcardFields: items.every((item) => !Object.keys(item).some((key) => (
      ["alias", "aliases", "fuzzy", "regex", "wildcard", "pattern"].includes(key)
    ))),
  };
}

async function mentionNamespaceEvidence() {
  const { installedProvider } = await makeRuntime();
  const namespacePartial = await getSuggestions(installedProvider, "@p");
  const bareNamespace = await getSuggestions(installedProvider, "@persona:");
  const query = await getSuggestions(installedProvider, "please ask @persona:DEV");
  const delegatedRawShort = await getSuggestions(installedProvider, "@vectl");
  const applied = installedProvider.applyCompletion(["please ask @persona:"], 0, "please ask @persona:".length, bareNamespace[0], "");
  const expected = [
    "@persona:vectl-planner",
    "@persona:vectl-reviewer",
    "@persona:qa-dev",
    "@persona:DevOps",
    "@persona:devrel",
    "@persona:backend-dev",
  ];
  return {
    namespacePartialValues: namespacePartial.map((item) => item.value),
    bareNamespaceValues: bareNamespace.map((item) => item.value),
    queryValues: query.map((item) => item.value),
    delegatedRawShort,
    applied,
    expected,
    namespacePartialReturnsAllEligible: JSON.stringify(namespacePartial.map((item) => item.value)) === JSON.stringify(expected),
    bareNamespaceReturnsAllEligible: JSON.stringify(bareNamespace.map((item) => item.value)) === JSON.stringify(expected),
    queryUsesSuffixOnly: JSON.stringify(query.map((item) => item.value)) === JSON.stringify([
      "@persona:DevOps",
      "@persona:devrel",
      "@persona:qa-dev",
      "@persona:backend-dev",
    ]),
    rawShortDelegatesOnly: delegatedRawShort === null,
    applyCompletionInsertedMention: applied.lines?.[0] === "please ask @persona:vectl-planner" && applied.cursorCol === "please ask @persona:vectl-planner".length,
  };
}

let output;
if (scenario === "substring-case-ordering") {
  const { installedProvider, registeredCommand } = await makeRuntime();
  const providerItems = await getSuggestions(installedProvider, `/larva-persona ${prefix || "DEV"}`);
  const commandItems = await registeredCommand.options.getArgumentCompletions(prefix || "DEV");
  output = {
    query: prefix || "DEV",
    providerValues: providerItems.map((item) => item.value),
    commandValues: commandItems.map((item) => item.value),
    substringCaseInsensitive: providerItems.some((item) => item.value === "qa-dev") && providerItems.some((item) => item.value === "DevOps"),
    prefixFirstStableOrder: providerItems.map((item) => item.value).join(",") === "DevOps,devrel,qa-dev,backend-dev",
    expectedOrder: ["DevOps", "devrel", "qa-dev", "backend-dev"],
    forcedAndCommandSharePath: JSON.stringify(providerItems) === JSON.stringify(commandItems),
  };
} else if (scenario === "cache-inflight") {
  const dir = await mkdtemp(join(tmpdir(), "larva-pi-autocomplete-"));
  const countFile = join(dir, "list-count.txt");
  const { installedProvider } = await makeRuntime(baseEnv({
    FAKE_LARVA_COUNT_FILE: countFile,
    FAKE_LARVA_LIST_DELAY_MS: "150",
  }));
  const [first, second] = await Promise.all([
    getSuggestions(installedProvider, "/larva-persona vectl", { force: true }),
    getSuggestions(installedProvider, "/larva-persona vectl", { force: false }),
  ]);
  const afterConcurrent = await readCount(countFile);
  const cached = await getSuggestions(installedProvider, "/larva-persona vectl");
  const afterCache = await readCount(countFile);
  output = {
    concurrentValues: [first.map((item) => item.value), second.map((item) => item.value)],
    cacheValues: cached.map((item) => item.value),
    listInvocationCountDuringOverlap: afterConcurrent,
    listInvocationCountAfterCacheReuse: afterCache,
    inFlightDedupeProven: afterConcurrent === 1,
    cacheReuseProven: afterCache === 1,
  };
} else if (scenario === "delegation-failure") {
  const { installedProvider } = await makeRuntime();
  const calls = [];
  const baseResult = [{ value: "file.txt", label: "file.txt", description: "base file completion" }];
  const delegatedProvider = mod.createLarvaPersonaAutocompleteProvider({ env: baseEnv() }, (...providerArgs) => {
    calls.push(providerArgs.map((arg) => (typeof arg === "string" ? arg : typeof arg)));
    return baseResult;
  });
  const delegatedItems = await delegatedProvider("/not-larva vectl", { force: true });
  process.env.FAKE_LARVA_SCENARIO = "list-exit";
  mod.resetPersonaCompletionCache();
  const failed = await getSuggestions(installedProvider, `/larva-persona ${prefix || "vectl"}`);
  process.env.FAKE_LARVA_SCENARIO = "list-malformed";
  mod.resetPersonaCompletionCache();
  const malformed = await getSuggestions(installedProvider, `/larva-persona ${prefix || "vectl"}`, { force: false });
  delete process.env.FAKE_LARVA_SCENARIO;
  output = {
    delegated: delegatedItems === baseResult,
    calls,
    delegatedItems,
    failed,
    malformed,
    failClosedNoCrash: failed === null && malformed === null,
  };
} else if (scenario === "fixture-shape") {
  output = await listFixtureEvidence();
} else if (scenario === "mention-namespace") {
  output = await mentionNamespaceEvidence();
} else {
  throw new Error(`unknown --case ${scenario}`);
}

console.log(JSON.stringify({ case: scenario, ...output }, null, 2));
