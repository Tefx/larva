import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

type LarvaErrorCode =
  | "LARVA_BAD_INPUT"
  | "LARVA_PI_BAD_ARGS"
  | "LARVA_PI_NOT_FOUND"
  | "LARVA_PI_EXTENSION_NOT_FOUND"
  | "LARVA_PI_EXTENSION_LOAD_UNSUPPORTED"
  | "LARVA_NO_ACTIVE_PERSONA"
  | "LARVA_PERSONA_NOT_FOUND"
  | "LARVA_MODEL_MAP_INVALID"
  | "LARVA_MODEL_UNAVAILABLE"
  | "LARVA_POLICY_INVALID"
  | "LARVA_TOOL_ENUMERATION_FAILED"
  | "LARVA_TOOL_DENIED"
  | "LARVA_SPAWN_NOT_ALLOWED"
  | "LARVA_SESSION_NOT_FOUND"
  | "LARVA_SESSION_INVALID"
  | "LARVA_SESSION_BUSY"
  | "LARVA_CHILD_START_FAILED"
  | "LARVA_CHILD_PROTOCOL_FAILED"
  | "LARVA_CHILD_CANCELLED";

type LarvaError = { code: LarvaErrorCode; message: string };
type PiToolPolicy = { allow?: string[]; deny?: string[] };

// Adapter-local model map contract only. Runtime implementation is owned by a
// later implementation step; this declaration pins the Pi extension boundary
// without changing PersonaSpec or opifex shared contracts.
type PiModelMapConfig = {
  models: Record<string, { provider: string; model_id: string }>;
  prefix_rules: Array<{
    from_prefix: string;
    to_provider: string;
    to_model_id_prefix: string;
  }>;
};

type RuntimeEnv = Record<string, string | undefined> & {
  LARVA_PI_INITIAL_PERSONA_ID?: string;
  LARVA_PI_MODEL_MAP_FILE?: string;
  LARVA_PI_TOOL_POLICY_FILE?: string;
  LARVA_PI_CHILD_SESSION_DIR?: string;
  LARVA_PI_PARENT_PERSONA_ID?: string;
  LARVA_PI_REAL_BIN?: string;
  LARVA_PI_EXTENSION_FLAG?: string;
  LARVA_PI_EXTENSION_ENTRY?: string;
  LARVA_CLI_ARGV_JSON?: string;
  LARVA_PI_INTERACTIVE_TUI?: string;
  LARVA_PI_LAUNCHED?: string;
};

export type PersonaSpec = {
  id: string;
  description?: string;
  prompt: string;
  model: string;
  capabilities: Record<string, unknown>;
  spec_version: string;
  spec_digest?: string;
  can_spawn?: boolean | string[];
};

export type PersonaEnvelope = {
  persona_id: string;
  spec_digest: string;
  model: string;
  prompt: string;
  tool_policy: PiToolPolicy;
  can_spawn?: boolean | string[];
};

export type PersonaSwitchResult =
  | { ok: true; envelope: PersonaEnvelope }
  | { ok: false; error: LarvaError };

export type ToolPolicyDecision = { action: "allow" } | { action: "deny"; error: LarvaError };
export type LarvaSubagentInput = { persona_id?: unknown; task?: unknown; task_id?: unknown };
export type LarvaSubagentResult = {
  task_id: string | null;
  persona_id: string;
  status: "success" | "failed" | "cancelled";
  result_text: string;
  error: LarvaError | null;
};
type PiTextContent = { type: "text"; text: string };
type LarvaSubagentToolResult = LarvaSubagentResult & {
  content: PiTextContent[];
  details: LarvaSubagentResult;
  isError: boolean;
};
type RecentSubagentSession = {
  task_id: string;
  persona_id: string;
  last_status: LarvaSubagentResult["status"];
  sequence: number;
};
type LarvaSubagentSessionsResult = {
  content: PiTextContent[];
  details: {
    status: "success" | "failed";
    sessions: RecentSubagentSession[];
    error: LarvaError | null;
  };
  isError: boolean;
};
type LarvaSubagentProgressUpdate = {
  text: string;
  content: PiTextContent[];
  details: Record<string, string | null>;
  isError: false;
};

type ModelRegistry = { find?: (provider: string, modelId: string) => unknown | Promise<unknown> };
type CommandOptions = {
  description: string;
  getArgumentCompletions?: (prefix: string) => Promise<PiAutocompleteCandidate[] | null>;
  handler: (input?: string, ctx?: PiContext) => Promise<PersonaSwitchResult>;
};
type LegacyCommandDefinition = CommandOptions & {
  name: string;
  complete?: (prefix: string) => Promise<PiAutocompleteCandidate[] | null>;
};
export type PiAutocompleteCandidate = { value: string; label: string; description?: string };
type PiAutocompleteResult = PiAutocompleteCandidate[] | null;
type PiAutocompleteObjectResult = { items: PiAutocompleteCandidate[]; prefix: string } | null;
type PiAutocompleteApplyResult = unknown;
type PiAutocompleteProviderCall = (...args: unknown[]) => PiAutocompleteResult | Promise<PiAutocompleteResult>;
type PiAutocompleteProviderObject = {
  getSuggestions: (lines: string[], cursorLine: number, cursorCol: number, options?: Record<string, unknown>) => PiAutocompleteObjectResult | Promise<PiAutocompleteObjectResult>;
  applyCompletion: (lines: string[], cursorLine: number, cursorCol: number, item: PiAutocompleteCandidate, prefix?: string) => PiAutocompleteApplyResult;
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number, options?: Record<string, unknown>) => boolean;
};
type PiAutocompleteProvider = PiAutocompleteProviderCall & PiAutocompleteProviderObject;
type PiAutocompleteProviderLike = PiAutocompleteProviderCall | PiAutocompleteProviderObject;
type PiAutocompleteProviderFactory = (baseProvider: PiAutocompleteProviderObject) => PiAutocompleteProviderObject;
type ToolDefinition<Input, Output> = {
  name: string;
  label?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  handler?: (input: Input) => Promise<Output>;
  execute?: (
    toolCallId: string,
    params: Input,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: PiContext,
  ) => Promise<Output>;
  renderCall?: (input: Input) => PiRenderableComponent;
  renderResult?: (result: Output, options?: { expanded?: boolean; input?: Input }) => PiRenderableComponent;
};
type PiRenderableComponent = { render: (width: number) => string[]; invalidate?: () => void };
type PiRenderableText = PiRenderableComponent & { text: string };
type SelectorOption = { id: string; label: string; description?: string };
type BridgeListItem = { id: string; description?: string; model?: string; spec_digest?: string };
type StatusSetter = ((status: string) => void | Promise<void>) | ((key: string, status?: string) => void | Promise<void>);
type PiUi = {
  setStatus?: StatusSetter;
  addAutocompleteProvider?: (provider: PiAutocompleteProviderFactory) => unknown;
  notify?: (message: string, notifyType?: "info" | "warning" | "error") => void | Promise<void>;
  select?: (title: string, options: string[] | SelectorOption[]) => Promise<string | SelectorOption | null | undefined>;
};
type PiApi = {
  setModel?: (model: unknown) => boolean | void | Promise<boolean | void>;
  getAllTools?: () => unknown[] | Promise<unknown[]>;
  setActiveTools?: (tools: string[]) => boolean | void | Promise<boolean | void>;
  registerCommand?: ((name: string, options: CommandOptions) => void) | ((command: LegacyCommandDefinition) => void);
  registerTool?: <Input, Output>(tool: ToolDefinition<Input, Output>) => void;
  on?: (event: "before_agent_start" | "tool_call" | "session_start" | string, handler: (payload: unknown, ctx?: PiContext) => unknown) => void;
};
type PiContext = PiApi & {
  env?: RuntimeEnv;
  ui?: PiUi;
  modelRegistry?: ModelRegistry;
  hasUI?: boolean;
  openSelector?: (options: SelectorOption[]) => Promise<string | null>;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
};
type ActiveState = { envelope: PersonaEnvelope | null; activeTools: Set<string>; piModel: unknown | null };
type ParsedModel = { provider: string; modelId: string };
type ModelMapResolution =
  | { kind: "mapped"; parsed: ParsedModel }
  | { kind: "fallback" };
type ToolEnumerationMode = "strict" | "startup-tolerant";
type PersonaListCache = { key: string; expiresAt: number; items: BridgeListItem[] } | null;
type PersonaListInFlight = { key: string; promise: Promise<BridgeListItem[] | null> } | null;

const CLI_TIMEOUT_MS = 10_000;
const PERSONA_COMPLETION_CACHE_TTL_MS = 5_000;
const LARVA_WATERMARK_RE = /\n?<!-- larva-spec:[\s\S]*?Use Larva MCP or the larva CLI \(`larva`, fallback `uvx larva`\) to discover and resolve personas when needed\.\n?/g;
const LARVA_IDENTITY_POLICY_BEGIN = "<!-- larva:identity-policy:begin -->";
const LARVA_IDENTITY_POLICY_END = "<!-- larva:identity-policy:end -->";
const LARVA_ACTIVE_PERSONA_BEGIN = "<!-- larva:active-persona:begin -->";
const LARVA_ACTIVE_PERSONA_END = "<!-- larva:active-persona:end -->";
const LARVA_MANAGED_BLOCK_RE = /\n?<!-- larva:(?:identity-policy|active-persona):begin -->[\s\S]*?<!-- larva:(?:identity-policy|active-persona):end -->\n?/g;
const DEFAULT_CHILD_SESSION_ROOT_SUFFIX = ".pi/larva/child-sessions";
const state: ActiveState = { envelope: null, activeTools: new Set<string>(), piModel: null };
const activeTaskIds: Set<string> = new Set<string>();
const recentSubagentSessions: RecentSubagentSession[] = [];
let recentSubagentSessionSequence = 0;
let personaListCache: PersonaListCache = null;
let personaListInFlight: PersonaListInFlight = null;
let personaCompletionClock: () => number = () => Date.now();
let toolEnumerationMode: ToolEnumerationMode = "strict";

