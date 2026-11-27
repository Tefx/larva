var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/mcp-server.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { readFile, stat as stat7 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { delimiter as delimiter2, join as join11 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/core/errors.ts
var ALL_LARVA_ERROR_CODES = [
  "LARVA_BAD_INPUT",
  "LARVA_CONFIG_INVALID",
  "LARVA_MODEL_MAP_INVALID",
  "LARVA_MODEL_UNAVAILABLE",
  "LARVA_PERSONA_INVALID",
  "LARVA_PERSONA_NOT_FOUND",
  "LARVA_PERSONA_CONFLICT",
  "LARVA_STORE_WRITE_FAILED",
  "LARVA_NO_ACTIVE_PERSONA",
  "LARVA_TOOL_DENIED",
  "LARVA_SPAWN_NOT_ALLOWED",
  "LARVA_CONFIRMATION_UNAVAILABLE",
  "LARVA_SWITCH_CHAIN_LIMIT",
  "LARVA_ROUTE_UNCERTAIN",
  "LARVA_RESTORE_FAILED",
  "LARVA_CWD_REQUIRED",
  "LARVA_SESSION_INVALID",
  "LARVA_SESSION_NOT_FOUND",
  "LARVA_SESSION_BUSY",
  "LARVA_CHILD_START_FAILED",
  "LARVA_CHILD_PROTOCOL_FAILED",
  "LARVA_CHILD_CANCELLED",
  "LARVA_INTERNAL_ERROR",
  "LARVA_CLI_USAGE"
];
var LarvaError = class extends Error {
  code;
  details;
  exitCode;
  constructor(code, message, details, exitCode) {
    super(message);
    this.name = "LarvaError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode ?? (code === "LARVA_CLI_USAGE" ? 2 : 1);
  }
};
function toErrorEnvelope(err) {
  if (!(err instanceof LarvaError)) {
    return { ok: false, error: { code: "LARVA_INTERNAL_ERROR", message: "An internal error occurred." } };
  }
  const { code, message, details } = err;
  return { ok: false, error: { code, message, ...details === void 0 ? {} : { details } } };
}

// src/runtime/supervisor.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { lstat as lstat7, realpath as realpath6, rename as rename5, rm as rm3, stat as stat5 } from "node:fs/promises";
import { basename as basename8, dirname as dirname5, isAbsolute as isAbsolute4, join as join10, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";

// src/core/config.ts
import { join } from "node:path";
var MAX_TIMEOUT_MS = 864e5;
var MIN_STALL_ALERT_MS = 6e4;
function invalid(field2) {
  throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid ${field2} in config.json.`);
}
function object(value, field2, keys2) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field2);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype || Object.keys(value).some((key) => !keys2.includes(key))) return invalid(field2);
  return value;
}
function field(obj, key, fallback) {
  return Object.hasOwn(obj, key) ? obj[key] : fallback;
}
function isIntegerIn(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function integer(value, name, min, max) {
  return isIntegerIn(value, min, max) ? value : invalid(name);
}
function isStallAlert(value) {
  return value === 0 || isIntegerIn(value, MIN_STALL_ALERT_MS, MAX_TIMEOUT_MS);
}
function parseLarvaConfig(value) {
  const config = object(value, "root object", ["default_persona", "switch_mode", "confirm_timeout_ms", "subagent", "gc"]);
  const persona = field(config, "default_persona", null);
  if (persona !== null && (typeof persona !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(persona))) {
    return invalid("default_persona");
  }
  const mode = field(config, "switch_mode", "confirm");
  if (mode !== "manual" && mode !== "confirm" && mode !== "auto" && mode !== "free") return invalid("switch_mode");
  const confirm = field(config, "confirm_timeout_ms", 9e5);
  if (confirm !== 0 && !isIntegerIn(confirm, 1e3, MAX_TIMEOUT_MS)) return invalid("confirm_timeout_ms");
  const subagent = object(field(config, "subagent", {}), "subagent", [
    "extension_sources",
    "root_session_spawn",
    "max_depth",
    "max_active_runs",
    "stall_alert_ms"
  ]);
  const sources = field(subagent, "extension_sources", []);
  if (!Array.isArray(sources)) return invalid("subagent.extension_sources");
  const uniqueSources = /* @__PURE__ */ new Set();
  for (const source of sources) {
    if (typeof source !== "string" || source === "" || uniqueSources.has(source)) {
      return invalid("subagent.extension_sources");
    }
    uniqueSources.add(source);
  }
  const rootSpawn = field(subagent, "root_session_spawn", "persona");
  if (rootSpawn !== "persona" && rootSpawn !== "allow") return invalid("subagent.root_session_spawn");
  const stall = field(subagent, "stall_alert_ms", 6e5);
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
      ...Object.hasOwn(subagent, "max_depth") ? { max_depth: integer(subagent.max_depth, "subagent.max_depth", 1, 100) } : {},
      ...Object.hasOwn(subagent, "max_active_runs") ? { max_active_runs: integer(subagent.max_active_runs, "subagent.max_active_runs", 1, 100) } : {}
    },
    gc: {
      max_age_days: integer(field(gc, "max_age_days", 30), "gc.max_age_days", 1, 3650),
      ...Object.hasOwn(gc, "max_bytes") ? { max_bytes: integer(gc.max_bytes, "gc.max_bytes", 1048576, Infinity) } : {}
    }
  };
}
async function loadLarvaConfig(home, readTextIfPresent) {
  let value;
  try {
    const text2 = await readTextIfPresent(join(home, "config.json"));
    value = text2 === void 0 ? {} : JSON.parse(text2);
  } catch {
    throw new LarvaError("LARVA_CONFIG_INVALID", "Could not read or parse config.json.");
  }
  return parseLarvaConfig(value);
}
function resolveWatchdogTimeouts(input, config) {
  const timeout = input.no_progress_timeout_ms === void 0 ? 36e5 : input.no_progress_timeout_ms;
  if (!isIntegerIn(timeout, 12e4, MAX_TIMEOUT_MS)) {
    throw new LarvaError("LARVA_BAD_INPUT", "Invalid no_progress_timeout_ms.");
  }
  const stall = input.stall_alert_ms;
  if (stall !== void 0 && (!isStallAlert(stall) || stall >= timeout)) {
    throw new LarvaError("LARVA_BAD_INPUT", "stall_alert_ms must be disabled or within range and below no_progress_timeout_ms.");
  }
  return {
    no_progress_timeout_ms: timeout,
    stall_alert_ms: stall ?? Math.min(config.stall_alert_ms, Math.floor(timeout / 2))
  };
}

// src/core/model-map.ts
import { basename, join as join2 } from "node:path";
function invalid2(field2) {
  throw new LarvaError("LARVA_MODEL_MAP_INVALID", `Invalid ${field2} in the model map.`);
}
function object2(value, field2, keys2) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid2(field2);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype || keys2 && Object.keys(value).some((key) => !keys2.includes(key))) return invalid2(field2);
  return value;
}
function token(value, field2, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && value === "" || /\s/.test(value)) return invalid2(field2);
  return value;
}
function isValidProfileName(profile) {
  return typeof profile === "string" && profile !== "" && profile !== "default" && !/[^a-z0-9-]/.test(profile);
}
function parseModelMapDoc(value) {
  const doc = object2(value, "root object", ["models", "prefix_rules"]);
  const result2 = {};
  if (Object.hasOwn(doc, "models")) {
    result2.models = Object.fromEntries(Object.entries(object2(doc.models, "models")).map(([key, entry]) => {
      token(key, "models key");
      const model = object2(entry, "models entry", ["provider", "model_id"]);
      const route = {
        provider: token(model.provider, "models provider"),
        model_id: token(model.model_id, "models model_id")
      };
      return [key, route];
    }));
  }
  if (Object.hasOwn(doc, "prefix_rules")) {
    if (!Array.isArray(doc.prefix_rules)) return invalid2("prefix_rules");
    const rules = [];
    const seen = /* @__PURE__ */ new Set();
    for (const entry of doc.prefix_rules) {
      const rule = object2(entry, "prefix rule", ["from_prefix", "to_provider", "to_model_id_prefix"]);
      const fromPrefix = token(rule.from_prefix, "from_prefix");
      if (seen.has(fromPrefix)) return invalid2("duplicate from_prefix");
      seen.add(fromPrefix);
      rules.push({
        from_prefix: fromPrefix,
        to_provider: token(rule.to_provider, "to_provider"),
        to_model_id_prefix: token(rule.to_model_id_prefix, "to_model_id_prefix", true)
      });
    }
    result2.prefix_rules = rules;
  }
  return result2;
}
async function loadModelMap(home, path, reader) {
  const filename = basename(path);
  const isDefault = filename === "model-map.json";
  const profile = /^model-map\.(.+)\.json$/.exec(filename)?.[1];
  if (path !== join2(home, filename) || !isDefault && !isValidProfileName(profile)) return invalid2("file path");
  let value;
  try {
    if (isDefault && !await reader.entryExists(path)) return void 0;
    const contained = await reader.resolveContainedPath(home, path);
    value = JSON.parse(await reader.readText(contained));
  } catch {
    throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Could not resolve, read, or parse the model map.");
  }
  return parseModelMapDoc(value);
}
function resolveModelRoute(specModel, modelMap) {
  const models = modelMap?.models;
  if (models && Object.hasOwn(models, specModel)) return models[specModel];
  let best;
  for (const rule of modelMap?.prefix_rules ?? []) {
    if (specModel.startsWith(rule.from_prefix) && (!best || rule.from_prefix.length > best.from_prefix.length)) {
      best = rule;
    }
  }
  if (best) {
    return { provider: best.to_provider, model_id: best.to_model_id_prefix + specModel.slice(best.from_prefix.length) };
  }
  const slash = specModel.indexOf("/");
  if (slash <= 0 || slash === specModel.length - 1 || /\s/.test(specModel)) {
    throw new LarvaError("LARVA_BAD_INPUT", "Expected a literal provider/model_id route.");
  }
  return { provider: specModel.slice(0, slash), model_id: specModel.slice(slash + 1) };
}

// src/core/paths.ts
import { homedir } from "node:os";
import { isAbsolute, join as join3, normalize, relative, resolve, sep } from "node:path";
function resolveLarvaHome(env = process.env) {
  const home = env.LARVA_HOME;
  if (home === void 0 || home === "") return join3(env.HOME || homedir(), ".larva");
  if (!isAbsolute(home) || home.includes("\0") || normalize(home) !== home) {
    throw new LarvaError("LARVA_CONFIG_INVALID", "LARVA_HOME must be a normalized absolute path.");
  }
  return home;
}
var BASE_PI_AGENT_DIR_ENV = "LARVA_PI_BASE_AGENT_DIR";
function resolveBasePiAgentDir(env, fallbackHome, baseCwd) {
  const home = env.HOME || fallbackHome || homedir();
  const configured = env[BASE_PI_AGENT_DIR_ENV] || env.PI_CODING_AGENT_DIR || "~/.pi/agent";
  const expanded = configured.startsWith("~/") ? join3(home, configured.slice(2)) : configured;
  return resolve(baseCwd ?? "", expanded);
}
function modelMapProfilePath(home, profile = "default") {
  if (profile === "" || /[^a-z0-9-]/.test(profile)) {
    throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Invalid model-map profile name.");
  }
  return join3(home, profile === "default" ? "model-map.json" : `model-map.${profile}.json`);
}
function getLarvaHomePaths(home) {
  const state = join3(home, "state");
  return {
    home,
    personas: join3(home, "personas"),
    config: join3(home, "config.json"),
    model_map: modelMapProfilePath(home),
    state,
    sessions: join3(state, "sessions"),
    artifacts: join3(state, "artifacts"),
    capsules: join3(state, "capsules")
  };
}
function isLexicallyContained(root, candidate) {
  if (!isAbsolute(root) || !isAbsolute(candidate) || root.includes("\0") || candidate.includes("\0")) {
    return false;
  }
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function assertContainedRealpath(realRoot, realCandidate) {
  if (!isLexicallyContained(realRoot, realCandidate)) {
    throw new LarvaError("LARVA_SESSION_INVALID", "The resolved path is outside the permitted directory.");
  }
}
async function resolveContainedPath(root, candidate, realpath7) {
  if (!isLexicallyContained(root, candidate)) {
    throw new LarvaError("LARVA_SESSION_INVALID", "The path is outside the permitted directory.");
  }
  const [realRoot, realCandidate] = await Promise.all([realpath7(root), realpath7(candidate)]);
  assertContainedRealpath(realRoot, realCandidate);
  return realCandidate;
}
async function resolveExtensionSources(sources, context) {
  const paths = [];
  let realHome;
  for (const [index, source] of sources.entries()) {
    if (source === "" || source.includes("\0")) {
      throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid extension_sources entry at index ${index}.`);
    }
    if (/^(?:builtin|npm|git):/.test(source) || !isAbsolute(source) && !source.startsWith("pi-agent:") && URL.canParse(source)) {
      paths.push(source);
      continue;
    }
    try {
      let path;
      if (source.startsWith("~/")) {
        path = join3(context.userHome, source.slice(2));
      } else if (source.startsWith("pi-agent:")) {
        const suffix = source.slice("pi-agent:".length);
        if (!suffix || isAbsolute(suffix)) throw new Error("Expected a relative path.");
        path = resolve(context.piAgentDir, suffix);
      } else if (isAbsolute(source)) {
        path = source;
      } else {
        realHome ??= await context.realpath(context.larvaHome);
        path = resolve(realHome, source);
      }
      const realPath = await context.realpath(path);
      await context.assertReadable(realPath);
      paths.push(realPath);
    } catch {
      throw new LarvaError("LARVA_CONFIG_INVALID", `Invalid or unreadable extension_sources entry at index ${index}.`);
    }
  }
  return paths;
}

// src/core/persona.ts
import { basename as basename2, extname } from "node:path";

// src/core/digest.ts
import { createHash } from "node:crypto";
function canonicalizePersona(fields) {
  const { id, description, prompt, model, thinking = "medium", can_spawn = false, tools } = fields;
  const canonical = {
    can_spawn: Array.isArray(can_spawn) ? [...can_spawn].sort() : can_spawn,
    description,
    id,
    model,
    prompt,
    thinking,
    tools: { allow: [...tools?.allow ?? []].sort(), deny: [...tools?.deny ?? []].sort() }
  };
  const hex = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return { ...canonical, spec_digest: `sha256:${hex}` };
}

