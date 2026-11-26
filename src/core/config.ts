import { join } from "node:path";
import { LarvaError } from "./errors.ts";
import type { LarvaConfig } from "./types.ts";

const MAX_TIMEOUT_MS = 86_400_000;
const MIN_STALL_ALERT_MS = 60_000;

function invalid(field: string): never {
  throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid ${field} in config.json.`);
}

function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field);
  const prototype: unknown = Object.getPrototypeOf(value);
  if ((prototype !== null && prototype !== Object.prototype)
      || Object.keys(value).some(key => !keys.includes(key))) return invalid(field);
  return value as Record<string, unknown>;
}

function field(obj: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : fallback;
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  return isIntegerIn(value, min, max) ? value : invalid(name);
}

function isStallAlert(value: unknown): value is number {
  return value === 0 || isIntegerIn(value, MIN_STALL_ALERT_MS, MAX_TIMEOUT_MS);
}

export function parseLarvaConfig(value: unknown): LarvaConfig {
  const config = object(value, "root object", ["default_persona", "switch_mode", "confirm_timeout_ms", "subagent", "gc"]);
  const persona = field(config, "default_persona", null);
  if (persona !== null && (typeof persona !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(persona))) {
    return invalid("default_persona");
  }
  const mode = field(config, "switch_mode", "confirm");
  if (mode !== "manual" && mode !== "confirm" && mode !== "auto" && mode !== "free") return invalid("switch_mode");
  const confirm = field(config, "confirm_timeout_ms", 900_000);
  if (confirm !== 0 && !isIntegerIn(confirm, 1_000, MAX_TIMEOUT_MS)) return invalid("confirm_timeout_ms");

  const subagent = object(field(config, "subagent", {}), "subagent", [
    "extension_sources", "root_session_spawn", "max_depth", "max_active_runs", "stall_alert_ms",
  ]);
  const sources = field(subagent, "extension_sources", []);
  if (!Array.isArray(sources)) return invalid("subagent.extension_sources");
  const uniqueSources = new Set<string>();
  for (const source of sources) {
    if (typeof source !== "string" || source === "" || uniqueSources.has(source)) {
      return invalid("subagent.extension_sources");
    }
    uniqueSources.add(source);
  }
  const rootSpawn = field(subagent, "root_session_spawn", "persona");
  if (rootSpawn !== "persona" && rootSpawn !== "allow") return invalid("subagent.root_session_spawn");
  const stall = field(subagent, "stall_alert_ms", 600_000);
  if (!isStallAlert(stall)) return invalid("subagent.stall_alert_ms");

  const gc = object(field(config, "gc", {}), "gc", ["max_age_days", "max_bytes"]);
  return {
    default_persona: persona,
    switch_mode: mode,
    confirm_timeout_ms: confirm,
    subagent: {
      extension_sources: [...uniqueSources],
      root_session_spawn: rootSpawn,
      stall_alert_ms: stall,
      ...(Object.hasOwn(subagent, "max_depth")
        ? { max_depth: integer(subagent.max_depth, "subagent.max_depth", 1, 100) } : {}),
      ...(Object.hasOwn(subagent, "max_active_runs")
        ? { max_active_runs: integer(subagent.max_active_runs, "subagent.max_active_runs", 1, 100) } : {}),
    },
    gc: {
      max_age_days: integer(field(gc, "max_age_days", 30), "gc.max_age_days", 1, 3650),
      ...(Object.hasOwn(gc, "max_bytes") ? { max_bytes: integer(gc.max_bytes, "gc.max_bytes", 1_048_576, Infinity) } : {}),
    },
  };
}

/** The reader returns undefined only for a genuinely absent entry; broken links and read failures throw. */
export async function loadLarvaConfig(
  home: string,
  readTextIfPresent: (path: string) => Promise<string | undefined>,
): Promise<LarvaConfig> {
  let value: unknown;
  try {
    const text = await readTextIfPresent(join(home, "config.json"));
    value = text === undefined ? {} : JSON.parse(text);
  } catch {
    throw new LarvaError("LARVA_CONFIG_INVALID", "Could not read or parse config.json.");
  }
  return parseLarvaConfig(value);
}

export function resolveWatchdogTimeouts(
  input: { no_progress_timeout_ms?: number; stall_alert_ms?: number },
  config: Pick<LarvaConfig["subagent"], "stall_alert_ms">,
): { no_progress_timeout_ms: number; stall_alert_ms: number } {
  const timeout = input.no_progress_timeout_ms === undefined ? 3_600_000 : input.no_progress_timeout_ms;
  if (!isIntegerIn(timeout, 120_000, MAX_TIMEOUT_MS)) {
    throw new LarvaError("LARVA_BAD_INPUT", "Invalid no_progress_timeout_ms.");
  }
  const stall = input.stall_alert_ms;
  if (stall !== undefined && (!isStallAlert(stall) || stall >= timeout)) {
    throw new LarvaError("LARVA_BAD_INPUT", "stall_alert_ms must be disabled or within range and below no_progress_timeout_ms.");
  }
  return {
    no_progress_timeout_ms: timeout,
    stall_alert_ms: stall ?? Math.min(config.stall_alert_ms, Math.floor(timeout / 2)),
  };
}