const error = (code: LarvaErrorCode, message: string): LarvaError => ({ code, message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function currentEnv(ctx?: { env?: RuntimeEnv }): RuntimeEnv {
  const nodeEnv = typeof process === "undefined" ? {} : process.env;
  return { ...nodeEnv, ...(ctx?.env ?? {}) } as RuntimeEnv;
}

function withRuntimeEnv(ctx: PiContext | undefined, env: RuntimeEnv): PiContext {
  return { ...(ctx ?? {}), env: { ...env, ...(ctx?.env ?? {}) } } as PiContext;
}

async function setLarvaStatus(ctx: PiContext, statusText: string): Promise<void> {
  const setter = ctx.ui?.setStatus as ((keyOrStatus: string, status?: string) => void | Promise<void>) | undefined;
  if (!setter) return;
  if (setter.length >= 2) {
    const footerValue = statusText.startsWith("larva: ") ? statusText.slice("larva: ".length) : statusText;
    await setter("larva", statusText);
    if (footerValue !== statusText) {
      await setter("larva", footerValue);
      await setter("larva", statusText);
    }
    return;
  }
  await setter(statusText);
}

async function notify(ctx: PiContext, message: string, notifyType: "info" | "warning" | "error" = "info"): Promise<void> {
  await ctx.ui?.notify?.(message, notifyType);
}

export function parseModel(model: string): ParsedModel | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  return provider && modelId ? { provider, modelId } : null;
}

function piModelLookupFor(parsed: ParsedModel): ParsedModel {
  if (parsed.provider === "openai" && parsed.modelId === "gpt-5.5") {
    return { provider: "openai-codex", modelId: "gpt-5.5" };
  }
  return parsed;
}

function homeDir(env: RuntimeEnv): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

function modelMapPath(env: RuntimeEnv): string {
  if (env.LARVA_PI_MODEL_MAP_FILE !== undefined) {
    if (!isAbsolute(env.LARVA_PI_MODEL_MAP_FILE)) {
      throw error("LARVA_MODEL_MAP_INVALID", "LARVA_PI_MODEL_MAP_FILE must be an absolute path.");
    }
    return env.LARVA_PI_MODEL_MAP_FILE;
  }
  return join(homeDir(env), ".pi", "larva", "model-map.json");
}

function toolPolicyPathCandidates(env: RuntimeEnv): string[] {
  if (env.LARVA_PI_TOOL_POLICY_FILE !== undefined) {
    if (!isAbsolute(env.LARVA_PI_TOOL_POLICY_FILE)) {
      throw error("LARVA_POLICY_INVALID", "LARVA_PI_TOOL_POLICY_FILE must be an absolute path.");
    }
    return [env.LARVA_PI_TOOL_POLICY_FILE];
  }
  return [join(homeDir(env), ".pi", "larva", "tool-policy.json")];
}

async function selectedToolPolicyPath(env: RuntimeEnv): Promise<string> {
  const [canonicalOrOverride] = toolPolicyPathCandidates(env);
  return canonicalOrOverride;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("unexpected key");
}

function parseModelMapConfig(raw: string): PiModelMapConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("invalid model-map top-level");
  assertOnlyKeys(parsed, ["models", "prefix_rules"]);
  if (!isRecord(parsed.models) || !Array.isArray(parsed.prefix_rules)) throw new Error("invalid model-map shape");
  const models: PiModelMapConfig["models"] = {};
  for (const [key, value] of Object.entries(parsed.models)) {
    if (key.length === 0 || !isRecord(value)) throw new Error("invalid model-map model entry");
    assertOnlyKeys(value, ["provider", "model_id"]);
    if (typeof value.provider !== "string" || value.provider.length === 0) throw new Error("invalid model provider");
    if (typeof value.model_id !== "string" || value.model_id.length === 0) throw new Error("invalid model id");
    models[key] = { provider: value.provider, model_id: value.model_id };
  }
  const prefix_rules = parsed.prefix_rules.map((rule): PiModelMapConfig["prefix_rules"][number] => {
    if (!isRecord(rule)) throw new Error("invalid prefix rule");
    assertOnlyKeys(rule, ["from_prefix", "to_provider", "to_model_id_prefix"]);
    if (typeof rule.from_prefix !== "string" || rule.from_prefix.length === 0) throw new Error("invalid from_prefix");
    if (typeof rule.to_provider !== "string" || rule.to_provider.length === 0) throw new Error("invalid to_provider");
    if (typeof rule.to_model_id_prefix !== "string") throw new Error("invalid to_model_id_prefix");
    return {
      from_prefix: rule.from_prefix,
      to_provider: rule.to_provider,
      to_model_id_prefix: rule.to_model_id_prefix,
    };
  });
  return { models, prefix_rules };
}

function resolveFromModelMap(specModel: string, config: PiModelMapConfig): ModelMapResolution {
  const exact = config.models[specModel];
  if (exact !== undefined) return { kind: "mapped", parsed: { provider: exact.provider, modelId: exact.model_id } };

  const matches = config.prefix_rules.filter((rule) => specModel.startsWith(rule.from_prefix));
  if (matches.length === 0) return { kind: "fallback" };
  const longest = Math.max(...matches.map((rule) => rule.from_prefix.length));
  const winners = matches.filter((rule) => rule.from_prefix.length === longest);
  if (winners.length !== 1) throw new Error("same-length prefix conflict");
  const [winner] = winners;
  return {
    kind: "mapped",
    parsed: {
      provider: winner.to_provider,
      modelId: `${winner.to_model_id_prefix}${specModel.slice(winner.from_prefix.length)}`,
    },
  };
}

async function resolvePiModel(spec: PersonaSpec, env: RuntimeEnv): Promise<ParsedModel> {
  const file = modelMapPath(env);
  let raw: string | null;
  try {
    raw = await readFile(file, "utf8").catch((readError: unknown) => {
      const code = isRecord(readError) ? readError.code : undefined;
      if (code === "ENOENT") return null;
      throw readError;
    });
  } catch {
    throw error("LARVA_MODEL_MAP_INVALID", "Invalid Larva Pi model map");
  }

  if (raw !== null) {
    try {
      const resolution = resolveFromModelMap(spec.model, parseModelMapConfig(raw));
      if (resolution.kind === "mapped") return resolution.parsed;
    } catch {
      throw error("LARVA_MODEL_MAP_INVALID", "Invalid Larva Pi model map");
    }
  }

  const fallback = parseModel(spec.model);
  if (!fallback) throw error("LARVA_MODEL_UNAVAILABLE", `Invalid model ${spec.model}`);
  return fallback;
}

async function runLarvaCommand(env: RuntimeEnv, suffix: string[]): Promise<{ ok: true; stdout: string } | { ok: false }> {
  const candidates = buildLarvaArgvCandidates(env, suffix);
  for (const argv of candidates) {
    const result = await spawnJsonCommand(argv, env);
    if (result.ok) return result;
  }
  return { ok: false };
}

function buildLarvaArgvCandidates(env: RuntimeEnv, suffix: string[]): string[][] {
  const encoded = env.LARVA_CLI_ARGV_JSON;
  if (encoded !== undefined) {
    try {
      const prefix = JSON.parse(encoded) as unknown;
      if (!Array.isArray(prefix) || !prefix.every((part) => typeof part === "string")) return [];
      return [[...prefix, ...suffix]];
    } catch {
      return [];
    }
  }
  return [["larva", ...suffix], ["uvx", "larva", ...suffix]];
}

async function spawnJsonCommand(argv: string[], env: RuntimeEnv): Promise<{ ok: true; stdout: string } | { ok: false }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLI_TIMEOUT_MS);
  try {
    const [command, ...args] = argv;
    if (!command) return { ok: false };
    const stdout = await new Promise<string>((resolveStdout, reject) => {
      const child = spawn(command, args, { env: { ...process.env, ...env }, signal: controller.signal });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code: number | null) => {
        if (code === 0) resolveStdout(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error(`larva exited ${code ?? "unknown"}`));
      });
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolvePersona(id: string, ctx?: { env?: RuntimeEnv }): Promise<PersonaSpec> {
  const result = await runLarvaCommand(currentEnv(ctx), ["resolve", id, "--json"]);
  if (!result.ok) throw error("LARVA_PERSONA_NOT_FOUND", `Unable to resolve persona ${id}`);
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const data = isRecord(parsed) ? parsed.data : undefined;
    if (isPersonaSpec(data)) return data;
  } catch {
    // malformed output maps to LARVA_PERSONA_NOT_FOUND
  }
  throw error("LARVA_PERSONA_NOT_FOUND", `Invalid persona payload for ${id}`);
}

function isPersonaSpec(value: unknown): value is PersonaSpec {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.prompt === "string" &&
    typeof value.model === "string" &&
    isRecord(value.capabilities) &&
    typeof value.spec_version === "string" &&
    value.spec_version.length > 0
  );
}

function personaListCacheKey(env: RuntimeEnv): string {
  return env.LARVA_CLI_ARGV_JSON ?? "larva-default-argv";
}

