import { LarvaError, toErrorEnvelope, type ErrorInfo } from "../core/errors.ts";
import { isValidProfileName, resolveModelRoute } from "../core/model-map.ts";
import { isRecord, isValidPersonaId } from "../core/predicates.ts";
import type {
  LarvaConfig, ModelMapDoc, ModelMapEntry, PersonaSpec, PersonaSwitchToolInput, SwitchMode, ThinkingLevel,
} from "../core/types.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import {
  assertSoloCall, confirmSwitch, larva_persona_switch, PERSONA_SWITCH_AUDIT, PersonaLeaseState,
  type Continuation, type PersonaSwitchContext, type PersonaSwitchOutcome,
} from "./persona-lease.ts";
import { composeSystemPrompt, replyToSystemPrompt, type SwitchContinuation } from "./system-prompt.ts";

const PERSONA_COMMIT = "larva-active-persona-commit";
const MODE_OVERRIDE = "larva-agent-persona-switch-mode";
const ROUTE_ATTRIBUTION = "larva-native-route-attribution";

type Awaitable<T> = T | Promise<T>;
export type NativeRoute = { model: ModelMapEntry | null; thinking: ThinkingLevel };
type RouteTarget = Partial<NativeRoute> & { preserveThinking?: ThinkingLevel };
export type ModelMapProfile = { name: string; generation: number; map?: ModelMapDoc };
export type ChildProfileReport = Record<
  "fenced_for_startup" | "in_flight_until_run_settles" | "ended_during_switch" | "failed", number
>;
export type ModelMapOutcome =
  | { status: "inspect"; profile: string; generation: number }
  | { status: "switched"; profile: string; generation: number; children?: ChildProfileReport; child_notification_error?: ErrorInfo }
  | { status: "failed" | "route_uncertain"; profile: string; generation: number; error: ErrorInfo };
export type TurnSettlement =
  | { status: "settled" }
  | { status: "continue"; continuation: Continuation }
  | { status: "restore_failed" | "route_uncertain"; error: ErrorInfo };

export type SessionAdapter = {
  /** Return the actual Pi state, including any native model or thinking changes. */
  readRoute: () => NativeRoute;
  /** Reject or return false if Pi cannot apply the exact model (including a null model). */
  setModel: (model: ModelMapEntry | null) => Awaitable<boolean>;
  setThinking: (thinking: ThinkingLevel) => Awaitable<void>;
  /** Atomic append: a throw means no entry was committed. */
  appendEntry: (customType: string, data: Record<string, unknown>) => void;
  /** Adapt to Pi's UI notification or structured RPC status surface. */
  report: (event: { action: string; data: unknown }) => void;
  readHistory?: () => readonly unknown[];
  readBranch?: () => readonly unknown[];
};

type SessionOptions = {
  personas: Pick<PersonaStore, "get" | "list">;
  /** Use core loadModelMap with the host's contained reader. Missing default is literal routing. */
  loadProfile: (name: string) => Promise<ModelMapDoc | undefined>;
  adapter: SessionAdapter;
  flags?: { persona?: string; mode?: string };
  env?: Partial<Pick<NodeJS.ProcessEnv, "LARVA_PI_LAUNCHED" | "LARVA_PI_INITIAL_PERSONA_ID" | "LARVA_PI_MODEL_MAP_PROFILE">>;
};

function isSwitchMode(value: unknown): value is SwitchMode {
  return value === "manual" || value === "confirm" || value === "auto" || value === "free";
}

export function entryData(entry: unknown, customType: string): Record<string, unknown> | undefined {
  if (isRecord(entry) && entry.type === "custom" && entry.customType === customType && isRecord(entry.data)) return entry.data;
}

function nativeModel(provider: unknown, modelId: unknown): ModelMapEntry | undefined {
  const token = (value: unknown): value is string => typeof value === "string" && /^[^\s\0]+$/.test(value);
  if (token(provider) && token(modelId)) return { provider, model_id: modelId };
}

function routeEntry(entry: unknown): RouteTarget | undefined {
  if (!isRecord(entry)) return;
  if (entry.type === "model_change") {
    const model = nativeModel(entry.provider, entry.modelId);
    if (model) return { model };
  }
  if (entry.type === "thinking_level_change" && isThinkingLevel(entry.thinkingLevel)) return { thinking: entry.thinkingLevel };
}

