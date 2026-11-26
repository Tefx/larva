import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { LarvaError } from "../core/errors.ts";
import type { ResolvedModelRoute } from "../core/types.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const MAX_MANIFEST_BYTES = 1_048_576;

export type PiInstallation = {
  /** Canonical package bin.pi script. Launch with process.execPath, not a PATH wrapper. */
  path: string;
  version?: string;
  registryEntry?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function readSmallFile(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error("Invalid Pi metadata file.");
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
      used += bytesRead;
    }
    throw new Error("Pi metadata changed while being read.");
  } finally {
    await file.close();
  }
}

async function registryEntry(directory: string, pkg: Record<string, unknown>): Promise<string | undefined> {
  const exported = isRecord(pkg.exports) ? pkg.exports["."] : pkg.exports;
  const entry = typeof exported === "string" ? exported : isRecord(exported) ? exported.import : pkg.main;
  if (typeof entry !== "string" || entry.length === 0 || isAbsolute(entry)) return undefined;
  try {
    const path = await realpath(resolve(directory, entry));
    return isWithin(directory, path) && (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

async function inspectPiScript(candidate: string): Promise<PiInstallation | undefined> {
  try {
    const path = await realpath(candidate);
    if (!(await stat(path)).isFile()) return undefined;
    await access(path, constants.R_OK);
    let directory = dirname(path);
    for (;;) {
      let raw: string;
      try {
        raw = await readSmallFile(join(directory, "package.json"), MAX_MANIFEST_BYTES);
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT" || dirname(directory) === directory) return undefined;
        directory = dirname(directory);
        continue;
      }
      const pkg: unknown = JSON.parse(raw);
      if (!isRecord(pkg) || pkg.name !== PI_PACKAGE || !isRecord(pkg.bin)
        || typeof pkg.bin.pi !== "string" || !pkg.bin.pi.trim() || isAbsolute(pkg.bin.pi)
        || await realpath(resolve(directory, pkg.bin.pi)) !== path) return undefined;
      const entry = await registryEntry(directory, pkg);
      return {
        path,
        ...(typeof pkg.version === "string" && pkg.version ? { version: pkg.version } : {}),
        ...(entry === undefined ? {} : { registryEntry: entry }),
      };
    }
  } catch {
    return undefined;
  }
}

async function inspectManagedLauncher(candidate: string): Promise<PiInstallation | undefined> {
  try {
    const launcher = await realpath(candidate);
    if (basename(launcher) !== "pi" || basename(dirname(launcher)) !== "bin"
      || !(await stat(launcher)).isFile()) return undefined;
    const install = await realpath(join(dirname(dirname(launcher)), "install"));
    const release = (await readSmallFile(join(install, "current-version"), 256)).trim();
    if (!/^[0-9A-Za-z._+-]+$/.test(release) || release === "." || release === "..") return undefined;
    const releaseRoot = join(install, "releases", release);
    const bin = join(releaseRoot, "node_modules", ".bin", "pi");
    await access(bin, constants.X_OK);
    const verified = await inspectPiScript(bin);
    return verified && isWithin(releaseRoot, verified.path) ? verified : undefined;
  } catch {
    return undefined;
  }
}

/** The explicit override is authoritative; otherwise use the first verified absolute PATH entry. */
export async function discoverPiInstallation(env: NodeJS.ProcessEnv = process.env): Promise<PiInstallation> {
  const override = env.LARVA_PI_CLI_SCRIPT;
  if (override !== undefined) {
    if (override.trim() && isAbsolute(override) && !override.includes("\0")) {
      const verified = await inspectPiScript(override);
      if (verified) return verified;
    }
    throw new LarvaError("LARVA_CHILD_START_FAILED", "LARVA_PI_CLI_SCRIPT must be an absolute path to a verified Pi package bin.pi script.");
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "pi");
    try {
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const verified = await inspectPiScript(candidate) ?? await inspectManagedLauncher(candidate);
    if (verified) return verified;
  }
  throw new LarvaError("LARVA_CHILD_START_FAILED", "No verified Pi installation found on PATH; set LARVA_PI_CLI_SCRIPT to the package bin.pi script.");
}

/** Check exact catalog identity, not auth readiness or extension-provided models. */
export async function resolveModelInRegistry(
  installation: PiInstallation,
  route: ResolvedModelRoute,
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
): Promise<ResolvedModelRoute | null> {
  try {
    if (installation.registryEntry === undefined) throw new Error("No Pi registry entry.");
    const sdk: unknown = await import(pathToFileURL(installation.registryEntry).href);
    if (!isRecord(sdk) || typeof sdk.ModelRegistry !== "function"
      || typeof sdk.ModelRuntime !== "function" || !("create" in sdk.ModelRuntime)
      || typeof sdk.ModelRuntime.create !== "function") throw new Error("No Pi registry API.");
    const dir = agentDir.startsWith("~/") ? join(homedir(), agentDir.slice(2)) : resolve(agentDir);
    const modelsPath = join(dir, "models.json");
    const info = await stat(modelsPath).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (info && !info.isFile()) throw new Error("Pi models.json must be a regular file.");
    // The initial catalog snapshot includes models.json. Refresh would also
    // inspect credentials and cached catalogs, taking locks on the agent dir.
    const runtime: unknown = await sdk.ModelRuntime.create({
      modelsPath,
      credentials: { async read() { return undefined; }, async list() { return []; } },
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registry: unknown = Reflect.construct(sdk.ModelRegistry, [runtime]);
    if (!isRecord(registry) || typeof registry.find !== "function" || typeof registry.getError !== "function"
      || registry.getError() !== undefined) throw new Error("Pi registry could not be read.");
    const model: unknown = registry.find(route.provider, route.model_id);
    return isRecord(model) && model.provider === route.provider && model.id === route.model_id
      ? { provider: route.provider, model_id: route.model_id } : null;
  } catch {
    // Pi registry failures may contain provider configuration or credentials.
    throw new LarvaError("LARVA_MODEL_UNAVAILABLE", "Could not read the verified Pi installation's model registry.");
  }
}