// src/core/yaml-frontmatter.ts
function invalid3(message) {
  throw new LarvaError("LARVA_PERSONA_INVALID", `Invalid YAML frontmatter: ${message}`);
}
function checkDepth(depth) {
  if (depth > 64) invalid3("collections are nested too deeply");
}
var nonPrintable = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f\ufffe\uffff]/u;
var horizontal = /^[ \t]*/;
var separation = /[ \t\n]/;
var flowPunctuation = /[\[\]{},]/;
var blockItem = /^-(?:[ \t]+|$)/;
var explicitKey = /^\?(?:[ \t]+|$)/;
var explicitValue = /^:(?:[ \t]+|$)/;
var blockPair = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*|[^\[\]{},"'][\s\S]*?):(?=[ \t]|$)/;
var escapes = {
  '"': '"',
  "/": "/",
  "\\": "\\",
  " ": " ",
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "	",
  "	": "	",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1B",
  N: "\x85",
  _: "\xA0",
  L: "\u2028",
  P: "\u2029"
};
function resolvePlain(text2) {
  if (/^(?:~|null|Null|NULL)$/.test(text2)) return null;
  if (/^(?:true|True|TRUE)$/.test(text2)) return true;
  if (/^(?:false|False|FALSE)$/.test(text2)) return false;
  if (/^[+-]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/.test(text2)) invalid3("non-finite numbers are not supported");
  if (!/^(?:0x[\da-fA-F]+|0o[0-7]+|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(text2)) return text2;
  const value = Number(text2);
  if (!Number.isFinite(value)) invalid3("non-finite numbers are not supported");
  return value;
}
function insert(map, key, value) {
  if (typeof key !== "string") invalid3("map keys must be strings");
  if (key === "<<") invalid3("merge keys are not supported");
  if (map.has(key)) invalid3("duplicate map key");
  map.set(key, value);
}
var Inline = class {
  source;
  minIndent;
  pos;
  constructor(source, pos, minIndent = 0) {
    this.source = source;
    this.pos = pos;
    this.minIndent = minIndent;
  }
  get char() {
    return this.source[this.pos] ?? "";
  }
  skipFlowSpace() {
    while (true) {
      if (this.char === "\n") {
        const next = this.lineAfter(this.pos);
        const char = this.source[next.content] ?? "";
        if (char && char !== "\n" && char !== "#" && next.indent < this.minIndent - (char === "]" || char === "}" ? 1 : 0)) {
          invalid3("invalid flow collection indentation");
        }
        this.pos = next.content;
      } else if (separation.test(this.char)) this.pos++;
      else if (this.char === "#" && separation.test(this.source[this.pos - 1] ?? "")) {
        this.pos = this.source.indexOf("\n", this.pos);
      } else return;
    }
  }
  value(depth, flow) {
    checkDepth(depth);
    if (this.char === "[" || this.char === "{") return this.collection(depth);
    if (this.char === '"' || this.char === "'") return this.quoted();
    return resolvePlain(this.plain(flow));
  }
  collection(depth) {
    const array = this.char === "[";
    const end = array ? "]" : "}";
    this.pos++;
    const items = [];
    const map = /* @__PURE__ */ new Map();
    this.skipFlowSpace();
    while (this.char !== end) {
      const next = this.source[this.pos + 1] ?? "";
      const explicit = this.char === "?" && (separation.test(next) || flowPunctuation.test(next));
      if (explicit) {
        this.pos++;
        this.skipFlowSpace();
      }
      const start = this.pos;
      const first = this.value(depth + 1, true);
      const endOfFirst = this.pos;
      this.skipFlowSpace();
      const hasValue = this.char === ":";
      let value = null;
      if (hasValue) {
        if (!explicit && this.source.indexOf("\n", start) < (array ? this.pos : endOfFirst)) {
          invalid3("implicit map keys must be on one line");
        }
        this.pos++;
        this.skipFlowSpace();
        const next2 = this.source[this.pos];
        if (next2 !== end && next2 !== ",") value = this.value(depth + 1, true);
      }
      if (!array) insert(map, first, value);
      else if (explicit || hasValue) {
        const pair = /* @__PURE__ */ new Map();
        insert(pair, first, value);
        items.push(Object.fromEntries(pair));
      } else items.push(first);
      this.skipFlowSpace();
      if (this.char === end) break;
      if (this.char !== ",") invalid3("expected a flow collection separator");
      this.pos++;
      this.skipFlowSpace();
    }
    this.pos++;
    return array ? items : Object.fromEntries(map);
  }
  plain(flow) {
    const start = this.pos;
    const next = this.source[start + 1] ?? "";
    if (!this.char || /[&*!|>%@`#,\[\]{}]/.test(this.char) || /[?:-]/.test(this.char) && (!next || separation.test(next) || flow && flowPunctuation.test(next))) {
      invalid3("expected a scalar or collection");
    }
    let text2 = "";
    let segmentStart = start;
    while (this.char) {
      if (this.char === "\n") {
        const { content, breaks, indent } = this.nonBlankAfter(this.pos);
        const next2 = this.source[content] ?? "";
        if (!next2 || next2 === "#" || indent < this.minIndent || flow && (flowPunctuation.test(next2) || next2 === ":" && this.mappingSeparator(content, flow))) break;
        text2 += this.source.slice(segmentStart, this.pos).replace(/[ \t]+$/, "") + this.fold(breaks);
        this.pos = segmentStart = content;
        continue;
      }
      if (this.char === "#" && separation.test(this.source[this.pos - 1] ?? "")) break;
      if (flow && flowPunctuation.test(this.char)) break;
      if (this.char === ":" && this.mappingSeparator(this.pos, flow)) {
        if (!flow) invalid3("unexpected mapping separator in a plain scalar");
        break;
      }
      this.pos++;
    }
    return text2 + this.source.slice(segmentStart, this.pos).replace(/[ \t]+$/, "");
  }
  mappingSeparator(colon, flow) {
    const next = this.source[colon + 1] ?? "";
    return !next || separation.test(next) || flow && flowPunctuation.test(next);
  }
  quoted() {
    const quote = this.char;
    this.pos++;
    let text2 = "";
    let segmentStart = this.pos;
    while (this.char) {
      const c = this.char;
      if (c === quote) {
        this.pos++;
        if (quote !== "'" || this.char !== "'") return text2 + this.source.slice(segmentStart, this.pos - 1);
        text2 += this.source.slice(segmentStart, this.pos++);
        segmentStart = this.pos;
      } else if (c === "\n") {
        text2 += this.source.slice(segmentStart, this.pos).replace(/[ \t]+$/, "");
        text2 += this.foldBreak();
        segmentStart = this.pos;
      } else if (c === "\\" && quote === '"') {
        text2 += this.source.slice(segmentStart, this.pos++);
        const code = this.char;
        if (code === "\n") text2 += this.foldBreak(true);
        else {
          this.pos++;
          const digits = code === "x" ? 2 : code === "u" ? 4 : code === "U" ? 8 : 0;
          if (digits) {
            const hex = this.source.slice(this.pos, this.pos + digits);
            const point = Number.parseInt(hex, 16);
            if (hex.length !== digits || /[^0-9a-f]/i.test(hex) || point > 1114111) invalid3("invalid Unicode escape");
            text2 += String.fromCodePoint(point);
            this.pos += digits;
          } else if (Object.hasOwn(escapes, code)) text2 += escapes[code];
          else invalid3("unknown quoted escape");
        }
        segmentStart = this.pos;
      } else this.pos++;
    }
    invalid3("unterminated quoted string");
  }
  lineAfter(newline) {
    let content = newline + 1;
    while (this.source[content] === " ") content++;
    const indent = content - newline - 1;
    while (this.source[content] === " " || this.source[content] === "	") content++;
    return { content, indent };
  }
  nonBlankAfter(newline) {
    let line = this.lineAfter(newline);
    let breaks = 1;
    while (this.source[line.content] === "\n") {
      line = this.lineAfter(line.content);
      breaks++;
    }
    return { ...line, breaks };
  }
  fold(breaks, escaped = false) {
    return breaks === 1 ? escaped ? "" : " " : "\n".repeat(breaks - 1);
  }
  foldBreak(escaped = false) {
    const { content, indent, breaks } = this.nonBlankAfter(this.pos);
    if (indent < this.minIndent) invalid3("invalid quoted string indentation");
    this.pos = content;
    return this.fold(breaks, escaped);
  }
};
var Block = class {
  row = 0;
  lines = [];
  source;
  constructor(source) {
    this.source = source;
    let start = 0;
    for (const text2 of source.split("\n").slice(0, -1)) {
      this.lines.push({ text: text2, start, indent: text2.length - text2.replace(/^ */, "").length });
      start += text2.length + 1;
    }
  }
  parse() {
    const line = this.peek();
    if (!line) invalid3("expected a map");
    const value = this.node(line.indent, 0);
    if (this.peek()) invalid3("unexpected content or indentation");
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid3("expected a map");
    return value;
  }
  peek() {
    while (true) {
      const line = this.lines[this.row];
      if (!line) return void 0;
      if (/^[ \t]*(?:#|$)/.test(line.text)) this.row++;
      else if (line.text[line.indent] === "	") invalid3("tabs cannot be used for block indentation");
      else return line;
    }
  }
  node(column, depth, parent = column - 1) {
    checkDepth(depth);
    const line = this.lines[this.row];
    const content = line.text.slice(column);
    if (blockItem.test(content)) {
      const items = [];
      let current = line;
      do {
        const dash = blockItem.exec(current.text.slice(column));
        if (!dash) break;
        items.push(this.entry(column + dash[0].length, column, depth + 1));
        current = this.peek();
      } while (current?.indent === column);
      return items;
    }
    if (explicitKey.test(content) || blockPair.test(content)) return this.map(column, depth);
    return this.entry(column, parent, depth);
  }
  map(column, depth) {
    checkDepth(depth);
    const map = /* @__PURE__ */ new Map();
    let current = this.lines[this.row];
    do {
      const content = current.text.slice(column);
      const explicit = explicitKey.exec(content);
      if (explicit) {
        const name = this.entry(column + explicit[0].length, column, depth + 1);
        const next = this.peek();
        const value = next?.indent === column ? explicitValue.exec(next.text.slice(column)) : null;
        insert(map, name, value ? this.entry(column + value[0].length, column, depth + 1, "explicit-value") : null);
      } else {
        const pair = blockPair.exec(content);
        if (!pair) break;
        const key = new Inline(`${pair[1].replace(/[ \t]+$/, "")}
`, 0);
        const name = key.value(depth + 1, false);
        if (key.char !== "\n") invalid3("malformed map key");
        insert(map, name, this.entry(column + pair[0].length, column, depth + 1, "implicit-value"));
      }
      current = this.peek();
    } while (current?.indent === column);
    return Object.fromEntries(map);
  }
  entry(column, parent, depth, mode = "node") {
    checkDepth(depth);
    const line = this.lines[this.row];
    const rest = line.text.slice(column);
    const start = column + horizontal.exec(rest)[0].length;
    const content = line.text.slice(start);
    if (!content || content.startsWith("#")) {
      this.row++;
      const next = this.peek();
      if (next && (next.indent > parent || mode !== "node" && next.indent === parent && blockItem.test(next.text.slice(parent)))) return this.node(next.indent, depth, parent);
      return null;
    }
    if (content.startsWith("|") || content.startsWith(">")) return this.blockScalar(content, parent);
    if (blockItem.test(content)) {
      if (mode === "implicit-value") invalid3("block sequences cannot start on an implicit key's line");
      return this.node(start, depth);
    }
    if (mode !== "implicit-value" && (explicitKey.test(content) || blockPair.test(content))) return this.map(start, depth);
    const value = new Inline(this.source, line.start + start, parent + 1);
    const result2 = value.value(depth, false);
    while (this.lines[this.row + 1]?.start <= value.pos) this.row++;
    const tail = this.source.slice(value.pos, this.lines[this.row].start + this.lines[this.row].text.length);
    if (!/^(?:[ \t]+(?:#.*)?|#.*)?$/.test(tail) || tail.startsWith("#") && !separation.test(this.source[value.pos - 1])) invalid3("unexpected text after value");
    this.row++;
    return result2;
  }
  blockScalar(header, parent) {
    const match = /^([|>])([1-9][+-]?|[+-][1-9]?)?(?:[ \t]+(?:#.*)?)?$/.exec(header);
    if (!match) invalid3("malformed block scalar header");
    const modifiers = match[2] ?? "";
    const indicated = /[1-9]/.exec(modifiers);
    this.row++;
    let first = this.row;
    while (/^ *$/.test(this.lines[first]?.text ?? "x")) first++;
    const firstLine = this.lines[first];
    const indent = indicated ? parent + Number(indicated[0]) : Math.max(parent + 1, firstLine?.indent ?? 0);
    if (!indicated && firstLine && firstLine.indent > parent) {
      for (let row = this.row; row < first; row++) {
        if (this.lines[row].indent > indent) invalid3("leading blank line is too indented for the block scalar");
      }
    }
    const lines = [];
    while (this.row < this.lines.length) {
      const line = this.lines[this.row];
      if (line.indent < indent && line.text.trimEnd() !== "") break;
      lines.push(line.text.slice(indent));
      this.row++;
    }
    let text2 = "";
    let previous;
    let breaks = 0;
    for (const line of lines) {
      if (line) {
        if (match[1] === ">" && previous && !/^[ \t]/.test(previous) && !/^[ \t]/.test(line)) {
          text2 += breaks === 1 ? " " : "\n".repeat(breaks - 1);
        } else text2 += "\n".repeat(breaks);
        text2 += line;
        previous = line;
        breaks = 0;
      }
      breaks++;
    }
    if (modifiers.includes("+")) return text2 + "\n".repeat(breaks);
    return !modifiers.includes("-") && previous !== void 0 ? `${text2}
` : text2;
  }
};
function parseYamlFrontmatter(text2) {
  const normalized = text2.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) invalid3("expected an opening '---' line");
  const closing = /\n---(?:\n|$)/g;
  closing.lastIndex = 3;
  const match = closing.exec(normalized);
  if (!match) invalid3("expected a closing '---' line");
  const header = normalized.slice(4, match.index + 1);
  if (nonPrintable.test(header)) invalid3("unexpected control character");
  return { fields: new Block(header).parse(), body: normalized.slice(closing.lastIndex) };
}

// src/core/persona.ts
var thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
var markdownFields = ["id", "description", "model", "thinking", "can_spawn", "tools"];
var jsonFields = [...markdownFields, "prompt", "spec_digest"];
var modelRoute = /^[^\s/]+\/[^\s]+$/;
var toolPattern = /^[^\s*]+\*?$/;
function invalid4(message) {
  throw new LarvaError("LARVA_PERSONA_INVALID", message);
}
function isValidPersonaId(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function closedObject(value, label, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid4(`${label} must be an object.`);
  const fields = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) invalid4(`Unexpected ${label} field: ${JSON.stringify(key)}.`);
    fields[key] = item;
  }
  return fields;
}
function normalizeText(value, field2) {
  if (typeof value !== "string") invalid4(`${field2} must be a non-empty string.`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) invalid4(`${field2} must be a non-empty string.`);
  return normalized;
}
function uniqueStrings(value, field2, matches2) {
  if (!Array.isArray(value)) invalid4(`${field2} must be an array.`);
  const entries = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || !matches2(entry)) invalid4(`${field2} contains an invalid entry.`);
    if (entries.has(entry)) invalid4(`${field2} contains a duplicate entry.`);
    entries.add(entry);
  }
  return [...entries];
}
function parseJson(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    invalid4("Invalid JSON persona input.");
  }
}
function parse(text2, format, stem) {
  const md = format === "md" ? parseYamlFrontmatter(text2) : void 0;
  const fields = md ? closedObject(md.fields, "frontmatter", markdownFields) : closedObject(parseJson(text2), "persona", jsonFields);
  const { description, model, thinking, can_spawn, tools, spec_digest } = fields;
  const id = md && !Object.hasOwn(fields, "id") ? stem : fields.id;
  if (!isValidPersonaId(id)) invalid4("id must be a lowercase kebab-case identifier.");
  if (stem !== void 0 && id !== stem) invalid4("Persona id must match the filename stem.");
  if (typeof model !== "string" || !modelRoute.test(model)) invalid4("model must be a whitespace-free provider/model_id route.");
  const level = thinking === void 0 ? void 0 : thinkingLevels.find((candidate) => candidate === thinking);
  if (thinking !== void 0 && level === void 0) invalid4("Invalid thinking level.");
  let spawn2;
  if (can_spawn === void 0 || typeof can_spawn === "boolean") spawn2 = can_spawn;
  else {
    if (!Array.isArray(can_spawn) || can_spawn.length < 1 || can_spawn.length > 100) {
      invalid4("can_spawn must be a boolean or an array of 1 to 100 persona IDs.");
    }
    spawn2 = uniqueStrings(can_spawn, "can_spawn", isValidPersonaId);
  }
  const policy = tools === void 0 ? void 0 : closedObject(tools, "tools", ["allow", "deny"]);
  const patterns = (key) => policy && Object.hasOwn(policy, key) ? uniqueStrings(policy[key], `tools.${key}`, (entry) => toolPattern.test(entry)) : void 0;
  const spec = canonicalizePersona({
    id,
    model,
    thinking: level,
    can_spawn: spawn2,
    description: normalizeText(description, "description"),
    prompt: normalizeText(md ? md.body : fields.prompt, "prompt"),
    tools: { allow: patterns("allow"), deny: patterns("deny") }
  });
  if (Object.hasOwn(fields, "spec_digest") && spec_digest !== spec.spec_digest) {
    invalid4("spec_digest does not match the computed persona digest.");
  }
  return spec;
}
function parsePersonaFile(text2, filePath) {
  const extension = extname(filePath);
  if (extension !== ".md" && extension !== ".json") invalid4("Expected a .md or .json persona filename.");
  const stem = basename2(filePath, extension);
  if (!isValidPersonaId(stem)) invalid4("Persona filename stem must be a lowercase kebab-case identifier.");
  return parse(text2, extension === ".md" ? "md" : "json", stem);
}
function parsePersonaInput(text2, source = "-") {
  if (source !== "-") return parsePersonaFile(text2, source);
  return parse(text2, text2.trimStart().startsWith("{") ? "json" : "md");
}
function toPersonaSummary(spec) {
  const { id, description, model, thinking, can_spawn, spec_digest } = spec;
  return { id, description, model, thinking, can_spawn, spec_digest };
}

// src/core/spawn-policy.ts
function evaluateEffectiveCanSpawn(context) {
  const { parent_persona_id: explicitParent, env, resolvePersona } = context;
  const descendant = context.surface === "pi" ? context.isLaunchedChild : context.depth >= 1;
  if (descendant) {
    const initial = env?.LARVA_PI_INITIAL_PERSONA_ID;
    if (!initial?.trim() || explicitParent !== void 0 && explicitParent !== initial) {
      throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Descendant spawn authority requires the launch-bound persona.");
    }
    const persona2 = resolvePersona(initial);
    if (!persona2) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "The launch-bound persona could not be resolved.");
    return persona2.can_spawn;
  }
  if (context.surface === "pi") {
    if (context.activePersona === null) return false;
    const capability = context.activePersona.can_spawn;
    return capability === false && context.rootSessionSpawn === "allow" ? true : capability;
  }
  const parent = explicitParent ?? (env?.LARVA_MCP_PARENT_PERSONA?.trim() || void 0);
  if (parent === void 0) return true;
  if (!parent.trim()) throw new LarvaError("LARVA_BAD_INPUT", "parent_persona_id must not be blank.");
  const persona = resolvePersona(parent);
  if (!persona) throw new LarvaError("LARVA_PERSONA_NOT_FOUND", "The MCP parent persona could not be resolved.");
  return persona.can_spawn;
}
function assertCanSpawnTarget(effectiveCanSpawn, targetPersonaId) {
  if (effectiveCanSpawn !== true && (effectiveCanSpawn === false || !effectiveCanSpawn.includes(targetPersonaId))) {
    throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "The effective spawn policy does not allow this target persona.");
  }
}

// src/store/artifacts.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join as join4 } from "node:path";
var inlineCodePoints = 36e3;
var previewCodePoints = 2e3;
async function writeOutputSnapshot(home, text2) {
  let points = 0;
  let previewEnd = 0;
  for (const char of text2) {
    points++;
    if (points <= previewCodePoints) previewEnd += char.length;
    if (points > inlineCodePoints) break;
  }
  if (points <= inlineCodePoints) return { output_state: "inline", result_text: text2 };
  let staged;
  try {
    const bytes = Buffer.from(text2, "utf8");
    const sha256 = createHash2("sha256").update(bytes).digest("hex");
    let lines = bytes[bytes.length - 1] === 10 ? 0 : 1;
    for (const byte of bytes) if (byte === 10) lines++;
    const directory2 = getLarvaHomePaths(home).artifacts;
    await mkdir(directory2, { recursive: true, mode: 448 });
    const metadata = await lstat(directory2);
    if (!metadata.isDirectory()) throw new Error("Artifact path is not a directory.");
    if ((metadata.mode & 4095) !== 448) await chmod(directory2, 448);
    const name = randomUUID();
    const path = join4(directory2, `${name}.txt`);
    const temporary = join4(directory2, `.${name}.tmp`);
    const file = await open(temporary, "wx", 384);
    staged = temporary;
    try {
      await file.chmod(384);
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    return {
      output_state: "artifactized",
      result_preview: text2.slice(0, previewEnd),
      full_output_artifact: { path, bytes: bytes.length, sha256, lines }
    };
  } catch {
    if (staged !== void 0) await unlink(staged).catch(() => void 0);
    return {
      output_state: "delivery_failed",
      output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Could not persist full output artifact." }
    };
  }
}

// src/store/capsule.ts
var capsule_exports = {};
__export(capsule_exports, {
  capsuleParentPid: () => capsuleParentPid,
  createCapsule: () => createCapsule,
  inspectCapsule: () => inspectCapsule,
  isErrno: () => isErrno,
  isPid: () => isPid,
  linkedCapsuleRoots: () => linkedCapsuleRoots,
  metadataObject: () => metadataObject,
  pidExited: () => pidExited,
  privateDirectory: () => privateDirectory,
  readMetadata: () => readMetadata,
  writeMetadata: () => writeMetadata
});
import { randomBytes } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { access, lstat as lstat2, mkdir as mkdir2, open as open3, opendir, realpath, rename as rename2, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { basename as basename3, dirname, join as join5 } from "node:path";

// src/store/bounded-read.ts
import { constants } from "node:fs";
import { open as open2 } from "node:fs/promises";
var decoder = new TextDecoder("utf-8", { fatal: true });
async function readBoundedRegularBytes(path, { maxBytes, flags = 0 }) {
  const file = await open2(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const metadata = await file.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("Invalid regular file size or type.");
    const bytes = Buffer.allocUnsafe(Number(metadata.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) return { bytes: bytes.subarray(0, used), metadata };
      used += bytesRead;
    }
    throw new Error("File grew while being read.");
  } finally {
    await file.close();
  }
}
async function readBoundedRegularText(path, options) {
  const { bytes } = await readBoundedRegularBytes(path, options);
  return decoder.decode(bytes);
}

// src/store/capsule.ts
var { O_RDONLY, O_NONBLOCK, O_NOFOLLOW, R_OK, X_OK } = constants2;
var CAPSULE_NAME = /^child-([1-9][0-9]*)-[a-f0-9]+$/;
var MAX_TREE_DEPTH = 100;
var MAX_CENSUS_ENTRIES = 1e4;
function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function isPid(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function pidExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, "ESRCH");
  }
}
async function privateDirectory(path) {
  const parent = dirname(path);
  await mkdir2(parent, { recursive: true, mode: 448 });
  if (!(await lstat2(parent)).isDirectory()) {
    throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Expected a real state directory.");
  }
  await mkdir2(path, { recursive: true, mode: 448 });
  const entry = await lstat2(path);
  if (!entry.isDirectory() || (entry.mode & 63) !== 0) {
    throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Expected a private state directory.");
  }
}
async function readMetadata(path) {
  const file = await open3(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(65537);
    if (!(await file.stat()).isFile()) throw new Error("Expected regular metadata file.");
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (bytesRead === 0) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)));
      used += bytesRead;
    }
    throw new Error("Metadata exceeds the read limit.");
  } finally {
    await file.close();
  }
}
function metadataObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function writeMetadata(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 65536) throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Metadata exceeds the write limit.");
  const temp = `${path}.tmp.${process.pid}.${randomBytes(16).toString("hex")}`;
  const file = await open3(temp, "wx", 384);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename2(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {
    });
    throw error;
  }
}
var missingBase = (error) => isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR");
async function snapshotPiConfig(agentDir, name) {
  const path = join5(agentDir, name);
  try {
    if (name === "models.json") {
      const entry = await lstat2(path).catch((error) => {
        if (!missingBase(error)) throw error;
      });
      if (!entry) return void 0;
      return (await readBoundedRegularBytes(await realpath(path), { maxBytes: 1048576, flags: O_NOFOLLOW })).bytes;
    }
    return (await readBoundedRegularBytes(path, { maxBytes: 1048576 }).catch((error) => {
      if (!missingBase(error)) throw error;
    }))?.bytes;
  } catch {
    throw new LarvaError("LARVA_CONFIG_INVALID", `Pi ${name} must be a readable regular file of at most 1 MiB.`);
  }
}
var privatePiEntries = /* @__PURE__ */ new Set(["settings.json", "models.json", "sessions", "backups", "crashes.json"]);
async function projectPiResources(base, agentDir) {
  const entries = await opendir(base).catch((error) => {
    if (!missingBase(error)) throw error;
  });
  if (!entries) return;
  for await (const { name } of entries) {
    if (privatePiEntries.has(name) || name.endsWith("-debug.log") || name.endsWith(".lock")) continue;
    let target, info;
    try {
      target = await realpath(join5(base, name));
      info = await stat(target);
    } catch (error) {
      if (missingBase(error) || isErrno(error, "ELOOP")) continue;
      throw error;
    }
    if (info.isFile() || info.isDirectory()) await symlink(target, join5(agentDir, name), info.isDirectory() ? "dir" : "file");
  }
}
async function createCapsule(options) {
  const capsules = getLarvaHomePaths(options.home).capsules;
  const root = join5(capsules, `child-${process.pid}-${randomBytes(16).toString("hex")}`);
  await privateDirectory(capsules);
  const [extension_sources, settings, models] = await Promise.all([
    resolveExtensionSources(options.extension_sources, {
      larvaHome: options.home,
      userHome: options.user_home ?? homedir2(),
      piAgentDir: options.pi_agent_dir,
      realpath,
      async assertReadable(path) {
        const entry = await stat(path);
        if (!entry.isDirectory() && !entry.isFile()) throw new Error("Expected file or directory.");
        await access(path, entry.isDirectory() ? R_OK | X_OK : R_OK);
      }
    }),
    snapshotPiConfig(options.pi_agent_dir, "settings.json"),
    snapshotPiConfig(options.pi_agent_dir, "models.json")
  ]);
  const agent_dir = join5(root, "agent");
  const settings_path = join5(agent_dir, "settings.json");
  const models_path = models === void 0 ? void 0 : join5(agent_dir, "models.json");
  await mkdir2(root, { mode: 448 });
  try {
    await mkdir2(join5(root, "descendants"), { mode: 448 });
    await mkdir2(agent_dir, { mode: 448 });
    await writeFile(settings_path, settings ?? "{}\n", { mode: 384, flag: "wx" });
    if (models !== void 0 && models_path !== void 0) await writeFile(models_path, models, { mode: 384, flag: "wx" });
    await projectPiResources(options.pi_agent_dir, agent_dir);
    await writeMetadata(join5(root, "owner.json"), { owner_pid: process.pid, state: "reserving" });
    return { root, agent_dir, settings_path, models_path, extension_sources };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function capsuleParentPid(home, root) {
  if (dirname(root) !== getLarvaHomePaths(home).capsules) return void 0;
  const match = CAPSULE_NAME.exec(basename3(root));
  if (!match || join5(dirname(root), match[0]) !== root) return void 0;
  const pid = Number(match[1]);
  return isPid(pid) ? pid : void 0;
}
function parseOwner(value) {
  if (!metadataObject(value) || Object.keys(value).some((key) => !["owner_pid", "state", "child_pid"].includes(key))) {
    throw new Error("Invalid capsule owner metadata.");
  }
  const { owner_pid, state, child_pid } = value;
  if (!isPid(owner_pid) || state !== "reserving" && state !== "spawning" && state !== "running" && state !== "unreconciled" || child_pid !== void 0 && child_pid !== null && !isPid(child_pid) || state === "running" && !isPid(child_pid) || (state === "reserving" || state === "spawning") && isPid(child_pid)) {
    throw new Error("Invalid capsule owner metadata.");
  }
  return { owner_pid, state, child_pid };
}
async function* readDescendants(home, dir, names) {
  for (const name of names) {
    const record2 = await readMetadata(join5(dir, name)).catch(() => void 0);
    if (!metadataObject(record2)) {
      yield void 0;
      continue;
    }
    const { pid, capsule_root: root } = record2;
    const owner = typeof root === "string" ? capsuleParentPid(home, root) : void 0;
    yield typeof root === "string" && owner !== void 0 ? { pid, linked: { root, owner } } : root === void 0 ? { pid } : void 0;
  }
}
function descendantCensus() {
  let remaining = MAX_CENSUS_ENTRIES;
  return async (dir) => {
    const names = [];
    for await (const entry of await opendir(dir)) {
      if (--remaining < 0) throw new Error("Capsule proof exceeds the census limit.");
      if (entry.name.endsWith(".json")) names.push(entry.name);
    }
    return names.sort();
  };
}
async function linkedCapsuleRoots(home, root) {
  const dir = join5(root, "descendants");
  const links = /* @__PURE__ */ new Set();
  try {
    if (!(await lstat2(root)).isDirectory() || !(await lstat2(dir)).isDirectory()) return links;
    for await (const record2 of readDescendants(home, dir, await descendantCensus()(dir))) {
      if (record2?.linked) links.add(record2.linked.root);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return links;
}
async function inspectCapsule(home, root, leaseChildPid, ownerMode = "exited") {
  const seen = /* @__PURE__ */ new Set();
  const records = descendantCensus();
  async function inspect(root2, ppid, expectedPid, depth) {
    if (depth > MAX_TREE_DEPTH || seen.has(root2) || !(await lstat2(root2)).isDirectory()) {
      throw new Error("Invalid capsule tree.");
    }
    seen.add(root2);
    const ownedHere = depth === 0 && ownerMode === "live";
    const ownerSettled = ownedHere ? ppid === process.pid : pidExited(ppid);
    const owner = parseOwner(await readMetadata(join5(root2, "owner.json")));
    if (owner.owner_pid !== ppid) throw new Error("Capsule owner does not match its path.");
    const childPids = /* @__PURE__ */ new Set();
    if (expectedPid != null) childPids.add(expectedPid);
    if (owner.child_pid != null) childPids.add(owner.child_pid);
    try {
      const self = await readMetadata(join5(root2, "child_self.json"));
      if (!metadataObject(self) || !isPid(self.pid)) throw new Error("Invalid capsule PID record.");
      childPids.add(self.pid);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const proof = { all_exited: false, has_child: childPids.size > 0, state: owner.state };
    if (!ownerSettled || ownedHere && expectedPid != null && childPids.size !== 1) return proof;
    if (![...childPids].every(pidExited)) return proof;
    const descendants = join5(root2, "descendants");
    const before = await lstat2(descendants, { bigint: true });
    if (!before.isDirectory()) throw new Error("Invalid descendant directory.");
    const names = await records(descendants);
    for await (const record2 of readDescendants(home, descendants, names)) {
      if (!record2) throw new Error("Invalid descendant record.");
      const { pid, linked } = record2;
      if (pid !== void 0 && !isPid(pid) || pid === void 0 && !linked) throw new Error("Invalid descendant PID record.");
      if (pid !== void 0 && !pidExited(pid)) return proof;
      if (!linked) continue;
      if (seen.has(linked.root)) return proof;
      try {
        await lstat2(linked.root);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        if (pid === void 0 || !pidExited(linked.owner)) return proof;
        continue;
      }
      const nested = await inspect(linked.root, linked.owner, pid ?? null, depth + 1);
      if (!nested.all_exited || !nested.has_child && pid === void 0) return proof;
    }
    const finalNames = await records(descendants);
    const after = await lstat2(descendants, { bigint: true });
    proof.all_exited = before.dev === after.dev && before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && finalNames.length === names.length && finalNames.every((name, index) => name === names[index]);
    return proof;
  }
  try {
    const ppid = capsuleParentPid(home, root);
    if (ppid !== void 0 && (await lstat2(dirname(root))).isDirectory()) return await inspect(root, ppid, leaseChildPid, 0);
  } catch {
  }
  return void 0;
}

// src/store/model-map.ts
import { constants as constants3 } from "node:fs";
import { lstat as lstat3, realpath as realpath2 } from "node:fs/promises";
async function entryExists(path) {
  try {
    await lstat3(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
function readBoundedRegularText2(path, flags = 0) {
  return readBoundedRegularText(path, { maxBytes: 1048576, flags });
}
function diskModelMapReader(home) {
  return {
    entryExists,
    resolveContainedPath: (_root, path) => resolveContainedPath(home, path, realpath2),
    // The selected entry can be a symlink; open its resolved target instead.
    readText: (path) => readBoundedRegularText2(path, constants3.O_NOFOLLOW)
  };
}
function loadDiskModelMap(home, path) {
  return loadModelMap(home, path, diskModelMapReader(home));
}

// src/store/persona-store.ts
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
import { constants as constants4 } from "node:fs";
import { lstat as lstat4, mkdir as mkdir3, open as open4, readdir, rename as rename3, stat as stat2, unlink as unlink2 } from "node:fs/promises";
import { basename as basename4, extname as extname2, join as join6 } from "node:path";
var MAX_PERSONA_BYTES = 1048576;
var formats = ["md", "json"];
var maxDiagnostics = 100;
var maxCachedPersonas = 128;
var decoder2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function fileFormat(path) {
  const ext = extname2(path);
  return ext === ".md" ? "md" : ext === ".json" ? "json" : void 0;
}
function candidates(directory2, names) {
  const files = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const format = fileFormat(name);
    if (!format) continue;
    files.push({ path: join6(directory2, name), id: basename4(name, `.${format}`), format });
  }
  return files.sort((a, b) => compareIds(a.id, b.id) || compareIds(a.format, b.format));
}
function conflict(id) {
  return new LarvaError("LARVA_PERSONA_CONFLICT", `Both formats exist for persona ${id}.`);
}
function notFound(id) {
  return new LarvaError("LARVA_PERSONA_NOT_FOUND", `Persona ${id} was not found.`);
}
function unreadable(path) {
  return new LarvaError("LARVA_PERSONA_INVALID", `Cannot read persona input: ${path}`);
}
function assertId(id) {
  if (!isValidPersonaId(id)) throw new LarvaError("LARVA_BAD_INPUT", "Expected a lowercase kebab-case persona ID.");
}
async function readPersonaFile(path, installed = false) {
  try {
    return await readBoundedRegularBytes(path, {
      maxBytes: MAX_PERSONA_BYTES,
      flags: installed ? constants4.O_NOFOLLOW : 0
    });
  } catch {
    throw unreadable(path);
  }
}
function parseFile(bytes, path) {
  let text2;
  try {
    text2 = decoder2.decode(bytes);
  } catch {
    throw new LarvaError("LARVA_PERSONA_INVALID", `Persona input is not UTF-8: ${path}`);
  }
  return parsePersonaInput(text2, path);
}
async function loadInput(target, { prune, stdinText }) {
  const badPrune = () => new LarvaError("LARVA_BAD_INPUT", "Prune requires a persona input directory.");
  if (target === "-") {
    if (prune) throw badPrune();
    if (stdinText === void 0) throw new LarvaError("LARVA_BAD_INPUT", "Persona stdin text is required.");
    if (Buffer.byteLength(stdinText, "utf8") > MAX_PERSONA_BYTES) {
      throw new LarvaError("LARVA_PERSONA_INVALID", "Persona stdin exceeds 1 MiB.");
    }
    const bytes = Buffer.from(stdinText, "utf8");
    const text2 = bytes.toString("utf8");
    return [{ spec: parsePersonaInput(text2), format: text2.trimStart().startsWith("{") ? "json" : "md", bytes }];
  }
  let files;
  try {
    const targetStat = await stat2(target);
    if (prune && !targetStat.isDirectory()) throw badPrune();
    files = [target];
    if (targetStat.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      const batch = candidates(target, entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name));
      for (let i = 1; i < batch.length; i++) {
        if (batch[i - 1].id === batch[i].id && isValidPersonaId(batch[i].id)) throw conflict(batch[i].id);
      }
      files = batch.map((file) => file.path);
    }
  } catch (error) {
    if (error instanceof LarvaError) throw error;
    throw unreadable(target);
  }
  const inputs = [];
  for (const path of files) {
    const format = fileFormat(path);
    if (!format) throw new LarvaError("LARVA_PERSONA_INVALID", "Expected a .md or .json persona filename.");
    const { bytes } = await readPersonaFile(path);
    inputs.push({ spec: parseFile(bytes, path), format, bytes });
  }
  return inputs;
}
async function unlinkIfPresent(path) {
  try {
    await unlink2(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
async function stageAndRename(directory2, { spec, format, bytes }) {
  const temporary = join6(directory2, `.${spec.id}.${randomUUID2()}.tmp`);
  const file = await open4(temporary, "wx", 384);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename3(temporary, join6(directory2, `${spec.id}.${format}`));
  } catch (error) {
    await unlinkIfPresent(temporary).catch(() => void 0);
    throw error;
  }
}
function rank(spec, query) {
  if (spec.id === query) return 0;
  if (spec.id.startsWith(query)) return 1;
  if (spec.id.includes(query)) return 2;
  return [spec.description, spec.model].some((value) => value.toLowerCase().includes(query)) ? 3 : Infinity;
}
var PersonaStore = class {
  #directory;
  #cache = /* @__PURE__ */ new Map();
  #diagnostics = [];
  #mutation = Promise.resolve();
  constructor(home = resolveLarvaHome()) {
    this.#directory = getLarvaHomePaths(home).personas;
  }
  /** Diagnostics from the most recently completed list scan, independent of search and limit. */
  get diagnostics() {
    return this.#diagnostics.map((item) => ({ ...item }));
  }
  async validate(target, stdinText) {
    return (await loadInput(target, { stdinText })).map((input) => input.spec);
  }
  async #installed(id) {
    const found = [];
    for (const format of formats) {
      const path = join6(this.#directory, `${id}.${format}`);
      try {
        await lstat4(path);
        found.push({ path, id, format });
      } catch (error) {
        if (!isMissing(error)) throw unreadable(path);
      }
    }
    return found;
  }
  async get(id) {
    assertId(id);
    try {
      const found = await this.#installed(id);
      if (found.length === 0) throw notFound(id);
      if (found.length > 1) throw conflict(id);
      const [{ path, format }] = found;
      const { bytes, metadata } = await readPersonaFile(path, true);
      const hash2 = createHash3("sha256").update(bytes).digest("hex");
      const fingerprint = `${format}:${metadata.dev}:${metadata.ino}:${metadata.mtimeNs}:${hash2}`;
      const cached = this.#cache.get(id);
      if (cached?.fingerprint === fingerprint) return structuredClone(cached.spec);
      const spec = parseFile(bytes, path);
      this.#cache.delete(id);
      if (this.#cache.size === maxCachedPersonas) {
        const oldest = this.#cache.keys().next();
        if (!oldest.done) this.#cache.delete(oldest.value);
      }
      this.#cache.set(id, { fingerprint, spec });
      return structuredClone(spec);
    } catch (error) {
      this.#cache.delete(id);
      throw error;
    }
  }
  async list({ full, query, limit } = {}) {
    if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new LarvaError("LARVA_BAD_INPUT", "Persona list limit must be a positive integer.");
    }
    const diagnostics = [];
    let files = [];
    try {
      files = candidates(this.#directory, await readdir(this.#directory));
    } catch (error) {
      if (!isMissing(error)) diagnostics.push({
        code: "LARVA_PERSONA_INVALID",
        message: "Cannot enumerate the persona directory.",
        path: this.#directory
      });
    }
    const valid = [];
    const checked = /* @__PURE__ */ new Set();
    for (const { id, path } of files) {
      if (!isValidPersonaId(id)) {
        if (diagnostics.length < maxDiagnostics) diagnostics.push({
          code: "LARVA_PERSONA_INVALID",
          message: "Invalid persona filename stem.",
          path
        });
        continue;
      }
      if (checked.has(id)) continue;
      checked.add(id);
      try {
        valid.push(await this.get(id));
      } catch (error) {
        if (!(error instanceof LarvaError)) throw error;
        if (diagnostics.length < maxDiagnostics) diagnostics.push({
          code: error.code,
          persona_id: id,
          message: error.code === "LARVA_PERSONA_CONFLICT" ? "Both persona formats exist." : error.code === "LARVA_PERSONA_NOT_FOUND" ? "Persona disappeared during listing." : "Persona file is malformed or unreadable.",
          ...error.code === "LARVA_PERSONA_CONFLICT" ? {} : { path }
        });
      }
    }
    this.#diagnostics = diagnostics;
    const needle = query?.trim().toLowerCase();
    const matches2 = needle ? valid.map((spec) => ({ spec, score: rank(spec, needle) })).filter((item) => Number.isFinite(item.score)).sort((a, b) => a.score - b.score || compareIds(a.spec.id, b.spec.id)).map((item) => item.spec) : valid;
    const selected = matches2.slice(0, limit);
    return full ? selected : selected.map(toPersonaSummary);
  }
  #mutate(operation) {
    const next = this.#mutation.then(operation);
    this.#mutation = next.catch(() => void 0);
    return next;
  }
  async put(target, options = {}) {
    const prune = options.prune;
    const inputs = await loadInput(target, options);
    return this.#mutate(async () => {
      const committed_ids = [];
      const pruned = /* @__PURE__ */ new Set();
      let failed_id = null;
      try {
        failed_id = inputs[0]?.spec.id ?? null;
        await mkdir3(this.#directory, { recursive: true, mode: 448 });
        for (const input of inputs) {
          failed_id = input.spec.id;
          this.#cache.delete(failed_id);
          await stageAndRename(this.#directory, input);
          committed_ids.push(failed_id);
          const other = input.format === "md" ? "json" : "md";
          await unlinkIfPresent(join6(this.#directory, `${failed_id}.${other}`));
        }
        if (prune) {
          failed_id = null;
          const incoming = new Set(committed_ids);
          const files = candidates(this.#directory, await readdir(this.#directory));
          for (const { path, id } of files) {
            if (incoming.has(id)) continue;
            failed_id = id;
            this.#cache.delete(id);
            if (await unlinkIfPresent(path)) pruned.add(id);
          }
        }
      } catch {
        throw new LarvaError("LARVA_STORE_WRITE_FAILED", "Could not finish writing the persona store.", {
          committed_ids,
          pruned_ids: [...pruned],
          failed_id
        });
      }
      return { committed_ids, pruned_ids: [...pruned] };
    });
  }
  async rm(ids) {
    const requested = [...new Set(ids)];
    requested.forEach(assertId);
    return this.#mutate(async () => {
      for (const id of requested) {
        if ((await this.#installed(id)).length === 0) throw notFound(id);
      }
      for (const id of requested) {
        this.#cache.delete(id);
        try {
          for (const format of formats) await unlinkIfPresent(join6(this.#directory, `${id}.${format}`));
        } catch {
          throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Could not remove persona ${id}.`, { failed_id: id });
        }
      }
    });
  }
};