function routeEntryIds(entries: readonly unknown[]): string[] {
  return entries.flatMap(entry => isRecord(entry) && typeof entry.id === "string" && routeEntry(entry) ? [entry.id] : []);
}

function routeAttributions(entries: readonly unknown[]): Map<string, RouteTarget> {
  const result = new Map<string, RouteTarget>();
  for (const entry of entries) {
    const data = entryData(entry, ROUTE_ATTRIBUTION);
    if (!data || !Array.isArray(data.entry_ids)) continue;
    const before = isRecord(data.before) ? data.before : {};
    const model = before.model === null ? null : isRecord(before.model) ? nativeModel(before.model.provider, before.model.model_id) : undefined;
    const thinking = isThinkingLevel(before.thinking) ? before.thinking : undefined;
    for (const id of data.entry_ids) if (typeof id === "string") result.set(id, { model, thinking });
  }
  return result;
}

function userRouteOverrides(branch: readonly unknown[], history: readonly unknown[], after: number,
  persona: PersonaSpec | null, startupRoute?: NativeRoute): RouteTarget {
  const attributed = routeAttributions(history);
  const overrides: RouteTarget = {};
  const origin: RouteTarget = {};
  const latestAttributed: RouteTarget = {};
  let pending: RouteTarget[] = [];
  let declarationAt: number | undefined;
  const flush = () => {
    for (const route of pending) Object.assign(overrides, route);
    pending = [];
    declarationAt = undefined;
  };
  for (const entry of branch.slice(after + 1)) {
    const route = routeEntry(entry);
    if (route && isRecord(entry)) {
      const before = typeof entry.id === "string" ? attributed.get(entry.id) : undefined;
      if (route.model !== undefined) {
        latestAttributed.model = before ? route.model : undefined;
        if (origin.model === undefined && before?.model !== undefined) origin.model = before.model;
      }
      if (route.thinking !== undefined) {
        latestAttributed.thinking = before ? route.thinking : undefined;
        origin.thinking ??= before?.thinking;
      }
      if (!before) pending.push(route);
      continue;
    }
    if (entryData(entry, "larva-tool-declarations")) {
      declarationAt = pending.length;
      continue;
    }
    const audit = entryData(entry, PERSONA_SWITCH_AUDIT);
    // 0.8.x appends a tool-declarations record as part of persona commit, then
    // logs the borrow. Captured-origin restore applies persona thinking before
    // that record and restores the captured model/thinking afterwards.
    const legacy = audit?.lease;
    if (isRecord(legacy) && legacy.scope === "turn" && isValidPersonaId(legacy.borrowedPersonaId)
        && (legacy.originPersonaId === null || isValidPersonaId(legacy.originPersonaId))
        && ((audit?.source === "tool" && audit.committed === true) || (audit?.source === "runtime" && audit.event === "restore"))) {
      const restoring = audit.event === "restore";
      const noRestore = restoring && legacy.originPersonaId === null;
      if (!noRestore) {
        if (restoring && legacy.originPiModelCaptured === true && declarationAt !== undefined) {
          pending.length = declarationAt;
          if (pending.at(-1)?.thinking !== undefined) pending.pop();
        } else {
          const modelIndex = pending.findLastIndex(change => change.model !== undefined);
          if (modelIndex !== -1) pending.length = modelIndex;
          else if (pending.at(-1)?.thinking !== undefined) pending.pop();
        }
      }
    }
    flush();
  }
  flush();
  if (persona) return overrides;
  // With no active persona Pi owns startup CLI precedence. Only repair a
  // component Pi actually replayed from a Larva transition, e.g. an interrupted
  // borrow from larva:none. Tree has no CLI route to preserve.
  const target = startupRoute ? {} : overrides;
  if (latestAttributed.model !== undefined && (!startupRoute || sameModel(startupRoute.model, latestAttributed.model))) {
    target.model = overrides.model === undefined ? origin.model : overrides.model;
  }
  if (latestAttributed.thinking !== undefined && (!startupRoute || startupRoute.thinking === latestAttributed.thinking)) {
    target.thinking = overrides.thinking ?? origin.thinking;
  }
  return target;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max";
}

function sameModel(a: NativeRoute["model"], b: NativeRoute["model"]): boolean {
  return a?.provider === b?.provider && a?.model_id === b?.model_id;
}

function modelUnavailable(): LarvaError {
  return new LarvaError("LARVA_MODEL_UNAVAILABLE", "Pi could not apply and verify the requested model and thinking level.");
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LarvaError("LARVA_BAD_INPUT", "Persona switch was cancelled.");
}

