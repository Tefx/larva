import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const extensionUrl = pathToFileURL(join(root, "contrib", "pi-extension", "larva.ts")).href;
const mod = await import(extensionUrl);

const dir = await mkdtemp(join(tmpdir(), "larva-pi-persona-hotpath-"));
const fakeCli = join(dir, "fake-larva-list-cli.mjs");
const listFile = join(dir, "list.json");
const invocationLog = join(dir, "invocations.log");
const cacheFile = join(dir, "persona-candidates-cache.json");
const sourceKey = JSON.stringify([process.execPath, fakeCli]);

await writeFile(fakeCli, `
import { appendFile, readFile } from "node:fs/promises";
const [, , command, jsonFlag] = process.argv;
await appendFile(process.env.FAKE_LARVA_INVOCATION_LOG, [command, jsonFlag ?? "", process.env.FAKE_LARVA_MODE ?? "ok"].join(" ") + "\\n");
if (command !== "list" || jsonFlag !== "--json") process.exit(3);
const delay = Number(process.env.FAKE_LARVA_DELAY_MS ?? "0");
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
if (process.env.FAKE_LARVA_MODE === "fail") process.exit(7);
const data = JSON.parse(await readFile(process.env.FAKE_LARVA_LIST_FILE, "utf8"));
process.stdout.write(JSON.stringify({ data }));
`, "utf8");

await writeFile(listFile, JSON.stringify([
  {
    id: "fresh-public",
    description: "Fresh public description",
    model: "provider/fresh",
    spec_digest: "sha256:fresh-public",
    capabilities: { shell: "read_only" },
    prompt: "SECRET PROMPT MUST NOT REACH CACHE OR UI",
  },
]), "utf8");

await writeFile(cacheFile, `${JSON.stringify({
  version: 1,
  source: "larva list --json",
  source_key: sourceKey,
  fetched_at_ms: 0,
  candidates: [
    {
      id: "disk-cached",
      description: "Disk cached description",
      model: "provider/cached",
      spec_digest: "sha256:disk-cached",
      capabilities: { shell: "read_only" },
    },
  ],
})}\n`, "utf8");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function personaValues(items) {
  return (items ?? []).map((item) => ({ value: item.value, label: item.label, description: item.description }));
}

async function collectSinks(ctx) {
  const slashStarted = Date.now();
  const slash = await mod.completePersonaIds("", ctx);
  const slashElapsedMs = Date.now() - slashStarted;

  const selector = { options: null, selected: null };
  const selectorStarted = Date.now();
  const selected = await mod.openPersonaSelector({
    ...ctx,
    ui: {
      select: async (_title, options) => {
        selector.options = options;
        selector.selected = options[0] ?? null;
        return selector.selected;
      },
    },
  });
  const selectorElapsedMs = Date.now() - selectorStarted;

  const provider = mod.createLarvaPersonaMentionAutocompleteProvider(ctx, {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    shouldTriggerFileCompletion: () => false,
  });
  const mentionStarted = Date.now();
  const mention = await provider.getSuggestions(["ask @persona:"], 0, "ask @persona:".length, { force: true });
  const mentionElapsedMs = Date.now() - mentionStarted;

  const personasTool = await mod.larva_personas({ limit: 25 }, ctx);
  const toolPersona = personasTool.details.personas[0] ?? null;
  const toolPersonaShape = toolPersona === null ? null : {
    keys: Object.keys(toolPersona),
    hasOwnPrompt: Object.prototype.hasOwnProperty.call(toolPersona, "prompt"),
    allowlistedKeysOnly: Object.keys(toolPersona).every((key) => ["id", "description", "model", "spec_digest", "capabilities"].includes(key)),
  };

  return {
    slash: personaValues(slash),
    slashElapsedMs,
    selector: {
      selected,
      options: selector.options,
      elapsedMs: selectorElapsedMs,
    },
    mention: {
      items: personaValues(mention?.items),
      prefix: mention?.prefix ?? null,
      elapsedMs: mentionElapsedMs,
    },
    personasTool: {
      status: personasTool.details.status,
      firstPersonaShape: toolPersonaShape,
    },
  };
}

function assertNoOwnPrompt(items, label) {
  for (const item of items) {
    const shape = item.personasTool?.firstPersonaShape;
    if (shape === null) continue;
    if (shape.hasOwnPrompt || shape.keys.includes("prompt") || !shape.allowlistedKeysOnly) {
      throw new Error(`${label} included a prompt own property or non-allowlisted key: ${JSON.stringify(shape)}`);
    }
  }
}

function assertNoPrompt(payload, label) {
  const text = JSON.stringify(payload);
  if (text.includes("prompt") || text.includes("SECRET")) throw new Error(`${label} leaked prompt material: ${text}`);
}

