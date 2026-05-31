import { mkdtemp, writeFile } from "node:fs/promises";
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

const temp = await mkdtemp(join(tmpdir(), "larva-pi-autocomplete-"));
const fakeCli = join(temp, "fake-larva-cli.mjs");
await writeFile(
  fakeCli,
  `
const mode = process.env.FAKE_LARVA_LIST_MODE || "ok";
if (mode === "exit") process.exit(17);
if (mode === "malformed") { process.stdout.write("{not json"); process.exit(0); }
const [, , command, flag] = process.argv;
if (command !== "list" || flag !== "--json") process.exit(3);
process.stdout.write(JSON.stringify({data: [
  {id: "vectl-planner", description: "Plan with vectl", model: "provider/model"},
  {id: "vectl-reviewer", model: "provider/model"},
  {id: "frontend-engineer", description: "Frontend", model: "provider/model"}
]}));
`,
  "utf8",
);

let installedProvider = null;
let registeredCommand = null;
const env = {
  LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
};
const ctx = {
  env,
  ui: {
    setStatus: async () => undefined,
    addAutocompleteProvider: (provider) => {
      installedProvider = provider;
    },
  },
};
const pi = {
  registerCommand: (name, options) => {
    registeredCommand = { name, options };
  },
  registerTool: () => undefined,
  on: () => undefined,
};

await mod.initializeExtension(ctx, pi);
if (registeredCommand?.name !== "larva-persona") throw new Error("larva-persona command was not preserved");
if (typeof registeredCommand.options?.getArgumentCompletions !== "function") {
  throw new Error("command argument completer was not preserved");
}
if (typeof installedProvider !== "function") throw new Error("autocomplete provider was not installed");

async function runTab(force) {
  const items = await installedProvider(`/larva-persona ${prefix}`, { force });
  return {
    command: registeredCommand.name,
    force,
    prefix,
    items,
    values: items?.map((item) => item.value) ?? null,
    allValuesAreStrings: Array.isArray(items) && items.every((item) => typeof item.value === "string"),
    exactShape: Array.isArray(items) && items.every((item) => (
      typeof item.value === "string"
      && item.label === item.value
      && Object.keys(item).every((key) => ["value", "label", "description"].includes(key))
    )),
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
  process.env.FAKE_LARVA_LIST_MODE = "exit";
  const failed = await installedProvider(`/larva-persona ${prefix || "vectl"}`, { force: true });
  process.env.FAKE_LARVA_LIST_MODE = "malformed";
  const malformed = await installedProvider(`/larva-persona ${prefix || "vectl"}`, { force: false });
  output = { failed, malformed, noCrash: failed === null && malformed === null };
} else {
  throw new Error(`unknown --case ${scenario}`);
}

console.log(JSON.stringify({ case: scenario, ...output }, null, 2));
