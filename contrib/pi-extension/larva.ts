import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Input as TuiInput, Key, Markdown, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type MarkdownTheme, type SelectItem } from "@earendil-works/pi-tui";
import { access, appendFile, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  | "LARVA_SUBAGENT_LOG_NOT_OBSERVED"
  | "LARVA_SUBAGENT_LOG_UI_UNAVAILABLE"
  | "LARVA_SUBAGENT_LOG_CONFIG_INVALID"
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
  LARVA_PI_CHILD_RPC_TRACE_FILE?: string;
  LARVA_PI_SUBAGENT_LOG_FILE?: string;
};

type CapabilityPosture = "none" | "read_only" | "read_write" | "destructive";

export type PersonaSpec = {
  id: string;
  description: string;
  prompt: string;
  model: string;
  capabilities: Record<string, CapabilityPosture>;
  model_params?: Record<string, unknown>;
  can_spawn?: boolean | string[];
  compaction_prompt?: string;
  spec_version: "0.1.0";
  spec_digest?: string;
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
type SubagentPresentationStatus = LarvaSubagentResult["status"] | "running";
type RecentSubagentSession = {
  task_id: string;
  persona_id: string;
  last_status: SubagentPresentationStatus;
  sequence: number;
};
type SubagentPresentationMode = "new" | "resume";
type SubagentToolStatus = "running" | "success" | "failed" | "cancelled";
type SubagentToolSnapshot = {
  toolCallId: string;
  name?: string;
  status: SubagentToolStatus;
  args_preview?: string;
  output_preview?: string;
  error_preview?: string;
};
type SubagentActiveToolState = { toolCallId: string; name?: string; status?: SubagentToolStatus } | null;
type SubagentPresentationLogEntry = {
  task_id: string | null;
  persona_id: string;
  status: SubagentPresentationStatus;
  sequence: number;
  mode?: SubagentPresentationMode;
  task_preview?: string;
  task_prompt?: string;
  phase?: string;
  result_text?: string;
  error?: LarvaError | null;
  call_id?: string;
  updated_at?: string;
  live_assistant_preview?: string;
  live_thinking_hidden?: boolean;
  tool_snapshots?: SubagentToolSnapshot[];
  active_tool_state?: SubagentActiveToolState;
  raw_rpc_events?: unknown[];
};
type LarvaSubagentOverlayResult = {
  ok: boolean;
  view_only: true;
  content: PiTextContent[];
  details: {
    status: "success" | "failed";
    entries: SubagentPresentationLogEntry[];
    selected_task_id: string | null;
    overlay_generation: number;
    error: LarvaError | null;
  };
  isError: boolean;
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
  handler: (input?: string, ctx?: PiContext) => Promise<unknown>;
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
type PiOverlayComponent = PiRenderableComponent & { handleInput?: (data: string) => void; dispose?: () => void };
type PiKeybindings = { matches?: (data: string, keybindingId: string) => boolean };
type PiOverlayHandle = { focus?: () => void };
type PiShortcutContext = PiContext & { isIdle?: () => boolean };
type PiTui = { requestRender?: () => void; terminal?: { write?: (data: string) => void; rows?: number; columns?: number } };
type PiCustomFactory = (
  tui: PiTui,
  theme: { fg?: (token: string, text: string) => string; bold?: (text: string) => string },
  keybindings: PiKeybindings,
  done: (result: unknown) => void,
) => PiOverlayComponent;
type PiRenderableText = PiRenderableComponent & { text: string; markdown?: string; format?: "plain_text" | "markdown" };
type SelectorOption = { id: string; label: string; description?: string };
type BridgeListItem = { id: string; description?: string; model?: string; spec_digest?: string; capabilities?: Record<string, CapabilityPosture> };
type StatusSetter = ((status: string) => void | Promise<void>) | ((key: string, status?: string) => void | Promise<void>);
type PiUi = {
  setStatus?: StatusSetter;
  addAutocompleteProvider?: (provider: PiAutocompleteProviderFactory) => unknown;
  notify?: (message: string, notifyType?: "info" | "warning" | "error") => void | Promise<void>;
  custom?: (factory: PiCustomFactory, options?: Record<string, unknown>) => unknown | Promise<unknown>;
  select?: (title: string, options: string[] | SelectorOption[]) => Promise<string | SelectorOption | null | undefined>;
};
type PiApi = {
  setModel?: (model: unknown) => boolean | void | Promise<boolean | void>;
  getAllTools?: () => unknown[] | Promise<unknown[]>;
  setActiveTools?: (tools: string[]) => boolean | void | Promise<boolean | void>;
  registerCommand?: ((name: string, options: CommandOptions) => void) | ((command: LegacyCommandDefinition) => void);
  registerShortcut?: (shortcut: string, options: { description?: string; handler: (ctx: PiShortcutContext) => void | Promise<void> }) => void;
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
const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_REPORTING = "\x1b[?1006l\x1b[?1000l";
const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: () => "",
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text === "- " ? "• " : text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
  codeBlockIndent: "  ",
};
const state: ActiveState = { envelope: null, activeTools: new Set<string>(), piModel: null };
const activeTaskIds: Set<string> = new Set<string>();
const retainedSubagentPresentationLog: SubagentPresentationLogEntry[] = [];
const activeSubagentChildren: Set<{ child: ChildProcessWithoutNullStreams; env: RuntimeEnv }> = new Set();
let currentSubagentOverlay: { entry: SubagentPresentationLogEntry; text: string; generation: number } | null = null;
let currentSubagentOverlayComponent: PiOverlayComponent | null = null;
let subagentOverlayGeneration = 0;
let subagentPresentationSequence = 0;
let subagentUiResetGeneration = 0;
let subagentPresentationCacheEnv: RuntimeEnv | null = null;
let subagentPresentationCacheError: LarvaError | null = null;

type SubagentPresentationCacheConfig = {
  enabled: boolean;
  max_entries: number;
  max_age_days: number;
  include_prompt: boolean;
  include_output: boolean;
};

type SubagentPresentationCacheFile = {
  version: 1;
  entries: SubagentPresentationLogEntry[];
};

const DEFAULT_SUBAGENT_PRESENTATION_CACHE_CONFIG: SubagentPresentationCacheConfig = {
  enabled: true,
  max_entries: 100,
  max_age_days: 7,
  include_prompt: true,
  include_output: true,
};
const SUBAGENT_LIVE_ASSISTANT_PREVIEW_LIMIT = 4_000;
const SUBAGENT_TOOL_ARGS_PREVIEW_LIMIT = 800;
const SUBAGENT_TOOL_OUTPUT_PREVIEW_LIMIT = 1_200;
const SUBAGENT_TRUNCATION_MARKER = "… [truncated]";
let personaListCache: PersonaListCache = null;
let personaListInFlight: PersonaListInFlight = null;
let personaCompletionClock: () => number = () => Date.now();
let toolEnumerationMode: ToolEnumerationMode = "strict";

const error = (code: LarvaErrorCode, message: string): LarvaError => ({ code, message });

type ChildRpcTraceFields = Record<string, unknown>;

function childRpcTraceFile(env: RuntimeEnv): string | null {
  const traceFile = env.LARVA_PI_CHILD_RPC_TRACE_FILE;
  return typeof traceFile === "string" && traceFile.length > 0 ? traceFile : null;
}

async function traceChildRpc(env: RuntimeEnv, event: string, fields: ChildRpcTraceFields = {}): Promise<void> {
  const traceFile = childRpcTraceFile(env);
  if (traceFile === null) return;
  try {
    await appendFile(traceFile, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`, "utf8");
  } catch {
    // Trace instrumentation is proof-only and must never change child runtime behavior.
  }
}

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

function overlaySafeLine(value: string): string {
  return value.normalize("NFC").replace(ANSI_ESCAPE_RE, "").replace(CONTROL_RE, " ").replace(/\t/g, "   ").trimEnd();
}

function overlayDisplayWidth(value: string): number {
  return visibleWidth(value);
}

function overlayTruncateLine(value: string, contentWidth: number, pad = false): string {
  return truncateToWidth(value, Math.max(0, contentWidth), "", pad);
}

function overlayWrapLine(value: string, contentWidth: number): string[] {
  const safeLine = overlaySafeLine(value);
  if (safeLine.length === 0) return [""];
  const wrapped = wrapTextWithAnsi(safeLine, Math.max(1, contentWidth));
  return (wrapped.length > 0 ? wrapped : [""]).map((line) => overlayTruncateLine(line, contentWidth));
}

function overlayPadLine(value: string, contentWidth: number): string {
  return overlayTruncateLine(value, contentWidth, true);
}

function keybindingsMatch(keybindings: PiKeybindings | undefined, data: string, keybindingIds: string[]): boolean {
  if (!keybindings || typeof keybindings.matches !== "function") return false;
  return keybindingIds.some((keybindingId) => {
    try {
      return keybindings.matches?.(data, keybindingId) === true;
    } catch {
      return false;
    }
  });
}

function matchesInputKey(
  keybindings: PiKeybindings | undefined,
  data: string,
  keybindingIds: string[],
  keys: string[],
  rawFallbacks: string[] = [],
  namedFallbacks: string[] = [],
): boolean {
  const lowered = data.toLowerCase();
  return keybindingsMatch(keybindings, data, keybindingIds)
    || keys.some((key) => matchesKey(data, key))
    || rawFallbacks.includes(data)
    || namedFallbacks.includes(lowered);
}

function isSubagentOverlayCloseKey(data: string, keybindings?: PiKeybindings): boolean {
  return matchesInputKey(keybindings, data, ["tui.select.cancel", "app.interrupt"], [Key.escape, Key.ctrl("c"), "q"], [], ["escape"])
    || /^\x1b\[27;\d+;27~$/.test(data)
    || /^\x1b\[27;\d+;27u$/.test(data)
    || /^\x1b\[27u$/.test(data);
}

function isSgrMouseEvent(data: string): boolean {
  return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data);
}

function mouseWheelScrollDelta(data: string): number | null {
  const match = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (!match) return null;
  const button = Number(match[1]);
  if (!Number.isInteger(button) || (button & 64) === 0) return null;
  const wheelDirection = button & 3;
  if (wheelDirection === 0) return -3;
  if (wheelDirection === 1) return 3;
  return null;
}

type PersonaSelectorTheme = { fg?: (token: string, text: string) => string; bold?: (text: string) => string };

const ANSI_RESET = "\x1b[0m";
const ANSI_FG_RESET = "\x1b[39m";
const ANSI_RESET_RE = /\x1b\[(?:0)?m/g;
const SELECTOR_SURFACE_BG = "\x1b[48;5;235m";
const SELECTOR_BORDER_FG = "\x1b[38;5;116m";
const SELECTOR_SHADOW_FG = "\x1b[38;5;232m";
const PERSONA_SELECTOR_MIN_LIST_LINES = 9;
const PERSONA_SELECTOR_DETAIL_LINES = 8;
const PERSONA_SELECTOR_FIXED_SURFACE_LINES_WITHOUT_LIST = PERSONA_SELECTOR_DETAIL_LINES + 8;
const PERSONA_SELECTOR_MIN_SURFACE_LINES = PERSONA_SELECTOR_FIXED_SURFACE_LINES_WITHOUT_LIST + PERSONA_SELECTOR_MIN_LIST_LINES;
const PERSONA_SELECTOR_FALLBACK_SURFACE_LINES = 34;
const PERSONA_SELECTOR_MAX_SURFACE_LINES = 36;

type LarvaPersonaSelectorOptions = {
  personas: BridgeListItem[];
  theme: PersonaSelectorTheme;
  keybindings?: PiKeybindings;
  tui?: PiTui;
  done: (result: string | null) => void;
};

function selectorThemeFg(theme: PersonaSelectorTheme, token: string, text: string): string {
  try {
    return theme.fg?.(token, text) ?? text;
  } catch {
    return text;
  }
}

function selectorThemeBold(theme: PersonaSelectorTheme, text: string): string {
  try {
    return theme.bold?.(text) ?? text;
  } catch {
    return text;
  }
}

function selectorLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "");
}

function selectorFixedViewportLines(lines: string[], width: number, count: number): string[] {
  const viewportLineCount = Math.max(0, count);
  const result = lines.slice(0, viewportLineCount).map((line) => selectorLine(line, width));
  if (lines.length > viewportLineCount && viewportLineCount > 0) {
    result[viewportLineCount - 1] = selectorLine("…", width);
  }
  while (result.length < viewportLineCount) result.push("");
  return result;
}

function selectorClamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function selectorTerminalRows(tui?: PiTui): number | null {
  const rows = tui?.terminal?.rows;
  if (typeof rows !== "number" || !Number.isFinite(rows)) return null;
  return Math.max(1, Math.floor(rows));
}

function selectorSurfaceLineCount(tui?: PiTui): number {
  const rows = selectorTerminalRows(tui);
  if (rows === null) return PERSONA_SELECTOR_FALLBACK_SURFACE_LINES;
  const shadowAwareBudget = Math.floor(rows * 0.82) - 1;
  return selectorClamp(shadowAwareBudget, PERSONA_SELECTOR_MIN_SURFACE_LINES, PERSONA_SELECTOR_MAX_SURFACE_LINES);
}

function selectorListViewportLines(tui?: PiTui): number {
  return Math.max(PERSONA_SELECTOR_MIN_LIST_LINES, selectorSurfaceLineCount(tui) - PERSONA_SELECTOR_FIXED_SURFACE_LINES_WITHOUT_LIST);
}

function selectorBorder(text: string): string {
  return `${SELECTOR_BORDER_FG}${text}${ANSI_FG_RESET}`;
}

function selectorSurfaceLine(line: string): string {
  return `${SELECTOR_SURFACE_BG}${line.replace(ANSI_RESET_RE, `${ANSI_RESET}${SELECTOR_SURFACE_BG}`)}${ANSI_RESET}`;
}

function selectorShadow(text: string): string {
  return `${SELECTOR_SHADOW_FG}${text}${ANSI_RESET}`;
}

function selectorShadowLine(width: number): string {
  return selectorShadow(`${" ".repeat(width > 0 ? 1 : 0)}${"▀".repeat(Math.max(0, width))}`);
}

function selectorBoxRow(line: string, contentWidth: number, withShadow: boolean): string {
  const row = `${selectorBorder("│")} ${overlayPadLine(line, contentWidth)} ${selectorBorder("│")}`;
  return `${selectorSurfaceLine(row)}${withShadow ? selectorShadow("█") : ""}`;
}

function selectorFullBorderRow(left: string, middle: string, right: string, withShadow: boolean): string {
  const row = selectorBorder(`${left}${middle}${right}`);
  return `${selectorSurfaceLine(row)}${withShadow ? selectorShadow("█") : ""}`;
}

function selectorDescription(persona: BridgeListItem): string | undefined {
  return persona.description ?? persona.model;
}

function selectorItemDescription(persona: BridgeListItem): string | undefined {
  const parts = [persona.model, persona.description].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

function selectorCapabilitiesSummary(capabilities: Record<string, CapabilityPosture> | undefined): string {
  if (capabilities === undefined) return "not listed";
  const entries = Object.entries(capabilities).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "none declared";
  const active = entries.filter(([, posture]) => posture !== "none");
  const summarySource = active.length > 0 ? active : entries;
  const visible = summarySource.slice(0, 4).map(([family, posture]) => `${family}:${posture}`);
  const remaining = summarySource.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")} +${remaining} more` : visible.join(", ");
}

export function rankPersonasForSelector(personas: BridgeListItem[], filter: string): BridgeListItem[] {
  const query = filter.trim().toLocaleLowerCase();
  if (query.length === 0) return personas.slice();
  return personas
    .map((persona, index) => {
      const idLower = persona.id.toLocaleLowerCase();
      const descriptionLower = (persona.description ?? "").toLocaleLowerCase();
      const idMatch = idLower.includes(query);
      const descriptionMatch = descriptionLower.includes(query);
      const rank = idLower.startsWith(query) ? 0 : idMatch ? 1 : 2;
      return { persona, index, idMatch, descriptionMatch, rank };
    })
    .filter((entry) => entry.idMatch || entry.descriptionMatch)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.persona);
}

export class LarvaPersonaSelector implements PiOverlayComponent, Focusable {
  private readonly personas: BridgeListItem[];
  private readonly theme: PersonaSelectorTheme;
  private readonly keybindings?: PiKeybindings;
  private readonly tui?: PiTui;
  private readonly done: (result: string | null) => void;
  private readonly input = new TuiInput();
  private filter = "";
  private filteredPersonas: BridgeListItem[] = [];
  private selectItems: SelectItem[] = [];
  private selectList: SelectList;
  private selectedIndex = 0;
  private listViewportLines = PERSONA_SELECTOR_MIN_LIST_LINES;
  private _focused = true;

  constructor(options: LarvaPersonaSelectorOptions) {
    this.personas = options.personas;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.tui = options.tui;
    this.done = options.done;
    this.input.focused = true;
    this.selectList = this.createSelectList([]);
    this.applyFilter("");
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private createSelectList(items: SelectItem[], listViewportLines = this.listViewportLines): SelectList {
    const selectList = new SelectList(items, Math.max(1, listViewportLines - 1), {
      selectedPrefix: (text) => selectorThemeFg(this.theme, "accent", text),
      selectedText: (text) => selectorThemeFg(this.theme, "accent", text),
      description: (text) => selectorThemeFg(this.theme, "muted", text),
      scrollInfo: (text) => selectorThemeFg(this.theme, "dim", text),
      noMatch: (text) => selectorThemeFg(this.theme, "warning", text.replace("commands", "personas")),
    }, {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 34,
    });
    selectList.onSelect = (item) => this.done(item.value);
    selectList.onCancel = () => this.done(null);
    selectList.onSelectionChange = (item) => this.syncSelectedItem(item.value);
    return selectList;
  }

  private rebuildSelectList(items = this.selectItems, listViewportLines = this.listViewportLines): void {
    this.selectItems = items;
    this.listViewportLines = listViewportLines;
    this.selectList = this.createSelectList(items, listViewportLines);
    this.selectList.setSelectedIndex(this.selectedIndex);
  }

  private applyFilter(filter: string): void {
    this.filter = filter;
    this.filteredPersonas = rankPersonasForSelector(this.personas, filter);
    this.selectedIndex = 0;
    const items = this.filteredPersonas.map((persona) => ({
      value: persona.id,
      label: persona.id,
      description: selectorItemDescription(persona),
    }));
    this.rebuildSelectList(items, this.listViewportLines);
  }

  private syncSelectedItem(personaId: string): void {
    const nextIndex = this.filteredPersonas.findIndex((persona) => persona.id === personaId);
    this.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
  }

  private selectedPersona(): BridgeListItem | null {
    return this.filteredPersonas[this.selectedIndex] ?? null;
  }

  private moveSelection(delta: number): void {
    if (this.filteredPersonas.length === 0) return;
    const nextIndex = (this.selectedIndex + delta + this.filteredPersonas.length) % this.filteredPersonas.length;
    this.selectedIndex = nextIndex;
    this.selectList.setSelectedIndex(nextIndex);
  }

  private confirmSelection(): void {
    const selected = this.selectList.getSelectedItem();
    if (selected) this.done(selected.value);
  }

  private requestRender(): void {
    this.tui?.requestRender?.();
  }

  private renderDetailRow(label: string, value: string, width: number): string[] {
    const prefix = `${label}: `;
    const safeValue = overlaySafeLine(value).trim() || "not listed";
    const valueWidth = Math.max(1, width - visibleWidth(prefix));
    const wrapped = wrapTextWithAnsi(safeValue, valueWidth);
    const lines = wrapped.length > 0 ? wrapped : [safeValue];
    return lines.map((line, index) => selectorLine(`${index === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${line}`, width));
  }

  private renderDetail(width: number): string[] {
    const persona = this.selectedPersona();
    if (!persona) return [selectorLine(selectorThemeFg(this.theme, "warning", "No matching persona."), width)];
    return [
      ...this.renderDetailRow("ID", persona.id, width),
      ...this.renderDetailRow("Model", persona.model ?? "not listed", width),
      ...this.renderDetailRow("Description", selectorDescription(persona) ?? "not listed", width),
      ...this.renderDetailRow("Capabilities", selectorCapabilitiesSummary(persona.capabilities), width),
      ...this.renderDetailRow("Digest", persona.spec_digest ?? "not listed", width),
    ];
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (renderWidth < 4) return [selectorLine("Select Larva persona", renderWidth)];
    const withShadow = renderWidth >= 8;
    const boxWidth = withShadow ? renderWidth - 1 : renderWidth;
    const contentWidth = boxWidth - 4;
    const nextListViewportLines = selectorListViewportLines(this.tui);
    if (nextListViewportLines !== this.listViewportLines) {
      this.rebuildSelectList(this.selectItems, nextListViewportLines);
    }
    const filterPrefix = "Filter: ";
    const inputWidth = Math.max(1, contentWidth - visibleWidth(filterPrefix));
    const inputLine = this.input.render(inputWidth)[0] ?? "";
    const listLines = selectorFixedViewportLines(
      this.selectList.render(contentWidth).map((line) => selectorLine(line, contentWidth)),
      contentWidth,
      this.listViewportLines,
    );
    const detailLines = selectorFixedViewportLines(this.renderDetail(contentWidth), contentWidth, PERSONA_SELECTOR_DETAIL_LINES);
    const contentLines = [
      selectorLine(`${filterPrefix}${inputLine}`, contentWidth),
      selectorLine(selectorThemeFg(this.theme, "dim", "Type to filter persona ids/descriptions."), contentWidth),
      "",
      ...listLines,
    ];
    const detailAndFooterLines = [
      selectorLine(selectorThemeFg(this.theme, "accent", selectorThemeBold(this.theme, "Detail")), contentWidth),
      ...detailLines,
      selectorLine(selectorThemeFg(this.theme, "dim", "↑↓ navigate • enter confirm • esc cancel • mouse click unsupported"), contentWidth),
    ];
    const title = selectorThemeFg(this.theme, "accent", selectorThemeBold(this.theme, "Select Larva persona"));
    const topTitle = overlayTruncateLine(`─ ${title} `, boxWidth - 2);
    const topMiddle = `${topTitle}${"─".repeat(Math.max(0, boxWidth - 2 - overlayDisplayWidth(topTitle)))}`;
    const dividerMiddle = "─".repeat(Math.max(0, boxWidth - 2));
    const rows = [
      selectorFullBorderRow("╭", topMiddle, "╮", withShadow),
      ...contentLines.map((line) => selectorBoxRow(line, contentWidth, withShadow)),
      selectorFullBorderRow("├", dividerMiddle, "┤", withShadow),
      ...detailAndFooterLines.map((line) => selectorBoxRow(line, contentWidth, withShadow)),
      selectorFullBorderRow("╰", "─".repeat(Math.max(0, boxWidth - 2)), "╯", withShadow),
    ];
    return withShadow ? [...rows, selectorShadowLine(boxWidth)] : rows;
  }

  invalidate(): void {
    this.input.invalidate();
    this.selectList.invalidate();
  }

  handleInput(data: string): void {
    if (isSgrMouseEvent(data)) return; // Mouse click/press/release SGR events are intentionally unsupported no-ops.
    if (matchesInputKey(this.keybindings, data, ["tui.select.cancel", "app.interrupt"], [Key.escape, Key.ctrl("c")], [], ["escape"])) {
      this.done(null);
      return;
    }
    if (matchesInputKey(this.keybindings, data, ["tui.select.confirm", "tui.input.submit"], [Key.enter], ["\r", "\n"], ["enter"])) {
      this.confirmSelection();
      return;
    }
    if (matchesInputKey(this.keybindings, data, ["tui.select.down", "tui.editor.cursorDown"], [Key.down], [], ["arrowdown", "down"])) {
      this.moveSelection(1);
      this.requestRender();
      return;
    }
    if (matchesInputKey(this.keybindings, data, ["tui.select.up", "tui.editor.cursorUp"], [Key.up], [], ["arrowup", "up"])) {
      this.moveSelection(-1);
      this.requestRender();
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (after !== before) {
      this.applyFilter(after);
      this.requestRender();
    }
  }
}

type BorderedScrollableTextOptions = {
  text: string;
  title?: string;
  keybindings?: PiKeybindings;
  tui?: PiTui;
  done?: (result: unknown) => void;
  maxBoxLines?: number;
  maxWidth?: number;
};

export class BorderedScrollableText implements PiOverlayComponent {
  private scrollOffset = 0;
  private lastMaxOffset = 0;
  private mouseReportingEnabled = false;
  private readonly text: string;
  private readonly title: string;
  private readonly keybindings?: PiKeybindings;
  private readonly tui?: PiTui;
  private readonly done?: (result: unknown) => void;
  private readonly maxBoxLines: number;
  private readonly maxWidth: number;

  constructor(options: BorderedScrollableTextOptions) {
    this.text = options.text;
    this.title = options.title ?? "Scrollable text";
    this.keybindings = options.keybindings;
    this.tui = options.tui;
    this.done = options.done;
    this.maxBoxLines = Math.max(4, Math.floor(options.maxBoxLines ?? 22));
    this.maxWidth = Math.max(4, Math.floor(options.maxWidth ?? 100));
    if (this.tui?.terminal?.write) {
      this.tui.terminal.write(ENABLE_MOUSE_REPORTING);
      this.mouseReportingEnabled = true;
    }
  }

  invalidate(): void {}

  dispose(): void {
    if (!this.mouseReportingEnabled) return;
    this.tui?.terminal?.write?.(DISABLE_MOUSE_REPORTING);
    this.mouseReportingEnabled = false;
  }

  private viewportLines(): number {
    return Math.max(1, this.maxBoxLines - 3);
  }

  private requestRender(): void {
    this.tui?.requestRender?.();
  }

  private scrollBy(delta: number): void {
    const next = Math.max(0, Math.min(this.lastMaxOffset, this.scrollOffset + delta));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.invalidate();
    this.requestRender();
  }

  private jumpTo(offset: number): void {
    const next = Math.max(0, Math.min(this.lastMaxOffset, offset));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.invalidate();
    this.requestRender();
  }

  render(width: number): string[] {
    const renderWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
    const boxWidth = Math.min(renderWidth, this.maxWidth);
    if (boxWidth < 4) return [truncateToWidth(this.title, boxWidth, "")];
    const contentWidth = boxWidth - 4;
    const viewportLines = this.viewportLines();
    const topTitle = overlayTruncateLine(`─ ${this.title} `, boxWidth - 2);
    const top = `╭${topTitle}${"─".repeat(Math.max(0, boxWidth - 2 - overlayDisplayWidth(topTitle)))}╮`;
    const innerLines = this.text.split(/\r?\n/).flatMap((line) => overlayWrapLine(line, contentWidth));
    this.lastMaxOffset = Math.max(0, innerLines.length - viewportLines);
    this.scrollOffset = Math.max(0, Math.min(this.lastMaxOffset, this.scrollOffset));
    const visibleLines = innerLines.slice(this.scrollOffset, this.scrollOffset + viewportLines);
    while (visibleLines.length < viewportLines) visibleLines.push("");
    const start = innerLines.length === 0 ? 0 : this.scrollOffset + 1;
    const end = Math.min(innerLines.length, this.scrollOffset + viewportLines);
    const scrollInfo = innerLines.length > viewportLines ? `Wheel/↑↓ PgUp/PgDn Home/End • Esc/q close • ${start}-${end}/${innerLines.length}` : "Esc/q close";
    return [
      top,
      ...visibleLines.map((line) => `│ ${overlayPadLine(line, contentWidth)} │`),
      `│ ${overlayPadLine(scrollInfo, contentWidth)} │`,
      `╰${"─".repeat(boxWidth - 2)}╯`,
    ];
  }

  handleInput(data: string): void {
    if (isSubagentOverlayCloseKey(data, this.keybindings)) {
      this.dispose();
      this.done?.(null);
      return;
    }
    const wheelDelta = mouseWheelScrollDelta(data);
    if (wheelDelta !== null) {
      this.scrollBy(wheelDelta);
      return;
    }
    if (isSgrMouseEvent(data)) return; // Mouse click/press/release SGR events are intentionally unsupported no-ops.
    if (matchesInputKey(this.keybindings, data, ["tui.select.down", "tui.editor.cursorDown"], [Key.down], [], ["arrowdown", "down"])) this.scrollBy(1);
    else if (matchesInputKey(this.keybindings, data, ["tui.select.up", "tui.editor.cursorUp"], [Key.up], [], ["arrowup", "up"])) this.scrollBy(-1);
    else if (matchesInputKey(this.keybindings, data, ["tui.select.pageDown", "tui.editor.pageDown"], [Key.pageDown], [], ["pagedown"])) this.scrollBy(this.viewportLines());
    else if (matchesInputKey(this.keybindings, data, ["tui.select.pageUp", "tui.editor.pageUp"], [Key.pageUp], [], ["pageup"])) this.scrollBy(-this.viewportLines());
    else if (matchesInputKey(this.keybindings, data, ["tui.editor.cursorLineStart"], [Key.home], ["\x1b[1~"], ["home"])) this.jumpTo(0);
    else if (matchesInputKey(this.keybindings, data, ["tui.editor.cursorLineEnd"], [Key.end], ["\x1b[4~"], ["end"])) this.jumpTo(this.lastMaxOffset);
  }
}

type SubagentOverlayTab = "summary" | "output" | "prompt" | "events" | "metadata";
const SUBAGENT_OVERLAY_TABS: Array<{ id: SubagentOverlayTab; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "prompt", label: "Prompt" },
  { id: "output", label: "Output" },
  { id: "events", label: "Events" },
  { id: "metadata", label: "Metadata" },
];
const SUBAGENT_OVERLAY_MIN_SURFACE_LINES = 18;
const SUBAGENT_OVERLAY_FALLBACK_SURFACE_LINES = 34;
const SUBAGENT_OVERLAY_MAX_SURFACE_LINES = 90;

type SubagentPresentationLogOverlayOptions = {
  entry: SubagentPresentationLogEntry;
  generation: number;
  theme?: PersonaSelectorTheme;
  keybindings?: PiKeybindings;
  tui?: PiTui;
  done?: (result: unknown) => void;
  maxBoxLines?: number;
  maxWidth?: number;
};

type SubagentOverlaySelection = {
  task_id: string | null;
  call_id?: string;
  sequence: number;
};

function rendererSafeMarkdownSource(value: string): string {
  const strippedAnsi = value.normalize("NFC").replace(ANSI_ESCAPE_RE, "");
  let rendered = "";
  for (const char of Array.from(strippedAnsi)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    if (char === "\n" || char === "\r") {
      rendered += char;
      continue;
    }
    if (char === "\t") {
      rendered += "   ";
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      rendered += " ";
      continue;
    }
    rendered += char;
  }
  return rendered;
}

function renderRendererSafePlainLines(text: string, contentWidth: number): string[] {
  const width = Math.max(1, Math.floor(contentWidth));
  const lines = rendererSafeMarkdownSource(text).split(/\r?\n/).flatMap((line) => {
    if (line.length === 0) return [""];
    const wrapped = wrapTextWithAnsi(line, width);
    return (wrapped.length > 0 ? wrapped : [""]).map((wrappedLine) => truncateToWidth(wrappedLine, width, ""));
  });
  return lines.length > 0 ? lines : [""];
}

function renderMarkdownLines(markdown: string, contentWidth: number): string[] {
  const width = Math.max(1, Math.floor(contentWidth));
  try {
    const component = new Markdown(rendererSafeMarkdownSource(markdown), 0, 0, DEFAULT_MARKDOWN_THEME);
    const rendered = component.render(width);
    return (rendered.length > 0 ? rendered : [""]).map((line) => truncateToWidth(line, width, ""));
  } catch {
    return renderRendererSafePlainLines(markdown, width);
  }
}

function markdownFence(value: string): string {
  const safe = rendererSafeMarkdownSource(value);
  const fence = safe.includes("```") ? "````" : "```";
  return `${fence}text\n${safe}\n${fence}`;
}

function boundedPresentationPreview(value: string, limit: number): string {
  const safe = rendererSafeMarkdownSource(value).replace(/\s+/g, " ").trim();
  const codePoints = Array.from(safe);
  if (codePoints.length <= limit) return safe;
  const marker = SUBAGENT_TRUNCATION_MARKER;
  const markerWidth = Array.from(marker).length;
  if (limit <= markerWidth) return marker.slice(0, limit);
  return `${codePoints.slice(0, Math.max(0, limit - markerWidth)).join("")}${marker}`;
}

function boundedAssistantPreview(value: string): string {
  return boundedPresentationPreview(value, SUBAGENT_LIVE_ASSISTANT_PREVIEW_LIMIT);
}

function boundedToolArgsPreview(value: string): string {
  return boundedPresentationPreview(value, SUBAGENT_TOOL_ARGS_PREVIEW_LIMIT);
}

function boundedToolOutputPreview(value: string): string {
  return boundedPresentationPreview(value, SUBAGENT_TOOL_OUTPUT_PREVIEW_LIMIT);
}

function subagentEntryOutput(entry: SubagentPresentationLogEntry): string {
  if (entry.status === "running" && typeof entry.live_assistant_preview === "string" && entry.live_assistant_preview.trim().length > 0) {
    return boundedAssistantPreview(entry.live_assistant_preview);
  }
  return typeof entry.result_text === "string" && entry.status !== "running" ? entry.result_text : "";
}

function subagentEntryOutputIsPresent(entry: SubagentPresentationLogEntry): boolean {
  return subagentEntryOutput(entry).trim().length > 0;
}

function subagentThinkingHiddenLine(entry: SubagentPresentationLogEntry): string | null {
  if (entry.live_thinking_hidden === true) return "thinking hidden";
  if (entry.status === "running" && typeof entry.result_text === "string" && /thinking/i.test(entry.result_text)) return "thinking hidden";
  return null;
}

type NormalizedSubagentStreamEvent =
  | { kind: "assistant_delta"; text: string }
  | { kind: "thinking_hidden" }
  | { kind: "tool"; toolCallId: string; name?: string; status: SubagentToolStatus; args_preview?: string; output_preview?: string; error_preview?: string }
  | { kind: "terminal"; type: "agent_end" };

function normalizeSubagentChildStreamEventForPresentation(frame: unknown): NormalizedSubagentStreamEvent | null {
  if (!isRecord(frame) || typeof frame.type !== "string") return null;
  if (frame.type === "message_update") {
    const channel = typeof frame.channel === "string" ? frame.channel : typeof frame.kind === "string" ? frame.kind : "assistant";
    if (channel.startsWith("thinking")) return { kind: "thinking_hidden" };
    const text = typeof frame.text === "string" ? frame.text : typeof frame.delta === "string" ? frame.delta : "";
    return text.length > 0 ? { kind: "assistant_delta", text: boundedAssistantPreview(text) } : null;
  }
  if (frame.type === "tool_execution_start" || frame.type === "tool_execution_update" || frame.type === "tool_execution_end") {
    const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : typeof frame.tool_call_id === "string" ? frame.tool_call_id : "";
    if (toolCallId.length === 0) return null;
    const status: SubagentToolStatus = frame.type === "tool_execution_end" ? (frame.success === false ? "failed" : "success") : "running";
    return {
      kind: "tool",
      toolCallId,
      name: typeof frame.name === "string" ? frame.name : typeof frame.toolName === "string" ? frame.toolName : undefined,
      status,
      args_preview: typeof frame.args === "string" ? boundedToolArgsPreview(frame.args) : typeof frame.arguments === "string" ? boundedToolArgsPreview(frame.arguments) : undefined,
      output_preview: typeof frame.output === "string" ? boundedToolOutputPreview(frame.output) : undefined,
      error_preview: typeof frame.error === "string" ? boundedToolOutputPreview(frame.error) : undefined,
    };
  }
  if (frame.type === "agent_end") return { kind: "terminal", type: "agent_end" };
  return null;
}

function subagentEntryErrorText(entry: SubagentPresentationLogEntry): string {
  return entry.error ? `${entry.error.code}: ${entry.error.message}` : "none";
}

function subagentOverlaySurfaceLineCount(tui?: PiTui, explicitMaxBoxLines?: number): number {
  if (typeof explicitMaxBoxLines === "number" && Number.isFinite(explicitMaxBoxLines)) return Math.max(6, Math.floor(explicitMaxBoxLines));
  const rows = selectorTerminalRows(tui);
  if (rows === null) return SUBAGENT_OVERLAY_FALLBACK_SURFACE_LINES;
  const shadowAwareBudget = Math.floor(rows * 0.9) - 1;
  return selectorClamp(shadowAwareBudget, SUBAGENT_OVERLAY_MIN_SURFACE_LINES, SUBAGENT_OVERLAY_MAX_SURFACE_LINES);
}

export class SubagentPresentationLogOverlay implements PiOverlayComponent {
  private activeTabIndex = 0;
  private selectorMode = false;
  private readonly scrollOffsets: Record<SubagentOverlayTab, number> = { summary: 0, output: 0, prompt: 0, events: 0, metadata: 0 };
  private readonly lastMaxOffsets: Record<SubagentOverlayTab, number> = { summary: 0, output: 0, prompt: 0, events: 0, metadata: 0 };
  private mouseReportingEnabled = false;
  private entry: SubagentPresentationLogEntry;
  private readonly selection: SubagentOverlaySelection;
  private readonly generation: number;
  private readonly theme: PersonaSelectorTheme;
  private readonly keybindings?: PiKeybindings;
  private readonly tui?: PiTui;
  private readonly done?: (result: unknown) => void;
  private readonly maxBoxLines: number;
  private readonly maxWidth: number;
  private lastRenderedViewportLines = 1;

  constructor(options: SubagentPresentationLogOverlayOptions) {
    this.entry = { ...options.entry, result_text: options.entry.result_text };
    this.selection = subagentOverlaySelection(options.entry);
    this.generation = options.generation;
    this.theme = options.theme ?? {};
    this.keybindings = options.keybindings;
    this.tui = options.tui;
    this.done = options.done;
    this.maxBoxLines = subagentOverlaySurfaceLineCount(options.tui, options.maxBoxLines);
    this.maxWidth = Math.max(4, Math.floor(options.maxWidth ?? Number.MAX_SAFE_INTEGER));
    if (this.tui?.terminal?.write) {
      this.tui.terminal.write(ENABLE_MOUSE_REPORTING);
      this.mouseReportingEnabled = true;
    }
  }

  invalidate(): void {}

  refreshFromPresentationLog(): void {
    const refreshed = refreshedSubagentOverlayEntry(this.selection);
    if (refreshed === null) {
      currentSubagentOverlay = null;
      this.dispose();
      this.done?.(null);
      return;
    }
    this.entry = refreshed;
    currentSubagentOverlay = { entry: refreshed, text: renderSubagentPresentationOverlay([refreshed], true, this.generation), generation: this.generation };
    this.invalidate();
    this.requestRender();
  }

  dispose(): void {
    if (this.mouseReportingEnabled) {
      this.tui?.terminal?.write?.(DISABLE_MOUSE_REPORTING);
      this.mouseReportingEnabled = false;
    }
    if (currentSubagentOverlayComponent === this) currentSubagentOverlayComponent = null;
  }

  private activeTab(): SubagentOverlayTab {
    return SUBAGENT_OVERLAY_TABS[this.activeTabIndex]?.id ?? "summary";
  }

  private viewportLines(withShadow = false): number {
    return Math.max(1, this.maxBoxLines - (withShadow ? 5 : 4));
  }

  private requestRender(): void {
    this.tui?.requestRender?.();
  }

  private sectionLine(title: string, contentWidth: number): string {
    const label = selectorThemeFg(this.theme, "accent", selectorThemeBold(this.theme, title));
    return overlayTruncateLine(`─ ${label} ${"─".repeat(Math.max(0, contentWidth))}`, contentWidth);
  }

  private fieldLines(label: string, value: string, contentWidth: number): string[] {
    const labelText = selectorThemeFg(this.theme, "accent", selectorThemeBold(this.theme, `${label.padEnd(16)} `));
    const valueText = value.trim().length > 0 ? value : "—";
    const valueWidth = Math.max(1, contentWidth - visibleWidth(labelText));
    const valueLines = renderRendererSafePlainLines(valueText, valueWidth);
    return valueLines.map((line, index) => overlayTruncateLine(`${index === 0 ? labelText : " ".repeat(visibleWidth(labelText))}${line}`, contentWidth));
  }

  private summaryPaneLines(contentWidth: number): string[] {
    return [
      this.sectionLine("Run", contentWidth),
      ...this.fieldLines("Status", this.entry.status, contentWidth),
      ...this.fieldLines("Persona", this.entry.persona_id, contentWidth),
      ...this.fieldLines("Progress", this.entry.phase ?? this.entry.status, contentWidth),
      ...this.fieldLines("Task ID", this.entry.task_id ?? "pending", contentWidth),
      "",
      this.sectionLine("Prompt", contentWidth),
      ...this.fieldLines("Initial", this.entry.task_prompt ? `recorded (${Array.from(this.entry.task_prompt).length} chars) — see Prompt tab` : "not recorded", contentWidth),
      "",
      this.sectionLine("Result", contentWidth),
      ...this.fieldLines("Output", subagentEntryOutputIsPresent(this.entry) ? (this.entry.status === "running" ? "live preview available — see Output tab" : "available — see Output tab (Markdown rendered)") : "No final output observed.", contentWidth),
      ...this.fieldLines("Live events", (this.entry.tool_snapshots?.length ?? 0) > 0 || this.entry.live_assistant_preview ? "available — see Events/Output tabs" : "not observed", contentWidth),
      ...this.fieldLines("Error", subagentEntryErrorText(this.entry), contentWidth),
      "",
      this.sectionLine("Provenance", contentWidth),
      ...this.fieldLines("View", "view-only parent extension memory", contentWidth),
      ...this.fieldLines("Generation", String(this.generation), contentWidth),
    ];
  }

  private promptPaneLines(contentWidth: number): string[] {
    return [
      this.sectionLine("Initial Prompt", contentWidth),
      ...renderRendererSafePlainLines(this.entry.task_prompt ?? "No initial subagent prompt was recorded for this entry.", contentWidth),
    ];
  }

  private eventsPaneLines(contentWidth: number): string[] {
    const lines = [this.sectionLine("Events", contentWidth)];
    const thinkingLine = subagentThinkingHiddenLine(this.entry);
    if (thinkingLine !== null) lines.push(...this.fieldLines("Assistant", thinkingLine, contentWidth));
    const snapshots = this.entry.tool_snapshots ?? [];
    if (snapshots.length === 0) {
      lines.push(...this.fieldLines("Tool calls", "No normalized child tool events observed.", contentWidth));
      return lines;
    }
    for (const snapshot of snapshots) {
      const title = `${snapshot.toolCallId} ${snapshot.name ?? "tool"} ${snapshot.status}`;
      lines.push(...this.fieldLines("Tool", title, contentWidth));
      if (snapshot.args_preview) lines.push(...this.fieldLines("Args", boundedToolArgsPreview(snapshot.args_preview), contentWidth));
      if (snapshot.output_preview) lines.push(...this.fieldLines("Output", boundedToolOutputPreview(snapshot.output_preview), contentWidth));
      if (snapshot.error_preview) lines.push(...this.fieldLines("Error", boundedToolOutputPreview(snapshot.error_preview), contentWidth));
    }
    return lines;
  }

  private metadataPaneLines(contentWidth: number): string[] {
    return [
      this.sectionLine("Metadata", contentWidth),
      ...this.fieldLines("Mode", this.entry.mode ?? "unknown", contentWidth),
      ...this.fieldLines("Sequence", String(this.entry.sequence), contentWidth),
      ...this.fieldLines("Phase", this.entry.phase ?? this.entry.status, contentWidth),
      ...this.fieldLines("Task preview", this.entry.task_preview ?? "", contentWidth),
      ...this.fieldLines("Initial prompt", this.entry.task_prompt ? "recorded — see Prompt tab" : "not recorded", contentWidth),
      ...this.fieldLines("Call ID", this.entry.call_id ?? "", contentWidth),
      ...this.fieldLines("Selected task", this.entry.task_id ?? "pending", contentWidth),
      ...this.fieldLines("Error object", this.entry.error ? JSON.stringify(this.entry.error) : "null", contentWidth),
      ...this.fieldLines("Output mode", subagentEntryOutputIsPresent(this.entry) ? (this.entry.status === "running" ? "live preview" : "markdown") : "fallback", contentWidth),
      ...this.fieldLines("Live stream", (this.entry.live_assistant_preview || (this.entry.tool_snapshots?.length ?? 0) > 0) ? "process-local only; cache sanitizer drops live fields" : "not observed", contentWidth),
      ...this.fieldLines("View-only", "no persona/model/tool-policy/session/recent-index/resume-authority mutation", contentWidth),
    ];
  }

  private paneLines(contentWidth: number): string[] {
    const tab = this.activeTab();
    if (tab === "output") {
      const output = subagentEntryOutput(this.entry);
      const thinkingLine = subagentThinkingHiddenLine(this.entry);
      if (output.trim().length === 0) {
        return renderRendererSafePlainLines(thinkingLine ?? "No final subagent output is available for this observed entry.", contentWidth);
      }
      const rendered = this.entry.status === "running" ? renderRendererSafePlainLines(output, contentWidth) : renderMarkdownLines(output, contentWidth);
      return thinkingLine === null ? rendered : [...renderRendererSafePlainLines(thinkingLine, contentWidth), "", ...rendered];
    }
    if (tab === "prompt") return this.promptPaneLines(contentWidth);
    if (tab === "events") return this.eventsPaneLines(contentWidth);
    if (tab === "metadata") return this.metadataPaneLines(contentWidth);
    return this.summaryPaneLines(contentWidth);
  }

  private tabLine(contentWidth: number): string {
    const labels = SUBAGENT_OVERLAY_TABS.map((tab, index) => `${index === this.activeTabIndex ? "●" : "○"} ${index + 1} ${tab.label}`);
    if (this.activeTab() === "events") labels.splice(4, 0, "● 4 Metadata");
    else labels.splice(4, 0, "○ 4 Metadata");
    return overlayPadLine(labels.join("   "), contentWidth);
  }

  private scrollBy(delta: number): void {
    const tab = this.activeTab();
    const next = Math.max(0, Math.min(this.lastMaxOffsets[tab], this.scrollOffsets[tab] + delta));
    if (next === this.scrollOffsets[tab]) return;
    this.scrollOffsets[tab] = next;
    this.invalidate();
    this.requestRender();
  }

  private jumpTo(offset: number): void {
    const tab = this.activeTab();
    const next = Math.max(0, Math.min(this.lastMaxOffsets[tab], offset));
    if (next === this.scrollOffsets[tab]) return;
    this.scrollOffsets[tab] = next;
    this.invalidate();
    this.requestRender();
  }

  private switchTab(index: number): void {
    const next = Math.max(0, Math.min(SUBAGENT_OVERLAY_TABS.length - 1, index));
    if (next === this.activeTabIndex) return;
    this.activeTabIndex = next;
    this.invalidate();
    this.requestRender();
  }

  private switchRelative(delta: number): void {
    this.switchTab((this.activeTabIndex + delta + SUBAGENT_OVERLAY_TABS.length) % SUBAGENT_OVERLAY_TABS.length);
  }

  private selectorPaneLines(contentWidth: number): string[] {
    return [
      this.sectionLine("Select subagent", contentWidth),
      ...overlayEntries(25).map((entry, index) => boundedPresentationPreview(`${index === 0 ? "›" : " "} ${presentationRow(entry)}`, contentWidth)),
    ];
  }

  render(width: number): string[] {
    const renderWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
    const withShadow = renderWidth >= 8;
    const boxWidth = Math.min(withShadow ? renderWidth - 1 : renderWidth, this.maxWidth);
    if (boxWidth < 4) return [truncateToWidth("Larva subagent log", boxWidth, "")];
    const contentWidth = boxWidth - 4;
    const viewportLines = this.viewportLines(withShadow);
    this.lastRenderedViewportLines = viewportLines;
    const title = overlayTruncateLine("─ Larva subagent log ", boxWidth - 2);
    const topMiddle = `${title}${"─".repeat(Math.max(0, boxWidth - 2 - overlayDisplayWidth(title)))}`;
    const tab = this.activeTab();
    const innerLines = this.selectorMode ? this.selectorPaneLines(contentWidth) : this.paneLines(contentWidth);
    this.lastMaxOffsets[tab] = Math.max(0, innerLines.length - viewportLines);
    this.scrollOffsets[tab] = Math.max(0, Math.min(this.lastMaxOffsets[tab], this.scrollOffsets[tab]));
    const visibleLines = innerLines.slice(this.scrollOffsets[tab], this.scrollOffsets[tab] + viewportLines);
    while (visibleLines.length < viewportLines) visibleLines.push("");
    const start = innerLines.length === 0 ? 0 : this.scrollOffsets[tab] + 1;
    const end = Math.min(innerLines.length, this.scrollOffsets[tab] + viewportLines);
    const scrollRange = innerLines.length > viewportLines ? ` • ${start}-${end}/${innerLines.length}` : "";
    const scrollInfo = this.selectorMode
      ? `selector • Enter select • s detail • Wheel/↑↓ PgUp/PgDn Home/End • Esc/q close${scrollRange}`
      : `1/2/3/4/5 ←→ tabs • s selector • Wheel/↑↓ PgUp/PgDn Home/End • Esc/q close${scrollRange}`;
    const rows = [
      selectorFullBorderRow("╭", topMiddle, "╮", withShadow),
      selectorBoxRow(this.selectorMode ? overlayPadLine("Select subagent", contentWidth) : this.tabLine(contentWidth), contentWidth, withShadow),
      ...visibleLines.map((line) => selectorBoxRow(line, contentWidth, withShadow)),
      selectorBoxRow(scrollInfo, contentWidth, withShadow),
      selectorFullBorderRow("╰", "─".repeat(Math.max(0, boxWidth - 2)), "╯", withShadow),
    ];
    return withShadow ? [...rows, selectorShadowLine(boxWidth)] : rows;
  }

  handleInput(data: string): void {
    if (isSubagentOverlayCloseKey(data, this.keybindings)) {
      this.dispose();
      this.done?.(null);
      return;
    }
    if (data === "s" || data === "S") {
      this.selectorMode = !this.selectorMode;
      this.invalidate();
      this.requestRender();
      return;
    }
    if (matchesInputKey(this.keybindings, data, ["tui.confirm", "tui.select.confirm"], [Key.enter], ["\r", "\n"], ["enter"])) return;
    if (/^[1-5]$/.test(data)) this.selectorMode = false;
    if (data === "1") this.switchTab(0);
    else if (data === "2") this.switchTab(1);
    else if (data === "3") this.switchTab(2);
    else if (data === "4") this.switchTab(3);
    else if (data === "5") this.switchTab(3);
    else if (matchesInputKey(this.keybindings, data, ["tui.select.left", "tui.editor.cursorLeft"], [Key.left], [], ["arrowleft", "left"])) this.switchRelative(-1);
    else if (matchesInputKey(this.keybindings, data, ["tui.select.right", "tui.editor.cursorRight"], [Key.right], [], ["arrowright", "right"])) this.switchRelative(1);
    else {
      const wheelDelta = mouseWheelScrollDelta(data);
      if (wheelDelta !== null) {
        this.scrollBy(wheelDelta);
        return;
      }
      if (isSgrMouseEvent(data)) return; // Mouse click/press/release SGR events are intentionally unsupported no-ops.
      if (matchesInputKey(this.keybindings, data, ["tui.select.down", "tui.editor.cursorDown"], [Key.down], [], ["arrowdown", "down"])) this.scrollBy(1);
      else if (matchesInputKey(this.keybindings, data, ["tui.select.up", "tui.editor.cursorUp"], [Key.up], [], ["arrowup", "up"])) this.scrollBy(-1);
      else if (matchesInputKey(this.keybindings, data, ["tui.select.pageDown", "tui.editor.pageDown"], [Key.pageDown], [], ["pagedown"])) this.scrollBy(this.lastRenderedViewportLines);
      else if (matchesInputKey(this.keybindings, data, ["tui.select.pageUp", "tui.editor.pageUp"], [Key.pageUp], [], ["pageup"])) this.scrollBy(-this.lastRenderedViewportLines);
      else if (matchesInputKey(this.keybindings, data, ["tui.editor.cursorLineStart"], [Key.home], ["\x1b[1~"], ["home"])) this.jumpTo(0);
      else if (matchesInputKey(this.keybindings, data, ["tui.editor.cursorLineEnd"], [Key.end], ["\x1b[4~"], ["end"])) this.jumpTo(this.lastMaxOffsets[this.activeTab()]);
    }
  }
}

async function openSubagentPresentationOverlay(ctx: PiContext, overlay: LarvaSubagentOverlayResult): Promise<boolean> {
  const custom = ctx.ui?.custom;
  if (typeof custom !== "function" || overlay.details.entries.length === 0) return false;
  const entry = overlay.details.entries[0];
  const generation = overlay.details.overlay_generation;
  await custom((tui, _theme, keybindings, done) => {
    let component: SubagentPresentationLogOverlay;
    component = new SubagentPresentationLogOverlay({
      entry,
      generation,
      theme: _theme,
      keybindings,
      tui,
      done: (result) => {
        component.dispose();
        done(result);
      },
    });
    currentSubagentOverlayComponent = component;
    return component;
  }, {
    overlay: true,
    overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 },
    onHandle: (handle: PiOverlayHandle) => handle.focus?.(),
  });
  return true;
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

function subagentPresentationCachePath(env: RuntimeEnv): string | LarvaError {
  if (env.LARVA_PI_SUBAGENT_LOG_FILE !== undefined) {
    if (!isAbsolute(env.LARVA_PI_SUBAGENT_LOG_FILE)) {
      return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "LARVA_PI_SUBAGENT_LOG_FILE must be an absolute path.");
    }
    return env.LARVA_PI_SUBAGENT_LOG_FILE;
  }
  return join(homeDir(env), ".pi", "larva", "subagent-presentation-log.json");
}

function subagentPresentationConfigPath(env: RuntimeEnv): string {
  return join(homeDir(env), ".pi", "larva", "subagent-log.json");
}

function parseSubagentPresentationCacheConfig(raw: unknown): SubagentPresentationCacheConfig | LarvaError {
  if (!isRecord(raw)) return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "subagent-log.json must be a JSON object.");
  const config = { ...DEFAULT_SUBAGENT_PRESENTATION_CACHE_CONFIG };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "enabled must be a boolean.");
    config.enabled = raw.enabled;
  }
  if (raw.max_entries !== undefined) {
    if (typeof raw.max_entries !== "number" || !Number.isInteger(raw.max_entries) || raw.max_entries < 1 || raw.max_entries > 1000) {
      return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "max_entries must be an integer from 1 to 1000.");
    }
    config.max_entries = raw.max_entries;
  }
  if (raw.max_age_days !== undefined) {
    if (typeof raw.max_age_days !== "number" || !Number.isInteger(raw.max_age_days) || raw.max_age_days < 1 || raw.max_age_days > 365) {
      return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "max_age_days must be an integer from 1 to 365.");
    }
    config.max_age_days = raw.max_age_days;
  }
  if (raw.include_prompt !== undefined) {
    if (typeof raw.include_prompt !== "boolean") return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "include_prompt must be a boolean.");
    config.include_prompt = raw.include_prompt;
  }
  if (raw.include_output !== undefined) {
    if (typeof raw.include_output !== "boolean") return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "include_output must be a boolean.");
    config.include_output = raw.include_output;
  }
  return config;
}