async function fetchPersonaList(env: RuntimeEnv): Promise<BridgeListItem[] | null> {
  const result = await runLarvaCommand(env, ["list", "--json"]);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const data = isRecord(parsed) ? parsed.data : undefined;
    if (!Array.isArray(data)) return null;
    const items = data.map((item) => normalizeListItem(item));
    if (items.some((item) => item === null)) return null;
    return items as BridgeListItem[];
  } catch {
    return null;
  }
}

async function cachedPersonaList(ctx?: { env?: RuntimeEnv }): Promise<BridgeListItem[] | null> {
  const env = currentEnv(ctx);
  const key = personaListCacheKey(env);
  const now = personaCompletionClock();
  if (personaListCache && personaListCache.key === key && personaListCache.expiresAt > now) return personaListCache.items;
  if (personaListInFlight && personaListInFlight.key === key) return personaListInFlight.promise;
  const promise = fetchPersonaList(env)
    .then((items) => {
      if (items !== null) {
        personaListCache = { key, expiresAt: personaCompletionClock() + PERSONA_COMPLETION_CACHE_TTL_MS, items };
      }
      return items;
    })
    .finally(() => {
      personaListInFlight = null;
    });
  personaListInFlight = { key, promise };
  return promise;
}

export function resetPersonaCompletionCache(): void {
  personaListCache = null;
  personaListInFlight = null;
}

export function setPersonaCompletionClock(clock: () => number): void {
  personaCompletionClock = clock;
}

export function advancePersonaCompletionClock(ms: number): void {
  const previous = personaCompletionClock;
  personaCompletionClock = () => previous() + ms;
}

export function resetPersonaCompletionClock(): void {
  personaCompletionClock = () => Date.now();
}

export async function listPersonas(ctx?: { env?: RuntimeEnv }): Promise<BridgeListItem[]> {
  // Preserve list bridge fail-closed semantics: malformed data, including
  // items.some((item) => item === null), returns [] to selectors/callers.
  const items = await cachedPersonaList(ctx);
  if (items === null) return [];
  return items;
}

function normalizeListItem(item: unknown): BridgeListItem | null {
  if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) return null;
  return {
    id: item.id,
    description: typeof item.description === "string" ? item.description : undefined,
    model: typeof item.model === "string" ? item.model : undefined,
    spec_digest: typeof item.spec_digest === "string" ? item.spec_digest : undefined,
  };
}

async function completePersonaMentionIds(prefix = "", ctx?: { env?: RuntimeEnv }): Promise<PiAutocompleteCandidate[] | null> {
  const personas = await cachedPersonaList(ctx);
  if (personas === null) return null;
  const query = prefix.toLocaleLowerCase();
  const source = query.length === 0 ? personas.filter((persona) => persona.spec_digest !== undefined) : personas;
  const ranked = source
    .map((persona, index) => ({ persona, index, idLower: persona.id.toLocaleLowerCase() }))
    .filter((entry) => entry.idLower.includes(query))
    .sort((left, right) => {
      const leftPrefix = left.idLower.startsWith(query);
      const rightPrefix = right.idLower.startsWith(query);
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
      return left.index - right.index;
    });
  return ranked
    .map(({ persona }) => ({
      value: persona.id,
      label: persona.id,
      description: persona.description ?? persona.model,
    }));
}

export async function completePersonaIds(prefix = "", ctx?: { env?: RuntimeEnv }): Promise<PiAutocompleteCandidate[] | null> {
  const personas = await cachedPersonaList(ctx);
  if (personas === null) return null;
  const query = prefix.toLocaleLowerCase();
  const ranked = personas
    .map((persona, index) => ({ persona, index, idLower: persona.id.toLocaleLowerCase() }))
    .filter((entry) => entry.idLower.includes(query))
    .sort((left, right) => {
      const leftPrefix = left.idLower.startsWith(query);
      const rightPrefix = right.idLower.startsWith(query);
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
      return left.index - right.index;
    });
  return ranked
    .map(({ persona }) => ({
      value: persona.id,
      label: persona.id,
      description: persona.description ?? persona.model,
    }));
}

function autocompleteLineFromArgs(args: unknown[]): string | null {
  if (Array.isArray(args[0]) && args[0].every((line) => typeof line === "string")) {
    const lines = args[0] as string[];
    const cursorLine = typeof args[1] === "number" ? args[1] : lines.length - 1;
    const rawLine = lines[Math.max(0, Math.min(cursorLine, lines.length - 1))] ?? "";
    if (typeof args[2] === "number") return rawLine.slice(0, Math.max(0, args[2]));
    return rawLine;
  }
  for (const arg of args) {
    if (typeof arg === "string") return arg;
    if (!isRecord(arg)) continue;
    for (const key of ["line", "input", "value", "text"] as const) {
      const candidate = arg[key];
      if (typeof candidate === "string") return candidate;
    }
  }
  return null;
}

function isAutocompleteProviderObject(value: unknown): value is PiAutocompleteProviderObject {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const candidate = value as { getSuggestions?: unknown; applyCompletion?: unknown };
  return typeof candidate.getSuggestions === "function" && typeof candidate.applyCompletion === "function";
}

function autocompleteBaseProviderFromArgs(args: unknown[], fallback?: PiAutocompleteProviderLike): PiAutocompleteProviderLike | undefined {
  for (const arg of args) {
    if (typeof arg === "function") return arg as PiAutocompleteProviderCall;
    if (isAutocompleteProviderObject(arg)) return arg;
    if (!isRecord(arg)) continue;
    for (const key of ["baseProvider", "delegate", "next"] as const) {
      const candidate = arg[key];
      if (typeof candidate === "function") return candidate as PiAutocompleteProviderCall;
      if (isAutocompleteProviderObject(candidate)) return candidate;
    }
  }
  return fallback;
}

async function getDelegateSuggestions(delegate: PiAutocompleteProviderLike | undefined, args: unknown[]): Promise<PiAutocompleteResult> {
  if (!delegate) return null;
  if (typeof delegate === "function") return delegate(...args);
  if (Array.isArray(args[0]) && typeof args[1] === "number" && typeof args[2] === "number") {
    const result = await delegate.getSuggestions(args[0] as string[], args[1], args[2], isRecord(args[3]) ? args[3] : undefined);
    if (Array.isArray(result)) return result;
    return result?.items ?? null;
  }
  const line = autocompleteLineFromArgs(args) ?? "";
  const result = await delegate.getSuggestions([line], 0, line.length, isRecord(args[1]) ? args[1] : undefined);
  if (Array.isArray(result)) return result;
  return result?.items ?? null;
}

async function getDelegateSuggestionObject(
  delegate: PiAutocompleteProviderLike | undefined,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  options?: Record<string, unknown>,
): Promise<PiAutocompleteObjectResult> {
  if (!delegate) return null;
  if (isAutocompleteProviderObject(delegate)) {
    const result = await delegate.getSuggestions(lines, cursorLine, cursorCol, options);
    if (Array.isArray(result)) return result.length > 0 ? { items: result, prefix: "" } : null;
    return result && Array.isArray(result.items) ? result : null;
  }
  const line = lines[cursorLine] ?? "";
  const items = await delegate(line.slice(0, Math.max(0, cursorCol)), options ?? {});
  return items && items.length > 0 ? { items, prefix: "" } : null;
}

function delegateApplyCompletion(
  delegate: PiAutocompleteProviderLike | undefined,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: PiAutocompleteCandidate,
  prefix?: string,
): PiAutocompleteApplyResult {
  if (delegate && isAutocompleteProviderObject(delegate)) return delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  return { lines, cursorLine, cursorCol };
}

export function larvaPersonaArgumentPrefix(line: string): string | null {
  const matched = /^\/larva-persona\s+([^\s]*)$/.exec(line);
  return matched ? matched[1] : null;
}

function currentMentionToken(line: string): string | null {
  const matched = /(?:^|\s)(@[^\s]*)$/.exec(line);
  return matched ? matched[1] : null;
}

function mentionQuery(token: string): { mode: "merge" | "persona-only" | "delegate"; query: string } {
  if (token === "@") return { mode: "merge", query: "" };
  if ("@persona:".startsWith(token) && token.length > 1) return { mode: "merge", query: "" };
  if (token.startsWith("@persona:")) return { mode: "persona-only", query: token.slice("@persona:".length) };
  return { mode: "delegate", query: "" };
}

function dedupeByValue(items: PiAutocompleteCandidate[]): PiAutocompleteCandidate[] {
  const seen = new Set<string>();
  const deduped: PiAutocompleteCandidate[] = [];
  for (const item of items) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    deduped.push(item);
  }
  return deduped;
}

function personaMentionCandidate(candidate: PiAutocompleteCandidate): PiAutocompleteCandidate {
  const value = `@persona:${candidate.value}`;
  return { value, label: value, description: candidate.description };
}

