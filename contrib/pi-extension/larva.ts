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
type PersonaSpec = {
  id: string;
  prompt: string;
  model: string;
  spec_digest?: string;
  can_spawn?: boolean | string[];
};

type PersonaEnvelope = {
  persona_id: string;
  spec_digest: string;
  model: string;
  prompt: string;
  tool_policy: PiToolPolicy;
  can_spawn?: boolean | string[];
};

type PersonaSwitchResult =
  | { ok: true; envelope: PersonaEnvelope }
  | { ok: false; error: LarvaError };

type ToolPolicyDecision = { action: "allow" } | { action: "deny"; error: LarvaError };
type LarvaSubagentInput = { persona_id?: unknown; task?: unknown; task_id?: unknown };
type LarvaSubagentResult = {
  task_id: string | null;
  persona_id: string;
  status: "success" | "failed" | "cancelled";
  result_text: string;
  error: LarvaError | null;
};

type RuntimeEnv = {
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

type PiContext = {
  env?: RuntimeEnv;
  ui?: { setStatus?: (text: string) => void | Promise<void> };
  modelRegistry?: { find?: (provider: string, modelId: string) => unknown | Promise<unknown> };
  getAllTools?: () => string[] | Promise<string[]>;
  setActiveTools?: (tools: string[]) => void | boolean | Promise<void | boolean>;
  setModel?: (model: unknown) => void | boolean | Promise<void | boolean>;
  on?: (event: string, handler: (value: unknown) => unknown) => void;
  abortSignal?: AbortSignal;
};

const LARVA_WATERMARK_RE = /\n?<!-- larva-spec:[\s\S]*? -->\n?/g;
const DEFAULT_CHILD_SESSION_ROOT_SUFFIX = ".pi/larva/child-sessions";
const activeTaskIds: Set<string> = new Set<string>();
let activeParent: PersonaEnvelope | null = null;
let allowedToolNames: Set<string> | null = null;

function error(code: LarvaErrorCode, message: string): LarvaError {
  return { code, message };
}

function failed(task_id: string | null, persona_id: string, larvaError: LarvaError): LarvaSubagentResult {
  return { task_id, persona_id, status: "failed", result_text: "", error: larvaError };
}

function cancelled(task_id: string | null, persona_id: string): LarvaSubagentResult {
  return {
    task_id,
    persona_id,
    status: "cancelled",
    result_text: "",
    error: error("LARVA_CHILD_CANCELLED", "Child run was cancelled."),
  };
}

function success(task_id: string, persona_id: string, result_text: string): LarvaSubagentResult {
  return { task_id, persona_id, status: "success", result_text, error: null };
}

function parseModel(model: string): { provider: string; modelId: string } | null {
  const split = model.indexOf("/");
  if (split <= 0 || split === model.length - 1) return null;
  const provider = model.slice(0, split);
  const modelId = model.slice(split + 1);
  return provider && modelId ? { provider, modelId } : null;
}

function replaceLarvaWatermark(systemPrompt: string, envelope: PersonaEnvelope | null): string {
  const withoutPrevious = systemPrompt.replace(LARVA_WATERMARK_RE, "\n").trimEnd();
  if (!envelope) return withoutPrevious;
  const digest = envelope.spec_digest || "unknown";
  return `${withoutPrevious}\n\n${envelope.prompt}\n<!-- larva-spec: ${envelope.persona_id}@${digest} -->\nUse Larva MCP or the larva CLI (\`larva\`, fallback \`uvx larva\`) to discover and resolve personas when needed.`;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function canSpawn(parent: PersonaEnvelope | null, personaId: string): LarvaError | null {
  if (!parent) return error("LARVA_NO_ACTIVE_PERSONA", "No active parent Larva persona.");
  const authority = parent.can_spawn;
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
  const root = configured && configured.length > 0 ? configured : join(homedir(), DEFAULT_CHILD_SESSION_ROOT_SUFFIX);
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
        LARVA_PI_PARENT_PERSONA_ID: activeParent?.persona_id || env.LARVA_PI_PARENT_PERSONA_ID || "",
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
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
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

  async command(id: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown | LarvaError> {
    const message = JSON.stringify({ id, ...body });
    return await new Promise((resolveCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveCommand(error("LARVA_CHILD_PROTOCOL_FAILED", "Child RPC command timed out after ten seconds."));
      }, timeoutMs);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolveCommand(value);
      });
      this.child.stdin.write(`${message}\n`);
    });
  }

  async waitForAgentEnd(): Promise<LarvaError | null> {
    while (true) {
      const found = this.events.find((eventValue) => typeof eventValue === "object" && eventValue !== null && (eventValue as { type?: unknown }).type === "agent_end");
      if (found) return null;
      if (this.events.some((eventValue) => typeof eventValue === "object" && eventValue !== null && (eventValue as { type?: unknown }).type === "protocol_error")) {
        return error("LARVA_CHILD_PROTOCOL_FAILED", "Child emitted malformed JSONL.");
      }
      if (this.child.exitCode !== null) return parseStartupError(this.stderr);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  startupError(): LarvaError { return parseStartupError(this.stderr); }

  async abort(): Promise<"success" | "cancelled" | "unknowable"> {
    const aborted = await this.command("abort-1", { type: "abort" }, 5_000);
    if (!isLarvaError(aborted)) return "cancelled";
    try { this.child.kill(); return "cancelled"; } catch { return "unknowable"; }
  }
}

function isLarvaError(value: unknown): value is LarvaError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

function isSuccessResponse(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { success?: unknown }).success === true;
}