/** One live context per Pi session. Retain it and rebind the adapter across /reload. */
export class SessionContext {
  readonly #options: Omit<SessionOptions, "adapter">;
  #adapter: SessionAdapter;
  readonly #child: boolean;
  readonly #lease = new PersonaLeaseState();
  #persona: PersonaSpec | null = null;
  #profile: ModelMapProfile = { name: "default", generation: 0 };
  #config?: LarvaConfig;
  #modeOverride?: SwitchMode;
  #profileError?: unknown;
  #startupWarning?: ErrorInfo;
  #continuation?: SwitchContinuation;
  #restoreFailed?: LarvaError;
  #routeUncertain?: LarvaError;
  #request?: AbortController;
  #queue: Promise<unknown> = Promise.resolve();
  #transition = false;

  constructor({ adapter, ...options }: SessionOptions) {
    this.#options = options;
    this.#adapter = adapter;
    this.#child = options.env?.LARVA_PI_LAUNCHED === "1";
  }

  get activePersona(): PersonaSpec | null { return this.#persona; }
  get config(): LarvaConfig | undefined { return this.#config; }
  get badge(): string {
    const id = this.#persona?.id ?? "none";
    const error = this.#routeUncertain ?? this.#restoreFailed ?? this.#startupWarning;
    if (error) return `🎭 ⚠️ ${id} (${error.code})`;
    const origin = this.#lease.origin;
    return `🎭 ${id}${origin ? ` ↩ ${origin.origin_persona_id ?? "none"}` : ""}`;
  }
  get switchMode(): SwitchMode { return this.#child ? "manual" : this.#modeOverride ?? this.#config?.switch_mode ?? "confirm"; }
  get restoreFailed(): boolean { return this.#restoreFailed !== undefined; }
  get routeUncertain(): boolean { return this.#routeUncertain !== undefined; }

  #exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.#queue.then(async () => {
      this.#transition = true;
      try { return await work(); } finally { this.#transition = false; }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #report(action: string, data: unknown): void {
    try { this.#adapter.report({ action, data }); } catch { /* An observer cannot undo a commit. */ }
  }

  #audit(data: Record<string, unknown>): void {
    try { this.#adapter.appendEntry(PERSONA_SWITCH_AUDIT, data); }
    catch { this.#report(PERSONA_SWITCH_AUDIT, data); }
  }

  #persistPersona(persona: PersonaSpec | null, source: "startup" | "user" | "tool"): void {
    this.#adapter.appendEntry(PERSONA_COMMIT, {
      schema_version: 1, persona_id: persona?.id ?? null, spec_digest: persona?.spec_digest ?? null, source,
    });
  }

  #persistMode(mode: SwitchMode, source: "slash-command" | "auto-borrow"): void {
    this.#adapter.appendEntry(MODE_OVERRIDE, { mode, source });
    this.#modeOverride = mode;
  }

  #preempt(): void {
    this.#lease.clearLease();
    this.endContinuationTurn();
    this.#restoreFailed = undefined;
    this.#routeUncertain = undefined;
    this.#startupWarning = undefined;
    this.#request?.abort();
  }

  #routeFor(persona: PersonaSpec, profile = this.#profile): NativeRoute {
    if (profile === this.#profile && this.#profileError) throw this.#profileError;
    return { model: resolveModelRoute(persona.model, profile.map), thinking: persona.thinking };
  }

  #readRoute(): NativeRoute {
    const { model, thinking } = this.#adapter.readRoute();
    return { model: model && { ...model }, thinking };
  }

  #routeMatches({ model, thinking }: RouteTarget): boolean {
    const current = this.#adapter.readRoute();
    return (model === undefined || sameModel(current.model, model)) && (thinking === undefined || current.thinking === thinking);
  }