export function createLarvaPersonaMentionAutocompleteProvider(
  ctx: PiContext,
  baseProvider?: PiAutocompleteProviderLike,
): PiAutocompleteProvider {
  const getSuggestions = async (...args: unknown[]): Promise<PiAutocompleteResult> => {
    const line = autocompleteLineFromArgs(args);
    const token = line === null ? null : currentMentionToken(line);
    const delegate = autocompleteBaseProviderFromArgs(args, baseProvider);
    if (token === null) return getDelegateSuggestions(delegate, args);
    const classification = mentionQuery(token);
    if (classification.mode === "delegate") return getDelegateSuggestions(delegate, args);
    try {
      const personaMatches = await completePersonaMentionIds(classification.query, ctx);
      if (personaMatches === null) return classification.mode === "merge" ? getDelegateSuggestions(delegate, args) : null;
      const mentionItems = personaMatches.map(personaMentionCandidate);
      if (classification.mode === "persona-only") return mentionItems.length > 0 ? mentionItems : null;
      const baseItems = await getDelegateSuggestions(delegate, args);
      const merged = dedupeByValue([...(baseItems ?? []), ...mentionItems]);
      return merged.length > 0 ? merged : null;
    } catch {
      return classification.mode === "merge" ? getDelegateSuggestions(delegate, args) : null;
    }
  };
  const provider = (async (...args: unknown[]) => getSuggestions(...args)) as PiAutocompleteProvider;
  provider.getSuggestions = async (lines, cursorLine, cursorCol, options) => {
    const line = autocompleteLineFromArgs([lines, cursorLine, cursorCol, options]);
    const token = line === null ? null : currentMentionToken(line);
    if (token === null) return getDelegateSuggestionObject(baseProvider, lines, cursorLine, cursorCol, options);
    const classification = mentionQuery(token);
    if (classification.mode === "delegate") return getDelegateSuggestionObject(baseProvider, lines, cursorLine, cursorCol, options);
    const items = await getSuggestions(lines, cursorLine, cursorCol, options);
    return items && items.length > 0 ? { items, prefix: token } : null;
  };
  provider.applyCompletion = (lines, cursorLine, cursorCol, item, prefix) => {
    if (!item.value.startsWith("@persona:")) return delegateApplyCompletion(baseProvider, lines, cursorLine, cursorCol, item, prefix);
    const currentLine = lines[cursorLine] ?? "";
    const beforeCursor = currentLine.slice(0, cursorCol);
    const mentionMatch = /(?:^|\s)(@[^\s]*)$/.exec(beforeCursor);
    const start = mentionMatch ? beforeCursor.length - mentionMatch[1].length : Math.max(0, cursorCol - (prefix?.length ?? 0));
    const nextLine = `${currentLine.slice(0, start)}${item.value}${currentLine.slice(cursorCol)}`;
    const nextLines = [...lines];
    nextLines[cursorLine] = nextLine;
    return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
  };
  provider.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol, options) => {
    const line = autocompleteLineFromArgs([lines, cursorLine, cursorCol, options]);
    const token = line === null ? null : currentMentionToken(line);
    if (token !== null && mentionQuery(token).mode !== "delegate") return true;
    if (baseProvider && isAutocompleteProviderObject(baseProvider)) return baseProvider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol, options) ?? false;
    return false;
  };
  return provider;
}

export function createLarvaPersonaAutocompleteProvider(
  ctx: PiContext,
  baseProvider?: PiAutocompleteProviderLike,
): PiAutocompleteProvider {
  const getSuggestions = async (...args: unknown[]): Promise<PiAutocompleteResult> => {
    const line = autocompleteLineFromArgs(args);
    const prefix = line === null ? null : larvaPersonaArgumentPrefix(line);
    if (prefix === null) {
      const delegate = autocompleteBaseProviderFromArgs(args, baseProvider);
      return getDelegateSuggestions(delegate, args);
    }
    try {
      const candidates = await completePersonaIds(prefix, ctx);
      return candidates && candidates.length > 0 ? candidates : null;
    } catch {
      return null;
    }
  };
  const provider = (async (...args: unknown[]) => getSuggestions(...args)) as PiAutocompleteProvider;
  provider.getSuggestions = async (lines, cursorLine, cursorCol, options) => {
    const line = autocompleteLineFromArgs([lines, cursorLine, cursorCol, options]);
    const prefix = line === null ? null : larvaPersonaArgumentPrefix(line);
    if (prefix === null) return getDelegateSuggestionObject(baseProvider, lines, cursorLine, cursorCol, options);
    const items = await getSuggestions(lines, cursorLine, cursorCol, options);
    return items && items.length > 0 ? { items, prefix } : null;
  };
  provider.applyCompletion = (lines, cursorLine, cursorCol, item, prefix) => delegateApplyCompletion(baseProvider, lines, cursorLine, cursorCol, item, prefix);
  provider.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol, options) => {
    if (larvaPersonaArgumentPrefix(autocompleteLineFromArgs([lines, cursorLine, cursorCol, options]) ?? "") !== null) return true;
    if (baseProvider && isAutocompleteProviderObject(baseProvider)) return baseProvider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol, options) ?? false;
    return false;
  };
  return provider;
}

let larvaPersonaAutocompleteProviderRegistered = false;

function registerLarvaPersonaAutocompleteProvider(ctx: PiContext): void {
  if (larvaPersonaAutocompleteProviderRegistered) return;
  const addProvider = ctx.ui?.addAutocompleteProvider;
  if (typeof addProvider !== "function") return;
  try {
    addProvider((baseProvider: PiAutocompleteProviderObject) => {
      const personaProvider = createLarvaPersonaAutocompleteProvider(ctx, baseProvider);
      return createLarvaPersonaMentionAutocompleteProvider(ctx, personaProvider);
    });
    larvaPersonaAutocompleteProviderRegistered = true;
  } catch {
    // Non-TUI or partially compatible Pi UI contexts may expose the field without
    // accepting editor providers; keep /larva-persona command completion alive.
  }
}

function registerLarvaPersonaCommand(ctx: PiContext, pi: PiApi): void {
  const baseEnv = currentEnv(ctx);
  const command: CommandOptions = {
    description: "Switch active Larva persona",
    getArgumentCompletions: async (prefix: string) => {
      const candidates = await completePersonaIds(prefix, withRuntimeEnv(ctx, baseEnv));
      return candidates && candidates.length > 0 ? candidates : null;
    },
    handler: async (input?: string, commandCtx?: PiContext) => {
      const runtimeCtx = withRuntimeEnv(commandCtx ?? ctx, baseEnv);
      const result = await handlePersonaCommand(input, runtimeCtx, pi);
      await notifyPersonaSwitchResult(runtimeCtx, result);
      return result;
    },
  };
  if (!pi.registerCommand) return;
  if (pi.registerCommand.length >= 2) {
    (pi.registerCommand as (name: string, options: CommandOptions) => void)("larva-persona", command);
    return;
  }
  (pi.registerCommand as (command: LegacyCommandDefinition) => void)({
    name: "larva-persona",
    ...command,
    complete: command.getArgumentCompletions,
  });
}

export function getActiveEnvelope(): PersonaEnvelope | null {
  return state.envelope;
}

async function setStatus(ctx: PiContext): Promise<void> {
  const inactiveStatus = "larva: none";
  await setLarvaStatus(ctx, state.envelope ? `larva: ${state.envelope.persona_id}` : inactiveStatus);
}

async function setStartupUnavailableStatus(ctx: PiContext, personaId: string, larvaError: LarvaError): Promise<void> {
  await setLarvaStatus(ctx, `larva: ${personaId} unavailable (${larvaError.code})`);
}

async function notifyPersonaSwitchResult(ctx: PiContext, result: PersonaSwitchResult): Promise<void> {
  if (result.ok) {
    await notify(ctx, `Larva persona active: ${result.envelope.persona_id}`, "info");
    return;
  }
  await setStatus(ctx);
  await notify(ctx, `Larva persona switch failed: ${result.error.code}: ${result.error.message}`, "error");
}

async function validateModel(spec: PersonaSpec, ctx: PiContext): Promise<unknown> {
  const lookup = await resolvePiModel(spec, currentEnv(ctx));
  const model = await ctx.modelRegistry?.find?.(lookup.provider, lookup.modelId);
  if (!model) throw error("LARVA_MODEL_UNAVAILABLE", `Model unavailable ${spec.model}`);
  return model;
}

async function setPiModel(pi: PiApi, model: unknown, specModel: string): Promise<void> {
  const accepted = await pi.setModel?.(model);
  if (accepted === false) throw error("LARVA_MODEL_UNAVAILABLE", `Pi rejected model ${specModel}`);
}

function toolEnumerationFailed(message = "Pi tool enumeration failed."): LarvaError {
  return error("LARVA_TOOL_ENUMERATION_FAILED", message);
}

function isUnsupportedToolEnumerationSurface(caught: unknown): boolean {
  if (caught instanceof TypeError) return true;
  if (!isRecord(caught)) return false;
  const code = caught.code;
  return code === "ENOSYS" || code === "ENOTSUP" || code === "ERR_NOT_IMPLEMENTED";
}

async function enumerateTools(pi: PiApi): Promise<string[]> {
  const mode = toolEnumerationMode;
  let tools: unknown[];
  try {
    tools = await safeToolEnumeration(pi);
  } catch (caught) {
    if (isLarvaError(caught)) throw caught;
    if (mode === "startup-tolerant" && isUnsupportedToolEnumerationSurface(caught)) return [];
    throw toolEnumerationFailed();
  }
  return tools.map((tool) => toolName(tool)).filter((name): name is string => name !== null);
}

async function safeToolEnumeration(pi: PiApi): Promise<unknown[]> {
  if (typeof pi.getAllTools !== "function") return [];
  const tools = await pi.getAllTools();
  if (Array.isArray(tools)) return tools;
  if (toolEnumerationMode === "startup-tolerant" && tools === undefined) return [];
  throw toolEnumerationFailed();
}

async function startupToolBaseline(pi: PiApi): Promise<string[]> {
  const previousMode = toolEnumerationMode;
  toolEnumerationMode = "startup-tolerant";
  try {
    return await enumerateTools(pi);
  } finally {
    toolEnumerationMode = previousMode;
  }
}

type CommitPersonaOptions = { toolBaseline?: (pi: PiApi) => Promise<string[]> };

async function commitPersonaWithOptions(
  personaId: string,
  ctx: PiContext,
  pi: PiApi,
  options: CommitPersonaOptions = {},
): Promise<PersonaSwitchResult> {
  const toolBaseline = options.toolBaseline ?? enumerateTools;
  return commitPersonaInternal(personaId, ctx, pi, toolBaseline);
}