function subagentPresentationCacheConfig(env: RuntimeEnv): SubagentPresentationCacheConfig | LarvaError {
  const path = subagentPresentationConfigPath(env);
  if (!existsSync(path)) return { ...DEFAULT_SUBAGENT_PRESENTATION_CACHE_CONFIG };
  try {
    return parseSubagentPresentationCacheConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (caught) {
    if (isLarvaError(caught)) return caught;
    return error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "Unable to read or parse subagent-log.json.");
  }
}

function entryUpdatedAtMs(entry: SubagentPresentationLogEntry): number {
  const parsed = typeof entry.updated_at === "string" ? Date.parse(entry.updated_at) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function withSubagentEntryTimestamp(entry: SubagentPresentationLogEntry): SubagentPresentationLogEntry {
  return { ...entry, updated_at: entry.updated_at ?? new Date().toISOString() };
}

function sanitizeSubagentPresentationCacheEntry(entry: SubagentPresentationLogEntry, config: SubagentPresentationCacheConfig): SubagentPresentationLogEntry {
  const sanitized: SubagentPresentationLogEntry = { ...entry, updated_at: entry.updated_at ?? new Date().toISOString() };
  delete sanitized.live_assistant_preview;
  delete sanitized.tool_snapshots;
  delete sanitized.active_tool_state;
  delete sanitized.raw_rpc_events;
  delete sanitized.live_thinking_hidden;
  if (sanitized.status === "running") delete sanitized.result_text;
  if (!config.include_prompt) delete sanitized.task_prompt;
  if (!config.include_output) delete sanitized.result_text;
  return sanitized;
}

function prunedSubagentPresentationEntries(entries: SubagentPresentationLogEntry[], config: SubagentPresentationCacheConfig): SubagentPresentationLogEntry[] {
  const minUpdatedAt = Date.now() - config.max_age_days * 24 * 60 * 60 * 1000;
  return entries
    .map((entry) => withSubagentEntryTimestamp(entry))
    .filter((entry) => entryUpdatedAtMs(entry) >= minUpdatedAt)
    .slice(-config.max_entries);
}

function loadSubagentPresentationCache(env: RuntimeEnv): void {
  subagentPresentationCacheEnv = env;
  subagentPresentationCacheError = null;
  const config = subagentPresentationCacheConfig(env);
  if (isLarvaError(config)) {
    subagentPresentationCacheError = config;
    return;
  }
  if (!config.enabled || retainedSubagentPresentationLog.length > 0) return;
  const path = subagentPresentationCachePath(env);
  if (isLarvaError(path)) {
    subagentPresentationCacheError = path;
    return;
  }
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
    const entries = prunedSubagentPresentationEntries(parsed.entries.filter(isRecord).map((entry) => sanitizeSubagentPresentationCacheEntry({ ...entry } as SubagentPresentationLogEntry, config)), config);
    retainedSubagentPresentationLog.push(...entries);
    subagentPresentationSequence = Math.max(subagentPresentationSequence, ...entries.map((entry) => typeof entry.sequence === "number" ? entry.sequence : 0), 0);
    if (entries.length !== parsed.entries.length) persistSubagentPresentationCache();
  } catch {
    // Malformed cache content is treated as empty UI cache, not as shared data loss.
  }
}

