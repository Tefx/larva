import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const extensionUrl = pathToFileURL(join(root, "contrib", "pi-extension", "larva.ts")).href;
const mod = await import(extensionUrl);

const dir = await mkdtemp(join(tmpdir(), "larva-pi-persona-refresh-command-"));
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
    prompt: "SECRET PROMPT MUST NOT REACH REFRESH OUTPUT OR CACHE",
  },
]), "utf8");

await writeFile(cacheFile, `${JSON.stringify({
  version: 1,
  source: "larva list --json",
  source_key: sourceKey,
  fetched_at_ms: 0,
  candidates: [
    {
      id: "disk-stale",
      description: "Disk stale description",
      model: "provider/stale",
      spec_digest: "sha256:disk-stale",
      capabilities: { shell: "read_only" },
    },
  ],
})}\n`, "utf8");

function personaValues(items) {
  return (items ?? []).map((item) => ({ value: item.value, label: item.label, description: item.description }));
}

function assertNoPrompt(payload, label) {
  const text = JSON.stringify(payload);
  if (text.includes("prompt") || text.includes("SECRET")) throw new Error(`${label} leaked prompt material: ${text}`);
}

mod.resetPersonaCompletionCache();
mod.setPersonaCompletionClock(() => 1);
let setModelCalls = 0;
let setActiveToolsCalls = 0;
let appendEntryCalls = 0;
const notifications = [];
const statuses = [];
const commandRegistrations = [];
const registeredTools = [];

const ctx = {
  env: {
    HOME: join(dir, "home"),
    LARVA_CLI_ARGV_JSON: sourceKey,
    LARVA_PI_AGENT_PERSONA_SWITCH: "off",
    LARVA_PI_PERSONA_CANDIDATES_CACHE_FILE: cacheFile,
    FAKE_LARVA_LIST_FILE: listFile,
    FAKE_LARVA_INVOCATION_LOG: invocationLog,
    FAKE_LARVA_MODE: "ok",
  },
  ui: {
    notify: async (message, type) => { notifications.push({ message, type }); },
    setStatus: async (...args) => { statuses.push(args); },
  },
  setModel: () => { setModelCalls += 1; },
  setActiveTools: () => { setActiveToolsCalls += 1; },
  appendEntry: () => { appendEntryCalls += 1; },
  registerCommand: (name, options) => {
    if (typeof name === "string") commandRegistrations.push({ name, options });
    else commandRegistrations.push({ name: name.name, options: name });
  },
  registerTool: (tool) => { registeredTools.push(tool); },
  registerShortcut: () => undefined,
  on: () => undefined,
};

await mod.initializeExtension(ctx, ctx);
const personaCommand = commandRegistrations.find((entry) => entry.name === "larva-persona")?.options;
if (!personaCommand?.handler) throw new Error("larva-persona command handler missing");

const commandNamesBefore = commandRegistrations.map((entry) => entry.name);
const toolNamesBefore = registeredTools.map((tool) => tool.name);
const stateBefore = { activeEnvelope: mod.getActiveEnvelope(), setModelCalls, setActiveToolsCalls, appendEntryCalls };
const staleBefore = personaValues(await mod.completePersonaIds("", ctx));
assertNoPrompt(staleBefore, "stale suggestions before refresh");

const refreshSuccess = await personaCommand.handler("--refresh-cache", ctx);
const afterSuccess = personaValues(await mod.completePersonaIds("", ctx));
const cacheAfterSuccessText = await readFile(cacheFile, "utf8");
assertNoPrompt({ refreshSuccess, afterSuccess, cacheAfterSuccessText, notifications }, "successful refresh");

await writeFile(listFile, JSON.stringify([
  {
    id: "newer-public-while-cli-fails",
    description: "Should not replace stale cache on failure",
    model: "provider/newer",
    prompt: "SECRET PROMPT MUST NOT APPEAR EVEN ON FAILURE",
  },
]), "utf8");
ctx.env.FAKE_LARVA_MODE = "fail";
const refreshFailure = await personaCommand.handler("--refresh-cache", ctx);
const afterFailure = personaValues(await mod.completePersonaIds("", ctx));
const cacheAfterFailureText = await readFile(cacheFile, "utf8");
assertNoPrompt({ refreshFailure, afterFailure, cacheAfterFailureText, notifications }, "failed refresh");