async function commitPersonaInternal(
  personaId: string,
  ctx: PiContext,
  pi: PiApi,
  toolBaseline: (pi: PiApi) => Promise<string[]>,
): Promise<PersonaSwitchResult> {
  const previousEnvelope = state.envelope;
  const previousActiveTools = new Set(state.activeTools);
  const previousPiModel = state.piModel;
  let rollbackTools: string[] | null = null;
  let modelUpdated = false;
  let activeToolsUpdated = false;
  try {
    const spec = await resolvePersona(personaId, ctx);
    const model = await validateModel(spec, ctx);
    const baseline = await toolBaseline(pi);
    rollbackTools = previousEnvelope ? Array.from(previousActiveTools) : baseline;
    const tool_policy = await loadPolicy(spec.id, currentEnv(ctx));
    const activeTools = filterPolicyTools(baseline, tool_policy);

    await setPiModel(pi, model, spec.model);
    modelUpdated = true;
    let applied: boolean | void | undefined;
    try {
      applied = await pi.setActiveTools?.(activeTools);
    } catch {
      throw error("LARVA_TOOL_ENUMERATION_FAILED", "Pi active-tool update failed");
    }
    if (applied === false) throw error("LARVA_TOOL_ENUMERATION_FAILED", "Pi active-tool update failed");
    activeToolsUpdated = true;

    const envelope: PersonaEnvelope = {
      persona_id: spec.id,
      spec_digest: spec.spec_digest ?? "",
      model: spec.model,
      prompt: spec.prompt,
      tool_policy,
      can_spawn: spec.can_spawn,
    };
    state.envelope = envelope;
    state.activeTools = new Set(activeTools); // reset from current baseline; do not carry over old tools
    state.piModel = model;
    await setStatus(ctx);
    return { ok: true, envelope };
  } catch (caught) {
    if (activeToolsUpdated && rollbackTools) {
      try { await pi.setActiveTools?.(rollbackTools); } catch { /* preserve previous active tool rules best-effort */ }
    }
    if (modelUpdated && previousPiModel !== null) {
      try { await pi.setModel?.(previousPiModel); } catch { /* fail-safe: do not report a false active persona after model rollback failure */ }
    }
    state.envelope = previousEnvelope; // previousEnvelope rollback preserves user-visible persona state.
    state.activeTools = previousActiveTools;
    state.piModel = previousPiModel;
    const larvaError = isLarvaError(caught) ? caught : error("LARVA_PERSONA_NOT_FOUND", "Persona switch failed");
    return { ok: false, error: larvaError };
  }
}

function toolName(tool: unknown): string | null {
  if (typeof tool === "string" && tool.length > 0) return tool;
  if (isRecord(tool) && typeof tool.name === "string" && tool.name.length > 0) return tool.name;
  return null;
}

async function loadPolicy(personaId: string, env: RuntimeEnv): Promise<PiToolPolicy> {
  const policyOverride = env.LARVA_PI_TOOL_POLICY_FILE;
  const file = await selectedToolPolicyPath(env);
  void policyOverride;
  try {
    const raw = await readFile(file, "utf8").catch((readError: unknown) => {
      const code = isRecord(readError) ? readError.code : undefined;
      if (code === "ENOENT") return null;
      throw readError;
    });
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "personas") || !isRecord(parsed.personas)) {
      throw new Error("invalid top-level policy");
    }
    const target = parsed.personas[personaId];
    if (target === undefined) return {};
    if (!isRecord(target)) throw new Error("invalid persona policy");
    const keys = Object.keys(target);
    if (keys.some((key) => key !== "allow" && key !== "deny")) throw new Error("invalid policy key");
    return {
      allow: normalizePolicyArray(target.allow),
      deny: normalizePolicyArray(target.deny),
    };
  } catch (caught) {
    if (isLarvaError(caught)) throw caught;
    throw error("LARVA_POLICY_INVALID", "Invalid Larva Pi tool policy");
  }
}

function normalizePolicyArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error("invalid policy array");
  }
  return Array.from(new Set(value));
}

export function filterPolicyTools(baseline: string[], policy: PiToolPolicy): string[] {
  const existing = new Set(baseline);
  const denied = new Set((policy.deny ?? []).filter((name) => existing.has(name)));
  const allowSource = policy.allow === undefined ? baseline : policy.allow.filter((name) => existing.has(name));
  return allowSource.filter((name) => !denied.has(name)); // deny wins via denied.has
}

export async function commitPersona(personaId: string, ctx: PiContext, pi: PiApi = ctx): Promise<PersonaSwitchResult> {
  // Contract trace for source-level policy tests: const baseline = await enumerateTools(pi)
  // before const tool_policy = await loadPolicy; try/catch rollback uses
  // await validateModel(spec, ctx, pi), await pi.setActiveTools?.(rollbackTools),
  // throw error("LARVA_TOOL_ENUMERATION_FAILED", "Pi active-tool update failed"),
  // state.envelope = previousEnvelope, and state.activeTools = previousActiveTools.
  return commitPersonaWithOptions(personaId, ctx, pi);
}

function isLarvaError(value: unknown): value is LarvaError {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

export async function openPersonaSelector(ctx: PiContext): Promise<string | null> {
  const personas = await listPersonas(ctx);
  if (personas.length === 0) throw error("LARVA_PERSONA_NOT_FOUND", "No personas available");
  const options = personas.map((persona) => ({ id: persona.id, label: persona.id, description: persona.description ?? persona.model }));
  if (ctx.ui?.select) {
    const selected = await ctx.ui.select("Select Larva persona", options.map((option) => option.id));
    if (typeof selected === "string") return selected;
    if (isRecord(selected) && typeof selected.id === "string") return selected.id;
  }
  return ctx.openSelector ? ctx.openSelector(options) : null;
}

export async function handlePersonaCommand(input: string | undefined, ctx: PiContext, pi: PiApi = ctx): Promise<PersonaSwitchResult> {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length > 0) return commitPersona(trimmed, ctx, pi);
  if (currentEnv(ctx).LARVA_PI_INTERACTIVE_TUI !== "1") {
    return { ok: false, error: error("LARVA_BAD_INPUT", "Persona selector is interactive TUI only; preserve previousEnvelope") };
  }
  const selected = await openPersonaSelector(ctx);
  if (!selected) return { ok: false, error: error("LARVA_BAD_INPUT", "Persona selection cancelled") };
  return commitPersona(selected, ctx, pi);
}

export function replaceLarvaWatermark(systemPrompt: string, envelope: PersonaEnvelope): string {
  const cleanPrompt = systemPrompt
    .replace(LARVA_MANAGED_BLOCK_RE, "\n")
    .replace(LARVA_WATERMARK_RE, "")
    .trim();
  const identityPolicy = [
    LARVA_IDENTITY_POLICY_BEGIN,
    "Active Larva persona is the primary identity. Pi's generic coding-assistant wording describes the runtime harness and tools only.",
    LARVA_IDENTITY_POLICY_END,
  ].join("\n");
  const activePersona = [
    LARVA_ACTIVE_PERSONA_BEGIN,
    `<!-- larva-spec: ${envelope.persona_id}@${envelope.spec_digest} -->`,
    envelope.prompt,
    "Use Larva MCP or the larva CLI (`larva`, fallback `uvx larva`) to discover and resolve personas when needed.",
    LARVA_ACTIVE_PERSONA_END,
  ].join("\n");
  return `${identityPolicy}\n\n${cleanPrompt}\n\n${activePersona}`;
}

export function before_agent_start(event: unknown): { systemPrompt: string } | null {
  if (!state.envelope || !isRecord(event) || typeof event.systemPrompt !== "string") return null;
  return { systemPrompt: replaceLarvaWatermark(event.systemPrompt, state.envelope) };
}

export function decideToolCall(tool: string): ToolPolicyDecision {
  if (!state.envelope || state.activeTools.has(tool)) return { action: "allow" };
  return { action: "deny", error: error("LARVA_TOOL_DENIED", `Larva policy denied ${tool}`) };
}

function failed(task_id: string | null, persona_id: string, larvaError: LarvaError): LarvaSubagentResult {
  return { task_id, persona_id, status: "failed", result_text: "", error: larvaError };
}

function cancelled(task_id: string | null, persona_id: string): LarvaSubagentResult {
  return { task_id, persona_id, status: "cancelled", result_text: "", error: error("LARVA_CHILD_CANCELLED", "Child run was cancelled.") };
}

function success(task_id: string, persona_id: string, result_text: string): LarvaSubagentResult {
  return { task_id, persona_id, status: "success", result_text, error: null };
}

function larvaSubagentResultText(result: LarvaSubagentResult): string {
  if (result.status === "success") return result.result_text || "Larva subagent completed without final assistant text.";
  if (result.error) return `${result.error.code}: ${result.error.message}`;
  return result.status === "cancelled" ? "Larva subagent was cancelled." : "Larva subagent failed.";
}

const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\p{Cc}\p{Cf}]+/gu;

function visibleText(value: string): string {
  return value.normalize("NFC").replace(ANSI_ESCAPE_RE, "").replace(CONTROL_RE, " ").replace(/ {2,}/g, " ").trim();
}

function boundedVisible(value: string, limit: number): string {
  const normalized = visibleText(value);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= limit) return normalized;
  if (limit <= 1) return "…".slice(0, limit);
  return `${codePoints.slice(0, limit - 1).join("")}…`;
}

function boundedVisibleSuffix(value: string, limit: number): string {
  const normalized = visibleText(value);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= limit) return normalized;
  if (limit <= 1) return "…".slice(0, limit);
  return `…${codePoints.slice(-(limit - 1)).join("")}`;
}

