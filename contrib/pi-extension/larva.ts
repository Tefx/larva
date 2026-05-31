import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, realpath, stat } from "node:fs/promises";
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

type RuntimeEnv = Record<string, string | undefined> & {
  LARVA_PI_INITIAL_PERSONA_ID?: string;
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
type PiAutocompleteProvider = (...args: unknown[]) => PiAutocompleteResult | Promise<PiAutocompleteResult>;
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
};
type SelectorOption = { id: string; label: string; description?: string };
type BridgeListItem = { id: string; description?: string; model?: string };
type StatusSetter = ((status: string) => void | Promise<void>) | ((key: string, status?: string) => void | Promise<void>);
type PiUi = {
  setStatus?: StatusSetter;
  addAutocompleteProvider?: (provider: PiAutocompleteProvider) => unknown;
  notify?: (message: string, notifyType?: "info" | "warning" | "error") => void | Promise<void>;
  select?: (title: string, options: string[] | SelectorOption[]) => Promise<string | SelectorOption | null | undefined>;
};
type PiApi = {
  setModel?: (model: unknown) => boolean | void | Promise<boolean | void>;
  getAllTools?: () => unknown[] | Promise<unknown[]>;
  setActiveTools?: (tools: string[]) => boolean | void | Promise<boolean | void>;
  registerCommand?: ((name: string, options: CommandOptions) => void) | ((command: LegacyCommandDefinition) => void);
  registerTool?: (tool: ToolDefinition<LarvaSubagentInput, LarvaSubagentResult>) => void;
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
type ActiveState = { envelope: PersonaEnvelope | null; activeTools: Set<string> };
type ParsedModel = { provider: string; modelId: string };

const CLI_TIMEOUT_MS = 10_000;
const LARVA_WATERMARK_RE = /\n?<!-- larva-spec:[\s\S]*?Use Larva MCP or the larva CLI \(`larva`, fallback `uvx larva`\) to discover and resolve personas when needed\.\n?/g;
const DEFAULT_CHILD_SESSION_ROOT_SUFFIX = ".pi/larva/child-sessions";
const state: ActiveState = { envelope: null, activeTools: new Set<string>() };
const activeTaskIds: Set<string> = new Set<string>();

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
    await setter("larva", statusText);
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

export async function listPersonas(ctx?: { env?: RuntimeEnv }): Promise<BridgeListItem[]> {
  const result = await runLarvaCommand(currentEnv(ctx), ["list", "--json"]);
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const data = isRecord(parsed) ? parsed.data : undefined;
    if (!Array.isArray(data)) return [];
    const items = data.map((item) => normalizeListItem(item));
    if (items.some((item) => item === null)) return [];
    return items as BridgeListItem[];
  } catch {
    return [];
  }
}

function normalizeListItem(item: unknown): BridgeListItem | null {
  if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) return null;
  return {
    id: item.id,
    description: typeof item.description === "string" ? item.description : undefined,
    model: typeof item.model === "string" ? item.model : undefined,
  };
}

export async function completePersonaIds(prefix = "", ctx?: { env?: RuntimeEnv }): Promise<PiAutocompleteCandidate[]> {
  const personas = await listPersonas(ctx);
  return personas
    .filter((persona) => persona.id.startsWith(prefix))
    .map((persona) => ({
      value: persona.id,
      label: persona.id,
      description: persona.description ?? persona.model,
    }));
}