const stateAfter = { activeEnvelope: mod.getActiveEnvelope(), setModelCalls, setActiveToolsCalls, appendEntryCalls };
const commandNamesAfter = commandRegistrations.map((entry) => entry.name);
const toolNamesAfter = registeredTools.map((tool) => tool.name);
const invocationsText = await readFile(invocationLog, "utf8").catch(() => "");

const personaCommandNames = commandNamesAfter.filter((name) => name.includes("persona"));
const refreshCommandNames = commandNamesAfter.filter((name) => name.includes("refresh") || name.includes("cache"));
const refreshToolNames = toolNamesAfter.filter((name) => name.includes("refresh") || name.includes("cache"));

const evidence = {
  smoke: "persona-refresh-command-runtime",
  source: "larva list --json",
  commandNamesBefore,
  commandNamesAfter,
  personaCommandNames,
  refreshCommandNames,
  toolNamesBefore,
  toolNamesAfter,
  refreshToolNames,
  staleBefore,
  refreshSuccess,
  afterSuccess,
  refreshFailure,
  afterFailure,
  cacheAfterSuccess: JSON.parse(cacheAfterSuccessText),
  cacheAfterFailure: JSON.parse(cacheAfterFailureText),
  notifications,
  statuses,
  invocations: invocationsText.trim().split("\n").filter(Boolean),
  noPromptInUiOrCache: !JSON.stringify({ refreshSuccess, afterSuccess, refreshFailure, afterFailure, cacheAfterSuccessText, cacheAfterFailureText, notifications }).includes("SECRET") && !JSON.stringify({ refreshSuccess, afterSuccess, refreshFailure, afterFailure, cacheAfterSuccessText, cacheAfterFailureText, notifications }).includes("prompt"),
  noNewRefreshCommand: refreshCommandNames.length === 0 && personaCommandNames.filter((name) => name === "larva-persona").length === 1,
  noNewRefreshTool: refreshToolNames.length === 0 && JSON.stringify(toolNamesBefore) === JSON.stringify(toolNamesAfter),
  refreshDidNotAlterActivePersonaModelToolsOrSession: JSON.stringify(stateBefore) === JSON.stringify(stateAfter),
};

if (!evidence.noNewRefreshCommand) throw new Error(`refresh registered an unexpected command: ${JSON.stringify(commandNamesAfter)}`);
if (!evidence.noNewRefreshTool) throw new Error(`refresh registered an unexpected tool: ${JSON.stringify(toolNamesAfter)}`);
if (JSON.stringify(staleBefore).includes("disk-stale") !== true) throw new Error("seeded stale cache was not visible before refresh");
if (!refreshSuccess.ok || refreshSuccess.refreshed !== true) throw new Error(`manual refresh did not report success: ${JSON.stringify(refreshSuccess)}`);
if (JSON.stringify(afterSuccess).includes("fresh-public") !== true) throw new Error("manual refresh success did not update candidate suggestions");
if (JSON.stringify(evidence.cacheAfterSuccess).includes("fresh-public") !== true) throw new Error("manual refresh success did not update disk cache");
if (refreshFailure.ok !== false || refreshFailure.refreshed !== true) throw new Error(`manual refresh failure was not reported: ${JSON.stringify(refreshFailure)}`);
if (JSON.stringify(afterFailure).includes("fresh-public") !== true) throw new Error("manual refresh failure did not retain stale suggestions");
if (JSON.stringify(afterFailure).includes("newer-public-while-cli-fails")) throw new Error("manual refresh failure replaced stale suggestions");
if (JSON.stringify(evidence.cacheAfterFailure).includes("fresh-public") !== true) throw new Error("manual refresh failure did not retain stale disk cache");
if (JSON.stringify(evidence.cacheAfterFailure).includes("newer-public-while-cli-fails")) throw new Error("manual refresh failure replaced stale disk cache");
if (!evidence.noPromptInUiOrCache) throw new Error("prompt material reached refresh output/UI/cache evidence");
if (!evidence.refreshDidNotAlterActivePersonaModelToolsOrSession) throw new Error("refresh altered active persona/model/tool/session state");
if (!notifications.some((entry) => entry.type === "info" && entry.message.includes("candidate cache refreshed"))) throw new Error("refresh success notification missing");
if (!notifications.some((entry) => entry.type === "error" && entry.message.includes("cache refresh failed") && entry.message.includes("Stale cache retained"))) throw new Error("refresh failure notification missing stale-retained report");

console.log(JSON.stringify(evidence, null, 2));