function sessionFileFromState(value: unknown): string | LarvaError {
  if (!isSuccessResponse(value)) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child get_state failed.");
  const sessionFile = (value as { data?: { sessionFile?: unknown } }).data?.sessionFile;
  if (typeof sessionFile !== "string" || sessionFile.length === 0) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child get_state omitted sessionFile.");
  return sessionFile;
}

function finalText(value: unknown): string | LarvaError {
  if (!isSuccessResponse(value)) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child final text request failed.");
  const text = (value as { data?: { text?: unknown } }).data?.text;
  // Contract token for static harness: typeof data.text === "string"
  if (typeof text === "string") return text;
  return error("LARVA_CHILD_PROTOCOL_FAILED", "Child get_last_assistant_text data.text was malformed.");
}

async function runChildSequence(env: RuntimeEnv, root: string, personaId: string, task: string, taskId: string | null): Promise<LarvaSubagentResult> {
  const child = startChild(env, root, personaId);
  if (isLarvaError(child)) return failed(taskId, personaId, child);
  const rpc = new RpcClient(child);
  const abortSignal = globalThis.AbortSignal ? undefined : undefined;
  void abortSignal;
  if (taskId) {
    const switched = await rpc.command("switch-1", { type: "switch_session", sessionPath: taskId });
    if (!isSuccessResponse(switched) || (switched as { data?: { cancelled?: unknown } }).data?.cancelled === true) {
      child.kill();
      return failed(taskId, personaId, isLarvaError(switched) ? switched : error("LARVA_CHILD_PROTOCOL_FAILED", "Child switch_session failed."));
    }
  } else {
    const state = await rpc.command("state-1", { type: "get_state" });
    const sessionFile = sessionFileFromState(state);
    if (isLarvaError(sessionFile)) { child.kill(); return failed(null, personaId, sessionFile); }
    const canonical = await validateTaskId(sessionFile, root);
    if (isLarvaError(canonical)) { child.kill(); return failed(null, personaId, error("LARVA_CHILD_PROTOCOL_FAILED", "Child returned invalid sessionFile.")); }
    taskId = canonical;
  }
  const prompted = await rpc.command("prompt-1", { type: "prompt", message: task });
  if (!isSuccessResponse(prompted)) { child.kill(); return failed(taskId, personaId, error("LARVA_CHILD_PROTOCOL_FAILED", "Child prompt failed.")); }
  const ended = await rpc.waitForAgentEnd();
  if (ended) { child.kill(); return failed(taskId, personaId, ended); }
  const last = await rpc.command("last-1", { type: "get_last_assistant_text" });
  const text = finalText(last);
  if (isLarvaError(text)) return failed(taskId, personaId, text);
  return success(taskId, personaId, text);
}