function autocompleteLineFromArgs(args: unknown[]): string | null {
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

function autocompleteBaseProviderFromArgs(args: unknown[], fallback?: PiAutocompleteProvider): PiAutocompleteProvider | undefined {
  for (const arg of args) {
    if (typeof arg === "function") return arg as PiAutocompleteProvider;
    if (!isRecord(arg)) continue;
    for (const key of ["baseProvider", "delegate", "next"] as const) {
      const candidate = arg[key];
      if (typeof candidate === "function") return candidate as PiAutocompleteProvider;
    }
  }
  return fallback;
}

export function larvaPersonaArgumentPrefix(line: string): string | null {
  const matched = /^\/larva-persona\s+([^\s]*)$/.exec(line);
  return matched ? matched[1] : null;
}

export function createLarvaPersonaAutocompleteProvider(
  ctx: PiContext,
  baseProvider?: PiAutocompleteProvider,
): PiAutocompleteProvider {
  return async (...args: unknown[]): Promise<PiAutocompleteResult> => {
    const line = autocompleteLineFromArgs(args);
    const prefix = line === null ? null : larvaPersonaArgumentPrefix(line);
    if (prefix === null) {
      const delegate = autocompleteBaseProviderFromArgs(args, baseProvider);
      return delegate ? await delegate(...args) : null;
    }
    try {
      const candidates = await completePersonaIds(prefix, ctx);
      return candidates.length > 0 ? candidates : null;
    } catch {
      return null;
    }
  };
}

function registerLarvaPersonaAutocompleteProvider(ctx: PiContext): void {
  const addProvider = ctx.ui?.addAutocompleteProvider;
  if (typeof addProvider !== "function") return;
  try {
    addProvider(createLarvaPersonaAutocompleteProvider(ctx));
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
      return candidates.length > 0 ? candidates : null;
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
  await notify(ctx, `Larva persona switch failed: ${result.error.code}: ${result.error.message}`, "error");
}

async function validateModel(spec: PersonaSpec, ctx: PiContext, pi: PiApi): Promise<unknown> {
  const parsed = parseModel(spec.model);
  if (!parsed) throw error("LARVA_MODEL_UNAVAILABLE", `Invalid model ${spec.model}`);
  const model = await ctx.modelRegistry?.find?.(parsed.provider, parsed.modelId);
  if (!model) throw error("LARVA_MODEL_UNAVAILABLE", `Model unavailable ${spec.model}`);
  const accepted = await pi.setModel?.(model);
  if (accepted === false) throw error("LARVA_MODEL_UNAVAILABLE", `Pi rejected model ${spec.model}`);
  return model;
}

async function enumerateTools(pi: PiApi): Promise<string[]> {
  const tools = await safeToolEnumeration(pi);
  return tools.map((tool) => toolName(tool)).filter((name): name is string => name !== null);
}

async function safeToolEnumeration(pi: PiApi): Promise<unknown[]> {
  if (typeof pi.getAllTools !== "function") return [];
  try {
    const tools = await pi.getAllTools();
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

function toolName(tool: unknown): string | null {
  if (typeof tool === "string" && tool.length > 0) return tool;
  if (isRecord(tool) && typeof tool.name === "string" && tool.name.length > 0) return tool.name;
  return null;
}

async function loadPolicy(personaId: string, env: RuntimeEnv): Promise<PiToolPolicy> {
  const file = env.LARVA_PI_TOOL_POLICY_FILE;
  if (!file) return {};
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(file, "utf8").catch((readError: unknown) => {
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
  } catch {
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
  const previousEnvelope = state.envelope;
  const previousActiveTools = new Set(state.activeTools);
  let rollbackTools: string[] | null = null;
  let activeToolsUpdated = false;
  try {
    const spec = await resolvePersona(personaId, ctx);
    const baseline = await enumerateTools(pi);
    rollbackTools = previousEnvelope ? Array.from(previousActiveTools) : baseline;
    const tool_policy = await loadPolicy(spec.id, currentEnv(ctx));
    const activeTools = filterPolicyTools(baseline, tool_policy);
    let applied: boolean | void | undefined;
    try {
      applied = await pi.setActiveTools?.(activeTools);
    } catch {
      throw error("LARVA_TOOL_ENUMERATION_FAILED", "Pi active-tool update failed");
    }
    if (applied === false) throw error("LARVA_TOOL_ENUMERATION_FAILED", "Pi active-tool update failed");
    activeToolsUpdated = true;
    await validateModel(spec, ctx, pi);
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
    await setStatus(ctx);
    return { ok: true, envelope };
  } catch (caught) {
    if (activeToolsUpdated && rollbackTools) {
      try { await pi.setActiveTools?.(rollbackTools); } catch { /* preserve previous active tool rules best-effort */ }
    }
    state.envelope = previousEnvelope; // previousEnvelope rollback preserves model-facing state.
    state.activeTools = previousActiveTools;
    const larvaError = isLarvaError(caught) ? caught : error("LARVA_PERSONA_NOT_FOUND", "Persona switch failed");
    return { ok: false, error: larvaError };
  }
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
  const cleanPrompt = systemPrompt.replace(LARVA_WATERMARK_RE, "").trimEnd();
  const block = [
    `<!-- larva-spec: ${envelope.persona_id}@${envelope.spec_digest} -->`,
    envelope.prompt,
    "Use Larva MCP or the larva CLI (`larva`, fallback `uvx larva`) to discover and resolve personas when needed.",
  ].join("\n");
  return `${cleanPrompt}\n\n${block}`;
}

export function before_agent_start(event: unknown): { systemPrompt: string } | undefined {
  if (!state.envelope || !isRecord(event) || typeof event.systemPrompt !== "string") return undefined;
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
      const canonical = await validateTaskId(sessionFile, root);
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
    const committed = await commitPersona(env.LARVA_PI_INITIAL_PERSONA_ID, ctx, pi);
    if (!committed.ok) {
      await setStartupUnavailableStatus(ctx, env.LARVA_PI_INITIAL_PERSONA_ID, committed.error);
      await notify(ctx, `Larva startup persona unavailable: ${committed.error.code}: ${committed.error.message}`, "error");
    }
  } else {
    await setStatus(ctx);
  }
}

export async function initializeExtension(ctx: PiContext, pi: PiApi = ctx): Promise<void> {
  const env = currentEnv(ctx);
  if (pi !== ctx) {
    await initializeSession(withRuntimeEnv(ctx, env), pi);
  }
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
  registerLarvaPersonaAutocompleteProvider(ctx);
  pi.registerTool?.({
    name: "larva_subagent",
    label: "Larva Subagent",
    description: "Spawn or resume one Larva persona child Pi session and return its final assistant text.",
    inputSchema: subagentSchema,
    parameters: subagentSchema,
    handler: (input: LarvaSubagentInput) => larva_subagent(input, { env, abortSignal: ctx.abortSignal ?? ctx.signal }),
    execute: (_toolCallId, input, signal, _onUpdate, toolCtx) => {
      const runtimeCtx = withRuntimeEnv(toolCtx ?? ctx, env);
      return larva_subagent(input, { env: currentEnv(runtimeCtx), abortSignal: signal ?? runtimeCtx.signal ?? runtimeCtx.abortSignal });
    },
  });
  pi.on?.("session_start", async (_payload: unknown, eventCtx?: PiContext) => {
    await initializeSession(withRuntimeEnv(eventCtx ?? ctx, env), pi);
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
};

export default initializeExtension;
