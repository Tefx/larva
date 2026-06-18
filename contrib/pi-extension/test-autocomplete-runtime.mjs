import { spawnSync } from "node:child_process";
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
const scenarios = [
  "substring-case-ordering",
  "cache-inflight",
  "delegation-failure",
  "fixture-shape",
  "mention-namespace",
  "registration-lifecycle",
];

if (!scenario) {
  const results = scenarios.map((scenarioName) => runScenarioProcess(scenarioName));
  console.log(JSON.stringify({ mode: "all", passed: results.length, cases: scenarios, results }, null, 2));
  process.exit(0);
}

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const extensionUrl = pathToFileURL(join(root, "contrib", "pi-extension", "larva.ts")).href;
const fakeCli = join(root, "tests", "fixtures", "pi", "fake-larva-cli.mjs");
const mod = await import(extensionUrl);
const defaultCacheDir = await mkdtemp(join(tmpdir(), "larva-pi-autocomplete-cache-"));
const defaultCacheFile = join(defaultCacheDir, "persona-candidates-cache.json");

function baseEnv(overrides = {}) {
  return {
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
    LARVA_PI_INITIAL_PERSONA_ID: "",
    LARVA_PI_LAUNCHED: "0",
    LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE: defaultCacheFile,
    ...overrides,
  };
}

async function makeRuntime(env = baseEnv()) {
  mod.resetPersonaCompletionCache();
  let installedFactory = null;
  let registeredCommand = null;
  const handlers = {};
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
    on: (event, handler) => { handlers[event] = handler; },
  };
  await mod.initializeExtension(ctx, pi);
  if (registeredCommand?.name !== "larva-persona") throw new Error("larva-persona command was not preserved");
  if (typeof registeredCommand.options?.getArgumentCompletions !== "function") throw new Error("command completer missing");
  if (typeof installedFactory === "function") throw new Error("autocomplete provider factory must not install during factory initialization");
  if (typeof handlers.session_start !== "function") throw new Error("session_start handler missing");
  await handlers.session_start({ reason: "runtime" }, ctx);
  if (typeof installedFactory !== "function") throw new Error("autocomplete provider factory missing");
  const baseProvider = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol, delegated: true }),
    shouldTriggerFileCompletion: () => false,
  };
  const installedProvider = installedFactory(baseProvider);
  if (typeof installedProvider?.getSuggestions !== "function") throw new Error("autocomplete provider object missing getSuggestions");
  if (typeof installedProvider?.applyCompletion !== "function") throw new Error("autocomplete provider object missing applyCompletion");
  return { ctx, installedProvider, registeredCommand, handlers };
}

async function registrationLifecycleEvidence() {
  let installCount = 0;
  let registeredCommand = null;
  const handlers = {};
  const factoryCtx = { env: baseEnv() };
  const runtimeCtx = {
    env: baseEnv(),
    ui: {
      setStatus: async () => undefined,
      addAutocompleteProvider: () => { installCount += 1; },
    },
  };
  const pi = {
    registerCommand: (name, options) => { registeredCommand = { name, options }; },
    registerTool: () => undefined,
    on: (event, handler) => { handlers[event] = handler; },
  };
  await mod.initializeExtension(factoryCtx, pi);
  const afterFactory = installCount;
  await handlers.session_start({ reason: "first" }, runtimeCtx);
  const afterFirstSession = installCount;
  await handlers.session_start({ reason: "second" }, runtimeCtx);
  return {
    afterFactory,
    afterFirstSession,
    afterSecondSession: installCount,
    hasSessionStart: typeof handlers.session_start === "function",
    registeredName: registeredCommand?.name ?? null,
  };
}

