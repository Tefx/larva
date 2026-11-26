import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { loadLarvaConfig } from "../core/config.ts";
import { LarvaError, exitCodeForError, toErrorEnvelope, toSuccessEnvelope, type CliErrorEnvelope } from "../core/errors.ts";
import { resolveLarvaHome } from "../core/paths.ts";
import type { GcConfig } from "../core/types.ts";
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

const HELP = `Usage:
  larva persona validate <file|dir|-> [--json]
  larva persona put <file|dir|-> [--prune] [--json]
  larva persona get <id> [--json]
  larva persona list [--query <text>] [--full] [--json]
  larva persona rm <id...> [--json]
  larva mcp
  larva doctor [--profile <name>] [--json]
  larva gc [--max-age <days>] [--max-bytes <bytes>] [--dry-run] [--json]
  larva --help | -h
  larva --version | -v
`;

const booleanFlag = { type: "boolean" } as const;
const stringFlag = { type: "string" } as const;
const MAX_STDIN_BYTES = 1_048_576;

function usage(message: string): never {
  throw new LarvaError("LARVA_CLI_USAGE", `${message} See larva --help.`);
}

function parse<T extends ParseArgsOptionsConfig>(
  args: string[], options: T, minPositionals: number, maxPositionals = minPositionals,
) {
  let result;
  try {
    result = parseArgs({ args, options: { json: booleanFlag, ...options }, allowPositionals: true, tokens: true });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return usage("Invalid or unknown option.");
  }
  const seen = new Set<string>();
  for (const token of result.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) usage(`Option --${token.name} may be specified only once.`);
    seen.add(token.name);
  }
  if (result.positionals.length < minPositionals || result.positionals.length > maxPositionals) {
    usage("Incorrect number of positional arguments.");
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

async function personaCommand([command, ...args]: string[], env: NodeJS.ProcessEnv, stdin: NonNullable<CliDeps["stdin"]>) {
  const store = () => new PersonaStore(resolveLarvaHome(env));
  switch (command) {
    case "validate": {
      const { positionals: [target] } = parse(args, {}, 1);
      return store().validate(target, target === "-" ? await readStdin(stdin) : undefined);
    }
    case "put": {
      const { values, positionals: [target] } = parse(args, { prune: booleanFlag }, 1);
      if (values.prune && target === "-") throw new LarvaError("LARVA_BAD_INPUT", "Prune requires a persona input directory.");
      return store().put(target, { prune: values.prune, stdinText: target === "-" ? await readStdin(stdin) : undefined });
    }
    case "get": {
      const { positionals: [id] } = parse(args, {}, 1);
      return store().get(id);
    }
    case "list": {
      const { values } = parse(args, { query: stringFlag, full: booleanFlag }, 0);
      return store().list({ query: values.query, full: values.full });
    }
    case "rm": {
      const { positionals } = parse(args, {}, 1, Infinity);
      await store().rm(positionals);
      return { removed_ids: [...new Set(positionals)] };
    }
    default:
      return usage("Expected a persona subcommand.");
  }
}

function decimalInteger(value: string, option: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) usage(`Option --${option} requires a decimal integer.`);
  return number;
}

async function gcCommand(args: string[], env: NodeJS.ProcessEnv) {
  const { values } = parse(args, { "max-age": stringFlag, "max-bytes": stringFlag, "dry-run": booleanFlag }, 0);
  const overrides: Partial<GcConfig> = {};
  if (values["max-age"] !== undefined) overrides.max_age_days = decimalInteger(values["max-age"], "max-age");
  if (values["max-bytes"] !== undefined) overrides.max_bytes = decimalInteger(values["max-bytes"], "max-bytes");
  const home = resolveLarvaHome(env);
  const { gc } = await loadLarvaConfig(home, readConfigTextIfPresent);
  return runGc({ ...gc, ...overrides, dry_run: values["dry-run"],
    leases: createSessionLeaseStore(home, capsules), capsules,
  });
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
  // Detect JSON mode even if parsing fails, but not for MCP or a positional
  // argument after the end-of-options marker.
  const end = args.indexOf("--");
  const json = command !== "mcp" && args.slice(0, end === -1 ? undefined : end).includes("--json");
  function writeFailure(envelope: CliErrorEnvelope): void {
    if (json) stdout.write(`${JSON.stringify(envelope)}\n`);
    else {
      stderr.write(`${envelope.error.code}: ${envelope.error.message}\n`);
      if (envelope.error.details !== undefined) stderr.write(`${JSON.stringify(envelope.error.details, null, 2)}\n`);
    }
  }
  try {
    let data: unknown;
    switch (command) {
      case "mcp":
        if (args.length !== 0) usage("larva mcp accepts no arguments.");
        return await runMcp() ?? 0;
      case undefined:
      case "--help":
      case "-h":
        if (args.length !== 0) usage("Help accepts no arguments.");
        stdout.write(HELP);
        return 0;
      case "--version":
      case "-v":
        if (args.length !== 0) usage("Version accepts no arguments.");
        stdout.write(`${version ?? await packageVersion()}\n`);
        return 0;
      case "persona":
        data = await personaCommand(args, env, stdin);
        break;
      case "doctor": {
        const { values } = parse(args, { profile: stringFlag }, 0);
        const report = await runDoctor({ profile: values.profile, env });
        if (!report.ok) {
          const [{ code }] = report.diagnostics;
          writeFailure({ ok: false, error: { code, message: "Larva health check failed.", details: report } });
          return 1;
        }
        data = report;
        break;
      }
      case "gc":
        data = await gcCommand(args, env);
        break;
      default:
        return usage("Unknown command.");
    }
    stdout.write(`${JSON.stringify(json ? toSuccessEnvelope(data) : data, null, json ? undefined : 2)}\n`);
    return 0;
  } catch (error) {
    writeFailure(toErrorEnvelope(error));
    return exitCodeForError(error);
  }
}
