import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { loadLarvaConfig } from "../core/config.ts";
import { LarvaError, exitCodeForError, toErrorEnvelope, toSuccessEnvelope, type CliErrorEnvelope } from "../core/errors.ts";
import { resolveLarvaHome } from "../core/paths.ts";
import type { DoctorReport, GcConfig, PersonaSpec, PersonaSummary } from "../core/types.ts";
import * as capsules from "../store/capsule.ts";
import { runGc } from "../store/gc.ts";
import { PersonaStore } from "../store/persona-store.ts";
import { createSessionLeaseStore } from "../store/session-lease.ts";
import { readConfigTextIfPresent, runDoctor } from "./doctor.ts";

type CliDeps = {
  runMcp: () => void | number | Promise<void | number>;
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
  env?: NodeJS.ProcessEnv;
  version?: string;
};

const usages = [
  "persona validate <file|dir|-> [--json]",
  "persona put <file|dir|-> [--prune] [--json]",
  "persona get <id> [--json]",
  "persona list [--query <text>] [--full] [--json]",
  "persona rm <id...> [--json]",
  "mcp",
  "doctor [--profile <name>] [--json]",
  "gc [--max-age <days>] [--max-bytes <bytes>] [--dry-run] [--json]",
  "--help | -h",
  "--version | -v",
];

const booleanFlag = { type: "boolean" } as const;
const stringFlag = { type: "string" } as const;
const MAX_STDIN_BYTES = 1_048_576;

function usage(message: string): never {
  throw new LarvaError("LARVA_CLI_USAGE", `${message} See larva --help.`);
}

function parse<T extends ParseArgsOptionsConfig>(
  args: string[], options: T, expected?: string, multiple = false,
) {
  let result;
  try {
    result = parseArgs({ args, options: { json: booleanFlag, ...options }, allowPositionals: true, tokens: true });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return usage(error.message);
  }
  const seen = new Set<string>();
  for (const token of result.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) usage(`Option --${token.name} may be specified only once.`);
    seen.add(token.name);
  }
  if (expected && result.positionals.length === 0) usage(`Missing ${expected}.`);
  const max = expected ? 1 : 0;
  if (!multiple && result.positionals.length > max) {
    usage(`Unexpected argument ${JSON.stringify(result.positionals[max])}.`);
  }
  return result;
}

async function readStdin(stdin: NonNullable<CliDeps["stdin"]>): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let total = 0;
  let text = "";
  try {
    for await (const chunk of stdin) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += bytes.byteLength;
      if (total > MAX_STDIN_BYTES) throw new LarvaError("LARVA_PERSONA_INVALID", "Persona stdin exceeds 1 MiB.");
      text += decoder.decode(bytes, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof LarvaError) throw error;
    throw new LarvaError("LARVA_PERSONA_INVALID", "Cannot read Persona stdin as UTF-8.");
  }
}

type Emit = <T>(data: T, human: (data: T) => string) => void;

function spawnText({ can_spawn }: PersonaSummary): string {
  return Array.isArray(can_spawn) ? can_spawn.join(", ") : can_spawn ? "yes" : "no";
}

function personaSummary(spec: PersonaSummary): string {
  return `${spec.id}\t${spec.model}\t${spec.thinking}\t${spawnText(spec)}\t${spec.description.replace(/\s+/g, " ")}`;
}

function fullPersona(spec: PersonaSpec): string {
  const { id, model, thinking, spec_digest, description, tools, prompt } = spec;
  return `${id} (${spec_digest})\n${description}\nModel: ${model}; thinking: ${thinking}; can spawn: ${spawnText(spec)}`
    + `\nTools allowed: ${tools.allow.join(", ") || "all"}; denied: ${tools.deny.join(", ") || "none"}\n\n${prompt}`;
}

async function personaCommand(
  [command, ...args]: string[], env: NodeJS.ProcessEnv, stdin: NonNullable<CliDeps["stdin"]>, emit: Emit,
): Promise<void> {
  const store = () => new PersonaStore(resolveLarvaHome(env));
  switch (command) {
    case "validate": {
      const { positionals: [target] } = parse(args, {}, "<file|dir|->");
      const specs = await store().validate(target, target === "-" ? await readStdin(stdin) : undefined);
      return emit(specs, items => [`Validated ${items.length} persona(s).`, ...items.map(item => item.id)].join("\n"));
    }
    case "put": {
      const { values, positionals: [target] } = parse(args, { prune: booleanFlag }, "<file|dir|->");
      if (values.prune && target === "-") throw new LarvaError("LARVA_BAD_INPUT", "Prune requires a persona input directory.");
      const result = await store().put(target, { prune: values.prune, stdinText: target === "-" ? await readStdin(stdin) : undefined });
      return emit(result, ({ committed_ids, pruned_ids }) =>
        `Installed: ${committed_ids.join(", ") || "none"}\nPruned: ${pruned_ids.join(", ") || "none"}`);
    }
    case "get": {
      const { positionals: [id] } = parse(args, {}, "<id>");
      return emit(await store().get(id), fullPersona);
    }
    case "list": {
      const { values } = parse(args, { query: stringFlag, full: booleanFlag });
      // The store ranks query matches for tool callers; CLI results are always ordered by ID.
      const byId = (a: PersonaSummary, b: PersonaSummary) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (values.full) {
        const entries = await store().list({ query: values.query, full: true });
        return emit(entries.sort(byId), specs => specs.map(fullPersona).join("\n\n") || "No matching personas.");
      }
      const entries = await store().list({ query: values.query });
      return emit(entries.sort(byId), specs => specs.length === 0 ? "No matching personas."
        : ["ID\tMODEL\tTHINKING\tCAN SPAWN\tDESCRIPTION", ...specs.map(personaSummary)].join("\n"));
    }
    case "rm": {
      const { positionals } = parse(args, {}, "<id>", true);
      await store().rm(positionals);
      return emit({ removed_ids: [...new Set(positionals)] }, ({ removed_ids }) => `Removed: ${removed_ids.join(", ")}`);
    }
    default:
      return usage(command === undefined ? "Missing persona subcommand." : `Unknown persona subcommand ${JSON.stringify(command)}.`);
  }
}

