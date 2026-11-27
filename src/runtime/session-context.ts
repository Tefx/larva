import { LarvaError, toErrorEnvelope, type ErrorInfo } from "../core/errors.ts";
import { isValidProfileName, resolveModelRoute } from "../core/model-map.ts";
import { isValidPersonaId } from "../core/persona.ts";
import type {
  LarvaConfig, ModelMapDoc, ModelMapEntry, PersonaSpec, PersonaSwitchToolInput, SwitchMode, ThinkingLevel,
} from "../core/types.ts";
import type { PersonaStore } from "../store/persona-store.ts";
import {
  assertSoloCall, confirmSwitch, larva_persona_switch, PERSONA_SWITCH_AUDIT, PersonaLeaseState,
  type Continuation, type PersonaSwitchContext, type PersonaSwitchOutcome,
} from "./persona-lease.ts";
import { composeSystemPrompt, type ResolveSystemPromptResult, type SwitchContinuation } from "./system-prompt.ts";

const PERSONA_COMMIT = "larva-active-persona-commit";
const MODE_OVERRIDE = "larva-agent-persona-switch-mode";

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
  | { status: "restore_failed"; error: ErrorInfo };

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
};

type SessionOptions = {
  personas: Pick<PersonaStore, "get" | "list">;
  /** Use core loadModelMap with the host's contained reader. Missing default is literal routing. */
  loadProfile: (name: string) => Promise<ModelMapDoc | undefined>;
  adapter: SessionAdapter;
  flags?: { persona?: string; mode?: string };
  env?: Pick<NodeJS.ProcessEnv, "LARVA_PI_LAUNCHED" | "LARVA_PI_INITIAL_PERSONA_ID">;
};