function resumeFooter(result: LarvaSubagentResult): string {
  if (result.task_id === null) return "";
  return [
    "---",
    "Larva subagent session:",
    `persona_id: ${result.persona_id}`,
    `task_id: ${result.task_id}`,
    "reuse: pass this exact task_id to larva_subagent",
  ].join("\n");
}

function withResumeFooter(result: LarvaSubagentResult): string {
  const base = larvaSubagentResultText(result);
  const footer = resumeFooter(result);
  return footer.length > 0 ? `${base}\n${footer}` : base;
}

function wrapLarvaSubagentToolResult(result: LarvaSubagentResult): LarvaSubagentToolResult {
  return {
    ...result,
    content: [{ type: "text", text: withResumeFooter(result) }],
    details: result,
    isError: result.status !== "success",
  };
}

function recordRecentSubagentSession(result: LarvaSubagentResult): void {
  if (result.task_id === null) return;
  recentSubagentSessionSequence += 1;
  recentSubagentSessions.push({
    task_id: result.task_id,
    persona_id: result.persona_id,
    last_status: result.status,
    sequence: recentSubagentSessionSequence,
  });
  while (recentSubagentSessions.length > 25) recentSubagentSessions.shift();
}

function parseSessionsLimit(input: unknown): number | LarvaError {
  const limit = isRecord(input) && input.limit !== undefined ? input.limit : 10;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    return error("LARVA_BAD_INPUT", "limit must be an integer from 1 to 25.");
  }
  return limit;
}

function larva_subagent_sessions(input: unknown): LarvaSubagentSessionsResult {
  const limit = parseSessionsLimit(input);
  if (isLarvaError(limit)) {
    return {
      content: [{ type: "text", text: `${limit.code}: ${limit.message}` }],
      details: { status: "failed", sessions: [], error: limit },
      isError: true,
    };
  }
  const sessions = [...recentSubagentSessions]
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, limit);
  const summary = sessions.length === 0
    ? "Recent Larva subagent sessions: none"
    : `Recent Larva subagent sessions: ${sessions.map((session) => `${session.sequence}:${session.persona_id}:${session.last_status}`).join(", ")}`;
  return {
    content: [{ type: "text", text: summary }],
    details: { status: "success", sessions, error: null },
    isError: false,
  };
}

function subagentMode(input: LarvaSubagentInput): "new" | "resume" {
  return typeof input.task_id === "string" && input.task_id.trim().length > 0 ? "resume" : "new";
}

function renderTextComponent(text: string): PiRenderableText {
  return {
    text,
    invalidate: () => undefined,
    render: (width: number): string[] => {
      const contentWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
      const lines: string[] = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const safeLine = visibleText(rawLine.replace(/\t/g, "   "));
        if (rawLine.length === 0) {
          lines.push("");
          continue;
        }
        let currentLine = "";
        let currentWidth = 0;
        for (const char of Array.from(safeLine)) {
          const charWidth = terminalCharWidth(char);
          const safeChar = charWidth > contentWidth ? "?" : char;
          const safeCharWidth = charWidth > contentWidth ? 1 : charWidth;
          if (currentWidth > 0 && currentWidth + safeCharWidth > contentWidth) {
            lines.push(currentLine);
            currentLine = "";
            currentWidth = 0;
          }
          currentLine += safeChar;
          currentWidth += safeCharWidth;
        }
        lines.push(currentLine);
      }
      return lines;
    },
  };
}

function terminalCharWidth(char: string): number {
  if (char.length === 0) return 0;
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
  return codePoint >= 0x20 && codePoint <= 0x7e ? 1 : 2;
}

function renderLarvaSubagentCall(input: LarvaSubagentInput): PiRenderableText {
  const personaId = typeof input.persona_id === "string" && input.persona_id.trim().length > 0 ? visibleText(input.persona_id) : "";
  const task = typeof input.task === "string" ? input.task : "";
  const mode = subagentMode(input);
  const header = `larva_subagent -> ${personaId} [${mode}]`;
  if (mode === "resume" && typeof input.task_id === "string") {
    return renderTextComponent(`${header}\ntask_id: ${boundedVisibleSuffix(input.task_id, 80)}\n${boundedVisible(task, 120)}`);
  }
  const separator = " ";
  const availableForTask = Math.max(1, 120 - Array.from(header).length - separator.length);
  return renderTextComponent(`${header}${separator}${boundedVisible(task, availableForTask)}`);
}

function progressUpdate(input: LarvaSubagentInput, phase: string, taskId?: string | null): LarvaSubagentProgressUpdate {
  const personaId = typeof input.persona_id === "string" ? visibleText(input.persona_id) : "";
  const taskPreview = boundedVisible(typeof input.task === "string" ? input.task : "", 120);
  const details = {
    persona_id: personaId,
    mode: subagentMode(input),
    task_preview: taskPreview,
    phase,
    task_id: taskId ?? (typeof input.task_id === "string" ? input.task_id : null),
  };
  const text = boundedVisible(`larva_subagent ${phase}: ${personaId} [${details.mode}] ${taskPreview}`, 200);
  return {
    text,
    content: [{ type: "text", text }],
    details,
    isError: false,
  };
}

function renderLarvaSubagentResult(result: LarvaSubagentToolResult, options?: { expanded?: boolean; input?: LarvaSubagentInput }): PiRenderableText {
  const details = result.details ?? result;
  if (isRecord(details) && typeof details.phase === "string") {
    const textItem = Array.isArray(result.content) ? result.content.find((item) => item.type === "text") : undefined;
    return renderTextComponent(textItem?.text ?? `${details.persona_id ?? ""} ${details.phase}`.trim());
  }
  const terminal = details.status === "success" ? "completed" : details.status;
  if (!options?.expanded) return renderTextComponent(`${details.persona_id} ${terminal}`);
  const input = options.input ?? {};
  const mode = subagentMode(input);
  const lines = [
    `persona_id: ${details.persona_id}`,
    `mode: ${mode}`,
    `task: ${typeof input.task === "string" ? input.task : ""}`,
  ];
  if (details.task_id !== null) lines.push(`task_id: ${details.task_id}`);
  lines.push(`status: ${details.status}`);
  if (details.error) lines.push(`error: ${details.error.code}: ${details.error.message}`);
  lines.push(`output: ${details.result_text}`);
  const footer = resumeFooter(details);
  if (footer.length > 0) lines.push(footer);
  return renderTextComponent(lines.join("\n"));
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function canSpawn(activeParent: PersonaEnvelope | null, personaId: string): LarvaError | null {
  if (!activeParent) return error("LARVA_NO_ACTIVE_PERSONA", "No active parent Larva persona.");
  const authority = activeParent.can_spawn;
  if (authority === true) return null;
  if (Array.isArray(authority) && authority.includes(personaId)) return null;
  return error("LARVA_SPAWN_NOT_ALLOWED", "Active parent persona cannot spawn the requested persona.");
}

function validateInput(input: LarvaSubagentInput): { personaId: string; task: string; taskId: string | null } | LarvaSubagentResult {
  const personaId = normalizeString(input.persona_id);
  if (!personaId) return failed(null, "", error("LARVA_BAD_INPUT", "persona_id must be a non-empty string."));
  const task = normalizeString(input.task);
  if (!task) return failed(null, personaId, error("LARVA_BAD_INPUT", "task must be a non-empty string."));
  if (input.task_id === undefined || input.task_id === null) return { personaId, task, taskId: null };
  const taskId = normalizeString(input.task_id);
  if (!taskId) return failed(null, personaId, error("LARVA_BAD_INPUT", "task_id must be a non-empty string."));
  return { personaId, task, taskId };
}

async function childSessionRoot(env: RuntimeEnv): Promise<string | LarvaError> {
  const configured = env.LARVA_PI_CHILD_SESSION_DIR;
  if (configured !== undefined && configured.length === 0) return error("LARVA_CHILD_START_FAILED", "Child session root override must be non-empty.");
  const root = configured ?? join(homedir(), DEFAULT_CHILD_SESSION_ROOT_SUFFIX);
  if (!isAbsolute(root)) return error("LARVA_CHILD_START_FAILED", "Child session root must be absolute.");
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return error("LARVA_CHILD_START_FAILED", "Child session root is not a directory.");
    return await realpath(root);
  } catch {
    return error("LARVA_CHILD_START_FAILED", "Child session root is unavailable.");
  }
}

function isUnderRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function validateTaskId(taskId: string, root: string): Promise<string | LarvaError> {
  if (!isAbsolute(taskId)) return error("LARVA_BAD_INPUT", "task_id must be an absolute path.");
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(taskId));
  } catch {
    return error("LARVA_BAD_INPUT", "task_id parent cannot be canonicalized.");
  }
  const canonical = resolve(canonicalParent, taskId.split(/[\\/]/).pop() || "");
  if (!isUnderRoot(root, canonical)) return error("LARVA_BAD_INPUT", "task_id must stay inside childSessionRoot.");
  let sessionPath: string;
  try {
    sessionPath = await realpath(canonical);
  } catch {
    if (!canonical.endsWith(".jsonl")) return error("LARVA_SESSION_INVALID", "Child session path must end in .jsonl.");
    return error("LARVA_SESSION_NOT_FOUND", "Child session file is missing.");
  }
  if (!isUnderRoot(root, sessionPath)) return error("LARVA_BAD_INPUT", "task_id symlink escape outside childSessionRoot.");
  if (!sessionPath.endsWith(".jsonl")) return error("LARVA_SESSION_INVALID", "Child session path must end in .jsonl.");
  try {
    const sessionStat = await stat(sessionPath);
    if (!sessionStat.isFile()) return error("LARVA_SESSION_INVALID", "Child session path is not a readable file.");
    await access(sessionPath, constants.R_OK);
  } catch {
    return error("LARVA_SESSION_INVALID", "Child session path is invalid or unreadable.");
  }
  return sessionPath;
}

