import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { LarvaError } from "./errors.ts";
import type { LarvaHomePaths } from "./types.ts";

export function resolveLarvaHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.LARVA_HOME;
  if (home === undefined || home === "") return join(env.HOME || homedir(), ".larva");
  if (!isAbsolute(home) || home.includes("\0") || normalize(home) !== home) {
    throw new LarvaError("LARVA_CONFIG_INVALID", "LARVA_HOME must be a normalized absolute path.");
  }
  return home;
}

export const BASE_PI_AGENT_DIR_ENV = "LARVA_PI_BASE_AGENT_DIR";

export function resolveBasePiAgentDir(env: NodeJS.ProcessEnv, fallbackHome?: string, baseCwd?: string): string {
  const home = env.HOME || fallbackHome || homedir();
  const configured = env[BASE_PI_AGENT_DIR_ENV] || env.PI_CODING_AGENT_DIR || "~/.pi/agent";
  const expanded = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  return resolve(baseCwd ?? "", expanded);
}

export function modelMapProfilePath(home: string, profile = "default"): string {
  if (profile === "" || /[^a-z0-9-]/.test(profile)) {
    throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Invalid model-map profile name.");
  }
  return join(home, profile === "default" ? "model-map.json" : `model-map.${profile}.json`);
}

export function getLarvaHomePaths(home: string): LarvaHomePaths {
  const state = join(home, "state");
  return {
    home,
    personas: join(home, "personas"),
    config: join(home, "config.json"),
    model_map: modelMapProfilePath(home),
    state,
    sessions: join(state, "sessions"),
    artifacts: join(state, "artifacts"),
    capsules: join(state, "capsules"),
  };
}

/** Strict descendant, not the root itself. Neither input is interpreted against cwd. */
export function isLexicallyContained(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate) || root.includes("\0") || candidate.includes("\0")) {
    return false;
  }
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Check two paths already canonicalized by the caller. */
export function assertContainedRealpath(realRoot: string, realCandidate: string): void {
  if (!isLexicallyContained(realRoot, realCandidate)) {
    throw new LarvaError("LARVA_SESSION_INVALID", "The resolved path is outside the permitted directory.");
  }
}

/** Use the returned canonical path, not the unchecked input, for subsequent reads. */
export async function resolveContainedPath(
  root: string,
  candidate: string,
  realpath: (path: string) => Promise<string>,
): Promise<string> {
  if (!isLexicallyContained(root, candidate)) {
    throw new LarvaError("LARVA_SESSION_INVALID", "The path is outside the permitted directory.");
  }
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  assertContainedRealpath(realRoot, realCandidate);
  return realCandidate;
}

type ExtensionSourceContext = {
  larvaHome: string;
  userHome: string;
  piAgentDir: string;
  realpath: (path: string) => Promise<string>;
  /** Reject anything other than a readable regular file or directory. */
  assertReadable: (path: string) => Promise<void>;
};

export async function resolveExtensionSources(
  sources: readonly string[],
  context: ExtensionSourceContext,
): Promise<string[]> {
  const paths: string[] = [];
  let realHome: string | undefined;
  for (const [index, source] of sources.entries()) {
    if (source === "" || source.includes("\0")) {
      throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid extension_sources entry at index ${index}.`);
    }
    try {
      let realPath: string;
      if (source.startsWith("pi-agent:")) {
        const suffix = source.slice("pi-agent:".length);
        if (!suffix || isAbsolute(suffix)) throw new Error("Expected a relative path.");
        realPath = await resolveContainedPath(context.piAgentDir, resolve(context.piAgentDir, suffix), context.realpath);
      } else if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
        if (!/^(?:builtin|npm|git):/.test(source)) {
          const url = new URL(source);
          if (!["http:", "https:", "file:"].includes(url.protocol)) throw new Error("Unsupported extension URL.");
        }
        paths.push(source);
        continue;
      } else {
        let path: string;
        if (source.startsWith("~/")) path = join(context.userHome, source.slice(2));
        else if (isAbsolute(source)) path = source;
        else {
          realHome ??= await context.realpath(context.larvaHome);
          path = resolve(realHome, source);
        }
        realPath = await context.realpath(path);
      }
      await context.assertReadable(realPath);
      paths.push(realPath);
    } catch {
      throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid or unreadable extension_sources entry at index ${index}.`);
    }
  }
  return paths;
}