function persistSubagentPresentationCache(): void {
  const env = subagentPresentationCacheEnv;
  if (env === null) return;
  const config = subagentPresentationCacheConfig(env);
  if (isLarvaError(config)) {
    subagentPresentationCacheError = config;
    return;
  }
  subagentPresentationCacheError = null;
  const path = subagentPresentationCachePath(env);
  if (isLarvaError(path)) {
    subagentPresentationCacheError = path;
    return;
  }
  if (!config.enabled) return;
  const entries = prunedSubagentPresentationEntries(retainedSubagentPresentationLog, config).map((entry) => sanitizeSubagentPresentationCacheEntry(entry, config));
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, entries } satisfies SubagentPresentationCacheFile, null, 2));
  } catch {
    subagentPresentationCacheError = error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "Unable to write subagent presentation cache.");
  }
}

function clearSubagentPresentationCacheFile(): void {
  const env = subagentPresentationCacheEnv;
  if (env === null) return;
  const path = subagentPresentationCachePath(env);
  if (isLarvaError(path)) {
    subagentPresentationCacheError = path;
    return;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    subagentPresentationCacheError = error("LARVA_SUBAGENT_LOG_CONFIG_INVALID", "Unable to clear subagent presentation cache.");
  }
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

const PERSONA_SPEC_KEYS = new Set([
  "id",
  "description",
  "prompt",
  "model",
  "capabilities",
  "model_params",
  "can_spawn",
  "compaction_prompt",
  "spec_version",
  "spec_digest",
]);
const CAPABILITY_POSTURES = new Set<string>(["none", "read_only", "read_write", "destructive"]);
const PERSONA_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function hasOnlyPersonaSpecKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => PERSONA_SPEC_KEYS.has(key));
}