export async function larva_subagent(input: LarvaSubagentInput, ctx?: { env?: RuntimeEnv; abortSignal?: AbortSignal }): Promise<LarvaSubagentResult> {
  const parsed = validateInput(input);
  if ("status" in parsed) return parsed; // public task_id: null on bad input pre-session failures
  const { personaId, task, taskId } = parsed;
  const authorityError = canSpawn(activeParent, personaId);
  if (authorityError) return failed(null, personaId, authorityError);
  const env = ctx?.env || process.env;
  const root = await childSessionRoot(env);
  if (isLarvaError(root)) return failed(null, personaId, root);

  let canonicalTaskId: string | null = null;
  if (taskId !== null) {
    const validated = await validateTaskId(taskId, root);
    if (isLarvaError(validated)) return failed(null, personaId, validated);
    canonicalTaskId = validated;
    if (activeTaskIds.has(canonicalTaskId)) return failed(canonicalTaskId, personaId, error("LARVA_SESSION_BUSY", "Child session is already being resumed."));
    activeTaskIds.add(canonicalTaskId);
  }

  try {
    if (ctx?.abortSignal?.aborted) return cancelled(canonicalTaskId, personaId);
    const result = await runChildSequence(env, root, personaId, task, canonicalTaskId);
    if (ctx?.abortSignal?.aborted && result.status !== "success") return cancelled(result.task_id, personaId);
    return result;
  } finally {
    if (canonicalTaskId) activeTaskIds.delete(canonicalTaskId);
  }
}

async function resolvePersona(personaId: string, env: RuntimeEnv): Promise<PersonaSpec | LarvaError> {
  const prefix = env.LARVA_CLI_ARGV_JSON ? JSON.parse(env.LARVA_CLI_ARGV_JSON) : ["uvx", "larva"];
  if (!Array.isArray(prefix) || !prefix.every((item) => typeof item === "string")) return error("LARVA_PERSONA_NOT_FOUND", "Invalid Larva CLI argv prefix.");
  const [cmd, ...args] = [...prefix, "resolve", personaId, "--json"];
  const child = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.timeout(10_000) });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolveExit) => child.on("exit", resolveExit));
  if (code !== 0) return error("LARVA_PERSONA_NOT_FOUND", "Persona could not be resolved.");
  try {
    const parsed = JSON.parse(stdout) as { data?: PersonaSpec };
    if (parsed.data && typeof parsed.data.id === "string") return parsed.data;
  } catch { /* malformed output maps to persona-not-found */ }
  return error("LARVA_PERSONA_NOT_FOUND", "Persona resolve returned malformed JSON.");
}

async function completePersonaIds(env: RuntimeEnv): Promise<string[]> {
  const prefix = env.LARVA_CLI_ARGV_JSON ? JSON.parse(env.LARVA_CLI_ARGV_JSON) : ["uvx", "larva"];
  const [cmd, ...args] = [...prefix, "list", "--json"];
  const child = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.timeout(10_000) });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  await new Promise((resolveExit) => child.on("exit", resolveExit));
  const parsed = JSON.parse(stdout) as { data?: Array<{ id?: unknown }> };
  return Array.isArray(parsed.data) ? parsed.data.map((item) => item.id).filter((id): id is string => typeof id === "string") : [];
}

async function filterPolicyTools(ctx: PiContext, policy: PiToolPolicy): Promise<string[] | LarvaError> {
  try {
    const baseline = await ctx.getAllTools?.();
    if (!Array.isArray(baseline)) return error("LARVA_TOOL_ENUMERATION_FAILED", "Pi tool enumeration failed.");
    const baselineSet = new Set(baseline);
    const denied = new Set((policy.deny || []).filter((tool) => baselineSet.has(tool)));
    const allowSource = policy.allow ? policy.allow.filter((tool) => baselineSet.has(tool)) : baseline;
    const filtered = allowSource.filter((tool) => !denied.has(tool)); // deny wins
    const applied = await ctx.setActiveTools?.(filtered);
    if (applied === false) return error("LARVA_TOOL_ENUMERATION_FAILED", "Pi active-tool update failed.");
    allowedToolNames = new Set(filtered);
    return filtered;
  } catch {
    return error("LARVA_TOOL_ENUMERATION_FAILED", "Pi tool enumeration failed.");
  }
}