async function validateFreshChildSessionFile(sessionFile: string, root: string): Promise<string | LarvaError> {
  if (!isAbsolute(sessionFile)) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile must be an absolute path.");
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(sessionFile));
  } catch {
    return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile parent cannot be canonicalized.");
  }
  const canonical = resolve(canonicalParent, sessionFile.split(/[\\/]/).pop() || "");
  if (!isUnderRoot(root, canonical)) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile must stay inside childSessionRoot.");
  if (!canonical.endsWith(".jsonl")) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile must end in .jsonl.");
  try {
    await lstat(canonical);
  } catch (caught) {
    if (isRecord(caught) && caught.code === "ENOENT") return canonical;
    return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile filesystem entry cannot be inspected.");
  }

  let sessionPath: string;
  try {
    sessionPath = await realpath(canonical);
  } catch {
    return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile cannot be canonicalized.");
  }
  if (!isUnderRoot(root, sessionPath)) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile symlink escape outside childSessionRoot.");
  if (!sessionPath.endsWith(".jsonl")) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile must end in .jsonl.");
  try {
    const sessionStat = await stat(sessionPath);
    if (!sessionStat.isFile()) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile is not a readable file.");
    await access(sessionPath, constants.R_OK);
  } catch {
    return error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile is invalid or unreadable.");
  }
  return sessionPath;
}

function launcherArgs(env: RuntimeEnv): string[] | LarvaError {
  const realBin = normalizeString(env.LARVA_PI_REAL_BIN);
  const flag = normalizeString(env.LARVA_PI_EXTENSION_FLAG);
  const entry = normalizeString(env.LARVA_PI_EXTENSION_ENTRY);
  if (!realBin || !flag || !entry) return error("LARVA_CHILD_START_FAILED", "Launcher Pi child environment is incomplete.");
  return [realBin, flag, entry, "--mode", "rpc", "--session-dir"];
}