// src/store/session-index.ts
import { constants as constants5 } from "node:fs";
import { lstat as lstat5, open as open5, readdir as readdir2, realpath as realpath3, stat as stat3 } from "node:fs/promises";
import { basename as basename5, dirname as dirname2, isAbsolute as isAbsolute2, join as join7, resolve as resolve2 } from "node:path";
var HEADER_LIMIT = 1048576;
function invalid5() {
  return new LarvaError("LARVA_SESSION_INVALID", "Invalid Pi session header or transcript path.");
}
function parseHeader(bytes, task_id) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid5();
  }
  if (value === null || typeof value !== "object" || !("type" in value) || value.type !== "session" || !("version" in value) || !("cwd" in value)) throw invalid5();
  const { version, cwd } = value;
  if (version !== 2 && version !== 3 || typeof cwd !== "string" || !isAbsolute2(cwd) || cwd.includes("\0")) {
    throw invalid5();
  }
  return { task_id, version, cwd };
}
function sessionReadError(error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return new LarvaError("LARVA_SESSION_NOT_FOUND", "Session transcript is missing.");
  }
  return error instanceof LarvaError ? error : invalid5();
}
async function canonicalPath(path) {
  if (await entryExists(path)) return realpath3(path);
  return join7(await canonicalPath(dirname2(path)), basename5(path));
}
async function resolveCanonicalSessionPath(home, taskId) {
  if (taskId.includes("\0") || !isAbsolute2(taskId) || resolve2(taskId) !== taskId || !taskId.endsWith(".jsonl")) throw invalid5();
  try {
    const root = await canonicalPath(getLarvaHomePaths(home).sessions);
    if (!isLexicallyContained(root, taskId) || await canonicalPath(taskId) !== taskId) throw invalid5();
    const info = await lstat5(taskId).catch((error) => {
      throw sessionReadError(error);
    });
    if (!info.isFile() || await realpath3(taskId) !== taskId) throw invalid5();
    return taskId;
  } catch (error) {
    throw error instanceof LarvaError ? error : invalid5();
  }
}
async function readSessionHeader(home, taskId) {
  const task_id = await resolveCanonicalSessionPath(home, taskId);
  try {
    const file = await open5(task_id, constants5.O_RDONLY | constants5.O_NONBLOCK | constants5.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw invalid5();
      const buffer = Buffer.alloc(HEADER_LIMIT + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, Math.min(8192, buffer.length - used), used);
        if (bytesRead === 0) return parseHeader(buffer.subarray(0, used), task_id);
        const newline = buffer.subarray(used, used + bytesRead).indexOf(10);
        if (newline !== -1) return parseHeader(buffer.subarray(0, used + newline), task_id);
        used += bytesRead;
      }
      throw invalid5();
    } finally {
      await file.close();
    }
  } catch (error) {
    throw sessionReadError(error);
  }
}
async function sessionCwdExists(cwd) {
  try {
    return (await stat3(cwd)).isDirectory();
  } catch {
    return false;
  }
}
async function readDiskSession(home, taskId, leases) {
  const { task_id, cwd } = await readSessionHeader(home, taskId);
  const [cwd_exists, lock_state] = await Promise.all([sessionCwdExists(cwd), leases.diskLockState(task_id)]);
  return { task_id, cwd, cwd_exists, lock_state };
}
async function scanDiskSessions(home, leases) {
  let root, names;
  try {
    root = await realpath3(getLarvaHomePaths(home).sessions);
    names = await readdir2(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const sessions = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      sessions.push(await readDiskSession(home, join7(root, name), leases));
    } catch (error) {
      if (!(error instanceof LarvaError) || error.code !== "LARVA_SESSION_INVALID" && error.code !== "LARVA_SESSION_NOT_FOUND") {
        throw error;
      }
    }
  }
  return sessions;
}

// src/store/session-lease.ts
import { createHash as createHash4, randomBytes as randomBytes2 } from "node:crypto";
import { link, lstat as lstat6, mkdir as mkdir4, realpath as realpath4, rename as rename4, rm as rm2 } from "node:fs/promises";
import { basename as basename6, join as join8 } from "node:path";
var LEASE_KEYS = ["lease_id", "owner_pid", "state", "child_pid", "capsule_root"];
var randomId = () => randomBytes2(16).toString("hex");
function createSessionLeaseStore(home, io) {
  const sessions = getLarvaHomePaths(home).sessions;
  async function lockPath(taskId) {
    const name = basename6(taskId);
    if (!taskId.endsWith(".jsonl") || taskId.includes("\0")) {
      throw new LarvaError("LARVA_SESSION_INVALID", "Expected a contained .jsonl task_id.");
    }
    if (!isLexicallyContained(sessions, taskId)) {
      let canonical;
      try {
        canonical = await realpath4(sessions);
      } catch (error) {
        if (io.isErrno(error, "ENOENT")) canonical = sessions;
        else throw error;
      }
      if (!isLexicallyContained(canonical, taskId)) {
        throw new LarvaError("LARVA_SESSION_INVALID", "Expected a contained .jsonl task_id.");
      }
    }
    return join8(sessions, `${name}.lock`);
  }
  function parseRecord(value) {
    if (!io.metadataObject(value) || Object.keys(value).some((key) => !LEASE_KEYS.includes(key))) return void 0;
    const { lease_id, state, owner_pid, child_pid, capsule_root } = value;
    if (typeof lease_id !== "string" || !lease_id.trim() || !io.isPid(owner_pid)) return void 0;
    if ((state === "reserving" || state === "gc_unlinking") && child_pid === null && capsule_root === null) {
      return { lease_id, state, owner_pid, child_pid, capsule_root };
    }
    if (typeof capsule_root !== "string" || io.capsuleParentPid(home, capsule_root) !== owner_pid) return void 0;
    if (state === "spawning" && child_pid === null) return { lease_id, state, owner_pid, child_pid, capsule_root };
    if (state === "running" && io.isPid(child_pid)) return { lease_id, state, owner_pid, child_pid, capsule_root };
    if (state === "unreconciled" && (child_pid === null || io.isPid(child_pid))) {
      return { lease_id, state, owner_pid, child_pid, capsule_root };
    }
    return void 0;
  }
  async function read(path) {
    try {
      if (!(await lstat6(sessions)).isDirectory() || !(await lstat6(path)).isDirectory()) return "invalid";
    } catch (error) {
      return io.isErrno(error, "ENOENT") ? "missing" : "invalid";
    }
    try {
      return parseRecord(await io.readMetadata(join8(path, "lease.json"))) ?? "invalid";
    } catch {
      return "invalid";
    }
  }
  async function assess(record2) {
    if (!io.pidExited(record2.owner_pid)) return record2.state === "unreconciled" ? "uncertain" : "active";
    if (record2.capsule_root === null) return "stale";
    const capsule = await io.inspectCapsule(home, record2.capsule_root, record2.child_pid);
    return capsule?.all_exited && capsule.has_child ? "stale" : "uncertain";
  }
  async function inspect(taskId) {
    const record2 = await read(await lockPath(taskId));
    if (typeof record2 === "string") return { disposition: record2 };
    return { disposition: await assess(record2), record: record2 };
  }
  async function diskLockState(taskId) {
    const lease = await inspect(taskId);
    if (lease.disposition === "missing" || lease.disposition === "stale") return "unlocked";
    if (lease.disposition !== "active") return "unreconciled";
    return lease.record.owner_pid === process.pid ? "active_local" : "active_external";
  }
  async function detach(path) {
    const detached2 = `${path}.retired.${process.pid}.${randomId()}`;
    await rename4(path, detached2);
    await rm2(detached2, { recursive: true, force: true }).catch(() => {
    });
  }
  async function reclaim(taskId, observedId) {
    const path = await lockPath(taskId);
    const observed = await read(path);
    if (typeof observed === "string" || observed.lease_id !== observedId || !io.pidExited(observed.owner_pid)) return false;
    const disposition = await assess(observed);
    if (disposition !== "stale" && observed.state !== "spawning") return false;
    const prefix = createHash4("sha256").update(observedId).digest("hex");
    const stage = `${path}.guard.tmp.${process.pid}.${randomId()}`;
    let claim;
    await io.writeMetadata(stage, { pid: process.pid });
    try {
      for (let slot = 0; ; slot++) {
        const candidate = join8(path, `.reclaim.${prefix}.${slot}`);
        try {
          await link(stage, candidate);
          claim = candidate;
          break;
        } catch (error) {
          if (io.isErrno(error, "ENOENT")) return false;
          if (!io.isErrno(error, "EEXIST")) throw error;
        }
        let guard;
        try {
          guard = await io.readMetadata(candidate);
        } catch {
          return false;
        }
        if (!io.metadataObject(guard) || !(guard.done === true || io.isPid(guard.pid) && io.pidExited(guard.pid))) return false;
      }
      const current = await read(path);
      if (typeof current === "string" || current.lease_id !== observedId || !io.pidExited(current.owner_pid)) return false;
      if (await assess(current) === "stale") {
        await detach(path);
        claim = void 0;
        return true;
      }
      if (current.state === "spawning") {
        await io.writeMetadata(join8(path, "lease.json"), { ...current, state: "unreconciled" });
      }
      return false;
    } finally {
      try {
        if (claim !== void 0) {
          const current = await read(path);
          if (typeof current !== "string" && current.lease_id === observedId) await io.writeMetadata(claim, { done: true });
        }
      } finally {
        await rm2(stage, { force: true }).catch(() => {
        });
      }
    }
  }
  async function acquire(taskId, state = "reserving") {
    const path = await lockPath(taskId);
    const lease_id = randomId();
    const temp = `${path}.tmp.${process.pid}.${lease_id}`;
    const owner_pid = process.pid;
    const initial = { lease_id, owner_pid, state, child_pid: null, capsule_root: null };
    const busy = () => new LarvaError("LARVA_SESSION_BUSY", "Session already has an active or unreconciled lease.");
    await io.privateDirectory(sessions);
    await mkdir4(temp, { mode: 448 });
    try {
      await io.writeMetadata(join8(temp, "lease.json"), initial);
      const current = await read(path);
      if (current === "invalid") throw busy();
      if (typeof current !== "string" && !await reclaim(taskId, current.lease_id)) throw busy();
      try {
        await rename4(temp, path);
      } catch (error) {
        if (io.isErrno(error, "EEXIST") || io.isErrno(error, "ENOTEMPTY") || io.isErrno(error, "ENOTDIR")) throw busy();
        throw error;
      }
    } finally {
      await rm2(temp, { recursive: true, force: true }).catch(() => {
      });
    }
    let settled = Promise.resolve();
    function mutate(operation) {
      const next = settled.then(async () => {
        const current = await read(path);
        if (typeof current === "string" || current.lease_id !== lease_id) throw busy();
        await operation(current);
      });
      settled = next.catch(() => {
      });
      return next;
    }
    async function publish(next) {
      await io.writeMetadata(join8(path, "lease.json"), next);
    }
    return {
      lease_id,
      markSpawning: (capsule_root) => mutate(async (current) => {
        if (current.state !== "reserving" || io.capsuleParentPid(home, capsule_root) !== process.pid) throw busy();
        if (!(await lstat6(capsule_root)).isDirectory()) throw busy();
        await io.writeMetadata(join8(capsule_root, "owner.json"), { owner_pid, state: "spawning" });
        await publish({ ...current, state: "spawning", capsule_root });
      }),
      markRunning: (child_pid) => mutate(async (current) => {
        if (current.state !== "spawning" || !io.isPid(child_pid)) throw busy();
        await io.writeMetadata(join8(current.capsule_root, "owner.json"), { owner_pid, state: "running", child_pid });
        await publish({ ...current, state: "running", child_pid });
      }),
      markUnreconciled: () => mutate(async (current) => {
        if (current.state === "unreconciled") return;
        if (current.state !== "spawning" && current.state !== "running") throw busy();
        await publish({ ...current, state: "unreconciled" });
      }),
      release: () => mutate(() => detach(path))
    };
  }
  return { home, acquire, inspect, reclaim, diskLockState };
}