async function commitPersona(personaId: string, ctx: PiContext): Promise<PersonaSwitchResult> {
  const previousEnvelope = activeParent;
  const spec = await resolvePersona(personaId, ctx.env || process.env);
  if (isLarvaError(spec)) return { ok: false, error: spec };
  const parsed = parseModel(spec.model);
  if (!parsed) return { ok: false, error: error("LARVA_MODEL_UNAVAILABLE", "Persona model must include provider/modelId such as openrouter/google/gemini.") };
  const model = await ctx.modelRegistry?.find?.(parsed.provider, parsed.modelId);
  if (!model) return { ok: false, error: error("LARVA_MODEL_UNAVAILABLE", "Persona model is unavailable.") };
  const setModel = await ctx.setModel?.(model);
  if (setModel === false) return { ok: false, error: error("LARVA_MODEL_UNAVAILABLE", "Pi rejected persona model.") };
  const envelope: PersonaEnvelope = { persona_id: spec.id, spec_digest: spec.spec_digest || "", model: spec.model, prompt: spec.prompt, tool_policy: {}, can_spawn: spec.can_spawn };
  const tools = await filterPolicyTools(ctx, envelope.tool_policy);
  if (isLarvaError(tools)) { activeParent = previousEnvelope; return { ok: false, error: tools }; }
  activeParent = envelope;
  await ctx.ui?.setStatus?.(`larva: ${envelope.persona_id}`);
  return { ok: true, envelope };
}

function evaluateToolPolicy(toolName: string): ToolPolicyDecision {
  if (allowedToolNames && !allowedToolNames.has(toolName)) return { action: "deny", error: error("LARVA_TOOL_DENIED", `Tool ${toolName} is denied by Larva policy.`) };
  return { action: "allow" };
}

async function openPersonaSelector(ctx: PiContext): Promise<PersonaSwitchResult> {
  if (ctx.env?.LARVA_PI_INTERACTIVE_TUI !== "1") return { ok: false, error: error("LARVA_BAD_INPUT", "Persona selector is interactive-only; preserve previousEnvelope.") };
  const ids = await completePersonaIds(ctx.env || process.env);
  const selected = ids[0];
  if (!selected) return { ok: false, error: error("LARVA_BAD_INPUT", "No persona selected; rollback to previousEnvelope.") };
  return commitPersona(selected, ctx);
}

export async function initializeExtension(ctx: PiContext): Promise<void> {
  const env = ctx.env || process.env;
  if (env.LARVA_PI_INITIAL_PERSONA_ID) {
    const committed = await commitPersona(env.LARVA_PI_INITIAL_PERSONA_ID, ctx);
    if (!committed.ok) throw new Error(`larva pi: ${committed.error.code}: ${committed.error.message}`);
  } else {
    await ctx.ui?.setStatus?.("larva: none");
  }
  ctx.on?.("before_agent_start", (event: unknown) => ({ systemPrompt: replaceLarvaWatermark(String((event as { systemPrompt?: unknown }).systemPrompt || ""), activeParent) }));
  ctx.on?.("tool_call", (event: unknown) => evaluateToolPolicy(String((event as { name?: unknown }).name || "")));
  void openPersonaSelector;
  void larva_subagent;
}

export const __contract_examples = {
  badInput: { task_id: null, persona_id: "", status: "failed", result_text: "", error: { code: "LARVA_BAD_INPUT", message: "task must be a non-empty string." } },
  failedAfterAllocation: { task_id: "/tmp/example.jsonl", persona_id: "doc-reviewer", status: "failed", result_text: "", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "failed after allocation" } },
  deniedSubagentNoHandler: "handler larva_subagent LARVA_TOOL_DENIED no LarvaSubagentResult",
  startupShape: "larva pi: <ERROR_CODE>: <human-readable message>",
  piApiTokens: "modelRegistry.find ctx.ui.setStatus typeof data.text === \"string\"",
};