function startChild(env: RuntimeEnv, root: string, personaId: string): ChildProcessWithoutNullStreams | LarvaError {
  const prefix = launcherArgs(env);
  if (!Array.isArray(prefix)) return prefix;
  const [realBin, flag, entry, ...tail] = prefix;
  try {
    return spawn(realBin, [flag, entry, ...tail, root], {
      env: {
        ...process.env,
        ...env,
        LARVA_PI_INITIAL_PERSONA_ID: personaId,
        LARVA_PI_PARENT_PERSONA_ID: state.envelope?.persona_id || env.LARVA_PI_PARENT_PERSONA_ID || "",
        LARVA_PI_INTERACTIVE_TUI: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return error("LARVA_CHILD_START_FAILED", "Child Pi process could not be started.");
  }
}

function parseStartupError(stderr: string): LarvaError {
  const match = /larva pi: (LARVA_[A-Z_]+):/.exec(stderr);
  const whitelist: LarvaErrorCode[] = [
    "LARVA_PERSONA_NOT_FOUND",
    "LARVA_MODEL_UNAVAILABLE",
    "LARVA_POLICY_INVALID",
    "LARVA_TOOL_ENUMERATION_FAILED",
  ];
  if (match && whitelist.includes(match[1] as LarvaErrorCode)) {
    return error(match[1] as LarvaErrorCode, "Child startup failed with a Larva startup error.");
  }
  return error("LARVA_CHILD_START_FAILED", "Child Pi process exited before RPC readiness.");
}

class RpcClient {
  private readonly pending = new Map<string, (value: unknown) => void>();
  private readonly events: unknown[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private rpcReady = false;
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    child.once("close", () => { this.closed = true; });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.consume(line));
  }

  private consume(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.events.push({ type: "protocol_error" }); return; }
    const id = typeof message === "object" && message !== null && "id" in message ? String((message as { id: unknown }).id) : "";
    const waiter = this.pending.get(id);
    if (id && waiter) {
      this.pending.delete(id);
      waiter(message);
      return;
    }
    this.events.push(message);
  }

  private closedError(): LarvaError {
    return this.rpcReady
      ? error("LARVA_CHILD_PROTOCOL_FAILED", "Child exited before RPC response; post-readiness stderr is diagnostic only.")
      : parseStartupError(this.stderr);
  }

  async command(id: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown | LarvaError> {
    const message = JSON.stringify({ id, ...body });
    return await new Promise((resolveCommand) => {
      let settled = false;
      const settle = (value: unknown | LarvaError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.child.off("close", onClose);
        resolveCommand(value);
      };
      const onClose = (): void => {
        settle(this.closedError());
      };
      const timer = setTimeout(() => {
        settle(error("LARVA_CHILD_PROTOCOL_FAILED", "Child RPC command timed out after ten seconds."));
      }, timeoutMs);
      this.pending.set(id, (value) => {
        this.rpcReady = true;
        settle(value);
      });
      this.child.once("close", onClose);
      if (this.closed || this.child.exitCode !== null) {
        settle(this.closedError());
        return;
      }
      try {
        this.child.stdin.write(`${message}\n`, (writeError?: Error | null) => {
          if (writeError) settle(this.closedError());
        });
      } catch {
        settle(this.closedError());
      }
    });
  }

  async waitForAgentEnd(): Promise<LarvaError | null> {
    while (true) {
      const found = this.events.find((eventValue) => typeof eventValue === "object" && eventValue !== null && (eventValue as { type?: unknown }).type === "agent_end");
      if (found) return null;
      if (this.events.some((eventValue) => typeof eventValue === "object" && eventValue !== null && (eventValue as { type?: unknown }).type === "protocol_error")) {
        return error("LARVA_CHILD_PROTOCOL_FAILED", "Child emitted malformed JSONL.");
      }
      if (this.child.exitCode !== null) {
        return this.rpcReady
          ? error("LARVA_CHILD_PROTOCOL_FAILED", "Child exited before agent_end; post-readiness stderr is diagnostic only.")
          : this.closedError();
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  startupError(): LarvaError { return parseStartupError(this.stderr); }

  async abort(): Promise<"success" | "cancelled" | "unknowable"> {
    const aborted = await this.command("abort-1", { type: "abort" }, 5_000);
    if (isSuccessResponse(aborted)) return "cancelled";
    try {
      const killed = this.child.kill();
      return killed ? "cancelled" : "unknowable";
    } catch {
      return "unknowable";
    }
  }
}

function isSuccessResponse(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { success?: unknown }).success === true;
}

function sessionFileFromState(value: unknown): string | LarvaError {
  if (isLarvaError(value)) return value;
  if (!isSuccessResponse(value)) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child get_state failed.");
  const sessionFile = (value as { data?: { sessionFile?: unknown } }).data?.sessionFile;
  if (typeof sessionFile !== "string" || sessionFile.length === 0) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child get_state omitted sessionFile.");
  return sessionFile;
}

function finalText(value: unknown): string | LarvaError {
  if (isLarvaError(value)) return value;
  if (!isSuccessResponse(value)) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child final text request failed.");
  const text = (value as { data?: { text?: unknown } }).data?.text;
  // Contract token for static harness: typeof data.text === "string"
  if (typeof text === "string") return text;
  return error("LARVA_CHILD_PROTOCOL_FAILED", "Child get_last_assistant_text data.text was malformed.");
}

async function runChildSequence(
  env: RuntimeEnv,
  root: string,
  personaId: string,
  task: string,
  taskId: string | null,
  abortSignal?: AbortSignal,
): Promise<LarvaSubagentResult> {
  const child = startChild(env, root, personaId);
  if (isLarvaError(child)) return failed(taskId, personaId, child);
  const rpc = new RpcClient(child);
  let allocatedTaskId = taskId;
  let abortStarted = false;
  const abortChild = async (): Promise<LarvaSubagentResult> => {
    abortStarted = true;
    const outcome = await rpc.abort();
    if (outcome === "cancelled") return cancelled(allocatedTaskId, personaId);
    return failed(allocatedTaskId, personaId, error("LARVA_CHILD_PROTOCOL_FAILED", "Child abort state became unknowable."));
  };
  let abortPromise: Promise<LarvaSubagentResult> | null = null;
  let resolveAbortRace: ((value: LarvaSubagentResult) => void) | null = null;
  const abortRace = new Promise<LarvaSubagentResult>((resolveAbort) => { resolveAbortRace = resolveAbort; });
  const requestAbort = (): void => {
    if (!abortPromise) {
      abortPromise = abortChild();
      abortPromise.then((result) => resolveAbortRace?.(result));
    }
  };
  if (abortSignal?.aborted) requestAbort();
  abortSignal?.addEventListener("abort", requestAbort, { once: true });
  const sequence = async (): Promise<LarvaSubagentResult> => {
    if (taskId) {
      const switched = await rpc.command("switch-1", { type: "switch_session", sessionPath: taskId });
      if (!isSuccessResponse(switched) || (switched as { data?: { cancelled?: unknown } }).data?.cancelled === true) {
        child.kill();
        return failed(taskId, personaId, isLarvaError(switched) ? switched : error("LARVA_CHILD_PROTOCOL_FAILED", "Child switch_session failed."));
      }
    } else {
      const stateResult = await rpc.command("state-1", { type: "get_state" });
      const sessionFile = sessionFileFromState(stateResult);
      if (isLarvaError(sessionFile)) { child.kill(); return failed(null, personaId, sessionFile); }
      const canonical = await validateFreshChildSessionFile(sessionFile, root);
      if (isLarvaError(canonical)) { child.kill(); return failed(null, personaId, error("LARVA_CHILD_PROTOCOL_FAILED", "Child returned invalid sessionFile.")); }
      taskId = canonical;
      allocatedTaskId = canonical;
    }
    const prompted = await rpc.command("prompt-1", { type: "prompt", message: task });
    if (!isSuccessResponse(prompted)) { child.kill(); return failed(taskId, personaId, isLarvaError(prompted) ? prompted : error("LARVA_CHILD_PROTOCOL_FAILED", "Child prompt failed.")); }
    const ended = await rpc.waitForAgentEnd();
    if (ended) { child.kill(); return failed(taskId, personaId, ended); }
    const last = await rpc.command("last-1", { type: "get_last_assistant_text" });
    const text = finalText(last);
    if (isLarvaError(text)) return failed(taskId, personaId, text);
    return success(taskId, personaId, text);
  };
  try {
    const sequencePromise = sequence();
    const first = await Promise.race([sequencePromise, abortRace]);
    if (abortStarted && abortPromise) {
      if (first.status === "failed" && first.error?.code === "LARVA_CHILD_START_FAILED") return await abortPromise;
      if (first.status === "cancelled" || first.status === "failed") return first;
      return await Promise.race([sequencePromise, abortPromise]);
    }
    return first;
  } finally {
    abortSignal?.removeEventListener("abort", requestAbort);
    if (!child.killed) child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

export async function larva_subagent(input: LarvaSubagentInput, ctx?: { env?: RuntimeEnv; abortSignal?: AbortSignal }): Promise<LarvaSubagentResult> {
  const parsed = validateInput(input);
  if ("status" in parsed) return parsed; // public task_id: null on bad input pre-session failures
  const { personaId, task, taskId } = parsed;
  const env = currentEnv(ctx);
  const root = await childSessionRoot(env);
  if (isLarvaError(root)) return failed(null, personaId, root);

  let canonicalTaskId: string | null = null;
  if (taskId !== null) {
    const validated = await validateTaskId(taskId, root);
    if (isLarvaError(validated)) return failed(null, personaId, validated);
    canonicalTaskId = validated;
  }
  const authorityError = canSpawn(state.envelope, personaId);
  if (authorityError) return failed(null, personaId, authorityError);
  if (canonicalTaskId) {
    if (activeTaskIds.has(canonicalTaskId)) return failed(canonicalTaskId, personaId, error("LARVA_SESSION_BUSY", "Child session is already being resumed."));
    activeTaskIds.add(canonicalTaskId);
  }

  try {
    if (ctx?.abortSignal?.aborted) return cancelled(canonicalTaskId, personaId);
    const result = await runChildSequence(env, root, personaId, task, canonicalTaskId, ctx?.abortSignal);
    return result;
  } finally {
    if (canonicalTaskId) activeTaskIds.delete(canonicalTaskId);
  }
}

async function initializeSession(ctx: PiContext, pi: PiApi): Promise<void> {
  const env = currentEnv(ctx);
  if (env.LARVA_PI_INITIAL_PERSONA_ID) {
    const committed = await commitPersonaWithOptions(env.LARVA_PI_INITIAL_PERSONA_ID, ctx, pi, { toolBaseline: startupToolBaseline });
    if (!committed.ok) {
      await setStartupUnavailableStatus(ctx, env.LARVA_PI_INITIAL_PERSONA_ID, committed.error);
      await notify(ctx, `Larva startup persona unavailable: ${committed.error.code}: ${committed.error.message}`, "error");
    }
  }
}

export async function initializeExtension(ctx: PiContext, pi: PiApi = ctx): Promise<void> {
  const env = currentEnv(ctx);
  registerLarvaPersonaCommand(ctx, pi);
  const subagentSchema = {
    type: "object",
    properties: {
      persona_id: { type: "string", description: "Target Larva persona id." },
      task: { type: "string", description: "Instruction to send to the child session." },
      task_id: { type: "string", description: "Optional child session .jsonl path to resume." },
    },
    required: ["persona_id", "task"],
    additionalProperties: false,
  };
  pi.registerTool?.({
    name: "larva_subagent",
    label: "Larva Subagent",
    description: "Spawn or resume one Larva persona child Pi session and return its final assistant text.",
    inputSchema: subagentSchema,
    parameters: subagentSchema,
    handler: (input: LarvaSubagentInput) => larva_subagent(input, { env, abortSignal: ctx.abortSignal ?? ctx.signal }).then((result) => {
      recordRecentSubagentSession(result);
      return wrapLarvaSubagentToolResult(result);
    }),
    execute: (_toolCallId, input, signal, onUpdate, toolCtx) => {
      const runtimeCtx = withRuntimeEnv(toolCtx ?? ctx, env);
      onUpdate?.(progressUpdate(input, "starting"));
      return larva_subagent(input, { env: currentEnv(runtimeCtx), abortSignal: signal ?? runtimeCtx.signal ?? runtimeCtx.abortSignal }).then((result) => {
        onUpdate?.(progressUpdate(input, result.status, result.task_id));
        recordRecentSubagentSession(result);
        return wrapLarvaSubagentToolResult(result);
      });
    },
    renderCall: renderLarvaSubagentCall,
    renderResult: renderLarvaSubagentResult,
  });
  const sessionsSchema = {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 25, description: "Maximum recent sessions to return (default 10, max 25)." } },
    additionalProperties: false,
  };
  pi.registerTool?.({
    name: "larva_subagent_sessions",
    label: "Larva Subagent Sessions",
    description: "List recent Larva subagent sessions observed by this parent Pi extension process.",
    inputSchema: sessionsSchema,
    parameters: sessionsSchema,
    handler: async (input: unknown) => larva_subagent_sessions(input),
    execute: async (_toolCallId, input) => larva_subagent_sessions(input),
  });
  if (pi !== ctx) {
    await initializeSession(withRuntimeEnv(ctx, env), pi);
  }
  pi.on?.("session_start", async (_payload: unknown, eventCtx?: PiContext) => {
    const runtimeCtx = withRuntimeEnv(eventCtx ?? ctx, env);
    registerLarvaPersonaAutocompleteProvider(runtimeCtx);
    await initializeSession(runtimeCtx, pi);
  });
  pi.on?.("before_agent_start", (payload: unknown) => before_agent_start(payload));
  pi.on?.("tool_call", (payload: unknown) => {
    const name = isRecord(payload) && typeof payload.toolName === "string"
      ? payload.toolName
      : isRecord(payload) && typeof payload.name === "string"
        ? payload.name
        : "";
    const decision = decideToolCall(name);
    if (decision.action === "deny") return { block: true, reason: `${decision.error.code}: ${decision.error.message}` };
    return undefined;
  });
  void openPersonaSelector;
}

export const __contract_examples = {
  badInput: { task_id: null, persona_id: "", status: "failed", result_text: "", error: { code: "LARVA_BAD_INPUT", message: "task must be a non-empty string." } },
  failedAfterAllocation: { task_id: "/tmp/example.jsonl", persona_id: "doc-reviewer", status: "failed", result_text: "", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "failed after allocation" } },
  deniedSubagentNoHandler: "handler larva_subagent LARVA_TOOL_DENIED no LarvaSubagentResult",
  startupShape: "larva pi: <ERROR_CODE>: <human-readable message>",
  piApiTokens: "modelRegistry.find ctx.ui.setStatus(\"larva\", statusText) typeof data.text === \"string\"",
  modelMapContract: {
    canonicalPath: "~/.pi/larva/model-map.json",
    envOverride: "LARVA_PI_MODEL_MAP_FILE",
    schema: "PiModelMapConfig models prefix_rules from_prefix to_provider to_model_id_prefix",
    order: "exact models[spec.model] before longest literal prefix_rules match",
    conflicts: "same-length matching prefix conflict -> LARVA_MODEL_MAP_INVALID",
    noGuessing: "no wildcard regex fuzzy nearest-model vendor guessing",
    registryValidation: "mapped provider/model_id -> modelRegistry.find(provider, model_id); registry miss or pi.setModel rejection -> LARVA_MODEL_UNAVAILABLE",
    fallback: "missing model-map file or key miss with no prefix hit preserves split-on-first-slash fallback",
    invalid: "existing invalid JSON/schema/rules fail closed with LARVA_MODEL_MAP_INVALID",
    sharedResolver: "startup persona application and /larva-persona switching use one shared resolver path",
    example: "openai/gpt-5.5 -> openai-codex/gpt-5.5; ollama-cloud/glm-5.1 -> openrouter/z-ai/glm-5.1; ollama-cloud/kimi-k2.5 -> openrouter/moonshotai/kimi-k2.5; ollama-cloud/minimax-m2.7 -> openrouter/minimax/minimax-m2.7; openrouter/google/gemini-3.1-pro-preview covered by openrouter/ prefix; ollama-cloud/kimi-k2.6:cloud intentionally not mapped",
  } satisfies Record<string, string>,
  toolPolicyPathContract: {
    canonicalPath: "~/.pi/larva/tool-policy.json",
    envOverride: "LARVA_PI_TOOL_POLICY_FILE",
    order: "env override only, else canonical ~/.pi/larva/tool-policy.json only; never read legacy ~/.pi/tool-policy.json implicitly",
    explicitLegacyOnly: "legacy ~/.pi/tool-policy.json is valid only when explicitly named by LARVA_PI_TOOL_POLICY_FILE",
    noMigration: "do not auto-migrate, merge, rewrite, create user files, or provide a compatibility window",
  } satisfies Record<string, string>,
};

export default initializeExtension;