function isSwitchMode(value: unknown): value is SwitchMode {
  return value === "manual" || value === "confirm" || value === "auto" || value === "free";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function latestEntryIndex(branch: readonly unknown[], customType: string): number {
  return branch.findLastIndex(entry => isRecord(entry) && entry.type === "custom" && entry.customType === customType);
}

function entryData(entry: unknown): Record<string, unknown> | null {
  return isRecord(entry) && isRecord(entry.data) ? entry.data : null;
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
  readonly #options: SessionOptions;
  #adapter: SessionAdapter;
  readonly #child: boolean;
  readonly #lease = new PersonaLeaseState();
  #persona: PersonaSpec | null = null;
  #profile: ModelMapProfile = { name: "default", generation: 0 };
  #config?: LarvaConfig;
  #modeOverride?: SwitchMode;
  // The lease owns the pending dispatch; capture its source before changing personas.
  #switchFrom: string | null = null;
  #continuation?: SwitchContinuation;
  #restoreFailed?: LarvaError;
  #routeUncertain?: LarvaError;
  #request?: AbortController;
  #queue: Promise<unknown> = Promise.resolve();
  #transition = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#adapter = options.adapter;
    this.#child = options.env?.LARVA_PI_LAUNCHED === "1";
  }

  get activePersona(): PersonaSpec | null { return this.#persona && structuredClone(this.#persona); }
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
    this.#switchFrom = null;
    this.endContinuationTurn();
    this.#restoreFailed = undefined;
    this.#routeUncertain = undefined;
    this.#request?.abort();
  }

  #routeFor(persona: PersonaSpec, { map }: Pick<ModelMapProfile, "map"> = this.#profile): NativeRoute {
    return { model: resolveModelRoute(persona.model, map), thinking: persona.thinking };
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
    try {
      await this.#applyRoute(target, options?.restoreExact ? "restore" : "activate");
      options?.commit?.();
    } catch (error) {
      try { await this.#applyRoute(before, "rollback"); }
      catch {
        this.#routeUncertain = new LarvaError("LARVA_ROUTE_UNCERTAIN", "Could not verify Pi route rollback; reconcile with /model or /larva-persona.");
        this.#report("route_uncertain", toErrorEnvelope(this.#routeUncertain).error);
        throw this.#routeUncertain;
      }
      throw error;
    }
  }

  /** Start or restore using the selected Pi branch, not all entries in the session tree. */
  async initialize(config: LarvaConfig, branch: readonly unknown[] = [], source: "startup" | "tree" = "startup"): Promise<{ applyModel: boolean }> {
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
        : entryData(branch[latestEntryIndex(branch, MODE_OVERRIDE)])?.mode;
      const commitIndex = this.#child || explicit !== undefined ? -1 : latestEntryIndex(branch, PERSONA_COMMIT);
      const stored = commitIndex === -1 ? undefined : entryData(branch[commitIndex]);
      const id = explicit ?? (stored === undefined ? config.default_persona : stored?.persona_id);
      const profile = this.#config ? this.#profile : { ...this.#profile, map: await this.#options.loadProfile("default") };
      let persona: PersonaSpec | null = null;
      let applyModel = false;
      let warning: ErrorInfo | undefined;
      try {
        if ((stored !== undefined && stored?.schema_version !== 1) || (id !== null && !isValidPersonaId(id))) {
          throw new LarvaError("LARVA_BAD_INPUT", "Invalid startup persona selection.");
        }
        if (id !== null) persona = await this.#options.personas.get(id);
        const commit = () => {
          if (this.#child || explicit !== undefined) this.#persistPersona(persona, "startup");
        };
        // Native Pi restores its own startup route for larva:none, including CLI
        // overrides, but retains the previous route on tree navigation.
        const afterCommit = !this.#child && (persona ? commitIndex !== -1 : source === "tree")
          ? branch.slice(commitIndex + 1).filter(isRecord) : [];
        const model = afterCommit.findLast(entry => entry.type === "model_change");
        const thinking = afterCommit.findLast(entry => entry.type === "thinking_level_change");
        if (!this.#child && (persona || model || thinking)) {
          const before = this.#readRoute();
          // Without a persona, only recorded components constrain the native route.
          const target: RouteTarget = persona ? this.#routeFor(persona, profile) : {};
          if (model) target.model = typeof model.provider === "string" && typeof model.modelId === "string"
            ? { provider: model.provider, model_id: model.modelId } : before.model;
          if (thinking) target.thinking = isThinkingLevel(thinking.thinkingLevel) ? thinking.thinkingLevel : before.thinking;
          // A model switch can reset thinking to a Pi default. Carry it over
          // when possible, without requiring a level the new model may clamp.
          else if (!persona && model) target.preserveThinking = before.thinking;
          await this.#moveRoute(target, before, { commit, restoreExact: !persona || model !== undefined });
          applyModel = true;
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
      this.#lease.beginUserTurn();
      this.#switchFrom = null;
      this.#request?.abort();
      this.#restoreFailed = undefined;
      if (warning?.code !== "LARVA_ROUTE_UNCERTAIN") this.#routeUncertain = undefined;
      this.#config = config;
      this.#modeOverride = isSwitchMode(override) ? override : undefined;
      this.#profile = profile;
      this.#persona = persona;
      this.#report("startup", { persona_id: persona?.id ?? null, switch_mode: this.switchMode, warning });
      return { applyModel };
    });
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
    if (!isRecord(request) || typeof request.reply !== "function") return;
    const result: ResolveSystemPromptResult = request.scope !== "main" || typeof request.systemPrompt !== "string"
      ? { status: "unavailable", reason: "invalid request" }
      : this.#transition || !this.#config || this.#routeUncertain
        ? { status: "unavailable", reason: "not ready" }
        : { status: "ok", systemPrompt: this.composeSystemPrompt(request.systemPrompt) };
    try { request.reply(result); } catch { /* One reply attempt; peers cannot interrupt the session. */ }
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

  async selectPersona(id: string | null): Promise<void> {
    try {
      await this.#exclusive(async () => {
        const persona = id === null ? null : await this.#options.personas.get(id.trim());
        const commit = () => this.#persistPersona(persona, "user");
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

  async modelMap(profile?: string): Promise<ModelMapOutcome> {
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
        if (this.#persona) {
          await this.#moveRoute(this.#routeFor(this.#persona, { map }), this.#readRoute());
        }
        this.#profile = { name: profile, map, generation: this.#profile.generation + 1 };
      } catch (error) {
        return report({ status: this.#routeUncertain ? "route_uncertain" : "failed", ...current(), error: toErrorEnvelope(error).error });
      }
      return report({ status: "switched", ...current() });
    });
  }

  larva_persona_switch(input: unknown, ctx: PersonaSwitchContext): Promise<PersonaSwitchOutcome> {
    return larva_persona_switch(input, ctx, request => this.#switchPersona(request, ctx));
  }

  #assertCanSwitch(): void {
    if (this.#restoreFailed) throw this.#restoreFailed;
    if (this.#routeUncertain) throw this.#routeUncertain;
    this.#lease.assertAllowed(this.switchMode);
  }

  async #switchPersona(input: PersonaSwitchToolInput, ctx: PersonaSwitchContext): Promise<PersonaSwitchOutcome> {
    this.#assertCanSwitch();
    assertNotCancelled(ctx.signal);
    if (this.#request) throw new LarvaError("LARVA_SESSION_BUSY", "Another persona switch is pending.");
    const controller = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    this.#request = controller;
    try {
      const mode = this.switchMode;
      const choice = mode === "confirm" ? await confirmSwitch(ctx, input, this.#config?.confirm_timeout_ms ?? 900_000, signal) : undefined;
      return await this.#exclusive(async () => {
        this.#assertCanSwitch();
        assertNotCancelled(signal);
        const persona = await this.#options.personas.get(input.persona_id);
        assertNotCancelled(signal);
        assertSoloCall(input, ctx);
        const persistent = mode === "free" || choice === "switch_persistently";
        const previous = this.#readRoute();
        const from = this.#persona?.id ?? null;
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
        this.#lease.recordSwitch(input, origin);
        if (input.continue_task) this.#switchFrom = from;
        this.#audit({ mode, from_persona_id: from, to_persona_id: persona.id, persistent, continue_task: input.continue_task });
        this.#report("persona-switch", { persona_id: persona.id, persistent, switch_mode: this.switchMode });
        return { ok: true, persona_id: persona.id, persistent, ...(input.continue_task ? { terminate: true } : {}) };
      });
    } finally { this.#request = undefined; }
  }

  async #restoreLease(): Promise<TurnSettlement> {
    if (this.#restoreFailed) return { status: "restore_failed", error: toErrorEnvelope(this.#restoreFailed).error };
    const origin = this.#lease.origin;
    if (!origin) return { status: "settled" };
    try {
      const persona = origin.origin_persona_id === null ? null : await this.#options.personas.get(origin.origin_persona_id);
      const rebased = persona && origin.origin_profile_generation !== this.#profile.generation;
      const target = rebased ? this.#routeFor(persona) : { model: origin.origin_model, thinking: origin.origin_thinking };
      await this.#moveRoute(target, this.#readRoute(), { restoreExact: !rebased });
      this.#persona = persona;
      this.#lease.clearLease();
      this.#audit({ status: "restored", persona_id: persona?.id ?? null });
      this.#report("persona-restore", { persona_id: persona?.id ?? null });
      return { status: "settled" };
    } catch (cause) {
      this.#restoreFailed = new LarvaError("LARVA_RESTORE_FAILED", "Persona lease restoration failed; select a persona explicitly to recover.");
      const error = toErrorEnvelope(this.#restoreFailed).error;
      this.#audit({ status: "restore_failed", error_code: error.code, cause_code: toErrorEnvelope(cause).error.code, origin_persona_id: origin.origin_persona_id });
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
      const continuation = allowContinuation ? pending : null;
      this.#continuation = continuation ? {
        fromPersona: this.#switchFrom, toPersona: continuation.persona_id, reason: continuation.reason,
      } : undefined;
      this.#switchFrom = null;
      return continuation ? { status: "continue", continuation } : this.#restoreLease();
    });
  }

  /** Do not call for a Larva-generated continuation: its chain count and lease carry forward. */
  async beginUserTurn(): Promise<TurnSettlement> {
    return this.#exclusive(() => {
      this.#request?.abort();
      this.#lease.beginUserTurn();
      this.#switchFrom = null;
      this.endContinuationTurn();
      return this.#restoreLease();
    });
  }
}