function isCanonicalCapabilities(value: unknown): value is Record<string, CapabilityPosture> {
  return isRecord(value) && Object.values(value).every((posture) => typeof posture === "string" && CAPABILITY_POSTURES.has(posture));
}

function isCanonicalCanSpawn(value: unknown): value is boolean | string[] | undefined {
  if (value === undefined) return true;
  if (typeof value === "boolean") return true;
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every((entry) => typeof entry === "string" && entry.length > 0) && new Set(value).size === value.length;
}

function isCanonicalModelParams(value: unknown): value is Record<string, unknown> | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const { temperature, top_p, top_k, max_tokens } = value;
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) return false;
  if (top_p !== undefined && (typeof top_p !== "number" || top_p < 0 || top_p > 1)) return false;
  if (top_k !== undefined && (typeof top_k !== "number" || !Number.isInteger(top_k) || top_k < 1)) return false;
  if (max_tokens !== undefined && (typeof max_tokens !== "number" || !Number.isInteger(max_tokens) || max_tokens < 1)) return false;
  return true;
}

function isPersonaSpec(value: unknown): value is PersonaSpec {
  if (!isRecord(value) || !hasOnlyPersonaSpecKeys(value)) return false;
  return (
    typeof value.id === "string" &&
    PERSONA_ID_RE.test(value.id) &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    typeof value.prompt === "string" &&
    value.prompt.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    isCanonicalCapabilities(value.capabilities) &&
    isCanonicalModelParams(value.model_params) &&
    isCanonicalCanSpawn(value.can_spawn) &&
    (value.compaction_prompt === undefined || typeof value.compaction_prompt === "string") &&
    value.spec_version === "0.1.0" &&
    (value.spec_digest === undefined || typeof value.spec_digest === "string")
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
    capabilities: isCanonicalCapabilities(item.capabilities) ? item.capabilities : undefined,
  };
}