mod.resetPersonaCompletionCache();
mod.setPersonaCompletionClock(() => 6_000);
let setModelCalls = 0;
let setActiveToolsCalls = 0;
let appendEntryCalls = 0;
const ctx = {
  env: {
    HOME: join(dir, "home"),
    LARVA_CLI_ARGV_JSON: sourceKey,
    LARVA_PI_AGENT_PERSONA_SWITCH: "auto",
    LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE: cacheFile,
    FAKE_LARVA_LIST_FILE: listFile,
    FAKE_LARVA_INVOCATION_LOG: invocationLog,
    FAKE_LARVA_DELAY_MS: "250",
    FAKE_LARVA_MODE: "ok",
  },
  setModel: () => { setModelCalls += 1; },
  setActiveTools: () => { setActiveToolsCalls += 1; },
  appendEntry: () => { appendEntryCalls += 1; },
  registerCommand: () => undefined,
  registerTool: () => undefined,
};
await mod.initializeExtension(ctx, ctx);
const stateBefore = { activeEnvelope: mod.getActiveEnvelope(), setModelCalls, setActiveToolsCalls, appendEntryCalls };

const staleBeforeRefresh = await collectSinks(ctx);
assertNoPrompt(staleBeforeRefresh, "stale hot path");
await sleep(400);
const refreshedCacheText = await readFile(cacheFile, "utf8");
assertNoPrompt(refreshedCacheText, "refreshed cache");
const freshAfterRefresh = await collectSinks(ctx);
assertNoPrompt(freshAfterRefresh, "fresh hot path");

mod.setPersonaCompletionClock(() => 12_000);
ctx.env.FAKE_LARVA_MODE = "fail";
ctx.env.FAKE_LARVA_DELAY_MS = "350";
const failureStale = await collectSinks(ctx);
assertNoPrompt(failureStale, "failure stale hot path");
await sleep(500);
const afterFailedRefresh = await collectSinks(ctx);
assertNoPrompt(afterFailedRefresh, "after failed refresh");
assertNoOwnPrompt([staleBeforeRefresh, freshAfterRefresh, failureStale, afterFailedRefresh], "larva_personas candidate output");

const stateAfter = { activeEnvelope: mod.getActiveEnvelope(), setModelCalls, setActiveToolsCalls, appendEntryCalls };
const invocationsText = await readFile(invocationLog, "utf8").catch(() => "");
const cacheAfterFailureText = await readFile(cacheFile, "utf8");

const evidence = {
  smoke: "persona-candidate-hotpath-runtime",
  source: "larva list --json",
  staleBeforeRefresh,
  freshAfterRefresh,
  failureStale,
  afterFailedRefresh,
  cacheAfterRefresh: JSON.parse(refreshedCacheText),
  cacheAfterFailure: JSON.parse(cacheAfterFailureText),
  invocations: invocationsText.trim().split("\n").filter(Boolean),
  noPromptInUiOrCache: !JSON.stringify({ staleBeforeRefresh, freshAfterRefresh, failureStale, afterFailedRefresh, refreshedCacheText, cacheAfterFailureText }).includes("SECRET") && !JSON.stringify({ staleBeforeRefresh, freshAfterRefresh, failureStale, afterFailedRefresh, refreshedCacheText, cacheAfterFailureText }).includes("prompt"),
  personasToolOwnPromptAbsent: [staleBeforeRefresh, freshAfterRefresh, failureStale, afterFailedRefresh].every((item) => {
    const shape = item.personasTool.firstPersonaShape;
    return shape === null || (!shape.hasOwnPrompt && !shape.keys.includes("prompt") && shape.allowlistedKeysOnly);
  }),
  hotPathUnder200ms: [
    staleBeforeRefresh.slashElapsedMs,
    staleBeforeRefresh.selector.elapsedMs,
    staleBeforeRefresh.mention.elapsedMs,
    failureStale.slashElapsedMs,
    failureStale.selector.elapsedMs,
    failureStale.mention.elapsedMs,
  ].every((elapsedMs) => elapsedMs < 200),
  stateBefore,
  stateAfter,
  refreshDidNotAlterActivePersonaModelToolsOrSession: JSON.stringify(stateBefore) === JSON.stringify(stateAfter),
};

if (JSON.stringify(evidence.staleBeforeRefresh).includes("disk-cached") !== true) throw new Error("stale disk suggestions were not served");
if (JSON.stringify(evidence.freshAfterRefresh).includes("fresh-public") !== true) throw new Error("successful refresh did not update hot path suggestions");
if (JSON.stringify(evidence.failureStale).includes("fresh-public") !== true) throw new Error("failure path did not preserve stale suggestions");
if (!evidence.noPromptInUiOrCache) throw new Error("prompt material reached UI/cache evidence");
if (!evidence.personasToolOwnPromptAbsent) throw new Error("larva_personas candidate output included prompt own property evidence");
if (!evidence.hotPathUnder200ms) throw new Error("a hot path synchronously waited for refresh");
if (!evidence.refreshDidNotAlterActivePersonaModelToolsOrSession) throw new Error("refresh altered active persona/model/tool/session state");

console.log(JSON.stringify(evidence, null, 2));