// src/runtime/child-rpc-client.ts
import { spawn } from "node:child_process";
import { dirname as dirname3 } from "node:path";
import { pathToFileURL } from "node:url";
var MAX_RECORD = 1048576;
var GRACE_MS = 1500;
var protocol = (message) => new LarvaError("LARVA_CHILD_PROTOCOL_FAILED", message);
var STDERR_LIMIT = 8192;
var SECRET_NAMES = "(?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)";
var SECRET_KEY = new RegExp(`^${SECRET_NAMES}$`, "i");
var SECRET_ASSIGNMENT = new RegExp(String.raw`["']?\b${SECRET_NAMES}\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+\S+|\S+)`, "gi");
function redactCredentials(raw) {
  return raw.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@").replace(SECRET_ASSIGNMENT, "[REDACTED]").replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\bAIza[0-9A-Za-z_-]{16,}/gi, "[REDACTED]");
}
function sanitizeRpcError(raw) {
  const clean = redactCredentials(raw.replace(/\s+/g, " ").trim());
  return Array.from(clean.slice(0, 600)).slice(0, 300).join("");
}
function previewToolArgs(args) {
  try {
    const serialized = JSON.stringify(args, (key, value) => SECRET_KEY.test(key) ? "[REDACTED]" : typeof value === "string" ? redactCredentials(value) : value);
    return serialized === void 0 ? void 0 : Array.from(serialized.slice(0, 320)).slice(0, 160).join("");
  } catch {
    return void 0;
  }
}
function startupError(stderr) {
  for (const line of stderr.toString("utf8").split("\n").reverse()) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (!metadataObject(frame) || frame.ok !== false || !metadataObject(frame.error)) continue;
    const { code, message } = frame.error;
    const knownCode = ALL_LARVA_ERROR_CODES.find((value) => value === code);
    if (knownCode && typeof message === "string") return new LarvaError(knownCode, sanitizeRpcError(message) || "Pi startup failed.");
  }
}
function launchChild(options, progress, telemetry) {
  const { piScript, extension, preload, extensionSources, env, home, basePiAgentDir, capsule, agentDir, cwd, taskId, depth, ancestors, persona, route, thinking } = options;
  const child = spawn(process.execPath, [
    piScript,
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    extension,
    ...extensionSources.flatMap((source) => ["-e", source]),
    "--larva-persona",
    persona,
    "--larva-mode",
    "manual",
    "--model",
    `${route.provider}/${route.model_id}`,
    "--thinking",
    thinking,
    "--session-dir",
    dirname3(taskId),
    "--session",
    taskId
  ], {
    cwd,
    stdio: "pipe",
    env: {
      ...env,
      NODE_OPTIONS: [`--import=${pathToFileURL(preload).href}`, env.NODE_OPTIONS].filter(Boolean).join(" "),
      LARVA_HOME: home,
      LARVA_PI_LAUNCHED: "1",
      LARVA_PI_INITIAL_PERSONA_ID: persona,
      LARVA_PI_CAPSULE_ROOT: capsule,
      [BASE_PI_AGENT_DIR_ENV]: basePiAgentDir,
      PI_CODING_AGENT_DIR: agentDir,
      LARVA_PI_SUBAGENT_DEPTH: String(depth),
      LARVA_PI_ANCESTOR_TASK_IDS: JSON.stringify(ancestors)
    }
  });
  return new ChildRpcClient(child, progress, telemetry);
}
var ChildRpcClient = class {
  #child;
  #terminal = Promise.withResolvers();
  #exit = Promise.withResolvers();
  #requests = /* @__PURE__ */ new Map();
  #error;
  #shutdown;
  #sequence = 0;
  #promptSent = false;
  #ready = false;
  get pid() {
    return this.#child.pid;
  }
  get settled() {
    return this.#terminal.promise;
  }
  constructor(child, progress, telemetry) {
    this.#child = child;
    this.settled.catch(() => {
    });
    let stderr = Buffer.alloc(0);
    child.stderr.on("data", (chunk) => {
      if (this.#ready) return;
      const tail = chunk.subarray(-STDERR_LIMIT);
      stderr = Buffer.concat([stderr.subarray(Math.max(0, stderr.length + tail.length - STDERR_LIMIT)), tail]);
    });
    child.on("error", () => this.#fail(new LarvaError("LARVA_CHILD_START_FAILED", "Could not launch the Pi child.")));
    child.stdin.on("error", () => {
      if (this.#ready) this.#fail(protocol("Child RPC input closed."));
    });
    child.once("exit", () => this.#exit.resolve());
    const read = this.#read(progress, telemetry).catch(() => this.#fail(protocol("Malformed or oversized child RPC frame.")));
    child.once("close", (code) => {
      this.#exit.resolve();
      void read.then(() => {
        const diagnostic = !this.#ready && code !== null && code !== 0 ? startupError(stderr) : void 0;
        this.#fail(diagnostic ?? protocol("Child exited before RPC completed."));
      });
    });
  }
  #fail(error) {
    this.#error ??= error;
    this.#terminal.reject(this.#error);
    for (const request of this.#requests.values()) request.reject(this.#error);
    this.#requests.clear();
  }
  async #read(progress, telemetry) {
    const buffer = Buffer.allocUnsafe(MAX_RECORD);
    const decoder5 = new TextDecoder("utf-8", { fatal: true });
    let used = 0;
    let stopReason;
    for await (const chunk of this.#child.stdout) {
      for (let start = 0; start < chunk.length; ) {
        const lf = chunk.indexOf(10, start);
        const end = lf === -1 ? chunk.length : lf;
        if (end - start > MAX_RECORD - used) throw protocol("Oversized frame.");
        used += chunk.copy(buffer, used, start, end);
        if (lf === -1) break;
        start = lf + 1;
        const frame = JSON.parse(decoder5.decode(buffer.subarray(0, used)));
        used = 0;
        if (!metadataObject(frame) || typeof frame.type !== "string" || frame.type === "larva_rpc_frame_error") throw protocol("Invalid frame.");
        if (frame.type === "response") {
          const request = typeof frame.id === "string" && this.#requests.get(frame.id);
          if (!request) continue;
          if (frame.command !== request.type || typeof frame.success !== "boolean") throw protocol("Invalid response.");
          if (frame.success && frame.data != null && !metadataObject(frame.data)) throw protocol("Invalid response data.");
          this.#requests.delete(frame.id);
          if (!frame.success) {
            const detail2 = typeof frame.error === "string" ? sanitizeRpcError(frame.error) : "";
            request.reject(protocol(detail2 ? `Child rejected ${request.type}: ${detail2}` : `Child rejected ${request.type}.`));
          } else request.resolve(frame.data ?? {});
          continue;
        }
        if (!this.#promptSent || this.#error) continue;
        telemetry(frame);
        if (frame.type === "agent_settled") {
          if (typeof frame.aborted !== "boolean") throw protocol("Malformed terminal frame.");
          if (frame.aborted || stopReason === "aborted") this.#terminal.reject(new LarvaError("LARVA_CHILD_CANCELLED", "Child aborted."));
          else if (stopReason === "error") this.#terminal.reject(protocol("Child assistant turn failed."));
          else this.#terminal.resolve();
        } else if (frame.type === "agent_start") stopReason = void 0;
        else if (frame.type === "message_end" && metadataObject(frame.message) && frame.message.role === "assistant") stopReason = frame.message.stopReason;
        else if (frame.type === "agent_end") {
          if (Array.isArray(frame.messages)) stopReason = frame.messages.findLast((m) => metadataObject(m) && m.role === "assistant")?.stopReason ?? stopReason;
          progress();
        } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(frame.type)) progress();
        else if (frame.type === "message_update" && metadataObject(frame.assistantMessageEvent)) {
          const e = frame.assistantMessageEvent;
          if (e.type === "thinking_start" || e.type === "thinking_end" || ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(e.type)) && typeof e.delta === "string" && e.delta.trim()) progress();
        }
      }
    }
    if (this.#ready) this.#fail(protocol("Child RPC stream closed."));
  }
  async #command(type, fields = {}) {
    if (this.#error) throw this.#error;
    const id = String(++this.#sequence);
    const response = Promise.withResolvers();
    const line = JSON.stringify({ type, id, ...fields });
    if (Buffer.byteLength(line) > MAX_RECORD) throw protocol("RPC command exceeds the record limit.");
    this.#requests.set(id, { type, ...response });
    const timer = setTimeout(() => response.reject(protocol(`Child ${type} timed out.`)), 3e4);
    try {
      this.#child.stdin.write(`${line}
`);
      return await response.promise;
    } finally {
      clearTimeout(timer);
      this.#requests.delete(id);
    }
  }
  async resume(taskId) {
    const reply = await this.#command("switch_session", { sessionPath: taskId });
    if (reply.cancelled !== false) throw protocol("Child did not confirm session switch.");
  }
  async verify(route, thinking, taskId, persona) {
    const s = await this.#command("get_state");
    const cap = s.larvaChildRpcFrame;
    if (!metadataObject(cap) || cap.capability !== "larva-child-rpc-frame-preload-v1" || cap.framing !== "lf-only" || cap.max_record_bytes !== MAX_RECORD || cap.terminal !== "agent_settled") throw protocol("Missing child preload capability.");
    if (s.sessionFile !== taskId || s.persona_id !== persona) throw protocol("Child session or persona mismatch.");
    if (!metadataObject(s.model) || s.model.provider !== route.provider || s.model.id !== route.model_id || s.thinkingLevel !== thinking) {
      throw new LarvaError("LARVA_MODEL_UNAVAILABLE", "Child did not verify the required model and thinking level.");
    }
    this.#ready = true;
  }
  async setRoute(route, thinking) {
    await this.#command("set_model", { provider: route.provider, modelId: route.model_id });
    await this.#command("set_thinking_level", { level: thinking });
  }
  async prompt(message) {
    this.#promptSent = true;
    if ((await this.#command("prompt", { message })).disposition === "handled") throw protocol("Child handled prompt without starting a run.");
  }
  async output() {
    const { text: text2 } = await this.#command("get_last_assistant_text");
    if (text2 == null) return "";
    if (typeof text2 !== "string") throw protocol("Child did not return assistant text.");
    return text2;
  }
  stop(abort) {
    if (abort) this.#fail(new LarvaError("LARVA_CHILD_CANCELLED", "Child is stopping."));
    return this.#shutdown ??= this.#stop(abort).catch(() => false);
  }
  async #stop(abort) {
    const child = this.#child;
    if (abort && child.stdin.writable) child.stdin.write('{"type":"abort"}\n');
    child.stdin.end();
    const exited = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      let timer;
      try {
        return await Promise.race([this.#exit.promise.then(() => true), new Promise((r) => {
          timer = setTimeout(() => r(false), GRACE_MS);
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (await exited()) return true;
    child.kill("SIGKILL");
    return exited();
  }
};

// src/runtime/outbox.ts
import { randomUUID as randomUUID3 } from "node:crypto";
var mintRunEpoch = () => randomUUID3();
function isTerminal(status) {
  return status === "success" || status === "failed" || status === "cancelled";
}
var RunOutbox = class {
  #completed = /* @__PURE__ */ new Map();
  retain(snapshot) {
    this.#completed.set(snapshot.run_epoch, snapshot);
    if (this.#completed.size <= 25) return;
    const oldest = this.#completed.values().next().value;
    this.#completed.delete(oldest.run_epoch);
    delete oldest.result_text;
    delete oldest.result_preview;
    delete oldest.full_output_artifact;
    delete oldest.output_diagnostic;
    oldest.output_state = "evicted";
  }
  publish(snapshot, output) {
    if (this.#completed.get(snapshot.run_epoch) === snapshot) Object.assign(snapshot, output);
  }
  recent() {
    return [...this.#completed.values()].reverse();
  }
  lookup(taskId, epoch) {
    if (epoch === void 0) return this.recent().find((s2) => s2.task_id === taskId);
    const s = this.#completed.get(epoch);
    return s?.task_id === taskId ? s : void 0;
  }
};
function terminalOutput(snapshot) {
  const { task_id, run_epoch, status, error, output_state, result_text, result_preview, full_output_artifact, output_diagnostic } = snapshot;
  if (!isTerminal(status)) throw new Error("Expected terminal execution status.");
  return structuredClone({
    task_id,
    run_epoch,
    status,
    output_state,
    ...error && { error },
    ...result_text !== void 0 && { result_text },
    ...result_preview !== void 0 && { result_preview },
    ...full_output_artifact && { full_output_artifact },
    ...output_diagnostic && { output_diagnostic }
  });
}

// src/runtime/pi-binary.ts
import { constants as constants6 } from "node:fs";
import { access as access2, realpath as realpath5, stat as stat4 } from "node:fs/promises";
import { basename as basename7, delimiter, dirname as dirname4, isAbsolute as isAbsolute3, join as join9, relative as relative2, resolve as resolve3, sep as sep2 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";
var PI_PACKAGE = "@earendil-works/pi-coding-agent";
var MAX_MANIFEST_BYTES = 1048576;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWithin(root, path) {
  const rel = relative2(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep2}`) && !isAbsolute3(rel);
}
async function registryEntry(directory2, pkg) {
  const exported = isRecord(pkg.exports) ? pkg.exports["."] : pkg.exports;
  const entry = typeof exported === "string" ? exported : isRecord(exported) ? exported.import : pkg.main;
  if (typeof entry !== "string" || entry.length === 0 || isAbsolute3(entry)) return void 0;
  try {
    const path = await realpath5(resolve3(directory2, entry));
    return isWithin(directory2, path) && (await stat4(path)).isFile() ? path : void 0;
  } catch {
    return void 0;
  }
}
async function inspectPiScript(candidate) {
  try {
    const path = await realpath5(candidate);
    if (!(await stat4(path)).isFile()) return void 0;
    await access2(path, constants6.R_OK);
    let directory2 = dirname4(path);
    for (; ; ) {
      let raw;
      try {
        raw = await readBoundedRegularText(join9(directory2, "package.json"), { maxBytes: MAX_MANIFEST_BYTES });
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT" || dirname4(directory2) === directory2) return void 0;
        directory2 = dirname4(directory2);
        continue;
      }
      const pkg = JSON.parse(raw);
      if (!isRecord(pkg) || pkg.name !== PI_PACKAGE || !isRecord(pkg.bin) || typeof pkg.bin.pi !== "string" || !pkg.bin.pi.trim() || isAbsolute3(pkg.bin.pi) || await realpath5(resolve3(directory2, pkg.bin.pi)) !== path) return void 0;
      const entry = await registryEntry(directory2, pkg);
      return {
        path,
        ...typeof pkg.version === "string" && pkg.version ? { version: pkg.version } : {},
        ...entry === void 0 ? {} : { registryEntry: entry }
      };
    }
  } catch {
    return void 0;
  }
}
async function inspectManagedLauncher(candidate) {
  try {
    const launcher = await realpath5(candidate);
    if (basename7(launcher) !== "pi" || basename7(dirname4(launcher)) !== "bin" || !(await stat4(launcher)).isFile()) return void 0;
    const install = await realpath5(join9(dirname4(dirname4(launcher)), "install"));
    const release = (await readBoundedRegularText(join9(install, "current-version"), { maxBytes: 256 })).trim();
    if (!/^[0-9A-Za-z._+-]+$/.test(release) || release === "." || release === "..") return void 0;
    const releaseRoot = join9(install, "releases", release);
    const bin = join9(releaseRoot, "node_modules", ".bin", "pi");
    await access2(bin, constants6.X_OK);
    const verified = await inspectPiScript(bin);
    return verified && isWithin(releaseRoot, verified.path) ? verified : void 0;
  } catch {
    return void 0;
  }
}
async function discoverPiInstallation(env = process.env) {
  const override = env.LARVA_PI_CLI_SCRIPT;
  if (override !== void 0) {
    if (override.trim() && isAbsolute3(override) && !override.includes("\0")) {
      const verified = await inspectPiScript(override);
      if (verified) return verified;
    }
    throw new LarvaError("LARVA_CHILD_START_FAILED", "LARVA_PI_CLI_SCRIPT must be an absolute path to a verified Pi package bin.pi script.");
  }
  for (const directory2 of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute3(directory2)) continue;
    const candidate = join9(directory2, "pi");
    try {
      await access2(candidate, constants6.X_OK);
    } catch {
      continue;
    }
    const verified = await inspectPiScript(candidate) ?? await inspectManagedLauncher(candidate);
    if (verified) return verified;
  }
  throw new LarvaError("LARVA_CHILD_START_FAILED", "No verified Pi installation found on PATH; set LARVA_PI_CLI_SCRIPT to the package bin.pi script.");
}

// src/runtime/settlement-barrier.ts
function childSettlementBarrier() {
  const pending = /* @__PURE__ */ new Map();
  let continuation;
  let scheduled = false;
  let parked;
  let bridge;
  let branch = () => [];
  function release() {
    if (parked === void 0 || pending.size) return;
    const frame = parked;
    parked = void 0;
    bridge?.emit([frame]);
  }
  function wake() {
    if (scheduled || !continuation || parked === void 0) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (parked === void 0 || !continuation?.isIdle()) return;
      const queued = [...pending].filter(([, state]) => state === "queued");
      if (!queued.length) return;
      for (const [id] of queued) pending.set(id, "redriven");
      try {
        void Promise.resolve(continuation.triggerTurn()).catch(() => {
        });
      } catch {
      }
    });
  }
  return {
    /** Reserve before asynchronous child admission, so an intervening agent_settled cannot escape. */
    register(kind, callbackId) {
      if (kind === "larva-subagent-result") pending.set(callbackId, "reserved");
    },
    delivery(callbackId, state) {
      if (state === "delivered" && pending.get(callbackId) === "reserved") {
        pending.set(callbackId, "queued");
        wake();
      }
      if (state === "failed" || state === "suppressed" || state === "stale") {
        pending.delete(callbackId);
        release();
      }
    },
    unbind() {
      continuation = void 0;
    },
    bind(next, getBranch, getActivePersona, idleContinuation) {
      bridge = next;
      continuation = idleContinuation;
      wake();
      branch = getBranch;
      next.configure((record2) => {
        const frame = JSON.parse(record2);
        if (!metadataObject(frame)) return [record2];
        if (getActivePersona && frame.type === "response" && frame.command === "get_state" && frame.success === true && metadataObject(frame.data)) {
          return [JSON.stringify({ ...frame, data: { ...frame.data, persona_id: getActivePersona() } })];
        }
        if (frame.type === "agent_start") parked = void 0;
        if (frame.type !== "agent_settled" || !pending.size) return [record2];
        let assistant = false;
        const entries = branch();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (!metadataObject(e)) continue;
          if (e.type === "message" && metadataObject(e.message) && e.message.role === "assistant") assistant = true;
          const details = e.type === "custom_message" ? e.details : e.type === "custom" ? e.data : void 0;
          if (assistant && e.customType === "larva-subagent-result" && metadataObject(details) && typeof details.callback_id === "string") pending.delete(details.callback_id);
        }
        if (!pending.size) {
          parked = void 0;
          return [record2];
        }
        parked = record2;
        wake();
        return [];
      });
    }
  };
}

// src/runtime/supervisor.ts
var bad = (message) => {
  throw new LarvaError("LARVA_BAD_INPUT", message);
};
var cancelled = (message) => new LarvaError("LARVA_CHILD_CANCELLED", message);
var now = () => (/* @__PURE__ */ new Date()).toISOString();
function keys(value, names) {
  if (!metadataObject(value) || Object.keys(value).some((k) => !names.includes(k))) bad("Invalid or unknown input fields.");
}
async function directory(path, code) {
  try {
    if (isAbsolute4(path) && (await stat5(path)).isDirectory()) return await realpath6(path);
  } catch {
  }
  throw new LarvaError(code, "Workspace must be an existing absolute directory.");
}
async function workspace(home, input, ctx) {
  if (input.task_id !== void 0) {
    const h = await readSessionHeader(home, input.task_id);
    const cwd = await directory(h.cwd, "LARVA_CHILD_START_FAILED");
    if (input.cwd !== void 0 && await directory(input.cwd, "LARVA_BAD_INPUT") !== cwd) bad("Workspace differs from the recorded session.");
    return { cwd, taskId: h.task_id };
  }
  if (input.cwd !== void 0) return { cwd: await directory(input.cwd, "LARVA_BAD_INPUT") };
  if (ctx.surface === "pi") return { cwd: await directory(ctx.cwd, "LARVA_CWD_REQUIRED") };
  try {
    const roots = (await ctx.listRoots?.())?.roots;
    if (Array.isArray(roots) && roots.length === 1 && typeof roots[0]?.uri === "string" && /^file:\/\//i.test(roots[0].uri)) {
      const u = new URL(roots[0].uri);
      if (u.protocol === "file:" && !u.host && !u.search && !u.hash) return { cwd: await directory(fileURLToPath(u), "LARVA_CWD_REQUIRED") };
    }
  } catch {
  }
  throw new LarvaError("LARVA_CWD_REQUIRED", "Provide cwd when there is not exactly one usable local workspace root.");
}
async function lineage(env, root, self) {
  const invalid6 = () => {
    throw new LarvaError("LARVA_CHILD_START_FAILED", "Invalid or over-limit subagent lineage.");
  };
  const rawDepth = env.LARVA_PI_SUBAGENT_DEPTH ?? (env.LARVA_PI_LAUNCHED === "1" ? "1" : "0");
  if (!/^(0|[1-9][0-9]?)$/.test(rawDepth) || env.LARVA_PI_LAUNCHED === "1" && rawDepth === "0") return invalid6();
  const depth = Number(rawDepth);
  const raw = env.LARVA_PI_ANCESTOR_TASK_IDS ?? "[]";
  if (Buffer.byteLength(raw) > 65536) return invalid6();
  let ids;
  try {
    ids = JSON.parse(raw);
  } catch {
    return invalid6();
  }
  if (!Array.isArray(ids) || ids.length > 100) return invalid6();
  const ancestors = /* @__PURE__ */ new Set();
  for (const id of [...ids, ...self !== void 0 && (depth > 0 || isLexicallyContained(root, self)) ? [self] : []]) {
    if (typeof id !== "string" || !isLexicallyContained(root, id) || resolve4(id) !== id || !id.endsWith(".jsonl")) return invalid6();
    try {
      if (join10(await realpath6(dirname5(id)), basename8(id)) !== id || await entryExists(id) && (!(await lstat7(id)).isFile() || await realpath6(id) !== id)) return invalid6();
    } catch {
      return invalid6();
    }
    ancestors.add(id);
  }
  if (ancestors.size > 100 || Buffer.byteLength(JSON.stringify([...ancestors])) > 65536) return invalid6();
  return { depth, ancestors: [...ancestors] };
}
function clearTimers(run) {
  clearTimeout(run.stall);
  clearTimeout(run.watchdog);
}
function clearLive(run) {
  run.activeTools.clear();
  run.s.active_tool = null;
  run.s.live_thinking = false;
}
function applyTelemetry(run, frame) {
  const { s, activeTools } = run;
  switch (frame.type) {
    case "turn_end":
    case "agent_settled": {
      const changed = !!(s.active_tool || s.live_thinking);
      clearLive(run);
      return changed;
    }
    case "message_update": {
      const e = frame.assistantMessageEvent;
      if (!metadataObject(e)) return false;
      if (e.type === "text_delta" && typeof e.delta === "string") {
        s.live_thinking = false;
        s.live_assistant_preview = Array.from(((s.live_assistant_preview ?? "") + e.delta.slice(-1200)).slice(-1200)).slice(-600).join("");
        return true;
      }
      if (e.type === "thinking_start" || e.type === "thinking_end") {
        s.live_thinking = e.type === "thinking_start";
        return true;
      }
      return false;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const { toolCallId, toolName } = frame;
      if (typeof toolCallId !== "string" || typeof toolName !== "string") return false;
      const tool2 = {
        tool_call_id: toolCallId,
        name: toolName,
        status: frame.type === "tool_execution_end" ? frame.isError === true ? "error" : "done" : "running"
      };
      const snapshots = [...s.tool_snapshots ?? []];
      const index = snapshots.findIndex((t) => t.tool_call_id === toolCallId);
      if (index !== -1 || frame.type === "tool_execution_start") {
        const args_preview = frame.args === void 0 ? snapshots[index]?.args_preview : previewToolArgs(frame.args);
        const row = { ...tool2, ...args_preview === void 0 ? {} : { args_preview } };
        if (index !== -1) snapshots[index] = row;
        else snapshots.push(row);
        s.tool_snapshots = snapshots.slice(-25);
      }
      activeTools.delete(toolCallId);
      if (frame.type === "tool_execution_end") {
        if (s.active_tool?.tool_call_id === toolCallId) s.active_tool = [...activeTools.values()].at(-1) ?? null;
      } else {
        activeTools.set(toolCallId, tool2);
        s.active_tool = tool2;
      }
      return true;
    }
    default:
      return false;
  }
}
var SubagentSupervisor = class {
  home;
  barrier = childSettlementBarrier();
  #opts;
  #env;
  #baseCwd = process.cwd();
  #root;
  #personas;
  #leases;
  #active = /* @__PURE__ */ new Map();
  // Includes startup and unconfirmed ownership.
  #outbox = new RunOutbox();
  #failures = [];
  #observers = /* @__PURE__ */ new Set();
  #callbacks = /* @__PURE__ */ new Map();
  #binding;
  #reloading = false;
  #closing = false;
  #profile;
  #generation = 0;
  #telemetryTimer;
  constructor(options = {}) {
    this.#opts = options;
    this.#env = options.env ?? process.env;
    this.home = options.home ?? resolveLarvaHome(this.#env);
    this.#root = getLarvaHomePaths(this.home).sessions;
    this.#leases = createSessionLeaseStore(this.home, capsule_exports);
    this.#personas = new PersonaStore(this.home);
    this.#profile = this.#env.LARVA_PI_MODEL_MAP_PROFILE ?? "default";
  }
  beginReload() {
    this.#reloading = true;
    this.#binding = void 0;
    this.barrier.unbind();
  }
  rebind(binding) {
    this.#binding = binding;
    this.#reloading = false;
    const session = binding.childSession;
    if (session) this.barrier.bind(session.bridge, () => session.branch(), () => session.activePersona(), session);
    this.#deliver();
  }
  /** Observe lifecycle and batched live updates without resetting child deadlines. */
  subscribe(onChange) {
    this.#observers.add(onChange);
    return () => this.#observers.delete(onChange);
  }
  #notify() {
    clearTimeout(this.#telemetryTimer);
    this.#telemetryTimer = void 0;
    for (const f of [...this.#observers]) {
      try {
        f();
      } catch {
      }
    }
  }
  #deliver() {
    for (const [s, key] of this.#callbacks) {
      if (this.#reloading) return;
      this.#callbacks.delete(s);
      if (s.output_state === "evicted" || !this.#binding || this.#binding.sessionKey !== key) {
        this.barrier.delivery(s.run_epoch, "stale");
        continue;
      }
      const binding = this.#binding;
      try {
        void Promise.resolve(binding.steer({ customType: "larva-subagent-result", details: { ...terminalOutput(s), callback_id: s.run_epoch } })).then(() => this.barrier.delivery(s.run_epoch, "delivered"), () => this.barrier.delivery(s.run_epoch, "failed"));
      } catch {
        this.barrier.delivery(s.run_epoch, "failed");
      }
    }
  }
  #taskSyntax(id) {
    if (typeof id !== "string" || !isAbsolute4(id) || resolve4(id) !== id || id.includes("\0") || !id.endsWith(".jsonl")) bad("Expected a canonical .jsonl task_id.");
  }
  #ids(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 25 || new Set(ids).size !== ids.length) bad("Expected 1..25 distinct task_ids.");
    for (const id of ids) this.#taskSyntax(id);
  }
  async #map(profile) {
    return loadDiskModelMap(this.home, modelMapProfilePath(this.home, profile));
  }
  async spawn(input, ctx) {
    const epoch = mintRunEpoch(), parentSession = ctx.surface === "pi" ? ctx.sessionKey : void 0;
    if (ctx.surface === "pi" && this.#env.LARVA_PI_LAUNCHED === "1") this.barrier.register("larva-subagent-result", epoch);
    try {
      keys(input, [
        "persona_id",
        "task",
        "task_id",
        "cwd",
        "no_progress_timeout_ms",
        "stall_alert_ms",
        ...ctx.surface === "mcp" ? ["parent_persona_id", "wait_for_completion"] : []
      ]);
      if (!isValidPersonaId(input.persona_id) || typeof input.task !== "string" || !input.task.trim() || input.cwd !== void 0 && (typeof input.cwd !== "string" || !isAbsolute4(input.cwd) || input.cwd.includes("\0")) || input.parent_persona_id !== void 0 && !isValidPersonaId(input.parent_persona_id) || input.wait_for_completion !== void 0 && typeof input.wait_for_completion !== "boolean") bad("Invalid spawn input.");
      resolveWatchdogTimeouts(input, { stall_alert_ms: 0 });
      if (input.task_id !== void 0) this.#taskSyntax(input.task_id);
      const { cwd, taskId } = await workspace(this.home, input, ctx);
      const root = await canonicalPath(this.#root);
      const chain = await lineage(this.#env, root, ctx.selfTaskId ?? this.#env.LARVA_PI_TASK_ID);
      const config = await loadLarvaConfig(this.home, async (p) => await entryExists(p) ? readBoundedRegularText2(p) : void 0);
      if (config.subagent.max_depth !== void 0 && chain.depth + 1 > config.subagent.max_depth) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Configured maximum depth exceeded.");
      const descendant = this.#env.LARVA_PI_LAUNCHED === "1" || chain.depth > 0;
      if (ctx.surface === "pi" && !descendant && !ctx.activePersona) throw new LarvaError("LARVA_NO_ACTIVE_PERSONA", "No active persona.");
      const parent = descendant ? this.#env.LARVA_PI_INITIAL_PERSONA_ID : ctx.surface === "mcp" ? input.parent_persona_id ?? this.#env.LARVA_MCP_PARENT_PERSONA?.trim() : void 0;
      const parentSpec = parent ? await this.#personas.get(parent).catch((e) => {
        if (descendant) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Launch-bound persona unavailable.");
        throw e;
      }) : void 0;
      const authority = { env: this.#env, parent_persona_id: input.parent_persona_id, resolvePersona: (id2) => id2 === parent ? parentSpec : void 0 };
      assertCanSpawnTarget(evaluateEffectiveCanSpawn(ctx.surface === "pi" ? {
        ...authority,
        surface: "pi",
        isLaunchedChild: descendant,
        activePersona: ctx.activePersona,
        rootSessionSpawn: config.subagent.root_session_spawn
      } : { ...authority, surface: "mcp", depth: chain.depth }), input.persona_id);
      const spec = await this.#personas.get(input.persona_id);
      const id = taskId ?? join10(root, `${randomUUID4()}.jsonl`);
      if (chain.ancestors.includes(id) || this.#active.has(id)) throw new LarvaError("LARVA_SESSION_BUSY", "Session is already owned.");
      if (this.#closing || this.#active.size >= (config.subagent.max_active_runs ?? Infinity)) throw new LarvaError("LARVA_CHILD_START_FAILED", "Supervisor cannot admit another child.");
      const started_at = now();
      const run = {
        s: {
          task_id: id,
          run_epoch: epoch,
          cwd,
          started_at,
          updated_at: started_at,
          persona_id: spec.id,
          phase: "starting",
          status: "running",
          output_state: "pending",
          thinking: spec.thinking,
          task_preview: Array.from(input.task.replace(/\s+/g, " ").trim().slice(0, 280)).slice(0, 140).join(""),
          active_tool: null,
          live_thinking: false,
          live_assistant_preview: "",
          tool_snapshots: []
        },
        activeTools: /* @__PURE__ */ new Map(),
        accepted: Promise.withResolvers(),
        cleaned: Promise.withResolvers(),
        prompted: false,
        parent: parentSession
      };
      this.#active.set(id, run);
      void this.#drive(run, spec, input, chain, config);
      this.#notify();
      const accepted = await run.accepted.promise;
      if (!input.wait_for_completion) return accepted;
      await this.#observe(() => isTerminal(run.s.status) && run.s.output_state !== "pending");
      return terminalOutput(run.s);
    } catch (e) {
      this.barrier.delivery(epoch, "suppressed");
      const failure = e instanceof LarvaError ? e : new LarvaError("LARVA_CHILD_START_FAILED", "Could not start the Pi child.");
      this.#failures.unshift({
        startup_id: epoch,
        persona_id: typeof input?.persona_id === "string" ? input.persona_id : "",
        status: "failed",
        phase: "startup_failed",
        updated_at: now(),
        error: toErrorEnvelope(failure).error
      });
      this.#failures.length = Math.min(25, this.#failures.length);
      throw failure;
    }
  }
  async #drive(run, spec, input, chain, config) {
    const s = run.s, id = s.task_id;
    let lease, box, manifest;
    let accepted = false, failure;
    const check = () => {
      if (run.abort) throw run.abort;
    };
    const times = resolveWatchdogTimeouts(input, config.subagent);
    const telemetry = (frame) => {
      if (s.status !== "running" || !applyTelemetry(run, frame)) return;
      this.#telemetryTimer ??= setTimeout(() => this.#notify(), 50);
    };
    const progress = () => {
      if (!accepted || s.status !== "running") return;
      const phaseChanged = s.phase !== "waiting_for_child";
      clearTimers(run);
      s.phase = "waiting_for_child";
      s.updated_at = now();
      if (times.stall_alert_ms) run.stall = setTimeout(() => {
        s.phase = "stall_suspected";
        s.updated_at = now();
        if (run.parent !== void 0 && this.#binding?.sessionKey === run.parent && !this.#reloading) {
          try {
            void Promise.resolve(this.#binding.steer({ customType: "larva-subagent-alert", details: structuredClone(s) })).catch(() => {
            });
          } catch {
          }
        }
        this.#notify();
      }, times.stall_alert_ms);
      run.watchdog = setTimeout(() => this.#abort(run, "Child exceeded its no-progress timeout."), times.no_progress_timeout_ms);
      if (phaseChanged) this.#notify();
    };
    try {
      lease = await this.#leases.acquire(id);
      if (input.task_id !== void 0) {
        const h = await readSessionHeader(this.home, id);
        if (await directory(h.cwd, "LARVA_CHILD_START_FAILED") !== s.cwd) throw new LarvaError("LARVA_SESSION_INVALID", "Session changed during admission.");
      }
      check();
      const installation = await discoverPiInstallation(this.#env);
      let generation = this.#generation;
      let route = resolveModelRoute(spec.model, await this.#map(this.#profile));
      s.model = `${route.provider}/${route.model_id}`;
      this.#notify();
      const basePiAgentDir = this.#opts.piAgentDir === void 0 ? resolveBasePiAgentDir(this.#env, void 0, this.#baseCwd) : resolve4(this.#baseCwd, this.#opts.piAgentDir);
      box = await createCapsule({
        home: this.home,
        pi_agent_dir: basePiAgentDir,
        user_home: this.#env.HOME,
        extension_sources: config.subagent.extension_sources
      });
      const parent = this.#env.LARVA_PI_CAPSULE_ROOT;
      if (parent !== void 0) {
        if (!capsuleParentPid(this.home, parent)) throw new LarvaError("LARVA_CHILD_START_FAILED", "Invalid parent capsule.");
        manifest = join10(parent, "descendants", `${basename8(box.root)}.json`);
        await writeMetadata(manifest, { capsule_root: box.root });
      }
      await lease.markSpawning(box.root);
      check();
      const rpc = run.rpc = launchChild({
        piScript: installation.path,
        extension: this.#opts.extension ?? fileURLToPath(new URL("./pi-extension.js", import.meta.url)),
        preload: this.#opts.preload ?? fileURLToPath(new URL("./child-rpc-preload.mjs", import.meta.url)),
        extensionSources: box.extension_sources,
        env: { ...this.#env, LARVA_PI_TASK_ID: id, LARVA_PI_MODEL_MAP_PROFILE: this.#profile },
        home: this.home,
        basePiAgentDir,
        capsule: box.root,
        agentDir: box.agent_dir,
        cwd: s.cwd,
        taskId: id,
        depth: chain.depth + 1,
        ancestors: chain.ancestors,
        persona: spec.id,
        route,
        thinking: spec.thinking
      }, progress, telemetry);
      if (rpc.pid === void 0) throw new LarvaError("LARVA_CHILD_START_FAILED", "Child did not start.");
      await lease.markRunning(rpc.pid);
      if (manifest) await writeMetadata(manifest, { capsule_root: box.root, pid: rpc.pid });
      check();
      if (input.task_id !== void 0) await rpc.resume(id);
      for (; ; ) {
        check();
        if (generation !== this.#generation) {
          generation = this.#generation;
          route = resolveModelRoute(spec.model, await this.#map(this.#profile));
          await rpc.setRoute(route, spec.thinking);
        }
        await rpc.verify(route, spec.thinking, id, spec.id);
        check();
        if (generation === this.#generation) break;
      }
      s.model = `${route.provider}/${route.model_id}`;
      run.prompted = true;
      await rpc.prompt(input.task);
      check();
      accepted = true;
      s.status = "running";
      progress();
      run.accepted.resolve({ status: "accepted", task_id: id, run_epoch: s.run_epoch, cwd: s.cwd });
      await rpc.settled;
      check();
      this.#finalize(run, "success");
      void this.#publish(run, await rpc.output());
    } catch (e) {
      failure = run.abort ?? e;
      if (accepted && !isTerminal(s.status)) {
        this.#finalize(run, failure instanceof LarvaError && failure.code === "LARVA_CHILD_CANCELLED" ? "cancelled" : "failed", failure);
        void this.#publish(run, "");
      } else if (accepted) void this.#publish(run, void 0);
    } finally {
      clearTimers(run);
      const settleOwnership = async () => {
        try {
          if (run.rpc && !await run.rpc.stop(!!failure) && !(run.rpc.pid && pidExited(run.rpc.pid))) throw new Error("Unconfirmed child exit.");
          if (box) {
            if (!(await inspectCapsule(this.home, box.root, run.rpc?.pid, "live"))?.all_exited) throw new Error("Unconfirmed capsule exit.");
            const staged = join10(this.#root, `${basename8(id)}.lock`, "capsule");
            await rename5(box.root, staged);
            try {
              await lease.release();
            } catch (e) {
              await rename5(staged, box.root);
              throw e;
            }
          } else await lease?.release();
          if (manifest) await rm3(manifest, { force: true }).catch(() => {
          });
          this.#active.delete(id);
          return true;
        } catch {
          await lease?.markUnreconciled().catch(() => {
          });
          return false;
        }
      };
      const confirmed = await settleOwnership();
      if (!confirmed) {
        let checking;
        run.reconcile = () => checking ??= settleOwnership().finally(() => {
          checking = void 0;
        });
      }
      run.cleaned.resolve(confirmed);
      if (!accepted) {
        clearLive(run);
        s.status = s.phase = run.abort ? "cancelled" : "failed";
        s.error = toErrorEnvelope(failure).error;
        Object.assign(s, { output_state: "inline", result_text: "" });
        run.accepted.reject(failure ?? new LarvaError("LARVA_CHILD_START_FAILED", "Pi startup failed."));
      }
      this.#notify();
    }
  }
  #finalize(run, status, error) {
    clearTimers(run);
    clearLive(run);
    Object.assign(run.s, { status, phase: status, updated_at: now() }, error ? { error: toErrorEnvelope(error).error } : {});
    this.#outbox.retain(run.s);
    this.#notify();
  }
  async #publish(run, text2) {
    let output;
    try {
      if (text2 === void 0) throw new Error();
      output = await (this.#opts.writeOutput ?? writeOutputSnapshot)(this.home, text2);
    } catch {
      output = { output_state: "delivery_failed", output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Could not deliver child output." } };
    }
    this.#outbox.publish(run.s, output);
    this.#notify();
    if (run.parent !== void 0) {
      await run.cleaned.promise;
      if (this.#closing || run.s.output_state === "evicted") {
        this.barrier.delivery(run.s.run_epoch, "stale");
        return;
      }
      for (const s of this.#callbacks.keys()) if (s.output_state === "evicted") {
        this.#callbacks.delete(s);
        this.barrier.delivery(s.run_epoch, "stale");
      }
      this.#callbacks.set(run.s, run.parent);
      this.#deliver();
    }
  }
  #abort(run, reason) {
    if (run.abort || isTerminal(run.s.status)) return;
    clearTimers(run);
    run.abort = cancelled(reason);
    run.s.status = run.s.phase = "cancelling";
    run.s.updated_at = now();
    void run.rpc?.stop(true);
    this.#notify();
  }
  #lookup(id) {
    return this.#active.get(id)?.s ?? this.#outbox.lookup(id);
  }
  async #admitExactHandle(id) {
    this.#taskSyntax(id);
    try {
      await resolveCanonicalSessionPath(this.home, id);
      return true;
    } catch (error) {
      if (error instanceof LarvaError && error.code === "LARVA_SESSION_NOT_FOUND") return false;
      throw error;
    }
  }
  async pinned(taskId, epoch) {
    await this.#admitExactHandle(taskId);
    const s = this.#active.get(taskId)?.s;
    return structuredClone((s?.run_epoch === epoch ? s : this.#outbox.lookup(taskId, epoch)) ?? { task_id: taskId, run_epoch: epoch, output_state: "evicted" });
  }
  async #observe(done, deadline) {
    if (done() || deadline !== void 0 && deadline <= performance.now()) return;
    let timer;
    const result2 = Promise.withResolvers();
    const notify = () => {
      if (done()) result2.resolve();
    };
    const unsubscribe = this.subscribe(notify);
    if (deadline !== void 0) timer = setTimeout(result2.resolve, Math.max(0, deadline - performance.now()));
    try {
      await result2.promise;
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }
  async wait(input, surface = "mcp") {
    const start = performance.now();
    keys(input, ["task_ids", "return_when", "timeout_ms"]);
    this.#ids(input.task_ids);
    const { return_when: mode = "all", timeout_ms: timeout = 1e4 } = input;
    if (!["all", "any", "first_error"].includes(mode) || !Number.isInteger(timeout) || timeout < 0 || timeout > 864e5) bad("Invalid wait condition or timeout.");
    const bound = input.task_ids.map((id) => this.#lookup(id) ?? bad("No observed run for requested task_id."));
    const ready = () => mode === "all" ? bound.every((s) => isTerminal(s.status)) : bound.some((s) => mode === "any" ? isTerminal(s.status) : s.status === "failed" || s.status === "cancelled");
    await this.#observe(() => ready() && (surface === "pi" || bound.every((s) => !isTerminal(s.status) || s.output_state !== "pending")), start + timeout);
    const runs = structuredClone(bound);
    const result2 = { runs, ready: ready(), timed_out: !ready() };
    return surface === "pi" ? result2 : { ...result2, terminal_outputs: Object.fromEntries(runs.filter((s) => isTerminal(s.status)).map((s) => [s.task_id, terminalOutput(s)])) };
  }
  async cancel(input) {
    keys(input, ["task_ids", "reason", "expected_run_epochs"]);
    this.#ids(input.task_ids);
    if (typeof input.reason !== "string" || !input.reason.trim() || [...input.reason].length > 500) bad("Invalid cancel reason.");
    const guards = input.expected_run_epochs;
    if (guards !== void 0 && (!metadataObject(guards) || Object.entries(guards).some(([id, epoch]) => !input.task_ids.includes(id) || typeof epoch !== "string" || !epoch))) bad("Invalid expected_run_epochs.");
    const results = await Promise.all(input.task_ids.map(async (task_id) => {
      const run = this.#active.get(task_id), s = this.#lookup(task_id);
      if (!s) return { task_id, outcome: "not_found" };
      if (!run || guards?.[task_id] !== void 0 && guards[task_id] !== s.run_epoch) return { task_id, outcome: "already_terminal" };
      const terminal = isTerminal(s.status);
      this.#abort(run, input.reason.trim());
      return { task_id, outcome: !await (run.reconcile?.() ?? run.cleaned.promise) ? "cleanup_unconfirmed" : terminal ? "already_terminal" : "cancelled" };
    }));
    return { results, isError: results.some((r) => r.outcome === "cleanup_unconfirmed") };
  }
  async status(input = {}) {
    keys(input, ["task_id", "scope", "limit"]);
    if (input.task_id !== void 0) {
      if (input.scope !== void 0 || input.limit !== void 0) bad("Exact status does not take scope or limit.");
      const exists = await this.#admitExactHandle(input.task_id);
      const s = this.#lookup(input.task_id);
      if (s) return { runs: [structuredClone(s)], startup_failures: [] };
      if (!exists) throw new LarvaError("LARVA_SESSION_NOT_FOUND", "Session transcript is missing.");
      return { runs: [], startup_failures: [], disk_sessions: [await readDiskSession(this.home, input.task_id, this.#leases)] };
    }
    const { scope = "recent", limit = 10 } = input;
    if (!["recent", "active", "disk"].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 25) bad("Invalid status scope or limit.");
    if (scope === "disk") return { runs: [], startup_failures: [], disk_sessions: (await scanDiskSessions(this.home, this.#leases)).slice(0, limit) };
    const active = [...this.#active.values()].map((r) => r.s);
    const runs = scope === "active" ? active : [.../* @__PURE__ */ new Set([...active, ...this.#outbox.recent()])];
    return structuredClone({ runs: runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit), startup_failures: this.#failures.slice(0, limit) });
  }
  /** Capture the fleet BEFORE the parent's asynchronous route transaction, then commit only on parent success. */
  captureFleet() {
    return [...this.#active.values()].map(({ s }) => ({ task_id: s.task_id, run_epoch: s.run_epoch }));
  }
  async commitProfile(profile, fleet = this.captureFleet()) {
    if (profile !== "default" && !isValidProfileName(profile)) bad("Invalid profile name.");
    this.#profile = profile;
    ++this.#generation;
    return Promise.all(fleet.map(async ({ task_id, run_epoch }) => {
      const run = this.#active.get(task_id);
      let state;
      if (!run || run.s.run_epoch !== run_epoch || isTerminal(run.s.status)) state = "ended_during_switch";
      else {
        const fenced = !run.prompted;
        try {
          await run.accepted.promise;
          state = isTerminal(run.s.status) ? "ended_during_switch" : fenced ? "fenced_for_startup" : "in_flight_until_run_settles";
        } catch {
          state = "failed";
        }
      }
      return { task_id, run_epoch, state };
    }));
  }
  /** EOF/signals are handled by the transport. Never terminate the host from a tool call. */
  async shutdown() {
    this.#closing = true;
    const owned = [...this.#active.values()];
    for (const run of owned) this.#abort(run, "Supervisor shutdown.");
    const settled = (await Promise.all(owned.map((r) => r.reconcile?.() ?? r.cleaned.promise))).every(Boolean);
    const host = process;
    if (settled && host[shared] === this) delete host[shared];
    return { settled };
  }
};
var shared = /* @__PURE__ */ Symbol.for("larva.0.9.native-subagent-supervisor");

// src/activity/inspector.ts
import { createHash as createHash5 } from "node:crypto";
import { constants as constants7 } from "node:fs";
import { open as open6, stat as stat6 } from "node:fs/promises";
import { isAbsolute as isAbsolute5, normalize as normalize2 } from "node:path";
var RESPONSE_BYTES = 8192;
var READ_BYTES = 64 * 1024;
var RECORD_BYTES = 8 * 1024 * 1024;
var SNAPSHOT_BYTES = 128 * 1024 * 1024;
var INDEX_UNITS = 48 * 1024 * 1024;
var JOIN_STEPS = 1e6;
var decoder3 = new TextDecoder("utf-8", { fatal: true });
var hash = (value) => createHash5("sha256").update(value).digest("hex");
var object3 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var nonempty = (value) => typeof value === "string" && value.length > 0;
var uint = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function badInput(message) {
  throw new LarvaError("LARVA_BAD_INPUT", message);
}
function invalidSession(message) {
  throw new LarvaError("LARVA_SESSION_INVALID", message);
}
function stale() {
  return invalidSession("The recorded session snapshot changed.");
}
function timestamp(value) {
  if (typeof value !== "string" || value.length > 128) return;
  const match = /^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match) return;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return ms;
}
var queryKeys = {
  task_id: true,
  limit: true,
  cursor: true,
  tool_name: true,
  since_timestamp: true,
  until_timestamp: true,
  tool_call_id: true,
  disambiguation_index: true,
  entry_id: true,
  result_index: true,
  segment_part: true,
  offset: true,
  length: true,
  source_version: true
};
var compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
var encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token2(value, extraKeys) {
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    badInput("Invalid activity continuation token.");
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    badInput("Invalid activity continuation token.");
  }
  const keys2 = ["file", "end", "digest", ...extraKeys];
  if (!object3(data) || Object.keys(data).some((key) => !keys2.includes(key)) || !uint(data.end) || typeof data.file !== "string" || !/^[a-f0-9]{64}$/.test(data.file) || typeof data.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.digest)) {
    badInput("Invalid activity continuation fields.");
  }
  return { ...data, file: data.file, end: data.end, digest: data.digest };
}
function parse2(input) {
  if (!object3(input) || Object.keys(input).some((key) => !Object.hasOwn(queryKeys, key))) {
    badInput("Unknown activity parameter; supply task_id, not session_path.");
  }
  const {
    task_id,
    limit = 5,
    cursor,
    tool_name,
    since_timestamp,
    until_timestamp,
    tool_call_id,
    disambiguation_index,
    entry_id,
    result_index,
    segment_part,
    offset = 0,
    length = 2e3,
    source_version
  } = input;
  if (!nonempty(task_id) || !isAbsolute5(task_id) || normalize2(task_id) !== task_id || !task_id.endsWith(".jsonl") || task_id.includes("\0") || Buffer.byteLength(task_id) > 4096) {
    badInput("task_id must be a canonical absolute .jsonl path.");
  }
  const identifier = (value) => {
    if (value === void 0) return;
    if (!nonempty(value) || Buffer.byteLength(value) > 8192) badInput("Invalid activity identifier.");
    return value;
  };
  const tool2 = identifier(tool_name), callId = identifier(tool_call_id), entryId = identifier(entry_id);
  if (!uint(limit) || limit < 1 || limit > 20 || !uint(length) || length < 1 || length > 4e3 || !uint(offset) || disambiguation_index !== void 0 && !uint(disambiguation_index) || result_index !== void 0 && !uint(result_index)) badInput("Invalid activity limit, offset, length or index.");
  if (entry_id !== void 0 && disambiguation_index !== void 0) badInput("Use only one call selector.");
  if (segment_part !== void 0 && segment_part !== "args" && segment_part !== "result") badInput("Invalid segment_part.");
  const since = timestamp(since_timestamp), until = timestamp(until_timestamp);
  if (since_timestamp !== void 0 && since === void 0 || until_timestamp !== void 0 && until === void 0 || since !== void 0 && until !== void 0 && since > until) badInput("Expected an ordered range of timezone-qualified ISO timestamps.");
  if (tool_call_id === void 0) {
    if ([entry_id, disambiguation_index, result_index, segment_part, input.offset, input.length, source_version].some((value) => value !== void 0)) badInput("Detail parameters require tool_call_id.");
  } else if ([cursor, tool_name, since, until].some((value) => value !== void 0)) {
    badInput("Exact lookup does not take listing parameters.");
  }
  const filter = hash(JSON.stringify([tool_name ?? null, since ?? null, until ?? null]));
  let page;
  if (cursor !== void 0) {
    const data = token2(cursor, ["filter", "base", "after"]);
    const { base, after } = data;
    if (data.filter !== filter || !uint(base) || base > data.end || after !== void 0 && (!Array.isArray(after) || after.length !== 3 || !after.every(uint) || after[0] >= data.end || after[1] > after[0]) || after === void 0 && base !== data.end) {
      badInput("Cursor does not match this activity query or position.");
    }
    page = {
      file: data.file,
      digest: data.digest,
      end: data.end,
      filter,
      base,
      after: after === void 0 ? void 0 : [after[0], after[1], after[2]]
    };
  }
  let version;
  if (source_version !== void 0) {
    const data = token2(source_version, ["selection"]);
    if (typeof data.selection !== "string" || !/^[a-f0-9]{64}$/.test(data.selection)) badInput("Invalid source_version selection.");
    version = { file: data.file, digest: data.digest, end: data.end, selection: data.selection };
  }
  if (offset > 0 && !version) badInput("Continued segments require source_version.");
  const part = segment_part ?? "result";
  return {
    path: task_id,
    limit,
    page,
    version,
    tool: tool2,
    since,
    until,
    filter,
    callId,
    callIndex: disambiguation_index,
    entryId,
    resultIndex: result_index,
    part,
    offset,
    length
  };
}
function record(bytes) {
  let text2;
  try {
    text2 = decoder3.decode(bytes);
  } catch {
    return { kind: "invalid_utf8", message: "Invalid UTF-8 record." };
  }
  try {
    return { value: JSON.parse(text2) };
  } catch {
    return { kind: "malformed_json", message: "Malformed JSON record." };
  }
}
function substantialDetails(details) {
  if (object3(details)) return Object.entries(details).some(([key, value]) => key !== "truncated" && key !== "fullOutputPath" && value != null && (key !== "truncation" || !object3(value) || Object.keys(value).some((key2) => key2 !== "truncated")));
  if (typeof details === "string" || Array.isArray(details)) return details.length > 0;
  return typeof details === "number" || typeof details === "boolean";
}
var detached = (value) => Buffer.from(value, "utf16le").toString("utf16le");
function resultPreview(content, details, isError) {
  let text2 = "", chars = 0, pieces = 0;
  let hasImage = false, nonText = false;
  for (const part of typeof content === "string" ? [content] : content) {
    const value = typeof part === "string" ? part : object3(part) && part.type === "text" ? part.text : void 0;
    if (typeof value === "string") {
      if (pieces++ && chars++ < 500) text2 += "\n";
      text2 += value.slice(0, Math.max(0, 500 - chars));
      chars += value.length;
    } else if (object3(part) && part.type === "image") hasImage = true;
    else if (part != null) nonText = true;
  }
  const top = object3(details) ? details.truncated : void 0;
  const nested = object3(details) && object3(details.truncation) ? details.truncation.truncated : void 0;
  const upstream = top === true || nested === true ? true : top === false || nested === false ? false : void 0;
  const hasDetails = substantialDetails(details);
  return {
    result: detached(text2),
    is_error: isError,
    result_truncated: chars > 500 || hasImage || nonText || hasDetails || void 0,
    has_image: hasImage || void 0,
    non_text: nonText || void 0,
    has_details: hasDetails || void 0,
    upstream_truncated: upstream
  };
}
async function readSnapshot(file, size, q, prior) {
  const pagingBase = q.page?.base ?? 0;
  if (size > SNAPSHOT_BYTES) invalidSession("Activity snapshot exceeds the inspection byte limit.");
  const calls = [], results = [];
  const byId = /* @__PURE__ */ new Map(), entries = /* @__PURE__ */ new Map();
  const diagnostics = [];
  let diagnosticCount = 0, budget = INDEX_UNITS;
  const diagnose = (kind, message, location) => {
    diagnosticCount++;
    if (diagnostics.length < 5) diagnostics.push({
      kind,
      message,
      byte_offset: location.byte_offset,
      line_byte_length: location.line_byte_length,
      line_number: location.line_number,
      content_index: location.content_index
    });
  };
  const charge = (...values) => {
    budget -= 128;
    for (const value of values) budget -= 2 * (value?.length ?? 0);
    if (budget < 0) invalidSession("Activity snapshot exceeds the inspection index limit.");
  };
  let sessionId;
  const accept = (parts2, location) => {
    const bytes = parts2.length === 1 ? parts2[0] : parts2.length > 1 ? Buffer.concat(parts2, location.line_byte_length) : void 0;
    const parsed = bytes ? record(bytes) : { kind: "oversized_record", message: "Record exceeds the inspection byte limit." };
    if (!("value" in parsed)) {
      if (location.line_number === 1) invalidSession("Invalid Pi session header.");
      diagnose(parsed.kind, parsed.message, location);
      return;
    }
    const row = parsed.value;
    if (location.line_number === 1) {
      if (!object3(row) || row.type !== "session" || row.version !== 2 && row.version !== 3 || !nonempty(row.id)) {
        invalidSession("Expected a Pi version 2 or 3 session header with an ID.");
      }
      sessionId = row.id;
      return;
    }
    if (!object3(row)) {
      diagnose("malformed_record", "Record must be an object.", location);
      return;
    }
    if (nonempty(row.id)) location.entry_id = row.id;
    if (typeof row.parentId === "string" || row.parentId === null) location.parent_id = row.parentId;
    const entry = { location, calls: [] };
    if (location.entry_id !== void 0) {
      charge(location.entry_id, location.parent_id);
      const group = entries.get(location.entry_id);
      if (group) group.push(entry);
      else entries.set(location.entry_id, [entry]);
    }
    if (row.type !== "message") return;
    const m = row.message;
    if (!object3(m)) {
      diagnose("malformed_record", "Missing message payload.", location);
      return;
    }
    if (m.role !== "assistant" && m.role !== "toolResult") return;
    const time = timestamp(row.timestamp);
    if (!location.entry_id || time === void 0 || row.parentId !== void 0 && location.parent_id === void 0) {
      diagnose("malformed_provenance", "Missing or invalid recorded provenance.", location);
    }
    const provenance = {
      location,
      time,
      timestamp: time === void 0 ? void 0 : String(row.timestamp),
      messageTime: typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : void 0
    };
    let digest;
    const recordDigest = (id) => id === q.callId && bytes ? digest ??= createHash5("sha256").update(bytes).digest("hex") : void 0;
    if (m.role === "assistant") {
      if (!Array.isArray(m.content)) {
        diagnose("malformed_record", "Assistant content must be an array.", location);
        return;
      }
      for (const [contentIndex, block] of m.content.entries()) {
        if (!object3(block) || block.type !== "toolCall") continue;
        const callLocation = { ...location, content_index: contentIndex };
        if (!nonempty(block.id) || !nonempty(block.name) || !Object.hasOwn(block, "arguments")) {
          diagnose("malformed_record", "Tool call requires an ID, name and recorded arguments.", callLocation);
          continue;
        }
        const group = byId.get(block.id) ?? [];
        const action = detached(block.name.length >= 201 ? block.name.slice(0, 201) : `${block.name} ${serialize(block.arguments).slice(0, 200 - block.name.length)}`);
        charge(block.id, block.name, provenance.timestamp, action);
        const call = {
          ...provenance,
          location: callLocation,
          id: block.id,
          name: block.name,
          index: group.length,
          action,
          recordDigest: recordDigest(block.id),
          results: [],
          uncertain: 0
        };
        if (!group.length) byId.set(call.id, group);
        group.push(call);
        calls.push(call);
        entry.calls.push(call);
      }
    } else if (nonempty(m.toolCallId) && nonempty(m.toolName) && (typeof m.content === "string" || Array.isArray(m.content)) && (m.isError === void 0 || typeof m.isError === "boolean")) {
      const preview = resultPreview(m.content, m.details, m.isError);
      charge(m.toolCallId, m.toolName, provenance.timestamp, preview.result);
      results.push({ ...provenance, id: m.toolCallId, name: m.toolName, preview, recordDigest: recordDigest(m.toolCallId) });
    } else diagnose("malformed_record", "Tool result requires an ID, name, content and an optional boolean error marker.", location);
  };
  let hasher = createHash5("sha256"), pendingHash;
  let pos = 0, end = 0, line = 0, pending = 0, priorVerified = !prior, sawBase = pagingBase === 0;
  let parts = [];
  while (pos < size) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, size - pos));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, pos);
    if (bytesRead === 0) stale();
    const chunk = buffer.subarray(0, bytesRead);
    for (let from = 0; from < bytesRead; ) {
      const nl = chunk.indexOf(10, from);
      const next = nl === -1 ? bytesRead : nl + 1;
      const piece = chunk.subarray(from, next);
      pending += piece.length;
      if (nl === -1) (pendingHash ??= hasher.copy()).update(piece);
      else {
        if (pendingHash) {
          hasher = pendingHash;
          pendingHash = void 0;
        }
        hasher.update(piece);
      }
      if (pending <= RECORD_BYTES) parts.push(piece);
      else parts = [];
      if (nl !== -1) {
        const location = { byte_offset: end, line_number: ++line, line_byte_length: pending };
        end = pos + next;
        if (end === pagingBase) sawBase = true;
        if (!priorVerified && prior && end >= prior.end) {
          if (end !== prior.end || hasher.copy().digest("hex") !== prior.digest) stale();
          priorVerified = true;
        }
        accept(parts, location);
        pending = 0;
        parts = [];
      }
      from = next;
    }
    pos += bytesRead;
  }
  if (!priorVerified) stale();
  if (!sawBase) badInput("Cursor base is not a recorded line boundary.");
  if (!sessionId) invalidSession("No complete Pi session header.");
  if (pending) diagnose(
    "unterminated_tail",
    "Pending tail has no terminating newline.",
    { byte_offset: end, line_number: line + 1, line_byte_length: pending }
  );
  return {
    sessionId,
    end,
    digest: hasher.digest("hex"),
    calls,
    results,
    byId,
    entries,
    diagnosticCount,
    diagnostics
  };
}
function serialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return invalidSession("Recorded payload exceeds the supported JSON nesting depth.");
  }
}
async function prefixDigest(file, end) {
  const buffer = Buffer.allocUnsafe(READ_BYTES), hasher = createHash5("sha256");
  for (let position = 0; position < end; ) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
    if (!bytesRead) stale();
    hasher.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hasher.digest("hex");
}
function joinResults(snapshot, q, onResult) {
  let remaining = JOIN_STEPS;
  const step = () => {
    if (--remaining < 0) invalidSession("Activity association exceeds the inspection work limit.");
  };
  for (const result2 of snapshot.results) {
    if (q.callId !== void 0 && q.callId !== result2.id || q.tool !== void 0 && q.tool !== result2.name) continue;
    const group = snapshot.byId.get(result2.id);
    if (!group) continue;
    const matches2 = (call) => call.name === result2.name && call.location.byte_offset < result2.location.byte_offset;
    let assigned;
    if (group.length === 1) {
      if (matches2(group[0])) assigned = group[0];
      else continue;
    } else {
      let child = result2.location;
      while (typeof child.parent_id === "string") {
        step();
        const candidates2 = snapshot.entries.get(child.parent_id);
        const first = candidates2?.[0];
        if (!first || first.location.byte_offset >= child.byte_offset || candidates2?.[1] && candidates2[1].location.byte_offset < child.byte_offset) break;
        let count = 0;
        for (const call of first.calls) {
          step();
          if (call.id === result2.id && matches2(call)) {
            assigned = call;
            count++;
          }
        }
        if (count > 1) {
          assigned = void 0;
          break;
        }
        if (count === 1) break;
        child = first.location;
      }
    }
    if (assigned) {
      assigned.results.push(result2);
      onResult?.(assigned, result2, false);
    } else {
      for (const call of group) {
        step();
        if (!matches2(call)) continue;
        call.uncertain++;
        call.results.push(result2);
        onResult?.(call, result2, true);
      }
    }
  }
}
function diagnosticsFor(snapshot) {
  const { diagnosticCount, diagnostics } = snapshot;
  return diagnosticCount ? {
    inspection_complete: false,
    diagnostics,
    total_diagnostics_count: diagnosticCount,
    diagnostics_truncated: diagnosticCount > diagnostics.length
  } : {};
}
function missingResult(snapshot) {
  return snapshot.diagnosticCount ? "incomplete" : "not_observed";
}
function fits(response) {
  return Buffer.byteLength(JSON.stringify(response)) <= RESPONSE_BYTES;
}
async function savedSegment(file, call, result2, q) {
  const target = q.part === "args" ? call : result2;
  if (!target?.recordDigest) stale();
  const { byte_offset, line_byte_length } = target.location;
  const buffer = Buffer.allocUnsafe(line_byte_length);
  for (let at = 0; at < buffer.length; ) {
    const { bytesRead } = await file.read(buffer, at, buffer.length - at, byte_offset + at);
    if (!bytesRead) stale();
    at += bytesRead;
  }
  if (createHash5("sha256").update(buffer).digest("hex") !== target.recordDigest) stale();
  const row = record(buffer);
  if (!("value" in row) || !object3(row.value) || !object3(row.value.message)) stale();
  const message = row.value.message;
  if (q.part === "result") return serialize(message);
  const block = Array.isArray(message.content) ? message.content[call.location.content_index] : void 0;
  if (!object3(block) || !Object.hasOwn(block, "arguments")) stale();
  return serialize(block.arguments);
}
async function detail(file, snapshot, source, q) {
  const group = q.callId === void 0 ? [] : snapshot.byId.get(q.callId) ?? [];
  const diagnostics = diagnosticsFor(snapshot);
  if (!group.length) {
    if (q.version) badInput("source_version does not match the selected call.");
    return {
      status: snapshot.diagnosticCount ? "partial" : "not_found",
      ...diagnostics,
      error: snapshot.diagnosticCount ? { code: "LARVA_SESSION_INVALID", message: "Call ID not observed; inspection was incomplete." } : { code: "LARVA_SESSION_NOT_FOUND", message: "Call ID not found in recorded session." }
    };
  }
  const matching = q.callIndex !== void 0 ? group.slice(q.callIndex, q.callIndex + 1) : q.entryId !== void 0 ? group.filter((call2) => call2.location.entry_id === q.entryId) : group;
  if (!matching.length) badInput("Call selector is out of range or does not match.");
  if (matching.length > 1) {
    if (q.version) badInput("source_version requires an exact call selection.");
    return {
      status: "ambiguous",
      candidates: matching.slice(0, 5).map((c) => ({
        index: c.index,
        ...c.location,
        call_timestamp: c.timestamp
      })),
      total_candidates_count: matching.length,
      candidates_truncated: matching.length > 5,
      selection: "Use the zero-based disambiguation_index or an entry_id that selects one call.",
      ...diagnostics
    };
  }
  const call = matching[0], count = call.results.length;
  const result2 = q.resultIndex !== void 0 ? call.results[q.resultIndex] : !call.uncertain && count === 1 ? call.results[0] : void 0;
  if (q.resultIndex !== void 0 && !result2) badInput("result_index is out of range for recorded candidates.");
  const response = {
    status: "success",
    session_id: snapshot.sessionId,
    ...diagnostics,
    call: {
      call_id: call.id,
      tool_name: call.name,
      call_location: call.location,
      call_timestamp: call.timestamp,
      call_message_timestamp: call.messageTime,
      result_state: call.uncertain || count > 1 && !result2 ? "ambiguous" : result2 ? void 0 : missingResult(snapshot),
      result_association: call.uncertain ? "ambiguous" : void 0,
      unassociated_results_count: call.uncertain || void 0,
      result_location: result2?.location,
      result_timestamp: result2?.timestamp,
      result_message_timestamp: result2?.messageTime,
      is_error: result2?.preview.is_error,
      upstream_truncated: result2?.preview.upstream_truncated,
      result_candidates_count: count > 1 || call.uncertain ? count : void 0,
      result_candidates: count > 1 || call.uncertain ? call.results.slice(0, 5).map((r, index) => ({
        index,
        ...r.location,
        result_timestamp: r.timestamp,
        is_error: r.preview.is_error
      })) : void 0,
      selected_result_index: q.resultIndex
    }
  };
  if (q.part === "result" && !result2) {
    if (q.version) badInput("source_version does not match an available segment.");
    return response;
  }
  const selection = hash(JSON.stringify([
    call.location.byte_offset,
    call.location.content_index,
    q.part,
    q.part === "result" ? result2?.location.byte_offset : null
  ]));
  if (q.version && q.version.selection !== selection) badInput("source_version belongs to a different call, result or segment part.");
  const text2 = await savedSegment(file, call, result2, q);
  if (q.offset > text2.length) badInput("Offset exceeds saved data length.");
  const source_version = encode({ ...source, selection });
  const segment = (length2) => {
    const next = q.offset + length2;
    return {
      part: q.part,
      encoding: "json",
      offset_units: "UTF-16 code units",
      text: text2.slice(q.offset, next),
      offset: q.offset,
      length: length2,
      total_chars: text2.length,
      has_more: next < text2.length,
      continuation_offset: next < text2.length ? next : void 0,
      source_version,
      upstream_truncated: q.part === "result" ? result2?.preview.upstream_truncated : void 0
    };
  };
  let length = Math.min(q.length, text2.length - q.offset);
  response.call.segment = segment(length);
  while (!fits(response) && length > 1) {
    length = Math.max(1, Math.floor(length * 0.75));
    response.call.segment = segment(length);
  }
  return response;
}
function listing(snapshot, source, q) {
  const base = q.page?.base ?? 0, after = q.page?.after;
  let eligible = 0, sawAfter = !after;
  const selected = [];
  const timeMatch = (time) => q.since === void 0 && q.until === void 0 || time !== void 0 && (q.since === void 0 || time >= q.since) && (q.until === void 0 || time <= q.until);
  const offer = (call, position, result2, lateUncertain) => {
    if (q.tool !== void 0 && q.tool !== call.name) return;
    if (after && compare(position, after) === 0) sawAfter = true;
    if (after && compare(position, after) <= 0) return;
    eligible++;
    if (selected.length === q.limit && compare(position, selected[q.page ? q.limit - 1 : 0].position) * (q.page ? 1 : -1) >= 0) return;
    const item = {
      call_id: call.id,
      action: call.action.slice(0, 200),
      action_truncated: call.action.length > 200 || void 0,
      disambiguation_index: (snapshot.byId.get(call.id)?.length ?? 0) > 1 ? call.index : void 0
    };
    if (lateUncertain ?? call.uncertain > 0) {
      item.result_state = "ambiguous";
      item.result_association = "ambiguous";
      item.unassociated_results_count = lateUncertain ? void 0 : call.uncertain;
    } else if (!result2 && call.results.length > 1) {
      item.result_state = "ambiguous";
      item.result_candidates_count = call.results.length;
      item.result_selection = "Use exact call lookup with result_index.";
    } else if (!result2) item.result_state = missingResult(snapshot);
    else Object.assign(item, result2.preview);
    selected.push({ position, item });
    selected.sort((a, b) => compare(a.position, b.position));
    if (selected.length > q.limit) q.page ? selected.pop() : selected.shift();
  };
  joinResults(snapshot, q, (call, result2, uncertain) => {
    if (call.location.byte_offset < base && result2.location.byte_offset >= base && (timeMatch(result2.time) || timeMatch(call.time))) {
      offer(call, [result2.location.byte_offset, call.location.byte_offset, call.location.content_index], result2, uncertain);
    }
  });
  for (const call of snapshot.calls) {
    const start = call.location.byte_offset;
    if (start >= base && (timeMatch(call.time) || call.results.some((result2) => timeMatch(result2.time)))) {
      offer(call, [start, start, call.location.content_index], call.results.length === 1 ? call.results[0] : void 0);
    }
  }
  if (!sawAfter) badInput("Cursor position does not identify a matching recorded event.");
  if (!q.page) eligible = selected.length;
  const makeResponse = () => {
    const more = eligible > selected.length;
    return {
      status: "success",
      items: selected.map((x) => x.item),
      has_more: more,
      cursor: encode({
        ...source,
        filter: q.filter,
        base: more ? base : source.end,
        after: more ? selected.at(-1)?.position : void 0
      }),
      ...diagnosticsFor(snapshot)
    };
  };
  let response = makeResponse();
  while (!fits(response) && selected.length > 1) {
    selected.pop();
    response = makeResponse();
  }
  if (!fits(response) && selected.length) {
    const item = selected[0].item;
    if (item.result !== void 0) {
      delete item.result;
      item.result_state = "present_omitted";
      item.result_truncated = true;
    }
    if (item.action.length > 50) {
      item.action = item.action.slice(0, 50);
      item.action_truncated = true;
    }
  }
  return response;
}
async function inspectSubagentActivity(larvaHome, input) {
  try {
    const q = parse2(input);
    const target = await resolveCanonicalSessionPath(larvaHome, q.path);
    const file = await open6(target, constants7.O_RDONLY | constants7.O_NONBLOCK | constants7.O_NOFOLLOW);
    try {
      const initial = await file.stat({ bigint: true });
      if (!initial.isFile()) invalidSession("Target is not a regular session file.");
      const checkTarget = async () => {
        const current = await resolveCanonicalSessionPath(larvaHome, target).then((path) => stat6(path, { bigint: true })).catch(stale);
        if (current.dev !== initial.dev || current.ino !== initial.ino || current.size < initial.size) stale();
      };
      await checkTarget();
      const identity = hash(JSON.stringify([target, String(initial.dev), String(initial.ino)]));
      const prior = q.version ?? q.page;
      if (prior && (prior.file !== identity || BigInt(prior.end) > initial.size)) stale();
      const size = q.version?.end ?? (q.page?.after ? q.page.end : Number(initial.size));
      const snapshot = await readSnapshot(file, size, q, prior);
      const source = { file: identity, end: snapshot.end, digest: snapshot.digest };
      let response;
      if (q.callId !== void 0) {
        joinResults(snapshot, q);
        response = await detail(file, snapshot, source, q);
      } else response = listing(snapshot, source, q);
      if (await prefixDigest(file, snapshot.end) !== snapshot.digest) stale();
      await checkTarget();
      if (!fits(response)) invalidSession("Required activity metadata exceeds the 8192-byte response limit.");
      return response;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { status: "failed", error: { code: "LARVA_SESSION_NOT_FOUND", message: "Session file not found." } };
    }
    if (isErrno(error, "ELOOP")) {
      return { status: "failed", error: { code: "LARVA_SESSION_INVALID", message: "Session path changed before opening." } };
    }
    return { status: "failed", error: toErrorEnvelope(error).error };
  }
}

// src/ui/codex-mentions.ts
var CODEX_PERSONA_URI_TEMPLATE = "larva://personas/{persona_id}";
function personaResourceUri(id) {
  return `larva://personas/${encodeURIComponent(id)}`;
}
function parsePersonaResourceUri(uri) {
  const match = /^larva:\/\/personas\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(uri);
  return match?.[0] === uri ? match[1] : void 0;
}
function buildSearchMentionsOutput(personas, input) {
  const text2 = input.query.trim().toLowerCase();
  const query = /^@(?:larva|persona)$/.test(text2) ? "" : text2.replace(/^(?:@?(?:larva|persona):|@)/, "").trim();
  const items = personas.flatMap((persona) => {
    const id = persona.id.toLowerCase();
    const rank2 = !query || id === query ? 0 : id.startsWith(query) ? 1 : id.includes(query) ? 2 : persona.description.toLowerCase().includes(query) ? 3 : -1;
    return rank2 < 0 ? [] : [{ persona, rank: rank2 }];
  }).sort((a, b) => a.rank - b.rank).slice(0, input.preload ? 200 : 30).map(({ persona }) => {
    const title = `@larva:${persona.id}`;
    return {
      type: "resource_link",
      uri: personaResourceUri(persona.id),
      name: persona.id,
      title,
      searchTerms: [persona.id, title, persona.description, persona.model],
      description: persona.description,
      mimeType: "text/markdown"
    };
  });
  return { items };
}
var CODEX_INITIALIZE_INSTRUCTIONS = `---
name: larva-subagent
description: Discover Larva personas and delegate self-contained work to Pi child sessions through MCP.
---

# Larva subagent routing

- An exact \`@larva:<persona_id>\`, \`@persona:<persona_id>\`, or \`larva://personas/<persona_id>\` resource (including a composer link with that title) delegates directly to \`larva_subagent\` with the supplied \`persona_id\`. Do not call \`larva_personas\` first.
- A generic \`@larva\` or \`@Larva Subagents\` mention without a persona ID calls \`larva_personas\` first. Select a returned ID; do not invent one.
- For ordinary work without a Larva or Persona request, use Codex's native tools. Do not mix Larva \`task_id\` handles with Codex agent IDs.

## Choose the workspace

For a fresh spawn, omit \`cwd\` only when the host supports \`roots/list\` and returns exactly one root (\`roots.length === 1\`) whose URI is a local \`file://\` directory that exists. For zero roots, multiple roots (even if only one exists), an unusable root, or unsupported \`roots/list\`, pass an explicitly authorized absolute \`cwd\`; ask the user if it is ambiguous. For resume, use the exact returned \`task_id\` and omit \`cwd\` so Larva uses the recorded workspace.

## Delegate and observe

Give \`larva_subagent\` the exact \`persona_id\`, a self-contained task, scope, and completion checks. Use \`wait_for_completion: true\` to receive one run's terminal output directly, or \`wait_for_completion: false\` to receive an accepted receipt before waiting. Keep exact \`.jsonl\` handles and retain responsibility for integrating results. Reconcile any uncertain effects before a user-authorized resume.

Use \`larva_subagent_wait\` with \`return_when: "any"\` and a bounded \`timeout_ms\` to collect ready runs. A timed-out checkpoint is not completion; inspect ready runs and their terminal outputs. Use unified \`larva_subagent_status\` with an exact \`task_id\` or an \`active\`, \`recent\`, or \`disk\` scope. Use \`larva_subagent_activity\` with \`task_id\` to inspect recorded tool activity, not to infer live state. To cancel, use \`larva_subagent_cancel\` with \`task_ids\` and \`reason\`; inspect each outcome rather than assuming cleanup succeeded.

For example, using an exact handle returned by \`larva_subagent\`:

\`\`\`json
[
  {"name":"larva_subagent_wait","arguments":{"task_ids":["/example/sessions/child.jsonl"],"return_when":"any","timeout_ms":60000}},
  {"name":"larva_subagent_status","arguments":{"task_id":"/example/sessions/child.jsonl"}},
  {"name":"larva_subagent_activity","arguments":{"task_id":"/example/sessions/child.jsonl"}},
  {"name":"larva_subagent_cancel","arguments":{"task_ids":["/example/sessions/child.jsonl"],"reason":"The user requested cancellation."}}
]
\`\`\`
`;

// src/ui/codex-panel-html.ts
var CODEX_PANEL_URI = "ui://larva-pi-subagent/panel-v4";
var CODEX_PANEL_DISPLAY_MODES = ["fullscreen"];
function renderCodexPanelHtml() {
  return renderCodexAppHtml("panel", CODEX_PANEL_DISPLAY_MODES);
}
function renderCodexAppHtml(surface, modes) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Larva Subagents</title><style>${styles}</style></head>
<body><div id="app"></div><script>(${app})(${JSON.stringify(surface)},${JSON.stringify(modes)});</script></body></html>`;
}
var styles = `
:root {
  color-scheme: light dark;
  font: 14px/1.5 var(--font-sans, system-ui, sans-serif);
  color: var(--color-text-primary, CanvasText);
  background: var(--color-background-primary, Canvas);
  --border: var(--color-border-secondary, color-mix(in srgb, currentColor 23%, transparent));
  --subtle: var(--color-background-secondary, color-mix(in srgb, currentColor 6%, Canvas));
}
[data-theme=light] { color-scheme: light }
[data-theme=dark] { color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0; padding: calc(12px + var(--safe-top, 0px)) calc(12px + var(--safe-right, 0px)) calc(12px + var(--safe-bottom, 0px)) calc(12px + var(--safe-left, 0px)); overflow-wrap: anywhere }
header, .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px }
header { margin-bottom: 12px; justify-content: space-between }
h1, h2, h3, p { margin: 0 0 8px }
h1 { font-size: 1rem; margin: 0 }
h2 { font-size: 1rem }
h3 { font-size: .9rem }
button { background: transparent; color: inherit; font: inherit; border: 1px solid var(--border); border-radius: var(--border-radius-sm, 6px); padding: 5px 9px; min-height: 32px; cursor: pointer }
button:focus-visible { outline: 2px solid var(--color-ring-primary, Highlight); outline-offset: 2px }
button[aria-pressed=true] { background: var(--subtle); border-color: currentColor }
button:disabled { opacity: .6; cursor: default }
main { display: grid; gap: 12px; align-items: start }
[data-mode=fullscreen] main:has(> nav) { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) }
.list { display: grid; gap: 6px; overflow: auto; max-height: 32dvh; padding: 3px }
[data-mode=fullscreen] .list { max-height: 75dvh }
.list button { text-align: start }
article { border: 1px solid var(--border); border-radius: var(--border-radius-md, 8px); padding: 10px; min-width: 0 }
article .controls { margin-bottom: 8px }
article .controls h2 { margin: 0 }
.telemetry { list-style: none; padding: 0; margin: 0 0 8px }
.telemetry li + li { border-top: 1px solid var(--border); padding-top: 6px }
.notice { padding: 8px 10px; background: var(--subtle); border-inline-start: 3px solid }
.warning { color: var(--color-text-warning, light-dark(#7b4b00, #ffd17a)) }
.error, .cancel { color: var(--color-text-danger, light-dark(#a82323, #ff9e9e)) }
code, pre { font: .9em/1.5 var(--font-mono, ui-monospace, monospace) }
pre { margin: 0 0 8px; padding: 8px; background: var(--subtle); white-space: pre-wrap; overflow: auto; max-height: 55dvh }
[data-mode=inline] pre { max-height: 200px }
@media (max-width: 600px) {
  [data-mode=fullscreen] main:has(> nav) { grid-template-columns: minmax(0, 1fr) }
  [data-mode=fullscreen] .list { max-height: 28dvh }
}
`;
var app = String.raw`function (surface, modes) {
  const panel = surface === 'panel';
  const root = document.getElementById('app');
  const terminal = new Set(['success', 'failed', 'cancelled']);
  const active = run => run.status === 'accepted' || run.status === 'running';
  const scopes = ['active', 'recent', 'disk'];
  const labels = { active: 'Active', recent: 'Recent', disk: 'Disk' };
  const pair = row => typeof row?.task_id === 'string' && row.task_id.length > 0 &&
    typeof row.run_epoch === 'string' && row.run_epoch.length > 0;
  const key = row => JSON.stringify([row.task_id, row.run_epoch]);
  const phase = run => ({ starting: 'Starting', waiting_for_child: 'Working', stall_suspected: 'Stall suspected',
    cancelling: 'Cancelling', success: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[run.phase] ?? run.status;
  const same = (a, b) => pair(a) && pair(b) && a.task_id === b.task_id && a.run_epoch === b.run_epoch;
  const captured = new Map();
  const cancelling = new Set();
  const detailsOpen = new Set();
  const requests = new Map();
  let activity;
  let sequence = 0, view = 0, renderVersion = 0, pollTimer, poll, displayRequest, mode = modes[0];
  let connection = 'connecting';
  let target = panel ? { kind: 'latest', query: { scope: 'recent' } } : { kind: 'pending' };
  let toolInput, initialResult;
  let rows = [], failures = [], selected, loading = true, readError, cancelNotice;

  const visible = () => document.visibilityState !== 'hidden';
  const observing = () => connection === 'ready' && visible();
  const post = message => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params = {}) => post({ method, params });

  function rpc(method, params, kind = 'observer') {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error('The host did not respond.'));
        disconnect();
      }, 15000);
      requests.set(id, { resolve, reject, timer, kind });
      try { post({ id, method, params }); }
      catch (error) { disconnect(); }
    });
  }

  function retireRequests(predicate) {
    for (const [id, request] of requests) {
      if (!predicate(request.kind)) continue;
      requests.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error('View closed.'));
    }
  }

  function clearActivity() {
    if (!activity) return;
    activity = undefined;
    retireRequests(kind => kind === 'activity');
  }

  function stopObserving() {
    view++;
    clearTimeout(pollTimer);
    poll = undefined;
    clearActivity();
    retireRequests(kind => kind === 'observer');
  }

  function disconnect() {
    if (connection === 'closed' || connection === 'lost') return;
    connection = 'lost';
    finishInvocation();
    stopObserving();
    retireRequests(() => true);
    observer.disconnect();
    render();
  }

  function applyContext(context) {
    if (modes.includes(context?.displayMode)) mode = context.displayMode;
    const html = document.documentElement;
    if (context?.theme === 'light' || context?.theme === 'dark') html.dataset.theme = context.theme;
    for (const [name, value] of Object.entries(context?.styles?.variables ?? {})) {
      if (name.startsWith('--') && typeof value === 'string') html.style.setProperty(name, value);
    }
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const size = context?.safeAreaInsets?.[side];
      if (Number.isFinite(size) && size >= 0) html.style.setProperty('--safe-' + side, size + 'px');
    }
    render();
  }

  function queryFor(input, fallbackScope) {
    if (typeof input.task_id === 'string' && input.task_id) return { task_id: input.task_id };
    return {
      ...(scopes.includes(input.scope) ? { scope: input.scope } : fallbackScope ? { scope: fallbackScope } : {}),
      ...(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 25 ? { limit: input.limit } : {}),
    };
  }

  function invocationFor(args) {
    if ('task_ids' in args) return { kind: 'wait', taskIds: Array.isArray(args.task_ids) ? args.task_ids.slice(0, 25) : [] };
    if ('task' in args || 'persona_id' in args) return { kind: 'spawn', personaId: typeof args.persona_id === 'string' ? args.persona_id : undefined };
    return { kind: 'status', query: queryFor(args) };
  }

  const dataOf = result => result?.structuredContent ?? result?.details ?? result;
  const errorOf = result => dataOf(result)?.error?.message ?? result?.content?.find?.(item => item.type === 'text')?.text;
  const tool = (name, args, kind) => rpc('tools/call', { name, arguments: args }, kind);

  function terminalOutput(run, outputs) {
    const output = outputs && Object.hasOwn(outputs, run.task_id) ? outputs[run.task_id] : undefined;
    if (!same(run, output) || !terminal.has(output.status)) return run;
    // Do not carry the run's stale preview/artifact into a different output state.
    const { output_state, result_text, result_preview, full_output_artifact, output_diagnostic, ...metadata } = run;
    return { ...metadata, ...output };
  }

  function isCaptured(run) {
    return terminal.has(run.status) && ['inline', 'artifactized', 'delivery_failed', 'evicted'].includes(run.output_state);
  }

  function acceptSnapshot(data, pinRefresh = false) {
    const runs = (Array.isArray(data?.runs) ? data.runs : []).slice(0, 25).filter(pair);
    if (target.kind === 'pinned') {
      rows = Array.from(target.pairs, ([id, epoch]) => {
        const run = runs.find(row => row.task_id === id && row.run_epoch === epoch);
        if (run) {
          const current = terminalOutput(run, data.terminal_outputs);
          if (isCaptured(current)) captured.set(id, current);
          return { kind: 'run', run: captured.get(id) ?? current };
        }
        const saved = captured.get(id);
        return saved ? { kind: 'run', run: saved }
          : { kind: pinRefresh ? 'expired' : 'run', run: { task_id: id, run_epoch: epoch, output_state: 'pending' } };
      });
      return;
    }
    if (target.kind !== 'latest') return;
    const query = target.query;
    failures = query.task_id || query.scope === 'disk' ? []
      : (Array.isArray(data?.startup_failures) ? data.startup_failures.slice(0, 25) : []);
    const live = runs.filter(run => !query.task_id || query.task_id === run.task_id)
      .map(run => terminalOutput(run, data.terminal_outputs));
    if (query.scope === 'disk' || (query.task_id && !live.length)) {
      const disk = Array.isArray(data?.disk_sessions) ? data.disk_sessions.slice(0, 25) : [];
      rows = disk.filter(row => typeof row?.task_id === 'string' && typeof row.cwd === 'string' &&
        (!query.task_id || query.task_id === row.task_id)).map(disk => ({
        kind: 'disk', disk, run: disk.lock_state === 'active_local' ? live.find(run => run.task_id === disk.task_id) : undefined,
      }));
    } else {
      rows = live.filter(run => query.scope !== 'active' || active(run) || run.status === 'cancelling').map(run => ({ kind: 'run', run }));
    }
  }

  function applyInvocation() {
    if (target.kind !== 'pending' || initialResult === undefined) return;
    const data = dataOf(initialResult);
    const runs = Array.isArray(data?.runs) ? data.runs.slice(0, 25) : [];
    // The app notifications carry arguments and a result, not necessarily the
    // tool name. Use the disjoint spawn/wait receipt shapes, never input IDs
    // alone, as the authority for binding an epoch.
    const waitResult = (!toolInput || toolInput.kind === 'wait') && !initialResult.isError &&
      typeof data?.ready === 'boolean' && typeof data.timed_out === 'boolean';
    let snapshots = [];
    if ((!toolInput || toolInput.kind === 'spawn') && pair(data) &&
        (terminal.has(data.status) || (!initialResult.isError && data.status === 'accepted'))) {
      snapshots = [{ persona_id: toolInput?.personaId, phase: data.status === 'accepted' ? 'starting' : data.status,
        output_state: 'pending', ...data }];
    } else if (waitResult) {
      snapshots = runs.filter(row => !toolInput || toolInput.taskIds.includes(row?.task_id));
    }
    const pairs = new Map(snapshots.filter(pair).map(row => [row.task_id, row.run_epoch]));
    if (pairs.size) {
      target = { kind: 'pinned', pairs };
      acceptSnapshot({ runs: snapshots, terminal_outputs: data.terminal_outputs });
    } else if (initialResult.isError || data?.error || waitResult) {
      const message = errorOf(initialResult) ?? (waitResult ? 'No run snapshot was returned for this wait.' : 'The tool call was rejected.');
      target = { kind: 'rejected', message };
    } else if (toolInput?.kind === 'status' && Array.isArray(data?.runs) && Array.isArray(data.startup_failures)) {
      target = { kind: 'latest', query: toolInput.query };
      acceptSnapshot(data);
    } else {
      return;
    }
    finishInvocation();
    loading = false;
    render();
    void refresh();
  }

  function finishInvocation() {
    toolInput = undefined;
    initialResult = undefined;
  }

  async function refresh() {
    if (!observing() || poll || (target.kind !== 'pinned' && target.kind !== 'latest')) return;
    clearTimeout(pollTimer);
    const ticket = poll = {};
    const args = target.kind === 'pinned' ? { run_epochs: Object.fromEntries(target.pairs) } : target.query;
    try {
      const response = await tool('larva_subagent_panel', args);
      if (poll !== ticket) return;
      if (response?.isError) throw new Error(errorOf(response) ?? 'Could not refresh runs.');
      const data = dataOf(response);
      if (!Array.isArray(data?.runs)) throw new Error('Invalid run snapshot from the host.');
      acceptSnapshot(data, true);
      readError = undefined;
    } catch (error) {
      if (poll === ticket) readError = error.message;
    } finally {
      if (poll === ticket) {
        poll = undefined;
        loading = false;
        render();
        if (target.kind === 'latest' || readError || rows.some(row => row.kind === 'run' && !isCaptured(row.run))) {
          pollTimer = setTimeout(refresh, 2500);
        }
      }
    }
  }

  function reopen() {
    render();
    void refresh();
  }

  function setQuery(query) {
    stopObserving();
    target = { kind: 'latest', query };
    rows = []; failures = []; selected = undefined; readError = undefined; cancelNotice = undefined;
    loading = true;
    reopen();
  }

  async function changeMode() {
    if (!observing() || displayRequest) return;
    const ticket = displayRequest = {};
    const token = view;
    render();
    try {
      const result = await rpc('ui/request-display-mode', { mode: mode === 'inline' ? 'fullscreen' : 'inline' });
      if (token !== view || !observing()) return;
      applyContext({ displayMode: result?.mode });
      void refresh();
    } catch (error) {
      if (token === view && observing()) readError = error.message;
    } finally {
      if (displayRequest === ticket) { displayRequest = undefined; render(); }
    }
  }

  async function cancel(run) {
    const id = key(run);
    const owns = row => same(row.run, run) && active(row.run);
    if (!observing() || loading || readError || cancelling.has(id) || !rows.some(owns)) return;
    const token = view;
    cancelling.add(id);
    cancelNotice = undefined;
    render();
    try {
      const response = await tool('larva_subagent_cancel', {
        task_ids: [run.task_id], reason: 'Cancelled from Larva Subagents',
        expected_run_epochs: { [run.task_id]: run.run_epoch },
      }, 'cancel');
      if (token !== view || !observing()) return;
      const item = dataOf(response)?.results?.find?.(result => result?.task_id === run.task_id);
      switch (item?.outcome) {
        case 'cancelled':
        case 'already_terminal': break;
        case 'cleanup_unconfirmed':
          cancelNotice = { text: 'Cancellation cleanup could not be confirmed.', style: 'warning' }; break;
        case 'not_found':
          cancelNotice = { text: 'Run not found for cancellation. No newer run was targeted.', style: 'error' }; break;
        default: throw new Error(errorOf(response) ?? 'Cancellation outcome unavailable.');
      }
      if (item.outcome !== 'cleanup_unconfirmed') {
        // Do not offer another Cancel on an observed pre-cancel snapshot.
        rows = rows.filter(row => !owns(row));
        loading = true;
      }
    } catch (error) {
      if (token === view && observing()) cancelNotice = { text: error.message, style: 'error' };
    } finally {
      cancelling.delete(id);
      if (token === view && observing()) {
        stopObserving();
        reopen();
      }
    }
  }

  function element(tag, text, parent = root) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }

  function button(name, action, parent, options = {}) {
    const node = element('button', name, parent);
    const version = renderVersion;
    const current = () => version === renderVersion && visible() && connection !== 'closed';
    node.type = 'button';
    node.onclick = () => { if (current() && !node.disabled) action(current); };
    node.disabled = options.disabled ?? false;
    node.dataset.focusKey = options.key ?? name;
    if (options.pressed !== undefined) node.setAttribute('aria-pressed', String(options.pressed));
    if (options.expanded !== undefined) node.setAttribute('aria-expanded', String(options.expanded));
    return node;
  }

  function copyButton(label, text, parent, id) {
    if (typeof text !== 'string' || !text) return;
    const feedback = element('span', '', parent);
    feedback.setAttribute('role', 'status');
    button(label, async current => {
      let copied = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch { /* A sandbox may deny Clipboard API access. */ }
      if (!current()) return;
      if (!copied) {
        const focus = document.activeElement;
        const field = element('textarea', undefined, parent);
        field.value = text;
        field.readOnly = true;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        try {
          field.select();
          copied = document.execCommand?.('copy') === true;
        } catch { /* Fall back to user selection. */ }
        finally { field.remove(); focus?.focus({ preventScroll: true }); }
      }
      feedback.textContent = copied ? 'Copied.' : 'Copy unavailable. Select the text to copy it manually.';
    }, parent, { key: label + ':' + id });
  }

  function notice(text, style, parent = root) {
    const node = element('p', text, parent);
    node.className = 'notice ' + style;
    node.setAttribute('role', style === 'error' ? 'alert' : 'status');
  }

  function pathLine(label, path, parent) {
    if (typeof path !== 'string' || !path) return;
    const line = element('p', label + ': ', parent);
    element('code', path, line);
  }

  function output(run, parent) {
    element('h3', 'Result', parent);
    const artifact = run.full_output_artifact?.path;
    const text = run.result_text ?? run.result_preview;
    const preview = run.result_preview ?? run.result_text;
    const show = value => {
      const pre = element('pre', value, parent);
      pre.dataset.scrollKey = 'output:' + key(run);
    };
    switch (run.output_state) {
      case 'inline':
        show(text ?? '');
        copyButton('Copy output', text, parent, key(run));
        break;
      case 'artifactized':
        if (preview) show(preview);
        copyButton('Copy output preview', preview, parent, key(run));
        pathLine(artifact ? 'Full output artifact' : 'Recorded transcript', artifact ?? run.task_id, parent);
        break;
      case 'delivery_failed':
        notice((run.status === 'success' ? 'Execution succeeded, but output delivery failed.' : 'Output delivery failed.') +
          (run.output_diagnostic?.message ? ' ' + run.output_diagnostic.message : ''), 'warning', parent);
        if (run.result_preview) show(run.result_preview);
        copyButton('Copy output preview', run.result_preview, parent, key(run));
        pathLine('Recorded transcript', run.task_id, parent);
        break;
      case 'evicted':
        notice('Output evicted from the live snapshot.', 'warning', parent);
        pathLine(artifact ? 'Full output artifact' : 'Recorded transcript', artifact ?? run.task_id, parent);
        break;
      default: notice('Output pending…', '', parent);
    }
  }

  async function inspect(run, toolCall, part) {
    if (!observing()) return;
    clearActivity();
    const request = activity = { runKey: key(run), callId: toolCall.tool_call_id, part, state: 'loading' };
    render();
    try {
      const result = await tool('larva_subagent_activity', {
        task_id: run.task_id, tool_call_id: request.callId, segment_part: part,
      }, 'activity');
      if (activity !== request || !observing()) return;
      const data = dataOf(result);
      const segment = data?.call?.segment;
      if (result?.isError || data?.error) throw new Error(errorOf(result) ?? 'Recorded activity unavailable.');
      if (data?.status === 'ambiguous') throw new Error('Multiple recorded calls match this tool ID. Inspect the recorded transcript.');
      if (part === 'result' && data?.call?.result_state === 'ambiguous') throw new Error('The recorded result is ambiguous. Inspect the recorded transcript.');
      if (data?.status !== 'success' || data.call?.call_id !== request.callId || segment?.part !== part || typeof segment.text !== 'string') {
        throw new Error('No recorded ' + part + ' available for this call yet.');
      }
      Object.assign(request, { state: 'ready', text: segment.text, partial: segment.has_more || segment.upstream_truncated || data.inspection_complete === false });
    } catch (error) {
      if (activity !== request || !observing()) return;
      Object.assign(request, { state: 'error', text: error.message });
    }
    render();
  }

  function recentTools(run, parent) {
    if (!run.tool_snapshots?.length) return;
    element('h3', 'Recent tool calls', parent);
    const list = element('ul', undefined, parent);
    list.className = 'telemetry';
    for (const call of run.tool_snapshots.slice().reverse()) {
      const item = element('li', undefined, list);
      element('p', call.name + ' (' + call.status + ')', item);
      if (call.args_preview) element('pre', call.args_preview, item);
      const controls = element('div', undefined, item);
      controls.className = 'controls';
      const current = activity?.callId === call.tool_call_id ? activity : undefined;
      const callKey = key(run) + ':' + call.tool_call_id;
      for (const part of ['args', 'result']) button(part === 'args' ? 'Recorded args' : 'Recorded result', () => void inspect(run, call, part), controls, {
        key: part + ':' + callKey, disabled: !observing() || (current?.part === part && current.state === 'loading'),
      });
      if (!current) continue;
      button('Close recording', () => { clearActivity(); render(); }, controls, { key: 'close:' + callKey });
      if (current.state === 'loading') notice('Loading recorded ' + current.part + '…', '', item);
      else if (current.state === 'error') notice(current.text, 'error', item);
      else {
        element('h3', 'Recorded ' + current.part, item);
        element('pre', current.text, item).dataset.scrollKey = current.part + ':' + callKey;
        if (current.partial) notice('Partial recording. Inspect the transcript for more.', 'warning', item);
      }
    }
  }

  const rowKey = row => row.kind === 'disk' ? 'disk:' + row.disk.task_id : key(row.run);
  const selectedRow = () => rows.find(row => rowKey(row) === selected) ?? rows[0];
  const diskStatus = disk => ['active_external', 'unreconciled'].includes(disk.lock_state) ? 'Busy' : '';
  function rowLabel(row) {
    if (row.kind === 'disk') return [row.disk.task_id, row.disk.cwd, diskStatus(row.disk),
      row.disk.cwd_exists === false ? 'Missing workspace' : ''].filter(Boolean).join(' · ');
    const run = row.run;
    return (run.persona_id ?? run.task_id) + ' · ' + (row.kind === 'expired' ? 'Snapshot expired' : phase(run) ?? 'Pending');
  }

  function renderContent() {
    const header = element('header');
    element('h1', 'Larva Subagents', header);
    const controls = element('div', undefined, header);
    controls.className = 'controls';
    if (panel) {
      for (const scope of scopes) button(labels[scope], () => setQuery({ scope, ...(target.query.limit ? { limit: target.query.limit } : {}) }), controls, {
        pressed: !target.query.task_id && target.query.scope === scope, disabled: !observing(),
      });
    }
    if (target.kind === 'latest' || target.kind === 'pinned') button('Refresh', refresh, controls, { disabled: !observing() });
    if (!panel) button(mode === 'inline' ? 'Fullscreen' : 'Inline', changeMode, controls, {
      key: 'display', disabled: !observing() || !!displayRequest,
    });
    if (connection === 'lost') notice('Connection lost. This view is read-only.', 'warning');
    if (readError) notice(readError, 'error');
    if (cancelNotice) notice(cancelNotice.text, cancelNotice.style);
    if (target.kind === 'pending') { notice('Waiting for this tool call…', ''); return; }
    if (target.kind === 'rejected') { notice(target.message, 'error'); return; }
    for (const failure of failures) {
      if (failure?.error?.message) notice('Startup failed · ' + failure.persona_id + ' · ' + failure.error.message, 'error');
    }
    if (!rows.length) {
      if (!readError) notice(loading ? 'Loading runs…' : 'No runs in this view.', '');
      return;
    }
    const main = element('main');
    const row = selectedRow();
    selected = rowKey(row);
    if (panel || mode === 'fullscreen' || rows.length > 1) {
      const list = element('nav', undefined, main);
      list.className = 'list';
      list.dataset.scrollKey = 'list';
      list.setAttribute('aria-label', 'Subagent runs');
      for (const item of rows) button(rowLabel(item), () => { selected = rowKey(item); render(); }, list, {
        key: rowKey(item), pressed: item === row,
      });
    }
    const detail = element('article', undefined, main);
    if (row.kind === 'expired') {
      notice('Run snapshot expired (inspect recorded transcript)', 'warning', detail);
      pathLine('Recorded transcript', row.run.task_id, detail);
      copyButton('Copy task_id', row.run.task_id, detail, key(row.run));
      return;
    }
    const run = row.run;
    if (row.kind === 'disk') {
      element('h2', 'Recorded session', detail);
      pathLine('Workspace', row.disk.cwd, detail);
      pathLine('Recorded transcript', row.disk.task_id, detail);
      if (diskStatus(row.disk)) notice('Busy', 'warning', detail);
      if (row.disk.cwd_exists === false) notice('Missing workspace', 'warning', detail);
      if (!run) {
        copyButton('Copy task_id', row.disk.task_id, detail, rowKey(row));
        return;
      }
    }
    const bar = element('div', undefined, detail);
    bar.className = 'controls';
    const heading = element('h2', run.persona_id ?? 'Subagent run', bar);
    heading.dir = 'auto';
    const status = ({ accepted: 'Accepted', running: 'Running' })[run.status];
    element('span', [status, phase(run) ?? 'Pending'].filter(Boolean).join(' · '), bar)
      .className = run.phase === 'stall_suspected' ? 'warning' : '';
    const route = [run.model, run.thinking && 'thinking: ' + run.thinking].filter(Boolean).join(' · ');
    if (route) element('span', route, bar);
    if (run.active_tool) element('span', run.active_tool.name + ' (' + run.active_tool.status + ')', bar);
    if (run.live_thinking) element('span', 'Thinking…', bar);
    const id = key(run);
    if (active(run) && observing()) button('Cancel', () => void cancel(run), bar, {
      key: 'cancel:' + id, disabled: loading || !!readError || cancelling.has(id),
    }).className = 'cancel';
    if (!panel) {
      const open = detailsOpen.has(id);
      button(open ? 'Hide details' : 'Details', () => {
        if (open) detailsOpen.delete(id);
        else detailsOpen.add(id);
        render();
      }, bar, { key: 'details:' + id, expanded: open });
      if (!open) return;
    }
    if (row.kind !== 'disk') {
      pathLine('Workspace', run.cwd, detail);
      pathLine('Session', run.task_id, detail);
    }
    copyButton('Copy task_id', run.task_id, detail, id);
    if (run.error?.message) notice(run.error.message, 'error', detail);
    if (run.task_preview) {
      element('h3', 'Task preview', detail);
      element('pre', run.task_preview, detail);
      copyButton('Copy prompt', run.task_preview, detail, id);
    }
    if (run.live_assistant_preview) {
      element('h3', 'Live assistant preview', detail);
      element('pre', run.live_assistant_preview, detail);
    }
    recentTools(run, detail);
    output(run, detail);
  }

  function render() {
    if (!visible() || connection === 'closed') return;
    renderVersion++;
    const liveKeys = new Set(rows.filter(row => row.kind !== 'expired' && row.run).map(row => key(row.run)));
    for (const id of detailsOpen) if (!liveKeys.has(id)) detailsOpen.delete(id);
    if (activity) {
      const row = selectedRow();
      const run = row?.run;
      if (row?.kind === 'expired' || !run || key(run) !== activity.runKey || (!panel && !detailsOpen.has(activity.runKey)) ||
          !run.tool_snapshots?.some(call => call.tool_call_id === activity.callId)) clearActivity();
    }
    const focus = document.activeElement?.dataset?.focusKey;
    const scroll = new Map(Array.from(root.querySelectorAll('[data-scroll-key]'), node => [node.dataset.scrollKey, node.scrollTop]));
    document.documentElement.dataset.mode = mode;
    root.replaceChildren();
    renderContent();
    for (const node of root.querySelectorAll('[data-scroll-key]')) if (scroll.has(node.dataset.scrollKey)) node.scrollTop = scroll.get(node.dataset.scrollKey);
    if (focus) Array.from(root.querySelectorAll('button')).find(node => node.dataset.focusKey === focus)?.focus({ preventScroll: true });
  }

  const observer = new ResizeObserver(() => {
    if (observing() && mode === 'inline') notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
  });
  observer.observe(root);
  document.addEventListener('visibilitychange', () => {
    if (!visible()) stopObserving();
    else {
      loading = true;
      reopen();
    }
  });
  window.addEventListener('messageerror', event => { if (event.source === window.parent) disconnect(); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || message?.jsonrpc !== '2.0' || connection === 'closed') return;
    if (message.method === 'ui/resource-teardown') {
      connection = 'closed';
      finishInvocation();
      stopObserving();
      retireRequests(() => true);
      observer.disconnect();
      if (Object.hasOwn(message, 'id')) post({ id: message.id, result: {} });
      return;
    }
    if (connection === 'lost') return;
    if (!message.method) {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    switch (message.method) {
      case 'ui/notifications/host-context-changed':
        applyContext(message.params?.hostContext ?? message.params); break;
      case 'ui/notifications/tool-input':
        if (message.params?.arguments && typeof message.params.arguments === 'object' && !Array.isArray(message.params.arguments)) {
          if (panel) setQuery(queryFor(message.params.arguments, 'recent'));
          else if (target.kind === 'pending' && toolInput === undefined) {
            toolInput = invocationFor(message.params.arguments);
            applyInvocation();
          }
        }
        break;
      case 'ui/notifications/tool-result':
        if (!panel && target.kind === 'pending' && initialResult === undefined && message.params && typeof message.params === 'object') {
          initialResult = message.params;
          applyInvocation();
        }
        break;
      case 'ui/notifications/tool-cancelled':
        if (target.kind === 'pending') {
          target = { kind: 'rejected', message: message.params?.reason ?? 'The tool call was cancelled before binding a run.' };
          finishInvocation();
          render();
        }
        break;
    }
  });
  render();
  rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Larva Subagents', version: '0.9.0' },
    appCapabilities: { availableDisplayModes: modes } }, 'initialize').then(result => {
    if (connection !== 'connecting') return;
    connection = 'ready';
    applyContext(result?.hostContext);
    notify('ui/notifications/initialized');
    void refresh();
  }).catch(disconnect);
}`;

// src/ui/codex-widget-html.ts
var CODEX_WIDGET_URI = "ui://larva-pi-subagent/widget-v4";
var CODEX_WIDGET_DISPLAY_MODES = ["inline", "fullscreen"];
function renderCodexWidgetHtml() {
  return renderCodexAppHtml("widget", CODEX_WIDGET_DISPLAY_MODES);
}

// src/surfaces/tool-schemas.ts
var isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};
var hasRequired = (value, keys2) => keys2.every((key) => Object.hasOwn(value, key));
function matches(schema, value) {
  if ("anyOf" in schema) return schema.anyOf.some((option) => matches(option, value));
  if (!("type" in schema)) return isPlainObject(value) && hasRequired(value, schema.required);
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string" || schema.minLength && !value.length || schema.enum && !schema.enum.includes(value)) return false;
      if (schema.maxLength === void 0) return true;
      let length = 0;
      for (const _ of value) if (++length > schema.maxLength) return false;
      return true;
    }
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
    case "array":
      return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && (!schema.uniqueItems || new Set(value).size === value.length) && value.every((item) => matches(schema.items, item));
    case "object": {
      if (!isPlainObject(value) || !hasRequired(value, schema.required ?? []) || schema.not && matches(schema.not, value)) return false;
      const entries = Object.entries(value);
      return entries.length >= (schema.minProperties ?? 0) && entries.length <= (schema.maxProperties ?? Infinity) && entries.every(([key, field2]) => {
        const rule = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : schema.additionalProperties;
        return rule !== false && matches(rule, field2);
      });
    }
  }
}
function admitToolInput(name, schema, input) {
  if (!matches(schema, input)) throw new LarvaError("LARVA_BAD_INPUT", `Invalid arguments for ${name}.`);
  return input;
}
var string = { type: "string" };
var text = { ...string, minLength: 1 };
var boolean = { type: "boolean" };
var integer2 = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
var choice = (...values) => ({ ...string, enum: values });
var object4 = (properties, ...required) => ({ type: "object", properties, required, additionalProperties: false });
var taskIds = { type: "array", items: text, minItems: 1, maxItems: 25, uniqueItems: true };
var epochs = { type: "object", additionalProperties: text, maxProperties: 25 };
var maxMs = 864e5;
var commonToolSchemas = {
  larva_personas: object4({ query: string, limit: integer2(1, 50) }),
  larva_subagent: object4({
    persona_id: text,
    task: text,
    task_id: text,
    cwd: text,
    no_progress_timeout_ms: integer2(12e4, maxMs),
    stall_alert_ms: { anyOf: [integer2(0, 0), integer2(6e4, maxMs)] }
  }, "persona_id", "task"),
  larva_subagent_wait: object4({ task_ids: taskIds, return_when: choice("all", "any", "first_error"), timeout_ms: integer2(0, maxMs) }, "task_ids"),
  larva_subagent_status: {
    ...object4({ task_id: text, scope: choice("active", "recent", "disk"), limit: integer2(1, 25) }),
    not: { anyOf: [{ required: ["task_id", "scope"] }, { required: ["task_id", "limit"] }] }
  },
  larva_subagent_activity: object4({
    task_id: text,
    limit: integer2(1, 20),
    cursor: text,
    tool_name: text,
    since_timestamp: text,
    until_timestamp: text,
    tool_call_id: text,
    disambiguation_index: integer2(0),
    entry_id: text,
    result_index: integer2(0),
    segment_part: choice("args", "result"),
    offset: integer2(0),
    length: integer2(1, 4e3),
    source_version: text
  }, "task_id"),
  larva_subagent_cancel: object4({ task_ids: taskIds, reason: { ...text, maxLength: 500 }, expected_run_epochs: epochs }, "task_ids", "reason")
};

// src/surfaces/mcp-tools.ts
var isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var bad2 = (message) => {
  throw new LarvaError("LARVA_BAD_INPUT", message);
};
var { larva_subagent: spawnSchema, larva_subagent_status: statusSchema } = commonToolSchemas;
var modelUi = { ui: { visibility: ["model", "app"] } };
var widgetUi = {
  ui: { ...modelUi.ui, resourceUri: CODEX_WIDGET_URI },
  "openai/ui": { preferredModelDisplayMode: "inline", availableDisplayModes: CODEX_WIDGET_DISPLAY_MODES }
};
function tool(name, description, inputSchema, _meta, handler) {
  return {
    definition: { name, description, inputSchema, _meta },
    invoke(input, listRoots) {
      return handler(admitToolInput(name, inputSchema, input), listRoots);
    }
  };
}
function result(data, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError };
}
function createMcpTools(supervisor, personas) {
  const registry = [
    tool(
      "larva_personas",
      "Search installed Larva personas without returning prompts.",
      commonToolSchemas.larva_personas,
      modelUi,
      async (args) => result({ personas: await personas.list({ ...args, limit: args.limit ?? 20 }) })
    ),
    tool("larva_subagent", "Start or resume an isolated Pi subagent.", {
      ...spawnSchema,
      properties: { ...spawnSchema.properties, wait_for_completion: boolean, parent_persona_id: text }
    }, widgetUi, async (args, listRoots) => result(await supervisor.spawn(args, { surface: "mcp", listRoots }))),
    tool(
      "larva_subagent_wait",
      "Observe exact run instances without consuming their outputs.",
      commonToolSchemas.larva_subagent_wait,
      widgetUi,
      async (args) => result(await supervisor.wait(args))
    ),
    tool(
      "larva_subagent_status",
      "Inspect an exact task or list active, recent, or recorded sessions.",
      statusSchema,
      widgetUi,
      async (args) => result(await supervisor.status(args))
    ),
    tool(
      "larva_subagent_activity",
      "Read recorded tool activity from an exact task transcript.",
      commonToolSchemas.larva_subagent_activity,
      modelUi,
      async (args) => {
        const data = await inspectSubagentActivity(supervisor.home, args);
        return result(data, data.status === "failed" || data.status === "not_found");
      }
    ),
    tool(
      "larva_subagent_cancel",
      "Cancel owned runs with optional epoch guards.",
      commonToolSchemas.larva_subagent_cancel,
      modelUi,
      async (args) => {
        const data = await supervisor.cancel(args);
        return result(data, data.isError);
      }
    ),
    tool(
      "search_mentions",
      "Find Persona mention resources.",
      object4({ query: string, preload: boolean, path: { type: "array", items: string } }, "query"),
      { ui: { visibility: ["app"] }, "openai/extensions": { "mentions/search": { preload: true } } },
      async (args) => {
        const data = buildSearchMentionsOutput(await personas.list(), args);
        return { content: data.items, structuredContent: data, isError: false };
      }
    ),
    tool(
      "larva_subagent_panel",
      "View sessions or recover exact run epochs for an inline card.",
      { ...statusSchema, properties: { ...statusSchema.properties, run_epochs: { ...epochs, minProperties: 1 } } },
      {
        ui: { visibility: ["app"], resourceUri: CODEX_PANEL_URI },
        "openai/ui": { entrypoints: [{ type: "thread" }], availableDisplayModes: CODEX_PANEL_DISPLAY_MODES }
      },
      async ({ run_epochs, ...query }) => {
        if (!run_epochs) return result(await supervisor.status(query));
        const entries = Object.entries(run_epochs);
        if (query.task_id !== void 0 && (entries.length !== 1 || entries[0][0] !== query.task_id)) {
          return bad2("Pinned epochs must match the requested task_id.");
        }
        const runs = (await Promise.all(entries.map(([id, epoch]) => supervisor.pinned(id, epoch)))).flatMap((run) => run.output_state !== "evicted" ? [run] : []);
        const terminal_outputs = Object.fromEntries(runs.flatMap((run) => isTerminal(run.status) ? [[run.task_id, terminalOutput(run)]] : []));
        return result({ runs, startup_failures: [], terminal_outputs });
      }
    )
  ];
  return {
    definitions: registry.map((entry) => entry.definition),
    async call(name, args, listRoots) {
      try {
        const entry = registry.find((item) => item.definition.name === name);
        if (!entry) return bad2("Unknown tool name.");
        return await entry.invoke(args, listRoots);
      } catch (error) {
        return result(toErrorEnvelope(error), true);
      }
    }
  };
}

// src/mcp-server.ts
var versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var maxMessageBytes = 8 * 1024 * 1024;
var maxHeaderBytes = 8192;
var maxConcurrentRequests = 128;
var rootsTimeoutMs = 5e3;
var decoder4 = new TextDecoder("utf-8", { fatal: true });
var isId = (value) => value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
function stdioReader(message) {
  let buffer = Buffer.alloc(0), used = 0;
  let length, headerBytes = 0, readingBody = false;
  function append(bytes, max) {
    const next = used + bytes.length;
    if (next > max) return false;
    if (next > buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(max, Math.max(next, 1024, buffer.length * 2)));
      buffer.copy(grown, 0, 0, used);
      buffer = grown;
    }
    bytes.copy(buffer, used);
    used = next;
    return true;
  }
  function emit(framing) {
    const body = buffer.subarray(0, used);
    used = 0;
    message(body, framing);
    if (buffer.length > 65536) buffer = Buffer.alloc(0);
  }
  return (chunk) => {
    let at = 0;
    while (at < chunk.length) {
      if (readingBody) {
        const end2 = Math.min(chunk.length, at + length - used);
        if (!append(chunk.subarray(at, end2), maxMessageBytes)) return false;
        at = end2;
        if (used === length) {
          emit("length");
          length = void 0;
          headerBytes = 0;
          readingBody = false;
        }
        continue;
      }
      const newline = chunk.indexOf(10, at);
      const end = newline < 0 ? chunk.length : newline;
      if (!append(chunk.subarray(at, end), length === void 0 ? maxMessageBytes : maxHeaderBytes - headerBytes)) return false;
      if (newline < 0) break;
      at = newline + 1;
      const line = buffer.subarray(0, used);
      if (length === void 0 && !/^content-length:/i.test(line.toString("latin1", 0, 15))) {
        if (used === 0 || used === 1 && line[0] === 13) used = 0;
        else emit("line");
        continue;
      }
      headerBytes += used + 1;
      used = 0;
      if (headerBytes > maxHeaderBytes) return false;
      if (length === void 0) {
        const match = /^content-length:[ \t]*(\d+)[ \t]*\r$/i.exec(line.toString("latin1"));
        if (!match || Number(match[1]) > maxMessageBytes) return false;
        length = Number(match[1]);
      } else if (line.length === 1 && line[0] === 13) {
        if (length === 0) {
          emit("length");
          length = void 0;
          headerBytes = 0;
        } else readingBody = true;
      } else if (!/^(?!content-length:)[a-z0-9-]+:[\t\x20-\x7e]*\r$/i.test(line.toString("latin1"))) return false;
    }
    return true;
  };
}
async function packageVersion() {
  if (true) return "0.9.0";
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (!isObject(manifest) || typeof manifest.version !== "string") throw new Error("Package version is unavailable.");
  return manifest.version;
}
var appMime = "text/html;profile=mcp-app";
var apps = [
  { uri: CODEX_PANEL_URI, name: "Larva Subagents Panel", modes: CODEX_PANEL_DISPLAY_MODES, render: renderCodexPanelHtml },
  { uri: CODEX_WIDGET_URI, name: "Larva Subagents Widget", modes: CODEX_WIDGET_DISPLAY_MODES, render: renderCodexWidgetHtml }
].map(({ uri, name, modes, render }) => ({
  resource: {
    uri,
    name,
    mimeType: appMime,
    _meta: { ui: { prefersBorder: true }, "openai/ui": { preferredDisplayMode: modes[0], availableDisplayModes: modes } }
  },
  render
}));
async function runMcpServer(env = process.env) {
  const { stdin, stdout } = process;
  const home = env.HOME || homedir3();
  const path = env.PATH ? env.PATH.split(delimiter2) : [];
  for (const dir of [join11(home, ".local", "bin"), join11(home, ".pi", "agent", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!path.includes(dir) && (await stat7(dir).catch(() => void 0))?.isDirectory()) path.push(dir);
  }
  const supervisor = new SubagentSupervisor({
    env: { ...env, PATH: path.join(delimiter2) },
    ...import.meta.url.endsWith(".ts") && {
      extension: fileURLToPath2(new URL("./pi-extension.ts", import.meta.url)),
      preload: fileURLToPath2(new URL("./child-rpc-preload.ts", import.meta.url))
    }
  });
  const personas = new PersonaStore(supervisor.home);
  const tools = createMcpTools(supervisor, personas);
  let rootsSupported = false, inFlight = 0, stopping = false;
  let version;
  const stopped = Promise.withResolvers();
  const pendingRoots = /* @__PURE__ */ new Map();
  function stop() {
    if (stopping) return;
    stopping = true;
    stdin.pause();
    for (const settle of pendingRoots.values()) settle(void 0);
    void supervisor.shutdown().then(({ settled }) => stopped.resolve(settled ? 0 : 1), stopped.reject);
  }
  function send(message, framing) {
    if (stopping) return;
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    if (stdout.writableLength > maxMessageBytes) {
      stop();
      return;
    }
    stdout.write(framing === "length" ? `Content-Length: ${Buffer.byteLength(body)}\r
\r
${body}` : `${body}
`);
  }
  function rpcError(id, code, message, framing, data) {
    send({ id, error: { code, message, data } }, framing);
  }
  function listRoots(framing) {
    if (stopping) return Promise.resolve({ roots: [] });
    const id = `roots:${randomUUID5()}`;
    const reply = Promise.withResolvers();
    const timeout = setTimeout(reply.resolve, rootsTimeoutMs, void 0);
    pendingRoots.set(id, reply.resolve);
    send({ id, method: "roots/list" }, framing);
    return reply.promise.then((value) => {
      if (!isObject(value) || !Array.isArray(value.roots) || value.roots.length !== 1) return { roots: [] };
      const root = value.roots[0];
      return { roots: isObject(root) && typeof root.uri === "string" ? [{ uri: root.uri }] : [] };
    }).finally(() => {
      clearTimeout(timeout);
      pendingRoots.delete(id);
    });
  }
  async function dispatch(id, method, params, framing) {
    const invalid6 = (message) => rpcError(id, -32602, message, framing);
    let result2;
    switch (method) {
      case "initialize":
        rootsSupported = isObject(params.capabilities) && isObject(params.capabilities.roots);
        result2 = {
          protocolVersion: typeof params.protocolVersion === "string" && versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "larva-pi-subagent", title: "Larva Subagents", version: await (version ??= packageVersion()) },
          instructions: CODEX_INITIALIZE_INSTRUCTIONS
        };
        break;
      case "ping":
        result2 = {};
        break;
      case "tools/list":
        result2 = { tools: tools.definitions };
        break;
      case "tools/call": {
        if (typeof params.name !== "string") return invalid6("Expected a tool name.");
        result2 = await tools.call(
          params.name,
          params.arguments === void 0 ? {} : params.arguments,
          rootsSupported ? () => listRoots(framing) : void 0
        );
        break;
      }
      case "resources/templates/list":
        result2 = { resourceTemplates: [{ uriTemplate: CODEX_PERSONA_URI_TEMPLATE, name: "larva-persona", title: "Larva Persona", mimeType: "text/markdown" }] };
        break;
      case "resources/list":
        result2 = { resources: [...apps.map((app2) => app2.resource), ...(await personas.list()).map((persona) => ({
          uri: personaResourceUri(persona.id),
          name: persona.id,
          title: `@larva:${persona.id}`,
          mimeType: "text/markdown",
          description: persona.description
        }))] };
        break;
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string") return invalid6("Expected a resource URI.");
        const app2 = apps.find((entry) => entry.resource.uri === uri);
        if (app2) {
          const { mimeType, _meta } = app2.resource;
          result2 = { contents: [{ uri, mimeType, _meta, text: app2.render() }] };
          break;
        }
        const personaId = parsePersonaResourceUri(uri);
        if (!personaId) return invalid6("Unknown or invalid resource URI.");
        const spec = await personas.get(personaId);
        result2 = { contents: [{
          uri,
          mimeType: "text/markdown",
          text: `# @larva:${spec.id}

${spec.description}

- **persona_id**: \`${spec.id}\`
- **model**: \`${spec.model}\`
- **delegation**: Call \`larva_subagent\` with \`persona_id: "${spec.id}"\`.
`
        }] };
        break;
      }
      default:
        return rpcError(id, -32601, "Method not found", framing);
    }
    send({ id, result: result2 }, framing);
  }
  const onData = stdioReader((body, framing) => {
    if (stopping) return;
    let message;
    try {
      message = JSON.parse(decoder4.decode(body));
    } catch {
      return rpcError(null, -32700, "Parse error", framing);
    }
    if (!isObject(message) || message.jsonrpc !== "2.0" || Object.hasOwn(message, "id") && !isId(message.id)) {
      return rpcError(null, -32600, "Invalid Request", framing);
    }
    const { id, method, params } = message;
    if (!Object.hasOwn(message, "method")) {
      if (typeof id === "string") {
        const settle = pendingRoots.get(id);
        if (settle) {
          const hasResult = Object.hasOwn(message, "result"), hasError = Object.hasOwn(message, "error");
          pendingRoots.delete(id);
          settle(hasResult && !hasError ? message.result : void 0);
          return;
        }
      }
      if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
        rpcError(isId(id) ? id : null, -32600, "Invalid Request", framing);
      }
      return;
    }
    if (typeof method !== "string") return rpcError(isId(id) ? id : null, -32600, "Invalid Request", framing);
    if (!isId(id)) return;
    if (params !== void 0 && !isObject(params)) return rpcError(id, -32602, "Expected named parameters", framing);
    if (inFlight >= maxConcurrentRequests) return rpcError(id, -32e3, "Too many concurrent requests", framing);
    ++inFlight;
    void dispatch(id, method, params ?? {}, framing).catch((error) => {
      const { error: info } = toErrorEnvelope(error);
      const code = info.code === "LARVA_PERSONA_NOT_FOUND" ? -32002 : -32603;
      rpcError(id, code, info.message, framing, info);
    }).finally(() => {
      --inFlight;
    });
  });
  const feed = (chunk) => {
    if (!onData(chunk)) stop();
  };
  const signals = ["SIGTERM", "SIGINT"];
  for (const signal of signals) process.on(signal, stop);
  stdout.on("error", stop);
  stdin.on("end", stop).on("close", stop).on("error", stop).on("data", feed);
  if (stdin.readableEnded || stdin.destroyed) stop();
  try {
    return await stopped.promise;
  } finally {
    stdin.off("data", feed).off("end", stop).off("close", stop).off("error", stop);
    stdout.off("error", stop);
    for (const signal of signals) process.off(signal, stop);
  }
}
if (import.meta.main) {
  process.exit(await runMcpServer());
}
export {
  runMcpServer
};