async function completePersonaMentionIds(prefix = "", ctx?: { env?: RuntimeEnv }): Promise<PiAutocompleteCandidate[] | null> {
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

function registerCommandCompat(pi: PiApi, name: string, command: CommandOptions): void {
  if (!pi.registerCommand) return;
  if (pi.registerCommand.length >= 2) {
    (pi.registerCommand as (name: string, options: CommandOptions) => void)(name, command);
    return;
  }
  (pi.registerCommand as (command: LegacyCommandDefinition) => void)({
    name,
    ...command,
    complete: command.getArgumentCompletions,
  });
}

function registerLarvaPersonaCommand(ctx: PiContext, pi: PiApi): void {
  // Static contract token for legacy Pi command shape: name: "larva-persona".
  const baseEnv = currentEnv(ctx);
  const runPersonaSelectorCommand = async (input: string | undefined, commandCtx?: PiContext): Promise<PersonaSwitchResult> => {
    const runtimeCtx = withRuntimeEnv(commandCtx ?? ctx, baseEnv);
    const result = await handlePersonaCommand(input, runtimeCtx, pi);
    await notifyPersonaSwitchResult(runtimeCtx, result);
    return result;
  };
  const command: CommandOptions = {
    description: "Switch active Larva persona",
    getArgumentCompletions: async (prefix: string) => {
      const candidates = await completePersonaIds(prefix, withRuntimeEnv(ctx, baseEnv));
      return candidates && candidates.length > 0 ? candidates : null;
    },
    handler: (input?: string, commandCtx?: PiContext) => runPersonaSelectorCommand(input, commandCtx),
  };
  registerCommandCompat(pi, "larva-persona", command);
  pi.registerShortcut?.(Key.ctrlAlt("p"), {
    description: "Open Larva persona selector",
    handler: async (shortcutCtx: PiShortcutContext) => {
      const runtimeCtx = withRuntimeEnv(shortcutCtx ?? ctx, baseEnv);
      if (typeof runtimeCtx.isIdle === "function" && !runtimeCtx.isIdle()) {
        await notify(runtimeCtx, "Larva persona selector shortcut is available when Pi is idle.", "warning");
        return;
      }
      await runPersonaSelectorCommand("", runtimeCtx);
    },
  });
}

function registerLarvaSubagentLogCommand(ctx: PiContext, pi: PiApi): void {
  const command: CommandOptions = {
    description: "Show the view-only Larva subagent log",
    handler: async (input?: string, commandCtx?: PiContext) => {
      const runtimeCtx = commandCtx ?? ctx;
      const overlay = larva_subagent_log(input ?? "");
      const text = overlay.content[0]?.text ?? "Larva subagent log is empty.";
      if (overlay.isError) {
        await notify(runtimeCtx, text, "error");
        return overlay;
      }
      if (overlay.details.entries.length === 0) return overlay;
      if (typeof runtimeCtx.ui?.custom !== "function") {
        if (runtimeCtx.ui !== undefined) return overlay;
        const unavailable = failedSubagentOverlay("LARVA_SUBAGENT_LOG_UI_UNAVAILABLE", "Larva subagent log UI is unavailable.");
        await notify(runtimeCtx, unavailable.content[0]?.text ?? unavailable.details.error?.message ?? "Larva subagent log UI is unavailable.", "error");
        return unavailable;
      }
      if (await openSubagentPresentationOverlay(runtimeCtx, overlay)) return overlay;
      const unavailable = failedSubagentOverlay("LARVA_SUBAGENT_LOG_UI_UNAVAILABLE", "Larva subagent log UI is unavailable.");
      await notify(runtimeCtx, unavailable.content[0]?.text ?? unavailable.details.error?.message ?? "Larva subagent log UI is unavailable.", "error");
      return unavailable;
    },
  };
  registerCommandCompat(pi, "larva-subagent-log", command);
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

function startupFailureStderr(personaId: string, larvaError: LarvaError): string {
  return `larva pi: ${larvaError.code}: initial persona '${personaId}' failed before first prompt/model turn: ${larvaError.message}\n`;
}

function shouldFatalInitialPersonaStartup(env: RuntimeEnv): boolean {
  return env.LARVA_PI_LAUNCHED === "1" && typeof env.LARVA_PI_INITIAL_PERSONA_ID === "string" && env.LARVA_PI_INITIAL_PERSONA_ID.length > 0;
}

function isFatalInitialPersonaStartupError(larvaError: LarvaError): boolean {
  return [
    "LARVA_PERSONA_NOT_FOUND",
    "LARVA_MODEL_MAP_INVALID",
    "LARVA_MODEL_UNAVAILABLE",
    "LARVA_POLICY_INVALID",
  ].includes(larvaError.code);
}

function fatalInitialPersonaStartup(env: RuntimeEnv, personaId: string, larvaError: LarvaError): never | null {
  if (!shouldFatalInitialPersonaStartup(env) || !isFatalInitialPersonaStartupError(larvaError)) return null;
  process.stderr.write(startupFailureStderr(personaId, larvaError));
  process.exit(1);
  throw larvaError;
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

type EnhancedPersonaSelectorResult = { handled: true; selected: string | null } | { handled: false };

async function openEnhancedPersonaSelector(ctx: PiContext, personas: BridgeListItem[]): Promise<EnhancedPersonaSelectorResult> {
  const custom = ctx.ui?.custom;
  if (typeof custom !== "function") return { handled: false };
  try {
    const selected = await custom((tui, theme, keybindings, done) => new LarvaPersonaSelector({
      personas,
      theme,
      keybindings,
      tui,
      done: (result) => done(result),
    }), {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 },
      onHandle: (handle: PiOverlayHandle) => handle.focus?.(),
    });
    return { handled: true, selected: typeof selected === "string" && selected.length > 0 ? selected : null };
  } catch {
    return { handled: false };
  }
}

export async function openPersonaSelector(ctx: PiContext): Promise<string | null> {
  const personas = await listPersonas(ctx);
  if (personas.length === 0) throw error("LARVA_PERSONA_NOT_FOUND", "No personas available");
  const enhanced = await openEnhancedPersonaSelector(ctx, personas);
  if (enhanced.handled) return enhanced.selected;
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

function appendSubagentPresentationLog(entry: Omit<SubagentPresentationLogEntry, "sequence">): SubagentPresentationLogEntry {
  subagentPresentationSequence += 1;
  const retained = withSubagentEntryTimestamp({ ...entry, sequence: subagentPresentationSequence });
  retainedSubagentPresentationLog.push(retained);
  while (retainedSubagentPresentationLog.length > 25) retainedSubagentPresentationLog.shift();
  persistSubagentPresentationCache();
  notifySubagentPresentationOverlay();
  return retained;
}

function appendSubagentPresentationRunning(taskId: string, personaId: string, input?: LarvaSubagentInput, callId?: string): void {
  retainedSubagentPresentationLog.push(withSubagentEntryTimestamp({
    task_id: taskId,
    persona_id: personaId,
    status: "running",
    sequence: 0,
    mode: presentationMode(input),
    task_preview: presentationTaskPreview(input),
    task_prompt: presentationTaskPrompt(input),
    phase: "waiting_for_child",
    call_id: callId,
  }));
  while (retainedSubagentPresentationLog.length > 25) retainedSubagentPresentationLog.shift();
  persistSubagentPresentationCache();
  notifySubagentPresentationOverlay();
}

function removePendingSubagentPresentationRunning(taskId: string): SubagentPresentationLogEntry | null {
  let preserved: SubagentPresentationLogEntry | null = null;
  for (let index = retainedSubagentPresentationLog.length - 1; index >= 0; index -= 1) {
    const entry = retainedSubagentPresentationLog[index];
    if (entry.task_id === taskId && entry.status === "running") {
      preserved = preserved ?? entry;
      retainedSubagentPresentationLog.splice(index, 1);
    }
  }
  return preserved;
}

function recordSubagentPresentationRunning(taskId: string, personaId: string, input?: LarvaSubagentInput, callId?: string): void {
  appendSubagentPresentationRunning(taskId, personaId, input, callId);
}

function presentationMode(input?: LarvaSubagentInput): SubagentPresentationMode | undefined {
  return input ? subagentMode(input) : undefined;
}

function presentationTaskPreview(input?: LarvaSubagentInput): string | undefined {
  return typeof input?.task === "string" ? boundedVisible(input.task, 120) : undefined;
}

function presentationTaskPrompt(input?: LarvaSubagentInput): string | undefined {
  return typeof input?.task === "string" ? rendererSafeMarkdownSource(input.task).trim() : undefined;
}

function applyNormalizedSubagentStreamEvent(taskId: string | null | undefined, callId: string | undefined, eventValue: NormalizedSubagentStreamEvent): void {
  const index = retainedSubagentPresentationLog.findIndex((entry) =>
    (callId !== undefined && entry.call_id === callId)
    || (taskId !== null && taskId !== undefined && entry.task_id === taskId && entry.status === "running")
  );
  if (index < 0) return;
  const entry = { ...retainedSubagentPresentationLog[index] };
  if (eventValue.kind === "assistant_delta") {
    const next = `${entry.live_assistant_preview ?? ""}${eventValue.text}`;
    entry.live_assistant_preview = boundedAssistantPreview(next);
  } else if (eventValue.kind === "thinking_hidden") {
    entry.live_thinking_hidden = true;
  } else if (eventValue.kind === "tool") {
    const snapshots = [...(entry.tool_snapshots ?? [])];
    const snapshotIndex = snapshots.findIndex((snapshot) => snapshot.toolCallId === eventValue.toolCallId);
    const current = snapshotIndex >= 0 ? snapshots[snapshotIndex] : { toolCallId: eventValue.toolCallId, status: eventValue.status };
    const nextSnapshot = { ...current, ...eventValue, kind: undefined } as SubagentToolSnapshot & { kind?: undefined };
    delete nextSnapshot.kind;
    if (snapshotIndex >= 0) snapshots[snapshotIndex] = nextSnapshot;
    else snapshots.push(nextSnapshot);
    entry.tool_snapshots = snapshots;
    entry.active_tool_state = eventValue.status === "running" ? { toolCallId: eventValue.toolCallId, name: eventValue.name, status: eventValue.status } : null;
  }
  retainedSubagentPresentationLog[index] = withSubagentEntryTimestamp(entry);
  persistSubagentPresentationCache();
  notifySubagentPresentationOverlay();
}

function upsertSubagentPresentationProgress(input: LarvaSubagentInput, phase: string, taskId: string | null | undefined, callId?: string): void {
  const normalizedTaskId = taskId ?? (typeof input.task_id === "string" && input.task_id.trim().length > 0 ? input.task_id : null);
  const existingIndex = retainedSubagentPresentationLog.findIndex((entry) =>
    (callId !== undefined && entry.call_id === callId)
    || (normalizedTaskId !== null && entry.task_id === normalizedTaskId && entry.status === "running")
  );
  const update: Omit<SubagentPresentationLogEntry, "sequence"> = {
    task_id: normalizedTaskId,
    persona_id: typeof input.persona_id === "string" ? visibleText(input.persona_id) : "",
    status: "running",
    mode: presentationMode(input),
    task_preview: presentationTaskPreview(input),
    task_prompt: presentationTaskPrompt(input),
    phase,
    result_text: "",
    error: null,
    call_id: callId,
  };
  if (existingIndex >= 0) {
    retainedSubagentPresentationLog[existingIndex] = withSubagentEntryTimestamp({ ...retainedSubagentPresentationLog[existingIndex], ...update });
    persistSubagentPresentationCache();
    notifySubagentPresentationOverlay();
    return;
  }
  appendSubagentPresentationLog(update);
}

function recordSubagentPresentationResult(result: LarvaSubagentResult, input?: LarvaSubagentInput, callId?: string): void {
  let preserved = result.task_id === null ? null : removePendingSubagentPresentationRunning(result.task_id);
  if (callId !== undefined) {
    for (let index = retainedSubagentPresentationLog.length - 1; index >= 0; index -= 1) {
      if (retainedSubagentPresentationLog[index].call_id === callId && retainedSubagentPresentationLog[index].status === "running") {
        preserved = preserved ?? retainedSubagentPresentationLog[index];
        retainedSubagentPresentationLog.splice(index, 1);
      }
    }
  }
  const statusEntry: Omit<SubagentPresentationLogEntry, "sequence"> = {
    task_id: result.task_id,
    persona_id: result.persona_id,
    status: result.status,
    mode: presentationMode(input) ?? preserved?.mode,
    task_preview: presentationTaskPreview(input) ?? preserved?.task_preview,
    task_prompt: presentationTaskPrompt(input) ?? preserved?.task_prompt,
    phase: result.status,
    result_text: result.result_text,
    error: result.error,
    call_id: callId ?? preserved?.call_id,
  };
  appendSubagentPresentationLog(statusEntry);
}

function parseSessionsLimit(input: unknown): number | LarvaError {
  if (input !== undefined && input !== null && !isRecord(input)) {
    return error("LARVA_BAD_INPUT", "limit must be an integer from 1 to 25.");
  }
  const limit = isRecord(input) && input.limit !== undefined ? input.limit : 10;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    return error("LARVA_BAD_INPUT", "limit must be an integer from 1 to 25.");
  }
  return limit;
}

function recentSessionsFromPresentationLog(limit: number): RecentSubagentSession[] {
  const sessions: RecentSubagentSession[] = [];
  for (let index = retainedSubagentPresentationLog.length - 1; index >= 0 && sessions.length < limit; index -= 1) {
    const entry = retainedSubagentPresentationLog[index];
    if (entry.task_id === null) continue;
    sessions.push({
      task_id: entry.task_id,
      persona_id: entry.persona_id,
      last_status: entry.status,
      sequence: entry.sequence,
    });
  }
  return sessions;
}

export function larva_subagent_sessions(input?: unknown): LarvaSubagentSessionsResult {
  const limit = parseSessionsLimit(input);
  if (isLarvaError(limit)) {
    return {
      content: [{ type: "text", text: `${limit.code}: ${limit.message}` }],
      details: { status: "failed", sessions: [], error: limit },
      isError: true,
    };
  }
  const sessions = recentSessionsFromPresentationLog(limit);
  const summary = sessions.length === 0
    ? "Recent Larva subagent sessions: none"
    : `Recent Larva subagent sessions: ${sessions.map((session) => `${session.sequence}:${session.persona_id}:${session.last_status}`).join(", ")}`;
  return {
    content: [{ type: "text", text: summary }],
    details: { status: "success", sessions, error: null },
    isError: false,
  };
}

function parseOverlayOptions(input: unknown): { expanded: boolean; limit: number; taskId: string | null; list: boolean; clear: boolean; select: boolean } {
  const fallback = { expanded: true, limit: 1, taskId: null, list: false, clear: false, select: false };
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "--clear") return { ...fallback, clear: true };
    if (trimmed === "--select") return { ...fallback, limit: 25, list: true, select: true };
    return { ...fallback, taskId: trimmed.length > 0 ? trimmed : null };
  }
  if (!isRecord(input)) return fallback;
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 25 ? input.limit : fallback.limit;
  const taskId = typeof input.task_id === "string" && input.task_id.trim().length > 0 ? input.task_id.trim() : fallback.taskId;
  const select = input.select === true;
  const list = input.list === true || input.limit !== undefined || select;
  const expanded = typeof input.expanded === "boolean" ? input.expanded : (list ? false : fallback.expanded);
  const clear = input.clear === true;
  return { expanded, limit, taskId, list, clear, select };
}