function decimalInteger(value: string, option: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) usage(`Option --${option} requires a decimal integer.`);
  return number;
}

async function gcCommand(args: string[], env: NodeJS.ProcessEnv, emit: Emit): Promise<void> {
  const { values } = parse(args, { "max-age": stringFlag, "max-bytes": stringFlag, "dry-run": booleanFlag });
  const overrides: Partial<GcConfig> = {};
  if (values["max-age"] !== undefined) overrides.max_age_days = decimalInteger(values["max-age"], "max-age");
  if (values["max-bytes"] !== undefined) overrides.max_bytes = decimalInteger(values["max-bytes"], "max-bytes");
  const home = resolveLarvaHome(env);
  const { gc } = await loadLarvaConfig(home, readConfigTextIfPresent);
  const dryRun = values["dry-run"];
  const report = await runGc({ ...gc, ...overrides, dry_run: dryRun,
    leases: createSessionLeaseStore(home, capsules), capsules,
  });
  emit(report, result => [
    `${dryRun ? "Dry run: would delete" : "Cleanup applied: deleted"} ${result.deleted_sessions} session(s) and ${result.deleted_artifacts} artifact(s).`,
    `${result.freed_bytes} bytes ${dryRun ? "would be freed" : "freed"}; ${result.remaining_bytes} remaining (${result.protected_bytes} protected).`,
    `Byte budget: ${result.budget_met ? "met" : "not met"}.`,
    ...(result.unreconciled_capsules?.map(path => `Unreconciled capsule: ${path}`) ?? []),
  ].join("\n"));
}

function doctorSummary(report: DoctorReport): string {
  const pi = report.pi;
  return [
    `Larva health check ${report.ok ? "passed" : "failed"}.`,
    `Home: ${report.larva_home || "unresolved"}; profile: ${report.profile}; personas checked: ${report.personas_checked}.`,
    `Pi: ${pi ? `${pi.path}${pi.version ? ` (${pi.version})` : ""}` : "unavailable"}.`,
    ...report.diagnostics.map(({ path, persona_id, code, message }) =>
      `${path ?? persona_id ?? "Doctor"}: ${code}: ${message}`),
  ].join("\n");
}

async function packageVersion(): Promise<string> {
  if (typeof __LARVA_VERSION__ === "string") return __LARVA_VERSION__;
  // Direct source execution has no build define. Do not bundle the manifest.
  const manifest: unknown = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  if (manifest !== null && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string") {
    return manifest.version;
  }
  throw new LarvaError("LARVA_INTERNAL_ERROR", "Package version is unavailable.");
}

export async function dispatchCli(
  argv: readonly string[],
  { runMcp, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
    env = process.env, version }: CliDeps,
): Promise<number> {
  const [command, ...args] = argv;
  // Detect display flags even if parsing fails, but not after the end-of-options marker.
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const json = command !== "mcp" && options.includes("--json");
  const emit: Emit = (data, human) => stdout.write(`${json ? JSON.stringify(toSuccessEnvelope(data)) : human(data)}\n`);
  function writeFailure(envelope: CliErrorEnvelope): void {
    if (json) stdout.write(`${JSON.stringify(envelope)}\n`);
    else {
      stderr.write(`${envelope.error.code}: ${envelope.error.message}\n`);
      if (envelope.error.details !== undefined) stderr.write(`${JSON.stringify(envelope.error.details, null, 2)}\n`);
    }
  }
  try {
    const isHelp = (arg: string | undefined) => arg === "--help" || arg === "-h";
    let helpLines: string[] = [];
    if (command === undefined || isHelp(command)) {
      if (args.length !== 0) usage(`Unexpected argument ${JSON.stringify(args[0])}.`);
      helpLines = usages;
    } else if (options.some(isHelp)) {
      const scope = command === "persona" && !isHelp(args[0]) ? `persona ${args[0]}` : command;
      helpLines = usages.filter(line => line === scope || line.startsWith(`${scope} `));
    }
    if (helpLines.length > 0) {
      stdout.write(`Usage:\n${helpLines.map(line => `  larva ${line}\n`).join("")}`);
      return 0;
    }
    switch (command) {
      case "mcp":
        if (args.length !== 0) usage(`larva mcp does not accept ${JSON.stringify(args[0])}.`);
        return await runMcp() ?? 0;
      case "--version":
      case "-v":
        if (args.length !== 0) usage(`Unexpected argument ${JSON.stringify(args[0])}.`);
        stdout.write(`${version ?? await packageVersion()}\n`);
        return 0;
      case "persona":
        await personaCommand(args, env, stdin, emit);
        break;
      case "doctor": {
        const { values } = parse(args, { profile: stringFlag });
        const report = await runDoctor({ profile: values.profile, env });
        if (!report.ok) {
          if (json) {
            const [{ code }] = report.diagnostics;
            writeFailure({ ok: false, error: { code, message: "Larva health check failed.", details: report } });
          } else stderr.write(`${doctorSummary(report)}\n`);
          return 1;
        }
        emit(report, doctorSummary);
        break;
      }
      case "gc":
        await gcCommand(args, env, emit);
        break;
      default:
        return usage(`Unknown command ${JSON.stringify(command)}.`);
    }
    return 0;
  } catch (error) {
    writeFailure(toErrorEnvelope(error));
    return exitCodeForError(error);
  }
}
