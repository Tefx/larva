import { basename, join } from "node:path";
import { LarvaError } from "./errors.ts";
import { isRecord } from "./predicates.ts";
import type { ModelMapDoc, ModelMapEntry, ModelMapPrefixRule, ResolvedModelRoute } from "./types.ts";

function invalid(field: string): never {
  throw new LarvaError("LARVA_MODEL_MAP_INVALID", `Invalid ${field} in the model map.`);
}

function object(value: unknown, field: string, keys?: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return invalid(field);
  const prototype: unknown = Object.getPrototypeOf(value);
  if ((prototype !== null && prototype !== Object.prototype)
      || (keys && Object.keys(value).some(key => !keys.includes(key)))) return invalid(field);
  return value;
}

function token(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "") || /\s/.test(value)) return invalid(field);
  return value;
}

export function isValidProfileName(profile: unknown): profile is string {
  return typeof profile === "string" && profile !== "" && profile !== "default" && !/[^a-z0-9-]/.test(profile);
}

export function parseModelMapDoc(value: unknown): ModelMapDoc {
  const doc = object(value, "root object", ["models", "prefix_rules"]);
  const result: ModelMapDoc = {};
  if (Object.hasOwn(doc, "models")) {
    result.models = Object.fromEntries(Object.entries(object(doc.models, "models")).map(([key, entry]) => {
      token(key, "models key");
      const model = object(entry, "models entry", ["provider", "model_id"]);
      const route: ModelMapEntry = {
        provider: token(model.provider, "models provider"),
        model_id: token(model.model_id, "models model_id"),
      };
      return [key, route];
    }));
  }
  if (Object.hasOwn(doc, "prefix_rules")) {
    if (!Array.isArray(doc.prefix_rules)) return invalid("prefix_rules");
    const rules: ModelMapPrefixRule[] = [];
    const seen = new Set<string>();
    for (const entry of doc.prefix_rules) {
      const rule = object(entry, "prefix rule", ["from_prefix", "to_provider", "to_model_id_prefix"]);
      const fromPrefix = token(rule.from_prefix, "from_prefix");
      if (seen.has(fromPrefix)) return invalid("duplicate from_prefix");
      seen.add(fromPrefix);
      rules.push({
        from_prefix: fromPrefix,
        to_provider: token(rule.to_provider, "to_provider"),
        to_model_id_prefix: token(rule.to_model_id_prefix, "to_model_id_prefix", true),
      });
    }
    result.prefix_rules = rules;
  }
  return result;
}

export type ModelMapReader = {
  /** lstat-style existence: a dangling symlink is still an entry. */
  entryExists: (path: string) => Promise<boolean>;
  /** Resolve against the canonical home, rejecting targets outside it. */
  resolveContainedPath: (root: string, path: string) => Promise<string>;
  /** Read bounded UTF-8 text from a regular file, using the resolved path. */
  readText: (path: string) => Promise<string>;
};

/** `path` is the selected entry from modelMapProfilePath. Named maps are required. */
export async function loadModelMap(home: string, path: string, reader: ModelMapReader): Promise<ModelMapDoc | undefined> {
  const filename = basename(path);
  const isDefault = filename === "model-map.json";
  const profile = /^model-map\.(.+)\.json$/.exec(filename)?.[1];
  if (path !== join(home, filename) || (!isDefault && !isValidProfileName(profile))) return invalid("file path");
  let value: unknown;
  try {
    if (isDefault && !await reader.entryExists(path)) return undefined;
    const contained = await reader.resolveContainedPath(home, path);
    value = JSON.parse(await reader.readText(contained));
  } catch {
    throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Could not resolve, read, or parse the model map.");
  }
  return parseModelMapDoc(value);
}

export function resolveModelRoute(specModel: string, modelMap?: ModelMapDoc): ResolvedModelRoute {
  const models = modelMap?.models;
  if (models && Object.hasOwn(models, specModel)) return models[specModel];
  let best: ModelMapPrefixRule | undefined;
  for (const rule of modelMap?.prefix_rules ?? []) {
    if (specModel.startsWith(rule.from_prefix) && (!best || rule.from_prefix.length > best.from_prefix.length)) {
      best = rule;
    }
  }
  if (best) {
    const model_id = best.to_model_id_prefix + specModel.slice(best.from_prefix.length);
    if (model_id === "") return invalid("resolved model_id");
    return { provider: best.to_provider, model_id };
  }
  const slash = specModel.indexOf("/");
  if (slash <= 0 || slash === specModel.length - 1 || /\s/.test(specModel)) {
    throw new LarvaError("LARVA_BAD_INPUT", "Expected a literal provider/model_id route.");
  }
  return { provider: specModel.slice(0, slash), model_id: specModel.slice(slash + 1) };
}