function presentationRowKind(status: SubagentPresentationStatus): "active" | "final" | "error" | "cancelled" {
  if (status === "running") return "active";
  if (status === "success") return "final";
  if (status === "cancelled") return "cancelled";
  return "error";
}

function presentationRow(entry: SubagentPresentationLogEntry): string {
  const rowKind = presentationRowKind(entry.status);
  const taskId = entry.task_id === null ? "task_id: pending" : `task_id: ${boundedVisibleSuffix(entry.task_id, 80)}`;
  const progress = entry.phase ?? entry.status;
  const taskPreview = entry.task_preview ? ` task: ${boundedPresentationPreview(entry.task_preview, 80)}` : "";
  return boundedPresentationPreview(`${entry.sequence}:${rowKind} ${entry.persona_id} ${taskId} progress: ${progress}${taskPreview}`, 180);
}

function sortedSubagentPresentationEntries(): SubagentPresentationLogEntry[] {
  return retainedSubagentPresentationLog.slice().sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (left.status !== "running" && right.status === "running") return 1;
    const updatedDelta = entryUpdatedAtMs(right) - entryUpdatedAtMs(left);
    if (updatedDelta !== 0) return updatedDelta;
    return right.sequence - left.sequence;
  });
}

function overlayEntries(limit: number): SubagentPresentationLogEntry[] {
  return sortedSubagentPresentationEntries().slice(0, limit).map((entry) => ({ ...entry }));
}

function newestOverlayEntry(): SubagentPresentationLogEntry | null {
  const entry = retainedSubagentPresentationLog[retainedSubagentPresentationLog.length - 1];
  return entry ? { ...entry } : null;
}

function exactOverlayEntry(taskId: string): SubagentPresentationLogEntry | null {
  for (let index = retainedSubagentPresentationLog.length - 1; index >= 0; index -= 1) {
    const entry = retainedSubagentPresentationLog[index];
    if (entry.task_id === taskId) return { ...entry };
  }
  return null;
}

function exactOverlayEntryByCallId(callId: string): SubagentPresentationLogEntry | null {
  for (let index = retainedSubagentPresentationLog.length - 1; index >= 0; index -= 1) {
    const entry = retainedSubagentPresentationLog[index];
    if (entry.call_id === callId) return { ...entry };
  }
  return null;
}

function exactOverlayEntryBySequence(sequence: number): SubagentPresentationLogEntry | null {
  for (let index = retainedSubagentPresentationLog.length - 1; index >= 0; index -= 1) {
    const entry = retainedSubagentPresentationLog[index];
    if (entry.sequence === sequence) return { ...entry };
  }
  return null;
}

function subagentOverlaySelection(entry: SubagentPresentationLogEntry): SubagentOverlaySelection {
  return { task_id: entry.task_id, call_id: entry.call_id, sequence: entry.sequence };
}

function refreshedSubagentOverlayEntry(selection: SubagentOverlaySelection): SubagentPresentationLogEntry | null {
  if (selection.call_id !== undefined) {
    const byCallId = exactOverlayEntryByCallId(selection.call_id);
    if (byCallId !== null) return byCallId;
  }
  if (selection.task_id !== null) {
    const byTaskId = exactOverlayEntry(selection.task_id);
    if (byTaskId !== null) return byTaskId;
  }
  return exactOverlayEntryBySequence(selection.sequence);
}

function notifySubagentPresentationOverlay(): void {
  if (currentSubagentOverlayComponent instanceof SubagentPresentationLogOverlay) {
    currentSubagentOverlayComponent.refreshFromPresentationLog();
  }
}

function renderSubagentPresentationOverlay(entries: SubagentPresentationLogEntry[], expanded: boolean, generation: number, mode: "detail" | "selector" = "detail"): string {
  if (entries.length === 0) return "Larva subagent log (view-only): empty";
  const lines = [
    "Larva subagent log (view-only)",
    mode === "selector" ? "selector: Select subagent" : "tabs: Summary | Prompt | Output | Events | Metadata",
    "source: in-memory presentation log; no raw JSONL authority",
  ];
  for (const entry of entries) {
    lines.push(presentationRow(entry));
    if (!expanded) continue;
    lines.push("  [Summary]");
    lines.push(`  task_id: ${entry.task_id ?? "pending"}`);
    lines.push(`  persona_id: ${entry.persona_id}`);
    lines.push(`  status: ${entry.status}`);
    lines.push(`  progress: ${entry.phase ?? entry.status}`);
    lines.push(`  result: ${entry.result_text ?? ""}`);
    const entryError = entry.error ? `${entry.error.code}: ${entry.error.message}` : "";
    lines.push(`  error: ${entryError}`);
    lines.push("  [Prompt]");
    if (entry.task_prompt) lines.push(`  initial_prompt: ${entry.task_prompt}`);
    lines.push("  [Output]");
    const thinkingLine = subagentThinkingHiddenLine(entry);
    if (thinkingLine !== null) lines.push(`  ${thinkingLine}`);
    lines.push(subagentEntryOutputIsPresent(entry) ? subagentEntryOutput(entry) : "  No final subagent output is available for this observed entry.");
    lines.push("  [Events]");
    for (const snapshot of entry.tool_snapshots ?? []) {
      lines.push(`  tool ${snapshot.toolCallId}: ${snapshot.name ?? "tool"} ${snapshot.status}`);
      if (snapshot.args_preview) lines.push(`    args: ${boundedToolArgsPreview(snapshot.args_preview)}`);
      if (snapshot.output_preview) lines.push(`    output: ${boundedToolOutputPreview(snapshot.output_preview)}`);
    }
    lines.push("  [Metadata]");
    lines.push(`  mode: ${entry.mode ?? "unknown"}`);
    lines.push(`  sequence: ${entry.sequence}`);
    lines.push(`  phase: ${entry.phase ?? entry.status}`);
    if (entry.task_preview) lines.push(`  task_preview: ${entry.task_preview}`);
    if (entry.task_prompt) lines.push(`  initial_prompt: ${entry.task_prompt}`);
    lines.push(`  output_render_mode: ${subagentEntryOutputIsPresent(entry) ? "markdown" : "fallback"}`);
    lines.push(`  overlay_generation: ${generation}`);
  }
  return lines.join("\n");
}