  async #applyRoute(target: RouteTarget, operation: "activate" | "restore" | "rollback"): Promise<void> {
    const { model, thinking, preserveThinking } = target;
    try {
      // Pi's model setter is also the native availability/auth check. A model
      // already selected in Pi isn't evidence that a new activation can use it.
      if (model !== undefined && ((operation === "activate" && model !== null) || !sameModel(this.#adapter.readRoute().model, model))
          && !await this.#adapter.setModel(model)) throw modelUnavailable();
    } catch {
      if (operation === "rollback" && thinking !== undefined) {
        // A rejected model rollback should not prevent best-effort thinking restoration.
        try { await this.#adapter.setThinking(thinking); } catch { /* Report the unverified pair. */ }
      }
      throw modelUnavailable();
    }
    try {
      const desiredThinking = thinking ?? preserveThinking;
      if (desiredThinking !== undefined && (thinking !== undefined || this.#routeMatches({ model }))
          && this.#adapter.readRoute().thinking !== desiredThinking) {
        try { await this.#adapter.setThinking(desiredThinking); }
        catch (error) { if (thinking !== undefined) throw error; }
      }
      if (!this.#routeMatches(target)) throw modelUnavailable();
    } catch { throw modelUnavailable(); }
  }

  async #moveRoute(target: RouteTarget, before: NativeRoute, options?: { commit?: () => void; restoreExact?: boolean }): Promise<void> {
    const apply = async (route: RouteTarget, operation: "activate" | "restore" | "rollback") => {
      const readBranch = this.#adapter.readBranch;
      const previous = readBranch?.().at(-1);
      const preImage = this.#readRoute();
      try { await this.#applyRoute(route, operation); }
      finally {
        if (readBranch) {
          const entries = readBranch();
          const index = previous === undefined ? -1 : entries.findLastIndex(entry => entry === previous ||
            isRecord(entry) && isRecord(previous) && typeof entry.id === "string" && entry.id === previous.id);
          if (index !== -1 || previous === undefined) {
            const entry_ids = routeEntryIds(entries.slice(index + 1));
            if (entry_ids.length) this.#adapter.appendEntry(ROUTE_ATTRIBUTION, { entry_ids, before: preImage });
          }
        }
      }
    };
    try {
      await apply(target, options?.restoreExact ? "restore" : "activate");
      options?.commit?.();
    } catch (error) {
      try { await apply(before, "rollback"); }
      catch {
        this.#routeUncertain = new LarvaError("LARVA_ROUTE_UNCERTAIN", "Could not verify Pi route rollback; reconcile with /model or /larva-persona.");
        this.#report("route_uncertain", toErrorEnvelope(this.#routeUncertain).error);
        throw this.#routeUncertain;
      }
      throw error;
    }
  }

  /** Start or restore using the selected Pi branch, not all entries in the session tree. */
  async initialize(config: LarvaConfig, branch: readonly unknown[] = [], source: "startup" | "tree" = "startup"): Promise<void> {
    return this.#exclusive(async () => {
      this.endContinuationTurn();
      const flagPersona = source === "startup" || this.#child ? this.#options.flags?.persona?.trim() : undefined;
      const explicit = this.#child ? this.#options.env?.LARVA_PI_INITIAL_PERSONA_ID ?? flagPersona : flagPersona;
      if (this.#child && (!explicit || (flagPersona !== undefined && flagPersona !== explicit))) {
        throw new LarvaError("LARVA_BAD_INPUT", "Child launch requires a matching launch-bound persona.", undefined, 2);
      }
      const flagMode = this.#child ? undefined : this.#options.flags?.mode;
      if (flagMode !== undefined && !isSwitchMode(flagMode)) {
        throw new LarvaError("LARVA_BAD_INPUT", "Invalid --larva-mode value.", undefined, 2);
      }
      // A launch mode and subsequent explicit changes outlive branch navigation.
      const override = this.#child ? undefined : flagMode !== undefined
        ? (source === "tree" ? this.#modeOverride ?? flagMode : flagMode)
        : branch.map(entry => entryData(entry, MODE_OVERRIDE)?.mode).findLast(isSwitchMode);
      this.#request?.abort();
      this.#lease.beginUserTurn();
      if (source === "tree" && (this.#restoreFailed || this.#routeUncertain)) {
        this.#modeOverride = isSwitchMode(override) ? override : undefined;
        return; // Branch navigation is not explicit recovery of an unverified route.
      }
      const commitIndex = this.#child || explicit !== undefined ? -1 : branch.findLastIndex(entry =>
        isRecord(entry) && entry.type === "custom" && entry.customType === PERSONA_COMMIT);
      const stored = entryData(branch[commitIndex], PERSONA_COMMIT);
      const id = explicit ?? (commitIndex === -1 ? config.default_persona : stored?.persona_id);
      if (!this.#config) {
        const name = this.#child ? this.#options.env?.LARVA_PI_MODEL_MAP_PROFILE ?? "default" : "default";
        this.#profile = { name, generation: 0 };
        try { this.#profile.map = await this.#options.loadProfile(name); }
        catch (error) { this.#profileError = error; }
      }
      let persona: PersonaSpec | null = null;
      let warning: ErrorInfo | undefined;
      try {
        if ((commitIndex !== -1 && stored?.schema_version !== 1) || (id !== null && !isValidPersonaId(id))) {
          throw new LarvaError("LARVA_BAD_INPUT", "Invalid startup persona selection.");
        }
        if (id !== null) persona = await this.#options.personas.get(id);
        const commit = () => {
          if (this.#child || explicit !== undefined || (commitIndex === -1 && persona)) this.#persistPersona(persona, "startup");
        };
        if (!this.#child && this.#profileError) throw this.#profileError;
        const before = this.#readRoute();
        const overrides = !this.#child && explicit === undefined && (!persona || commitIndex !== -1)
          ? userRouteOverrides(branch, this.#adapter.readHistory?.() ?? branch, commitIndex, persona, source === "startup" && !persona ? before : undefined) : {};
        if (!this.#child && (persona || overrides.model !== undefined || overrides.thinking)) {
          const target: RouteTarget = { ...(persona && this.#routeFor(persona)), ...overrides };
          // A model switch can reset thinking to a Pi default. Carry it over
          // when possible, without requiring a level the new model may clamp.
          if (!persona && overrides.model && !overrides.thinking) target.preserveThinking = before.thinking;
          await this.#moveRoute(target, before, { commit, restoreExact: !persona || overrides.model !== undefined });
        } else commit();
      } catch (error) {
        const info = toErrorEnvelope(error).error;
        if (explicit !== undefined || this.#child) {
          throw new LarvaError(error instanceof LarvaError ? error.code : "LARVA_INTERNAL_ERROR", info.message, undefined, 2);
        }
        warning = { code: info.code, message: "Could not activate the startup persona; using larva:none." };
        persona = null;
      }
      // Preserve a new rollback-uncertain latch when startup degraded after a failed transition.
      this.#lease.clearLease();
      this.#restoreFailed = undefined;
      if (warning?.code !== "LARVA_ROUTE_UNCERTAIN") this.#routeUncertain = undefined;
      this.#config = config;
      this.#modeOverride = isSwitchMode(override) ? override : undefined;
      this.#startupWarning = warning;
      this.#persona = persona;
      this.#report("startup", { persona_id: persona?.id ?? null, switch_mode: this.switchMode, warning });
    });
  }

  /** Stop pending confirmation and drain route writes before Pi invalidates this adapter. */
  async detach(): Promise<void> {
    this.#request?.abort();
    await this.#exclusive(() => this.endContinuationTurn());
  }

  /** Reload the adapter/config in-place; startup flags and later session overrides retain their authority. */
  async reload(config: LarvaConfig, adapter = this.#adapter): Promise<void> {
    await this.#exclusive(() => {
      this.#request?.abort();
      this.#adapter = adapter;
      this.#config = config;
      this.#report("reload", { persona_id: this.#persona?.id ?? null, switch_mode: this.switchMode });
    });
  }

  composeSystemPrompt(base: string): string {
    return composeSystemPrompt({ activePersona: this.#persona, launched: this.#child,
      switchMode: this.switchMode, continuation: this.#continuation }, base);
  }

  /** Bind this handler to larva:resolve-system-prompt:v1; no prompt data in unavailable replies. */
  resolveSystemPrompt(request: unknown): void {
    replyToSystemPrompt(request, this.#child || this.#transition || !this.#config || this.#routeUncertain
      ? undefined : base => this.composeSystemPrompt(base));
  }

  async personaCandidates(query = "", surface: "mention" | "command" = "mention") {
    const results = await this.#options.personas.list({ query, limit: 50 });
    return results.map(({ id, description }) => ({ value: surface === "mention" ? `@persona:${id}` : id, label: id, description }));
  }

  async setMode(mode?: string): Promise<SwitchMode> {
    if (mode === undefined) return this.#inspectMode();
    try {
      return await this.#exclusive(() => {
        if (!isSwitchMode(mode) || (this.#child && mode !== "manual")) {
          throw new LarvaError("LARVA_BAD_INPUT", "Invalid switch mode for this session.");
        }
        this.#persistMode(mode, "slash-command");
        this.#request?.abort();
        return this.#inspectMode();
      });
    } catch (error) {
      this.#report("larva-mode", toErrorEnvelope(error));
      throw error;
    }
  }

  #inspectMode(): SwitchMode {
    const mode = this.switchMode;
    this.#report("larva-mode", { mode });
    return mode;
  }

  async selectPersona(id: string | null, canCommit = () => true): Promise<void> {
    const check = () => {
      if (!canCommit()) throw new LarvaError("LARVA_SESSION_BUSY", "Wait for the active turn to finish before changing personas.");
    };
    try {
      await this.#exclusive(async () => {
        check();
        const persona = id === null ? null : await this.#options.personas.get(id.trim());
        check();
        const commit = () => { check(); this.#persistPersona(persona, "user"); };
        if (persona) await this.#moveRoute(this.#routeFor(persona), this.#readRoute(), { commit });
        else commit();
        this.#persona = persona;
        this.#preempt();
        this.#report("larva-persona", { persona_id: persona?.id ?? null });
      });
    } catch (error) {
      this.#report("larva-persona", toErrorEnvelope(error));
      throw error;
    }
  }

  /** Call only for a successfully committed explicit /model selection, never thinking or programmatic route events. */
  async reconcileManualModel(): Promise<void> {
    await this.#exclusive(() => {
      if (!this.#routeUncertain) return;
      this.#routeUncertain = undefined;
      this.#report("route_reconciled", { source: "model" });
    });
  }

  async modelMap(profile?: string, config = this.#config): Promise<ModelMapOutcome> {
    const report = (outcome: ModelMapOutcome) => { this.#report("larva-model-map", outcome); return outcome; };
    const current = () => ({ profile: this.#profile.name, generation: this.#profile.generation });
    if (profile === undefined) return report({ status: "inspect", ...current() });
    return this.#exclusive(async () => {
      try {
        if (this.#routeUncertain) throw this.#routeUncertain;
        if (profile !== "default" && !isValidProfileName(profile)) {
          throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Invalid model-map profile name.");
        }
        const map = await this.#options.loadProfile(profile);
        if (!map && profile !== "default") throw new LarvaError("LARVA_MODEL_MAP_INVALID", "Named model-map profile does not exist.");
        const next = { name: profile, map, generation: this.#profile.generation + 1 };
        if (this.#persona) await this.#moveRoute(this.#routeFor(this.#persona, next), this.#readRoute());
        this.#profile = next;
        this.#config = config;
        if (this.#profileError) this.#startupWarning = undefined;
        this.#profileError = undefined;
      } catch (error) {
        return report({ status: this.#routeUncertain ? "route_uncertain" : "failed", ...current(), error: toErrorEnvelope(error).error });
      }
      return report({ status: "switched", ...current() });
    });
  }

  larva_persona_switch(input: unknown, ctx: PersonaSwitchContext): Promise<PersonaSwitchOutcome> {
    return larva_persona_switch(input, ctx, request => this.#switchPersona(request, ctx));
  }

  #assertCanSwitch(changing: boolean): void {
    if (this.#restoreFailed) throw this.#restoreFailed;
    if (this.#routeUncertain) throw this.#routeUncertain;
    this.#lease.assertAllowed(this.switchMode, changing);
  }

  async #switchPersona(input: PersonaSwitchToolInput, ctx: PersonaSwitchContext): Promise<PersonaSwitchOutcome> {
    const from = this.#persona?.id ?? null;
    const mode = this.switchMode;
    const audit = { source: "tool", mode, from_persona_id: from, to_persona_id: input.persona_id,
      reason: input.reason, continue_task: input.continue_task };
    let denial: "deny" | "timeout" | "dismissed" | "cancelled" | undefined;
    const controller = new AbortController();
    try {
      this.#assertCanSwitch(from !== input.persona_id);
      assertNotCancelled(ctx.signal);
      if (this.#request || this.#transition) throw new LarvaError("LARVA_SESSION_BUSY", "Another persona transition is pending.");
      if (from === input.persona_id) return { ok: true, persona_id: from, persistent: !this.#lease.origin };
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      this.#request = controller;
      const choice = mode === "confirm" ? await confirmSwitch(ctx, input, this.#config?.confirm_timeout_ms ?? 900_000, signal) : undefined;
      if (choice === "deny" || choice === "timeout" || choice === "dismissed" || choice === "cancelled") {
        denial = choice;
        throw new LarvaError("LARVA_BAD_INPUT", `Persona switch confirmation: ${choice}.`);
      }
      return await this.#exclusive(async () => {
        this.#assertCanSwitch(true);
        assertNotCancelled(signal);
        const persona = await this.#options.personas.get(input.persona_id);
        assertNotCancelled(signal);
        assertSoloCall(input, ctx);
        const persistent = mode === "free" || choice === "switch_persistently";
        const previous = this.#readRoute();
        const origin = persistent || this.#lease.origin ? null : {
          origin_persona_id: from, origin_model: previous.model, origin_thinking: previous.thinking,
          origin_profile_generation: this.#profile.generation,
        };
        const commit = () => {
          assertNotCancelled(signal);
          assertSoloCall(input, ctx);
          if (persistent) this.#persistPersona(persona, choice === "switch_persistently" ? "user" : "tool");
          else if (choice === "auto_borrow") this.#persistMode("auto", "auto-borrow");
        };
        await this.#moveRoute(this.#routeFor(persona), previous, { commit });
        this.#persona = persona;
        if (persistent) this.#preempt();
        this.#lease.recordSwitch(input, origin, from);
        this.#audit({ ...audit, status: "committed", persistent });
        this.#report("persona-switch", { persona_id: persona.id, persistent, switch_mode: this.switchMode });
        return { ok: true, persona_id: persona.id, persistent, ...(input.continue_task ? { terminate: true } : {}) };
      });
    } catch (error) {
      this.#audit({ ...audit, status: denial ?? "failed", error_code: toErrorEnvelope(error).error.code });
      throw error;
    } finally { if (this.#request === controller) this.#request = undefined; }
  }

  async #restoreLease(): Promise<TurnSettlement> {
    if (this.#routeUncertain) return { status: "route_uncertain", error: toErrorEnvelope(this.#routeUncertain).error };
    if (this.#restoreFailed) return { status: "restore_failed", error: toErrorEnvelope(this.#restoreFailed).error };
    const origin = this.#lease.origin;
    if (!origin) return { status: "settled" };
    const audit = { source: "runtime", event: "restore", from_persona_id: this.#persona?.id ?? null,
      to_persona_id: origin.origin_persona_id, reason: "Restore the turn-scoped borrow origin." };
    try {
      const persona = origin.origin_persona_id === null ? null : await this.#options.personas.get(origin.origin_persona_id);
      const rebased = persona && origin.origin_profile_generation !== this.#profile.generation;
      const target = rebased ? this.#routeFor(persona) : { model: origin.origin_model, thinking: origin.origin_thinking };
      await this.#moveRoute(target, this.#readRoute(), { restoreExact: !rebased });
      this.#persona = persona;
      this.#lease.clearLease();
      this.#audit({ ...audit, status: "restored" });
      this.#report("persona-restore", { persona_id: persona?.id ?? null });
      return { status: "settled" };
    } catch (cause) {
      this.#restoreFailed = new LarvaError("LARVA_RESTORE_FAILED", "Persona lease restoration failed; select a persona explicitly to recover.");
      const error = toErrorEnvelope(this.#restoreFailed).error;
      this.#audit({ ...audit, status: "restore_failed", error_code: error.code, cause_code: toErrorEnvelope(cause).error.code });
      this.#report("restore_failed", error);
      return { status: "restore_failed", error };
    }
  }

  /** Prompt context lasts one model turn, independently of the borrow lease. */
  endContinuationTurn(): void { this.#continuation = undefined; }

  /** Dispatch an immediate continuation, or restore the lease at agent settlement. */
  async settleTurn({ allowContinuation = true } = {}): Promise<TurnSettlement> {
    return this.#exclusive(() => {
      this.#request?.abort();
      const pending = this.#lease.takeContinuation();
      const continuation = allowContinuation && !this.#routeUncertain ? pending : null;
      this.#continuation = continuation ? {
        fromPersona: continuation.fromPersona, toPersona: continuation.persona_id, reason: continuation.reason,
      } : undefined;
      return continuation ? { status: "continue", continuation: { persona_id: continuation.persona_id, reason: continuation.reason } } : this.#restoreLease();
    });
  }

  /** Do not call for a Larva-generated continuation: its chain count and lease carry forward. */
  async beginUserTurn(): Promise<TurnSettlement> {
    return this.#exclusive(() => {
      this.#request?.abort();
      this.#lease.beginUserTurn();
      this.endContinuationTurn();
      return this.#restoreLease();
    });
  }
}