async function getSuggestions(provider, line, options = { force: true }) {
  return provider.getSuggestions([line], 0, line.length, options);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCount(path) {
  try {
    return Number.parseInt(await readFile(path, "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

async function eventuallyCachedSuggestion(provider, line) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await getSuggestions(provider, line);
    if (result !== null) return result;
    await sleep(25);
  }
  return null;
}

async function listFixtureEvidence() {
  const { installedProvider } = await makeRuntime();
  const result = await getSuggestions(installedProvider, "/larva-persona vectl");
  const items = result?.items ?? [];
  return {
    providerResultIsObject: result !== null && typeof result === "object" && !Array.isArray(result),
    resultItemsIsArray: Array.isArray(result?.items),
    prefixFromProvider: result?.prefix ?? null,
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
  const namespacePartialItems = namespacePartial?.items ?? [];
  const bareNamespaceItems = bareNamespace?.items ?? [];
  const queryItems = query?.items ?? [];
  const applied = installedProvider.applyCompletion(["please ask @persona:"], 0, "please ask @persona:".length, bareNamespaceItems[0], bareNamespace.prefix);
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
    namespacePartialResultIsObject: namespacePartial !== null && typeof namespacePartial === "object" && !Array.isArray(namespacePartial),
    bareNamespaceResultIsObject: bareNamespace !== null && typeof bareNamespace === "object" && !Array.isArray(bareNamespace),
    queryResultIsObject: query !== null && typeof query === "object" && !Array.isArray(query),
    namespacePartialItemsIsArray: Array.isArray(namespacePartial?.items),
    bareNamespaceItemsIsArray: Array.isArray(bareNamespace?.items),
    queryItemsIsArray: Array.isArray(query?.items),
    namespacePartialPrefix: namespacePartial?.prefix ?? null,
    bareNamespacePrefix: bareNamespace?.prefix ?? null,
    queryPrefix: query?.prefix ?? null,
    namespacePartialValues: namespacePartialItems.map((item) => item.value),
    bareNamespaceValues: bareNamespaceItems.map((item) => item.value),
    queryValues: queryItems.map((item) => item.value),
    delegatedRawShort,
    applied,
    expected,
    namespacePartialReturnsAllEligible: JSON.stringify(namespacePartialItems.map((item) => item.value)) === JSON.stringify(expected),
    bareNamespaceReturnsAllEligible: JSON.stringify(bareNamespaceItems.map((item) => item.value)) === JSON.stringify(expected),
    queryUsesSuffixOnly: JSON.stringify(queryItems.map((item) => item.value)) === JSON.stringify([
      "@persona:DevOps",
      "@persona:devrel",
      "@persona:qa-dev",
      "@persona:backend-dev",
    ]),
    rawShortDelegatesOnly: delegatedRawShort === null,
    applyCompletionInsertedMention: applied.lines?.[0] === "please ask @persona:ok" && applied.cursorCol === "please ask @persona:ok".length,
  };
}

function failCheck(scenarioName, label, actual, expected) {
  throw new Error(`${scenarioName}: ${label} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

function assertEqual(scenarioName, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failCheck(scenarioName, label, actual, expected);
}

function assertTrue(scenarioName, label, actual) {
  if (actual !== true) failCheck(scenarioName, label, actual, true);
}

function assertNull(scenarioName, label, actual) {
  if (actual !== null) failCheck(scenarioName, label, actual, null);
}

function assertScenarioChecks(result) {
  if (result.case === "substring-case-ordering") {
    const expected = ["DevOps", "devrel", "qa-dev", "backend-dev"];
    assertEqual(result.case, "providerValues", result.providerValues, expected);
    assertEqual(result.case, "commandValues", result.commandValues, expected);
    assertEqual(result.case, "prefixFromProvider", result.prefixFromProvider, prefix || "DEV");
    assertTrue(result.case, "providerResultIsObject", result.providerResultIsObject);
    assertTrue(result.case, "resultItemsIsArray", result.resultItemsIsArray);
    assertTrue(result.case, "substringCaseInsensitive", result.substringCaseInsensitive);
    assertTrue(result.case, "prefixFirstStableOrder", result.prefixFirstStableOrder);
    assertTrue(result.case, "forcedAndCommandSharePath", result.forcedAndCommandSharePath);
  } else if (result.case === "cache-inflight") {
    assertEqual(result.case, "listInvocationCountDuringOverlap", result.listInvocationCountDuringOverlap, 1);
    assertEqual(result.case, "listInvocationCountAfterCacheReuse", result.listInvocationCountAfterCacheReuse, 1);
    assertEqual(result.case, "prefixesFromProvider[-1]", result.prefixesFromProvider.at(-1), "vectl");
    assertTrue(result.case, "coldResultsAreNullOrObjects", result.coldResultsAreNullOrObjects);
    assertTrue(result.case, "cachedResultIsObject", result.cachedResultIsObject);
    assertTrue(result.case, "resultItemsAreArrays", result.resultItemsAreArrays);
    assertTrue(result.case, "inFlightDedupeProven", result.inFlightDedupeProven);
    assertTrue(result.case, "cacheReuseProven", result.cacheReuseProven);
  } else if (result.case === "delegation-failure") {
    assertTrue(result.case, "delegated", result.delegated);
    assertEqual(result.case, "calls", result.calls, [["/not-larva vectl", "object"]]);
    assertEqual(result.case, "delegatedItems", result.delegatedItems, [
      { value: "file.txt", label: "file.txt", description: "base file completion" },
    ]);
    assertNull(result.case, "failed", result.failed);
    assertNull(result.case, "malformed", result.malformed);
    assertTrue(result.case, "failClosedNoCrash", result.failClosedNoCrash);
  } else if (result.case === "fixture-shape") {
    assertEqual(result.case, "exactDocumentedShape", result.exactDocumentedShape, {
      data: [
        {
          id: "vectl-planner",
          description: "Plan with vectl",
          spec_digest: "sha256:vectl-planner",
          model: "openai/gpt-5.5",
        },
        {
          id: "vectl-reviewer",
          description: "Review with vectl",
          spec_digest: "sha256:vectl-reviewer",
          model: "openai/gpt-5.5",
        },
      ],
    });
    assertEqual(result.case, "candidateKeys", result.candidateKeys, [["description", "label", "value"], ["description", "label", "value"]]);
    assertEqual(result.case, "prefixFromProvider", result.prefixFromProvider, "vectl");
    assertTrue(result.case, "providerResultIsObject", result.providerResultIsObject);
    assertTrue(result.case, "resultItemsIsArray", result.resultItemsIsArray);
    assertTrue(result.case, "noAliasFuzzyRegexWildcardFields", result.noAliasFuzzyRegexWildcardFields);
  } else if (result.case === "mention-namespace") {
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
    assertEqual(result.case, "namespacePartialValues", result.namespacePartialValues, expected);
    assertEqual(result.case, "bareNamespaceValues", result.bareNamespaceValues, expected);
    assertEqual(result.case, "queryValues", result.queryValues, ["@persona:DevOps", "@persona:devrel", "@persona:qa-dev", "@persona:backend-dev"]);
    assertEqual(result.case, "namespacePartialPrefix", result.namespacePartialPrefix, "@p");
    assertEqual(result.case, "bareNamespacePrefix", result.bareNamespacePrefix, "@persona:");
    assertEqual(result.case, "queryPrefix", result.queryPrefix, "@persona:DEV");
    assertNull(result.case, "delegatedRawShort", result.delegatedRawShort);
    assertTrue(result.case, "namespacePartialResultIsObject", result.namespacePartialResultIsObject);
    assertTrue(result.case, "bareNamespaceResultIsObject", result.bareNamespaceResultIsObject);
    assertTrue(result.case, "queryResultIsObject", result.queryResultIsObject);
    assertTrue(result.case, "namespacePartialItemsIsArray", result.namespacePartialItemsIsArray);
    assertTrue(result.case, "bareNamespaceItemsIsArray", result.bareNamespaceItemsIsArray);
    assertTrue(result.case, "queryItemsIsArray", result.queryItemsIsArray);
    assertTrue(result.case, "namespacePartialReturnsAllEligible", result.namespacePartialReturnsAllEligible);
    assertTrue(result.case, "bareNamespaceReturnsAllEligible", result.bareNamespaceReturnsAllEligible);
    assertTrue(result.case, "queryUsesSuffixOnly", result.queryUsesSuffixOnly);
    assertTrue(result.case, "rawShortDelegatesOnly", result.rawShortDelegatesOnly);
    assertTrue(result.case, "applyCompletionInsertedMention", result.applyCompletionInsertedMention);
  } else if (result.case === "registration-lifecycle") {
    assertEqual(result.case, "registeredName", result.registeredName, "larva-persona");
    assertEqual(result.case, "afterFactory", result.afterFactory, 0);
    assertEqual(result.case, "afterFirstSession", result.afterFirstSession, 1);
    assertEqual(result.case, "afterSecondSession", result.afterSecondSession, 1);
    assertTrue(result.case, "hasSessionStart", result.hasSessionStart);
  } else {
    throw new Error(`unknown --case ${result.case}`);
  }
}

function runScenarioProcess(scenarioName) {
  const completed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--case", scenarioName], { encoding: "utf8" });
  if (completed.status !== 0) {
    if (completed.stdout) process.stdout.write(completed.stdout);
    if (completed.stderr) process.stderr.write(completed.stderr);
    throw new Error(`${scenarioName}: exited ${completed.status}`);
  }
  let result;
  try {
    result = JSON.parse(completed.stdout);
  } catch (error) {
    throw new Error(`${scenarioName}: invalid JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertScenarioChecks(result);
  return result;
}

let output;
if (scenario === "substring-case-ordering") {
  const { installedProvider, registeredCommand } = await makeRuntime();
  const providerResult = await getSuggestions(installedProvider, `/larva-persona ${prefix || "DEV"}`);
  const providerItems = providerResult?.items ?? [];
  const commandItems = await registeredCommand.options.getArgumentCompletions(prefix || "DEV");
  output = {
    query: prefix || "DEV",
    providerResultIsObject: providerResult !== null && typeof providerResult === "object" && !Array.isArray(providerResult),
    resultItemsIsArray: Array.isArray(providerResult?.items),
    prefixFromProvider: providerResult?.prefix ?? null,
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
    FAKE_LARVA_LIST_DELAY_MS: "25",
  }));
  const [first, second] = await Promise.all([
    getSuggestions(installedProvider, "/larva-persona vectl", { force: true }),
    getSuggestions(installedProvider, "/larva-persona vectl", { force: false }),
  ]);
  const afterConcurrent = await readCount(countFile);
  const cached = await eventuallyCachedSuggestion(installedProvider, "/larva-persona vectl");
  const afterCache = await readCount(countFile);
  const acceptableColdResult = (result) => result === null || (typeof result === "object" && !Array.isArray(result));
  output = {
    coldResultsAreNullOrObjects: [first, second].every(acceptableColdResult),
    cachedResultIsObject: cached !== null && typeof cached === "object" && !Array.isArray(cached),
    resultItemsAreArrays: [first, second].every((result) => result === null || Array.isArray(result?.items)) && Array.isArray(cached?.items),
    prefixesFromProvider: [first?.prefix ?? null, second?.prefix ?? null, cached?.prefix ?? null],
    concurrentValues: [first?.items?.map((item) => item.value) ?? null, second?.items?.map((item) => item.value) ?? null],
    cacheValues: cached?.items?.map((item) => item.value) ?? null,
    listInvocationCountDuringOverlap: afterConcurrent,
    listInvocationCountAfterCacheReuse: afterCache,
    inFlightDedupeProven: afterConcurrent === 1,
    cacheReuseProven: afterCache === 1 && cached !== null,
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
} else if (scenario === "registration-lifecycle") {
  output = await registrationLifecycleEvidence();
} else {
  throw new Error(`unknown --case ${scenario}`);
}

const payload = { case: scenario, ...output };
assertScenarioChecks(payload);
console.log(JSON.stringify(payload, null, 2));