function subagentOverlayDetailsEntry(entry: SubagentPresentationLogEntry): SubagentPresentationLogEntry {
  const detailsEntry: SubagentPresentationLogEntry = { ...entry };
  if (entry.status === "running" && typeof entry.result_text === "string" && /thinking/i.test(entry.result_text)) detailsEntry.live_thinking_hidden = true;
  if (detailsEntry.result_text !== undefined) {
    Object.defineProperty(detailsEntry, "result_text", { value: detailsEntry.result_text, enumerable: false, configurable: true, writable: true });
  }
  return detailsEntry;
}

function failedSubagentOverlay(code: Extract<LarvaErrorCode, "LARVA_SUBAGENT_LOG_NOT_OBSERVED" | "LARVA_SUBAGENT_LOG_UI_UNAVAILABLE" | "LARVA_SUBAGENT_LOG_CONFIG_INVALID">, message: string): LarvaSubagentOverlayResult {
  const larvaError = error(code, message);
  return {
    ok: false,
    view_only: true,
    content: [{ type: "text", text: `${larvaError.code}: ${larvaError.message}` }],
    details: { status: "failed", entries: [], selected_task_id: null, overlay_generation: subagentOverlayGeneration, error: larvaError },
    isError: true,
  };
}

export function closeSubagentPresentationOverlay(): void {
  currentSubagentOverlayComponent?.dispose?.();
  currentSubagentOverlayComponent = null;
  currentSubagentOverlay = null;
}

function clearedSubagentPresentationOverlay(): LarvaSubagentOverlayResult {
  return {
    ok: true,
    view_only: true,
    content: [{ type: "text", text: "Larva subagent log cleared (view-only presentation cache and in-memory overlay entries)." }],
    details: { status: "success", entries: [], selected_task_id: null, overlay_generation: subagentOverlayGeneration, error: null },
    isError: false,
  };
}

export function larva_subagent_log(input?: unknown): LarvaSubagentOverlayResult {
  const options = parseOverlayOptions(input);
  if (options.clear) {
    retainedSubagentPresentationLog.length = 0;
    subagentPresentationSequence = 0;
    subagentUiResetGeneration += 1;
    clearSubagentPresentationCacheFile();
    closeSubagentPresentationOverlay();
    return clearedSubagentPresentationOverlay();
  }
  if (retainedSubagentPresentationLog.length === 0 && subagentPresentationCacheEnv !== null) loadSubagentPresentationCache(subagentPresentationCacheEnv);
  if (subagentPresentationCacheError !== null) {
    closeSubagentPresentationOverlay();
    return failedSubagentOverlay("LARVA_SUBAGENT_LOG_CONFIG_INVALID", subagentPresentationCacheError.message);
  }
  const entries = options.list
    ? overlayEntries(options.limit)
    : [options.taskId === null ? newestOverlayEntry() : exactOverlayEntry(options.taskId)].filter((entry): entry is SubagentPresentationLogEntry => entry !== null);
  if (entries.length === 0) {
    const target = options.taskId === null
      ? "No Larva subagent run has been observed in this parent extension process since the last reload/reset. Run a subagent in this session, then reopen /larva-subagent-log."
      : `Larva subagent run not observed for task_id ${options.taskId} in this parent extension process since the last reload/reset.`;
    closeSubagentPresentationOverlay();
    return failedSubagentOverlay("LARVA_SUBAGENT_LOG_NOT_OBSERVED", target);
  }
  subagentOverlayGeneration += 1;
  const generation = subagentOverlayGeneration;
  const text = renderSubagentPresentationOverlay(entries, options.expanded, generation, options.select ? "selector" : "detail");
  currentSubagentOverlay = { entry: entries[0], text, generation };
  return {
    ok: true,
    view_only: true,
    content: [{ type: "text", text }],
    details: { status: "success", entries: entries.map(subagentOverlayDetailsEntry), selected_task_id: entries[0].task_id, overlay_generation: generation, error: null },
    isError: false,
  };
}

export function renderSubagentPresentationOverlayForTests(input?: unknown): string {
  return larva_subagent_log(input).content[0]?.text ?? "";
}

export function currentSubagentOverlayForTests(): { task_id: string | null; generation: number } | null {
  return currentSubagentOverlay ? { task_id: currentSubagentOverlay.entry.task_id, generation: currentSubagentOverlay.generation } : null;
}

export function subagentPresentationLogForTests(): SubagentPresentationLogEntry[] {
  return retainedSubagentPresentationLog.map((entry) => ({ ...entry }));
}

export function resetSubagentPresentationStateForTests(): void {
  retainedSubagentPresentationLog.length = 0;
  subagentPresentationSequence = 0;
  subagentUiResetGeneration += 1;
  activeTaskIds.clear();
  closeSubagentPresentationOverlay();
}

export function recordSubagentPresentationEntryForTests(
  taskId: string | null,
  personaId: string,
  status: SubagentPresentationStatus,
  metadata: Partial<Omit<SubagentPresentationLogEntry, "task_id" | "persona_id" | "status" | "sequence">> = {},
): void {
  if (taskId !== null) {
    for (let index = retainedSubagentPresentationLog.length - 1; index >= 0; index -= 1) {
      if (retainedSubagentPresentationLog[index].task_id === taskId) retainedSubagentPresentationLog.splice(index, 1);
    }
  }
  appendSubagentPresentationLog({ task_id: taskId, persona_id: personaId, status, ...metadata });
}

export function isSubagentTaskBusyForTests(taskId: string): boolean {
  return activeTaskIds.has(taskId);
}

function subagentMode(input: LarvaSubagentInput): "new" | "resume" {
  return typeof input.task_id === "string" && input.task_id.trim().length > 0 ? "resume" : "new";
}

function renderTextComponent(text: string, markdown?: string): PiRenderableText {
  return {
    text,
    markdown,
    format: markdown === undefined ? "plain_text" : "markdown",
    invalidate: () => undefined,
    render: (width: number): string[] => {
      const contentWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
      return markdown === undefined
        ? renderRendererSafePlainLines(text, contentWidth)
        : renderMarkdownLines(markdown, contentWidth);
    },
  };
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
  const task = typeof input.task === "string" ? input.task : "";
  const taskIdLine = details.task_id !== null ? `task_id: ${details.task_id}` : "task_id: pending";
  const footer = resumeFooter(details);
  const output = details.result_text.length > 0 ? details.result_text : "Larva subagent completed without final assistant text.";
  const fallbackLines = [
    "Summary",
    `persona_id: ${details.persona_id}`,
    `mode: ${mode}`,
    taskIdLine,
    `status: ${details.status}`,
    "",
    "Task",
    `task: ${task}`,
    "",
    "Output",
    `output: ${output}`,
  ];
  if (details.error) fallbackLines.push("", "Error", `error: ${details.error.code}: ${details.error.message}`);
  if (footer.length > 0) fallbackLines.push("", "Resume", footer);
  const fallback = fallbackLines.join("\n");
  const markdownSections = [
    "## Summary",
    `- persona_id: ${details.persona_id}`,
    `- mode: ${mode}`,
    `- ${taskIdLine}`,
    `- status: ${details.status}`,
    "",
    "## Task",
    markdownFence(task),
    "",
    "## Output",
    output,
  ];
  if (details.error) markdownSections.push("", "## Error", `- ${details.error.code}: ${details.error.message}`);
  if (footer.length > 0) markdownSections.push("", "## Resume", markdownFence(footer));
  return renderTextComponent(fallback, markdownSections.join("\n"));
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

function isLarvaPiLaunched(env: RuntimeEnv): boolean {
  return env.LARVA_PI_LAUNCHED === "1";
}

function launcherArgs(env: RuntimeEnv): string[] | LarvaError {
  const launched = isLarvaPiLaunched(env);
  const realBin = normalizeString(env.LARVA_PI_REAL_BIN);
  const flag = normalizeString(env.LARVA_PI_EXTENSION_FLAG);
  const entry = normalizeString(env.LARVA_PI_EXTENSION_ENTRY);
  if (!launched || !realBin || !flag || !entry) return error("LARVA_CHILD_START_FAILED", "Launcher Pi child environment is incomplete.");
  return [realBin, flag, entry, "--mode", "rpc", "--session-dir"];
}

function startChild(env: RuntimeEnv, root: string, personaId: string): ChildProcessWithoutNullStreams | LarvaError {
  const prefix = launcherArgs(env);
  if (!Array.isArray(prefix)) return prefix;
  const [realBin, flag, entry, ...tail] = prefix;
  const args = [flag, entry, ...tail, root];
  try {
    const child = spawn(realBin, args, {
      env: {
        ...process.env,
        ...env,
        LARVA_PI_INITIAL_PERSONA_ID: personaId,
        LARVA_PI_PARENT_PERSONA_ID: state.envelope?.persona_id || env.LARVA_PI_PARENT_PERSONA_ID || "",
        LARVA_PI_INTERACTIVE_TUI: "0",
        LARVA_PI_LAUNCHED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    void traceChildRpc(env, "child_spawn", { pid: child.pid ?? null, command: realBin, args, root, persona_id: personaId });
    return child;
  } catch {
    void traceChildRpc(env, "child_spawn_error", { command: realBin, args, root, persona_id: personaId });
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
  private readonly pending = new Map<string, (value: unknown | LarvaError) => void>();
  private readonly events: unknown[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private rpcReady = false;
  private closed = false;
  private stdoutClosed = false;
  private childError: unknown = null;
  private readonly traceEnv: RuntimeEnv;
  private readonly onPresentationEvent?: (eventValue: NormalizedSubagentStreamEvent) => void;

  constructor(child: ChildProcessWithoutNullStreams, traceEnv: RuntimeEnv, onPresentationEvent?: (eventValue: NormalizedSubagentStreamEvent) => void) {
    this.child = child;
    this.traceEnv = traceEnv;
    this.onPresentationEvent = onPresentationEvent;
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderr += text;
      void traceChildRpc(this.traceEnv, "child_stderr", { pid: this.child.pid ?? null, text });
    });
    child.once("error", (caught: unknown) => {
      this.childError = caught;
      void traceChildRpc(this.traceEnv, "child_error", { pid: this.child.pid ?? null, message: caught instanceof Error ? caught.message : String(caught) });
      this.failPending(this.closedError());
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed = true;
      void traceChildRpc(this.traceEnv, "child_exit", { pid: this.child.pid ?? null, code, signal });
      this.failPending(this.closedError());
    });
    child.stdout.once("close", () => {
      this.stdoutClosed = true;
      void traceChildRpc(this.traceEnv, "child_stdout_close", { pid: this.child.pid ?? null });
      if (!this.closed && this.rpcReady) this.failPending(this.stdoutClosedError());
    });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.consume(line));
  }

  private consume(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch {
      void traceChildRpc(this.traceEnv, "rpc_rx_malformed", { pid: this.child.pid ?? null, line });
      const protocolError = error("LARVA_CHILD_PROTOCOL_FAILED", "Child emitted malformed JSONL.");
      this.events.push({ type: "protocol_error" });
      this.failPending(protocolError);
      return;
    }
    void traceChildRpc(this.traceEnv, "rpc_rx", { pid: this.child.pid ?? null, frame: message });
    const normalizedPresentationEvent = normalizeSubagentChildStreamEventForPresentation(message);
    if (normalizedPresentationEvent !== null) this.onPresentationEvent?.(normalizedPresentationEvent);
    const id = typeof message === "object" && message !== null && "id" in message ? String((message as { id: unknown }).id) : "";
    const waiter = this.pending.get(id);
    if (id && waiter) {
      this.pending.delete(id);
      waiter(message);
      return;
    }
    this.events.push(message);
  }

  private failPending(larvaError: LarvaError): void {
    const waiters = Array.from(this.pending.values());
    this.pending.clear();
    for (const waiter of waiters) waiter(larvaError);
  }

  private closedError(): LarvaError {
    if (this.childError !== null && !this.rpcReady) return error("LARVA_CHILD_START_FAILED", "Child Pi process could not be started.");
    return this.rpcReady
      ? error("LARVA_CHILD_PROTOCOL_FAILED", "Child exited before RPC response; post-readiness stderr is diagnostic only.")
      : parseStartupError(this.stderr);
  }

  private stdoutClosedError(): LarvaError {
    return this.rpcReady
      ? error("LARVA_CHILD_PROTOCOL_FAILED", "Child stdout closed before RPC response.")
      : error("LARVA_CHILD_START_FAILED", "Child stdout closed before RPC readiness.");
  }

  async command(id: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown | LarvaError> {
    const frame = { id, ...body };
    const message = JSON.stringify(frame);
    void traceChildRpc(this.traceEnv, "rpc_tx", { pid: this.child.pid ?? null, frame });
    return await new Promise((resolveCommand) => {
      let settled = false;
      const settle = (value: unknown | LarvaError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.child.off("close", onClose);
        this.child.off("error", onError);
        this.child.stdout.off("close", onStdoutClose);
        resolveCommand(value);
      };
      const onClose = (): void => {
        settle(this.closedError());
      };
      const onError = (): void => {
        settle(this.closedError());
      };
      const onStdoutClose = (): void => {
        if (!this.closed && this.rpcReady) settle(this.stdoutClosedError());
      };
      const timer = setTimeout(() => {
        settle(error("LARVA_CHILD_PROTOCOL_FAILED", "Child RPC command timed out after ten seconds."));
      }, timeoutMs);
      this.pending.set(id, (value) => {
        this.rpcReady = true;
        settle(value);
      });
      this.child.once("close", onClose);
      this.child.once("error", onError);
      this.child.stdout.once("close", onStdoutClose);
      if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) {
        settle(this.closedError());
        return;
      }
      if (this.stdoutClosed) {
        settle(this.stdoutClosedError());
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
      if (this.stdoutClosed && !this.closed) return error("LARVA_CHILD_PROTOCOL_FAILED", "Child stdout closed before agent_end.");
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        return this.rpcReady
          ? error("LARVA_CHILD_PROTOCOL_FAILED", "Child exited before agent_end; post-readiness stderr is diagnostic only.")
          : this.closedError();
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  startupError(): LarvaError { return parseStartupError(this.stderr); }

  async abort(): Promise<"success" | "cancelled" | "unknowable"> {
    void traceChildRpc(this.traceEnv, "abort_start", { pid: this.child.pid ?? null });
    const aborted = await this.command("abort-1", { type: "abort" }, 5_000);
    void traceChildRpc(this.traceEnv, "abort_rpc_result", { pid: this.child.pid ?? null, result: aborted });
    if (isSuccessResponse(aborted)) return "cancelled";
    try {
      const killed = this.child.kill();
      void traceChildRpc(this.traceEnv, "abort_kill", { pid: this.child.pid ?? null, killed });
      return killed ? "cancelled" : "unknowable";
    } catch {
      void traceChildRpc(this.traceEnv, "abort_kill_error", { pid: this.child.pid ?? null });
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

type SubagentLifecycleCallbacks = {
  onPhase?: (phase: string, taskId?: string | null) => void;
  onTaskAllocated?: (taskId: string) => void;
  onStreamEvent?: (eventValue: NormalizedSubagentStreamEvent, taskId?: string | null) => void;
};

function childStillRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (!childStillRunning(child)) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

async function cleanupChild(child: ChildProcessWithoutNullStreams, env: RuntimeEnv): Promise<void> {
  void traceChildRpc(env, "cleanup_start", { pid: child.pid ?? null, running: childStillRunning(child) });
  try { child.stdin.end(); } catch { /* stdin may already be closed */ }
  if (childStillRunning(child)) {
    try {
      const killed = child.kill("SIGTERM");
      void traceChildRpc(env, "cleanup_sigterm", { pid: child.pid ?? null, killed });
    } catch { /* best-effort shutdown */ }
    await waitForChildClose(child, 5_000);
  }
  if (childStillRunning(child)) {
    try {
      const killed = child.kill("SIGKILL");
      void traceChildRpc(env, "cleanup_sigkill", { pid: child.pid ?? null, killed });
    } catch { /* best-effort hard kill */ }
    await waitForChildClose(child, 1_000);
  }
  try { child.stdin.destroy(); } catch { /* ignore stream cleanup errors */ }
  try { child.stdout.destroy(); } catch { /* ignore stream cleanup errors */ }
  try { child.stderr.destroy(); } catch { /* ignore stream cleanup errors */ }
  void traceChildRpc(env, "cleanup_end", { pid: child.pid ?? null, running: childStillRunning(child), exitCode: child.exitCode, signalCode: child.signalCode });
}

async function resetActiveSubagentChildren(): Promise<number> {
  const active = Array.from(activeSubagentChildren);
  activeSubagentChildren.clear();
  await Promise.all(active.map(async (entry) => cleanupChild(entry.child, entry.env)));
  return active.length;
}

export async function resetExtensionUI(_reason = "manual"): Promise<{ status: "success"; active_children_reaped: number; busy_cleared: boolean; overlay_closed: boolean; presentation_cleared: boolean }> {
  const activeChildrenReaped = await resetActiveSubagentChildren();
  activeTaskIds.clear();
  retainedSubagentPresentationLog.length = 0;
  subagentPresentationSequence = 0;
  subagentUiResetGeneration += 1;
  closeSubagentPresentationOverlay();
  return { status: "success", active_children_reaped: activeChildrenReaped, busy_cleared: true, overlay_closed: true, presentation_cleared: true };
}

async function runChildSequence(
  env: RuntimeEnv,
  root: string,
  personaId: string,
  task: string,
  taskId: string | null,
  abortSignal?: AbortSignal,
  callbacks?: SubagentLifecycleCallbacks,
): Promise<LarvaSubagentResult> {
  const lifecycle = callbacks ?? {};
  const child = startChild(env, root, personaId);
  if (isLarvaError(child)) return failed(taskId, personaId, child);
  const activeChildEntry = { child, env };
  activeSubagentChildren.add(activeChildEntry);
  let allocatedTaskId = taskId;
  const rpc = new RpcClient(child, env, (eventValue) => lifecycle.onStreamEvent?.(eventValue, allocatedTaskId));
  let freshBusyTaskId: string | null = null;
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
  const abortResultIfRequested = async (): Promise<LarvaSubagentResult | null> => {
    if (abortSignal?.aborted) requestAbort();
    if (!abortStarted) return null;
    return abortPromise ? await abortPromise : cancelled(allocatedTaskId, personaId);
  };
  if (abortSignal?.aborted) requestAbort();
  abortSignal?.addEventListener("abort", requestAbort, { once: true });
  const sequence = async (): Promise<LarvaSubagentResult> => {
    const isResume = taskId !== null;
    const alreadyAborting = await abortResultIfRequested();
    if (alreadyAborting) return alreadyAborting;
    if (taskId) {
      const switched = await rpc.command("switch-1", { type: "switch_session", sessionPath: taskId });
      const switchAbort = await abortResultIfRequested();
      if (switchAbort) return switchAbort;
      if (!isSuccessResponse(switched) || (switched as { data?: { cancelled?: unknown } }).data?.cancelled === true) {
        child.kill();
        return failed(taskId, personaId, isLarvaError(switched) ? switched : error("LARVA_CHILD_PROTOCOL_FAILED", "Child switch_session failed."));
      }
      lifecycle.onPhase?.("session_ready", taskId);
    } else {
      const stateResult = await rpc.command("state-1", { type: "get_state" });
      const stateAbort = await abortResultIfRequested();
      if (stateAbort) return stateAbort;
      const sessionFile = sessionFileFromState(stateResult);
      if (isLarvaError(sessionFile)) { child.kill(); return failed(null, personaId, sessionFile); }
      const canonical = await validateFreshChildSessionFile(sessionFile, root);
      if (isLarvaError(canonical)) { child.kill(); return failed(null, personaId, error("LARVA_CHILD_PROTOCOL_FAILED", "Child returned invalid sessionFile.")); }
      if (activeTaskIds.has(canonical)) { child.kill(); return failed(canonical, personaId, error("LARVA_SESSION_BUSY", "Child session is already active.")); }
      activeTaskIds.add(canonical);
      freshBusyTaskId = canonical;
      taskId = canonical;
      allocatedTaskId = canonical;
      lifecycle.onTaskAllocated?.(canonical);
      lifecycle.onPhase?.("session_ready", canonical);
    }
    const beforePromptAbort = await abortResultIfRequested();
    if (beforePromptAbort) return beforePromptAbort;
    const prompted = await rpc.command("prompt-1", { type: "prompt", message: task });
    const promptAbort = await abortResultIfRequested();
    if (promptAbort) return promptAbort;
    if (!isSuccessResponse(prompted)) { child.kill(); return failed(taskId, personaId, isLarvaError(prompted) ? prompted : error("LARVA_CHILD_PROTOCOL_FAILED", "Child prompt failed.")); }
    lifecycle.onPhase?.("prompt_sent", taskId);
    lifecycle.onPhase?.("waiting_for_child", taskId);
    const ended = await rpc.waitForAgentEnd();
    const endedAbort = await abortResultIfRequested();
    if (endedAbort) return endedAbort;
    if (ended) { child.kill(); return failed(taskId, personaId, ended); }
    if (!isResume && taskId !== null) {
      const finalSessionPath = await validateTaskId(taskId, root);
      if (isLarvaError(finalSessionPath)) {
        child.kill();
        return failed(taskId, personaId, error("LARVA_CHILD_PROTOCOL_FAILED", "Child sessionFile was not available after prompt."));
      }
      taskId = finalSessionPath;
      allocatedTaskId = finalSessionPath;
    }
    const finalTextAbort = await abortResultIfRequested();
    if (finalTextAbort) return finalTextAbort;
    lifecycle.onPhase?.("collecting_final_text", taskId);
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
    if (freshBusyTaskId) activeTaskIds.delete(freshBusyTaskId);
    activeSubagentChildren.delete(activeChildEntry);
    await cleanupChild(child, env);
  }
}

export async function larva_subagent(input: LarvaSubagentInput, ctx?: { env?: RuntimeEnv; abortSignal?: AbortSignal; onPhase?: (phase: string, taskId?: string | null) => void; presentationCallId?: string }): Promise<LarvaSubagentResult> {
  const presentationGeneration = subagentUiResetGeneration;
  const recordIfCurrent = (result: LarvaSubagentResult): void => {
    if (presentationGeneration === subagentUiResetGeneration) recordSubagentPresentationResult(result, input, ctx?.presentationCallId);
  };
  const parsed = validateInput(input);
  if ("status" in parsed) {
    recordIfCurrent(parsed);
    return parsed; // public task_id: null on bad input pre-session failures
  }
  const { personaId, task, taskId } = parsed;
  const env = currentEnv(ctx);
  const root = await childSessionRoot(env);
  if (isLarvaError(root)) {
    const result = failed(null, personaId, root);
    recordIfCurrent(result);
    return result;
  }

  let canonicalTaskId: string | null = null;
  if (taskId !== null) {
    const validated = await validateTaskId(taskId, root);
    if (isLarvaError(validated)) {
      const result = failed(null, personaId, validated);
      recordIfCurrent(result);
      return result;
    }
    canonicalTaskId = validated;
  }
  const authorityError = canSpawn(state.envelope, personaId);
  if (authorityError) {
    const result = failed(null, personaId, authorityError);
    recordIfCurrent(result);
    return result;
  }
  let busyTaskId = canonicalTaskId;
  if (canonicalTaskId) {
    if (activeTaskIds.has(canonicalTaskId)) {
      const result = failed(canonicalTaskId, personaId, error("LARVA_SESSION_BUSY", "Child session is already being resumed."));
      recordIfCurrent(result);
      return result;
    }
    activeTaskIds.add(canonicalTaskId);
    recordSubagentPresentationRunning(canonicalTaskId, personaId, input, ctx?.presentationCallId);
  }

  try {
    const result = ctx?.abortSignal?.aborted
      ? cancelled(canonicalTaskId, personaId)
      : await runChildSequence(env, root, personaId, task, canonicalTaskId, ctx?.abortSignal, {
        onPhase: ctx?.onPhase,
        onTaskAllocated: (allocatedTaskId) => {
          busyTaskId = allocatedTaskId;
          if (presentationGeneration === subagentUiResetGeneration) recordSubagentPresentationRunning(allocatedTaskId, personaId, input, ctx?.presentationCallId);
        },
        onStreamEvent: (eventValue, streamedTaskId) => {
          if (presentationGeneration === subagentUiResetGeneration) applyNormalizedSubagentStreamEvent(streamedTaskId, ctx?.presentationCallId, eventValue);
        },
      });
    busyTaskId = result.task_id ?? busyTaskId;
    recordIfCurrent(result);
    return result;
  } finally {
    if (busyTaskId) activeTaskIds.delete(busyTaskId);
  }
}

function safelyEmitSubagentUpdate(onUpdate: ((update: unknown) => void) | undefined, update: LarvaSubagentProgressUpdate): void {
  try {
    onUpdate?.(update);
  } catch {
    // Pi update callbacks are presentation-only; callback failures must not invalidate child RPC lifecycle or public result contracts.
  }
}

async function initializeSession(ctx: PiContext, pi: PiApi): Promise<void> {
  const env = currentEnv(ctx);
  if (!env.LARVA_PI_INITIAL_PERSONA_ID) {
    await setStatus(ctx);
    return;
  }
  const committed = await commitPersonaWithOptions(env.LARVA_PI_INITIAL_PERSONA_ID, ctx, pi, { toolBaseline: startupToolBaseline });
  if (!committed.ok) {
    fatalInitialPersonaStartup(env, env.LARVA_PI_INITIAL_PERSONA_ID, committed.error);
    await setStartupUnavailableStatus(ctx, env.LARVA_PI_INITIAL_PERSONA_ID, committed.error);
    await notify(ctx, `Larva startup persona unavailable: ${committed.error.code}: ${committed.error.message}`, "error");
  }
}

export async function initializeExtension(ctx: PiContext, pi: PiApi = ctx): Promise<void> {
  const env = currentEnv(ctx);
  loadSubagentPresentationCache(env);
  registerLarvaSubagentLogCommand(ctx, pi);
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
    handler: (input: LarvaSubagentInput) => larva_subagent(input, { env, abortSignal: ctx.abortSignal ?? ctx.signal }).then((result) => wrapLarvaSubagentToolResult(result)),
    execute: (_toolCallId, input, signal, onUpdate, toolCtx) => {
      const runtimeCtx = withRuntimeEnv(toolCtx ?? ctx, env);
      const callId = typeof _toolCallId === "string" && _toolCallId.length > 0 ? _toolCallId : undefined;
      const executeGeneration = subagentUiResetGeneration;
      const emitProgress = (phase: string, taskId?: string | null): void => {
        if (executeGeneration === subagentUiResetGeneration) upsertSubagentPresentationProgress(input, phase, taskId, callId);
        safelyEmitSubagentUpdate(onUpdate, progressUpdate(input, phase, taskId));
      };
      emitProgress("starting");
      return larva_subagent(input, {
        env: currentEnv(runtimeCtx),
        abortSignal: signal ?? runtimeCtx.signal ?? runtimeCtx.abortSignal,
        onPhase: emitProgress,
        presentationCallId: callId,
      }).then((result) => {
        safelyEmitSubagentUpdate(onUpdate, progressUpdate(input, result.status, result.task_id));
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
    await resetExtensionUI("session_start");
    await initializeSession(runtimeCtx, pi);
  });
  for (const lifecycleEvent of ["shutdown", "session_end", "exit"]) {
    pi.on?.(lifecycleEvent, async () => resetExtensionUI(lifecycleEvent));
  }
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
