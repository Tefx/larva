import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLarvaConfig, resolveWatchdogTimeouts } from "../core/config.ts";
import { LarvaError, toErrorEnvelope, type LarvaErrorCode } from "../core/errors.ts";
import { resolveModelRoute, isValidProfileName } from "../core/model-map.ts";
import { getLarvaHomePaths, isLexicallyContained, modelMapProfilePath, resolveBasePiAgentDir, resolveLarvaHome } from "../core/paths.ts";
import { isValidPersonaId } from "../core/persona.ts";
import { assertCanSpawnTarget, evaluateEffectiveCanSpawn } from "../core/spawn-policy.ts";
import type { LarvaConfig, McpSubagentToolInput, McpSubagentWaitOutput, ModelMapDoc, PersonaSpec, RunSnapshot, StartupFailureRecord,
  SubagentAcceptedReceipt, SubagentCancelOutput, SubagentCancelToolInput, SubagentStatusOutput, SubagentStatusToolInput, SubagentTerminalOutput,
  SubagentTerminalStatus, SubagentWaitToolInput, SubagentWaitOutput, OutputSnapshot } from "../core/types.ts";
import { writeOutputSnapshot } from "../store/artifacts.ts";
import * as capsule from "../store/capsule.ts";
import { entryExists, loadDiskModelMap, readBoundedRegularText } from "../store/model-map.ts";
import { PersonaStore } from "../store/persona-store.ts";
import { canonicalPath, readDiskSession, readSessionHeader, resolveCanonicalSessionPath, scanDiskSessions } from "../store/session-index.ts";
import { createSessionLeaseStore } from "../store/session-lease.ts";
import { launchChild, previewToolArgs, type ChildRpcClient } from "./child-rpc-client.ts";
import { isTerminal, mintRunEpoch, RunOutbox, terminalOutput } from "./outbox.ts";
import { discoverPiInstallation } from "./pi-binary.ts";
import { childSettlementBarrier, type FrameBridge } from "./settlement-barrier.ts";

type AdmissionContext = { selfTaskId?: string } & (
  | { surface: "pi"; cwd: string; activePersona: Pick<PersonaSpec, "can_spawn"> | null; sessionKey: string }
  // Supply the MCP roots/list request only when the client advertised roots support.
  | { surface: "mcp"; listRoots?: () => Promise<{ roots: readonly { uri: string }[] }> }
);
export type NativeBinding = {
  sessionKey: string;
  /** Launched Pi supplies its preload bridge and actual current session/persona. */
  childSession?: { bridge: FrameBridge; branch(): readonly unknown[]; activePersona(): string | null;
    isIdle(): boolean; triggerTurn(): void | Promise<void> };
  steer(message: { customType: "larva-subagent-alert" | "larva-subagent-result"; details: Record<string, unknown> }): void | Promise<void>;
};
type Options = {
  home?: string; env?: NodeJS.ProcessEnv; piAgentDir?: string; extension?: string; preload?: string;
  writeOutput?: typeof writeOutputSnapshot;
};
type Lease = Awaited<ReturnType<ReturnType<typeof createSessionLeaseStore>["acquire"]>>;
type Run = {
  s: RunSnapshot; parent?: string; rpc?: ChildRpcClient; abort?: LarvaError; prompted: boolean;
  activeTools: Map<string, NonNullable<RunSnapshot["active_tool"]>>;
  accepted: PromiseWithResolvers<SubagentAcceptedReceipt>; cleaned: PromiseWithResolvers<boolean>;
  stall?: NodeJS.Timeout; watchdog?: NodeJS.Timeout;
  reconcile?: () => Promise<boolean>;
};
type FleetOutcome = "fenced_for_startup" | "in_flight_until_run_settles" | "ended_during_switch" | "failed";
const bad = (message: string): never => { throw new LarvaError("LARVA_BAD_INPUT", message); };
const cancelled = (message: string) => new LarvaError("LARVA_CHILD_CANCELLED", message);
const now = () => new Date().toISOString();
function keys(value: unknown, names: string[]) {
  if (!capsule.metadataObject(value) || Object.keys(value).some(k => !names.includes(k))) bad("Invalid or unknown input fields.");
}
async function directory(path: string, code: LarvaErrorCode) {
  try { if (isAbsolute(path) && (await stat(path)).isDirectory()) return await realpath(path); } catch { /* fail below */ }
  throw new LarvaError(code, "Workspace must be an existing absolute directory.");
}
async function workspace(home: string, input: McpSubagentToolInput, ctx: AdmissionContext) {
  if (input.task_id !== undefined) {
    const h = await readSessionHeader(home, input.task_id);
    const cwd = await directory(h.cwd, "LARVA_CHILD_START_FAILED");
    if (input.cwd !== undefined && await directory(input.cwd, "LARVA_BAD_INPUT") !== cwd) bad("Workspace differs from the recorded session.");
    return { cwd, taskId: h.task_id };
  }
  if (input.cwd !== undefined) return { cwd: await directory(input.cwd, "LARVA_BAD_INPUT") };
  if (ctx.surface === "pi") return { cwd: await directory(ctx.cwd, "LARVA_CWD_REQUIRED") };
  try {
    const roots = (await ctx.listRoots?.())?.roots;
    if (Array.isArray(roots) && roots.length === 1 && typeof roots[0]?.uri === "string" && /^file:\/\//i.test(roots[0].uri)) {
      const u = new URL(roots[0].uri);
      if (u.protocol === "file:" && !u.host && !u.search && !u.hash) return { cwd: await directory(fileURLToPath(u), "LARVA_CWD_REQUIRED") };
    }
  } catch { /* Unavailable, invalid or unusable roots do not imply server cwd. */ }
  throw new LarvaError("LARVA_CWD_REQUIRED", "Provide cwd when there is not exactly one usable local workspace root.");
}
async function lineage(env: NodeJS.ProcessEnv, root: string, self?: string) {
  const invalid = (): never => { throw new LarvaError("LARVA_CHILD_START_FAILED", "Invalid or over-limit subagent lineage."); };
  const rawDepth = env.LARVA_PI_SUBAGENT_DEPTH ?? (env.LARVA_PI_LAUNCHED === "1" ? "1" : "0");
  if (!/^(0|[1-9][0-9]?)$/.test(rawDepth) || (env.LARVA_PI_LAUNCHED === "1" && rawDepth === "0")) return invalid();
  const depth = Number(rawDepth);
  const raw = env.LARVA_PI_ANCESTOR_TASK_IDS ?? "[]";
  if (Buffer.byteLength(raw) > 65536) return invalid();
  let ids: unknown;
  try { ids = JSON.parse(raw); } catch { return invalid(); }
  if (!Array.isArray(ids) || ids.length > 100) return invalid();
  const ancestors = new Set<string>();
  for (const id of [...ids, ...(self !== undefined && (depth > 0 || isLexicallyContained(root, self)) ? [self] : [])]) {
    if (typeof id !== "string" || !isLexicallyContained(root, id) || resolve(id) !== id || !id.endsWith(".jsonl")) return invalid();
    try {
      if (join(await realpath(dirname(id)), basename(id)) !== id || (await entryExists(id) && (!(await lstat(id)).isFile() || await realpath(id) !== id))) return invalid();
    } catch { return invalid(); }
    ancestors.add(id);
  }
  if (ancestors.size > 100 || Buffer.byteLength(JSON.stringify([...ancestors])) > 65536) return invalid();
  return { depth, ancestors: [...ancestors] };
}
function clearTimers(run: Run) { clearTimeout(run.stall); clearTimeout(run.watchdog); }
function clearLive(run: Run) {
  run.activeTools.clear();
  run.s.active_tool = null;
  run.s.live_thinking = false;
}

function applyTelemetry(run: Run, frame: Record<string, unknown>): boolean {
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
      if (!capsule.metadataObject(e)) return false;
      if (e.type === "text_delta" && typeof e.delta === "string") {
        s.live_thinking = false;
        // At most two UTF-16 code units per code point. Limit the slice before spreading it.
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
      const tool: NonNullable<RunSnapshot["active_tool"]> = { tool_call_id: toolCallId, name: toolName,
        status: frame.type === "tool_execution_end" ? (frame.isError === true ? "error" : "done") : "running" };
      const snapshots = [...(s.tool_snapshots ?? [])];
      const index = snapshots.findIndex(t => t.tool_call_id === toolCallId);
      if (index !== -1 || frame.type === "tool_execution_start") {
        const args_preview = frame.args === undefined ? snapshots[index]?.args_preview : previewToolArgs(frame.args);
        const row = { ...tool, ...(args_preview === undefined ? {} : { args_preview }) };
        if (index !== -1) snapshots[index] = row;
        else snapshots.push(row);
        s.tool_snapshots = snapshots.slice(-25);
      }
      // The display window can evict a tool that is still running.
      activeTools.delete(toolCallId);
      if (frame.type === "tool_execution_end") {
        if (s.active_tool?.tool_call_id === toolCallId) s.active_tool = [...activeTools.values()].at(-1) ?? null;
      } else {
        activeTools.set(toolCallId, tool);
        s.active_tool = tool;
      }
      return true;
    }
    default: return false;
  }
}

export class SubagentSupervisor {
  readonly home: string;
  readonly barrier = childSettlementBarrier();
  readonly #opts: Options;
  readonly #env: NodeJS.ProcessEnv;
  readonly #baseCwd = process.cwd();
  readonly #personas: PersonaStore;
  readonly #leases: ReturnType<typeof createSessionLeaseStore>;
  readonly #active = new Map<string, Run>(); // Includes startup and unconfirmed ownership.
  readonly #outbox = new RunOutbox();
  readonly #failures: StartupFailureRecord[] = [];
  readonly #observers = new Set<() => void>();
  readonly #callbacks = new Map<RunSnapshot, string>();
  #binding?: NativeBinding;
  #reloading = false;
  #closing = false;
  #profile: string;
  #generation = 0;
  #telemetryTimer?: NodeJS.Timeout;

  constructor(options: Options = {}) {
    this.#opts = options;
    this.#env = options.env ?? process.env;
    this.home = options.home ?? resolveLarvaHome(this.#env);
    this.#leases = createSessionLeaseStore(this.home, capsule);
    this.#personas = new PersonaStore(this.home);
    this.#profile = this.#env.LARVA_PI_MODEL_MAP_PROFILE ?? "default";
  }

  beginReload() { this.#reloading = true; this.#binding = undefined; this.barrier.unbind(); }
  rebind(binding: NativeBinding) {
    this.#binding = binding; this.#reloading = false;
    const session = binding.childSession;
    if (session) this.barrier.bind(session.bridge, () => session.branch(), () => session.activePersona(), session);
    this.#deliver();
  }
  /** Observe lifecycle and batched live updates without resetting child deadlines. */
  subscribe(onChange: () => void) {
    this.#observers.add(onChange);
    return () => this.#observers.delete(onChange);
  }
  #notify() {
    clearTimeout(this.#telemetryTimer);
    this.#telemetryTimer = undefined;
    for (const f of [...this.#observers]) { try { f(); } catch { /* observers do not own the transition */ } }
  }
  #deliver() {
    for (const [s, key] of this.#callbacks) {
      if (this.#reloading) return;
      this.#callbacks.delete(s); // Commit to this binding before invoking external code.
      if (s.output_state === "evicted" || !this.#binding || this.#binding.sessionKey !== key) { this.barrier.delivery(s.run_epoch, "stale"); continue; }
      const binding = this.#binding;
      try {
        void Promise.resolve(binding.steer({ customType: "larva-subagent-result", details: { ...terminalOutput(s), callback_id: s.run_epoch } }))
          .then(() => this.barrier.delivery(s.run_epoch, "delivered"), () => this.barrier.delivery(s.run_epoch, "failed"));
      } catch { this.barrier.delivery(s.run_epoch, "failed"); }
    }
  }
  #taskSyntax(id: unknown) {
    if (typeof id !== "string" || !isAbsolute(id) || resolve(id) !== id || id.includes("\0") || !id.endsWith(".jsonl")) bad("Expected a canonical .jsonl task_id.");
  }
  #ids(ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 25 || new Set(ids).size !== ids.length) bad("Expected 1..25 distinct task_ids.");
    for (const id of ids) this.#taskSyntax(id);
  }
  async #map(profile: string): Promise<ModelMapDoc | undefined> {
    return loadDiskModelMap(this.home, modelMapProfilePath(this.home, profile));
  }

  async spawn(input: McpSubagentToolInput, ctx: AdmissionContext): Promise<SubagentAcceptedReceipt | SubagentTerminalOutput> {
    // Capture callback scope at ingress; /reload may replace the surface while admitting.
    const epoch = mintRunEpoch(), parentSession = ctx.surface === "pi" ? ctx.sessionKey : undefined;
    if (ctx.surface === "pi" && this.#env.LARVA_PI_LAUNCHED === "1") this.barrier.register("larva-subagent-result", epoch);
    try {
      keys(input, ["persona_id", "task", "task_id", "cwd", "no_progress_timeout_ms", "stall_alert_ms",
        ...(ctx.surface === "mcp" ? ["parent_persona_id", "wait_for_completion"] : [])]);
      if (!isValidPersonaId(input.persona_id) || typeof input.task !== "string" || !input.task.trim()
          || (input.cwd !== undefined && (typeof input.cwd !== "string" || !isAbsolute(input.cwd) || input.cwd.includes("\0")))
          || (input.parent_persona_id !== undefined && !isValidPersonaId(input.parent_persona_id))
          || (input.wait_for_completion !== undefined && typeof input.wait_for_completion !== "boolean")) bad("Invalid spawn input.");
      resolveWatchdogTimeouts(input, { stall_alert_ms: 0 });
      if (input.task_id !== undefined) this.#taskSyntax(input.task_id);
      const { cwd, taskId } = await workspace(this.home, input, ctx);
      const home = await canonicalPath(this.home);
      const root = getLarvaHomePaths(home).sessions;
      const chain = await lineage(this.#env, root, ctx.selfTaskId ?? this.#env.LARVA_PI_TASK_ID);
      const config = await loadLarvaConfig(this.home, async p => await entryExists(p) ? readBoundedRegularText(p) : undefined);
      if (config.subagent.max_depth !== undefined && chain.depth + 1 > config.subagent.max_depth) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Configured maximum depth exceeded.");
      const descendant = this.#env.LARVA_PI_LAUNCHED === "1" || chain.depth > 0;
      if (ctx.surface === "pi" && !descendant && !ctx.activePersona) throw new LarvaError("LARVA_NO_ACTIVE_PERSONA", "No active persona.");
      const parent = descendant ? this.#env.LARVA_PI_INITIAL_PERSONA_ID : ctx.surface === "mcp" ? input.parent_persona_id ?? this.#env.LARVA_MCP_PARENT_PERSONA?.trim() : undefined;
      const parentSpec = parent ? await this.#personas.get(parent).catch(e => { if (descendant) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Launch-bound persona unavailable."); throw e; }) : undefined;
      const authority = { env: this.#env, parent_persona_id: input.parent_persona_id, resolvePersona: (id: string) => id === parent ? parentSpec : undefined };
      assertCanSpawnTarget(evaluateEffectiveCanSpawn(ctx.surface === "pi" ? { ...authority, surface: "pi", isLaunchedChild: descendant,
        activePersona: ctx.activePersona, rootSessionSpawn: config.subagent.root_session_spawn } : { ...authority, surface: "mcp", depth: chain.depth }), input.persona_id);
      const spec = await this.#personas.get(input.persona_id);
      const id = taskId ?? join(root, `${randomUUID()}.jsonl`);
      if (chain.ancestors.includes(id) || this.#active.has(id)) throw new LarvaError("LARVA_SESSION_BUSY", "Session is already owned.");
      if (this.#closing || this.#active.size >= (config.subagent.max_active_runs ?? Infinity)) throw new LarvaError("LARVA_CHILD_START_FAILED", "Supervisor cannot admit another child.");
      const started_at = now();
      const run: Run = { s: { task_id: id, run_epoch: epoch, cwd, started_at, updated_at: started_at, persona_id: spec.id,
        phase: "starting", status: "running", output_state: "pending", thinking: spec.thinking,
        task_preview: Array.from(input.task.replace(/\s+/g, " ").trim().slice(0, 280)).slice(0, 140).join(""),
        active_tool: null, live_thinking: false, live_assistant_preview: "", tool_snapshots: [] },
        activeTools: new Map(), accepted: Promise.withResolvers(), cleaned: Promise.withResolvers(),
        prompted: false, parent: parentSession };
      this.#active.set(id, run); // No await between capacity check and reservation.
      void this.#drive(run, spec, input, chain, config, home);
      this.#notify();
      const accepted = await run.accepted.promise;
      if (!input.wait_for_completion) return accepted;
      await this.#observe(() => isTerminal(run.s.status) && run.s.output_state !== "pending");
      return terminalOutput(run.s);
    } catch (e) {
      this.barrier.delivery(epoch, "suppressed");
      const failure = e instanceof LarvaError ? e : new LarvaError("LARVA_CHILD_START_FAILED", "Could not start the Pi child.");
      this.#failures.unshift({ startup_id: epoch, persona_id: typeof input?.persona_id === "string" ? input.persona_id : "", status: "failed",
        phase: "startup_failed", updated_at: now(), error: toErrorEnvelope(failure).error });
      this.#failures.length = Math.min(25, this.#failures.length);
      throw failure;
    }
  }

  async #drive(run: Run, spec: PersonaSpec, input: McpSubagentToolInput, chain: Awaited<ReturnType<typeof lineage>>, config: LarvaConfig, home: string) {
    const s = run.s, id = s.task_id;
    let lease: Lease | undefined, box: Awaited<ReturnType<typeof capsule.createCapsule>> | undefined, manifest: string | undefined;
    let accepted = false, failure: unknown;
    const check = () => { if (run.abort) throw run.abort; };
    const times = resolveWatchdogTimeouts(input, config.subagent);
    const telemetry = (frame: Record<string, unknown>) => {
      if (s.status !== "running" || !applyTelemetry(run, frame)) return;
      this.#telemetryTimer ??= setTimeout(() => this.#notify(), 50);
    };
    const progress = () => {
      if (!accepted || s.status !== "running") return;
      const phaseChanged = s.phase !== "waiting_for_child";
      clearTimers(run); s.phase = "waiting_for_child"; s.updated_at = now();
      if (times.stall_alert_ms) run.stall = setTimeout(() => {
        s.phase = "stall_suspected"; s.updated_at = now();
        if (run.parent !== undefined && this.#binding?.sessionKey === run.parent && !this.#reloading) {
          try { void Promise.resolve(this.#binding.steer({ customType: "larva-subagent-alert", details: structuredClone(s) })).catch(() => {}); } catch { /* observer only */ }
        }
        this.#notify();
      }, times.stall_alert_ms);
      run.watchdog = setTimeout(() => this.#abort(run, "Child exceeded its no-progress timeout."), times.no_progress_timeout_ms);
      if (phaseChanged) this.#notify();
    };
    try {
      lease = await this.#leases.acquire(id);
      if (input.task_id !== undefined) {
        const h = await readSessionHeader(this.home, id);
        if (await directory(h.cwd, "LARVA_CHILD_START_FAILED") !== s.cwd) throw new LarvaError("LARVA_SESSION_INVALID", "Session changed during admission.");
      }
      check();
      const installation = await discoverPiInstallation(this.#env);
      let generation = this.#generation;
      let route = resolveModelRoute(spec.model, await this.#map(this.#profile));
      s.model = `${route.provider}/${route.model_id}`;
      this.#notify();
      const basePiAgentDir = this.#opts.piAgentDir === undefined
        ? resolveBasePiAgentDir(this.#env, undefined, this.#baseCwd)
        : resolve(this.#baseCwd, this.#opts.piAgentDir);
      box = await capsule.createCapsule({ home, pi_agent_dir: basePiAgentDir,
        user_home: this.#env.HOME, extension_sources: config.subagent.extension_sources });
      const parent = this.#env.LARVA_PI_CAPSULE_ROOT;
      if (parent !== undefined) {
        if (!capsule.capsuleParentPid(home, parent)) throw new LarvaError("LARVA_CHILD_START_FAILED", "Invalid parent capsule.");
        manifest = join(parent, "descendants", `${basename(box.root)}.json`);
        await capsule.writeMetadata(manifest, { capsule_root: box.root }); // intent before fork
      }
      await lease.markSpawning(box.root);
      check();
      const rpc = run.rpc = launchChild({ piScript: installation.path,
        extension: this.#opts.extension ?? fileURLToPath(new URL("./pi-extension.js", import.meta.url)),
        preload: this.#opts.preload ?? fileURLToPath(new URL("./child-rpc-preload.mjs", import.meta.url)), extensionSources: box.extension_sources,
        env: { ...this.#env, LARVA_PI_TASK_ID: id, LARVA_PI_MODEL_MAP_PROFILE: this.#profile }, home, basePiAgentDir,
        capsule: box.root, agentDir: box.agent_dir, cwd: s.cwd,
        taskId: id, depth: chain.depth + 1, ancestors: chain.ancestors, persona: spec.id, route, thinking: spec.thinking }, progress, telemetry);
      if (rpc.pid === undefined) throw new LarvaError("LARVA_CHILD_START_FAILED", "Child did not start.");
      await lease.markRunning(rpc.pid);
      if (manifest) await capsule.writeMetadata(manifest, { capsule_root: box.root, pid: rpc.pid });
      check();
      if (input.task_id !== undefined) await rpc.resume(id);
      for (;;) {
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
      run.prompted = true; // Fence linearization point: prompt write precedes the next await.
      await rpc.prompt(input.task); check();
      accepted = true; s.status = "running"; progress();
      run.accepted.resolve({ status: "accepted", task_id: id, run_epoch: s.run_epoch, cwd: s.cwd });
      await rpc.settled; check();
      this.#finalize(run, "success");
      // Fetch text while RPC is alive, but artifact I/O is independent of process ownership.
      void this.#publish(run, await rpc.output());
    } catch (e) {
      failure = run.abort ?? e;
      if (accepted && !isTerminal(s.status)) {
        this.#finalize(run, failure instanceof LarvaError && failure.code === "LARVA_CHILD_CANCELLED" ? "cancelled" : "failed", failure);
        void this.#publish(run, "");
      } else if (accepted) void this.#publish(run, undefined);
    } finally {
      clearTimers(run);
      const settleOwnership = async () => {
        try {
          if (run.rpc && !await run.rpc.stop(!!failure) && !(run.rpc.pid && capsule.pidExited(run.rpc.pid))) throw new Error("Unconfirmed child exit.");
          if (box) {
            if (!(await capsule.inspectCapsule(home, box.root, run.rpc?.pid, "live"))?.all_exited) throw new Error("Unconfirmed capsule exit.");
            // Detach capsule + lease in ONE commit (release renames the complete directory).
            // Roll back a pre-commit failure rather than unlinking ownership evidence piecemeal.
            const staged = join(getLarvaHomePaths(home).sessions, `${basename(id)}.lock`, "capsule");
            await rename(box.root, staged);
            try { await lease!.release(); } catch (e) { await rename(staged, box.root); throw e; }
          } else await lease?.release();
          if (manifest) await rm(manifest, { force: true }).catch(() => {}); // dead PID + absent capsule also proves retirement
          this.#active.delete(id);
          return true;
        } catch { await lease?.markUnreconciled().catch(() => {}); return false; }
      };
      const confirmed = await settleOwnership();
      if (!confirmed) {
        // Explicit later cancel/shutdown can recheck the retained evidence. Serialize
        // reconcilers so no two attempts move the same directory or release a successor.
        let checking: Promise<boolean> | undefined;
        run.reconcile = () => checking ??= settleOwnership().finally(() => { checking = undefined; });
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

  #finalize(run: Run, status: SubagentTerminalStatus, error?: unknown) {
    clearTimers(run);
    clearLive(run);
    Object.assign(run.s, { status, phase: status, updated_at: now() }, error ? { error: toErrorEnvelope(error).error } : {});
    this.#outbox.retain(run.s); this.#notify();
  }
  async #publish(run: Run, text: string | undefined) {
    let output: OutputSnapshot;
    try {
      if (text === undefined) throw new Error();
      output = await (this.#opts.writeOutput ?? writeOutputSnapshot)(this.home, text);
    } catch { output = { output_state: "delivery_failed", output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Could not deliver child output." } }; }
    this.#outbox.publish(run.s, output); this.#notify();
    if (run.parent !== undefined) {
      await run.cleaned.promise;
      if (this.#closing || run.s.output_state === "evicted") { this.barrier.delivery(run.s.run_epoch, "stale"); return; }
      for (const s of this.#callbacks.keys()) if (s.output_state === "evicted") {
        this.#callbacks.delete(s); this.barrier.delivery(s.run_epoch, "stale");
      }
      this.#callbacks.set(run.s, run.parent); this.#deliver();
    }
  }
  #abort(run: Run, reason: string) {
    if (run.abort || isTerminal(run.s.status)) return;
    clearTimers(run); run.abort = cancelled(reason); run.s.status = run.s.phase = "cancelling"; run.s.updated_at = now();
    void run.rpc?.stop(true); this.#notify();
  }
  #lookup(id: string) { return this.#active.get(id)?.s ?? this.#outbox.lookup(id); }
  async #admitExactHandle(id: string): Promise<boolean> {
    this.#taskSyntax(id);
    try {
      await resolveCanonicalSessionPath(this.home, id);
      return true;
    } catch (error) {
      if (error instanceof LarvaError && error.code === "LARVA_SESSION_NOT_FOUND") return false;
      throw error;
    }
  }
  async pinned(taskId: string, epoch: string): Promise<RunSnapshot | { task_id: string; run_epoch: string; output_state: "evicted" }> {
    await this.#admitExactHandle(taskId);
    const s = this.#active.get(taskId)?.s;
    return structuredClone((s?.run_epoch === epoch ? s : this.#outbox.lookup(taskId, epoch)) ?? { task_id: taskId, run_epoch: epoch, output_state: "evicted" });
  }
  async #observe(done: () => boolean, deadline?: number) {
    if (done() || (deadline !== undefined && deadline <= performance.now())) return;
    let timer: NodeJS.Timeout | undefined;
    const result = Promise.withResolvers<void>();
    const notify = () => { if (done()) result.resolve(); };
    const unsubscribe = this.subscribe(notify);
    if (deadline !== undefined) timer = setTimeout(result.resolve, Math.max(0, deadline - performance.now()));
    try { await result.promise; } finally { clearTimeout(timer); unsubscribe(); }
  }
  wait(input: SubagentWaitToolInput, surface?: "mcp"): Promise<McpSubagentWaitOutput>;
  wait(input: SubagentWaitToolInput, surface: "pi"): Promise<SubagentWaitOutput>;
  async wait(input: SubagentWaitToolInput, surface: "mcp" | "pi" = "mcp") {
    const start = performance.now();
    keys(input, ["task_ids", "return_when", "timeout_ms"]); this.#ids(input.task_ids);
    const { return_when: mode = "all", timeout_ms: timeout = 10000 } = input;
    if (!["all", "any", "first_error"].includes(mode) || !Number.isInteger(timeout) || timeout < 0 || timeout > 86400000) bad("Invalid wait condition or timeout.");
    const bound = input.task_ids.map(id => this.#lookup(id) ?? bad("No observed run for requested task_id."));
    const ready = () => mode === "all" ? bound.every(s => isTerminal(s.status)) : bound.some(s => mode === "any" ? isTerminal(s.status) : s.status === "failed" || s.status === "cancelled");
    await this.#observe(() => ready() && (surface === "pi" || bound.every(s => !isTerminal(s.status) || s.output_state !== "pending")), start + timeout);
    const runs = structuredClone(bound);
    const result = { runs, ready: ready(), timed_out: !ready() };
    return surface === "pi" ? result : { ...result, terminal_outputs: Object.fromEntries(runs.filter(s => isTerminal(s.status)).map(s => [s.task_id, terminalOutput(s)])) } satisfies McpSubagentWaitOutput;
  }
  async cancel(input: SubagentCancelToolInput): Promise<SubagentCancelOutput> {
    keys(input, ["task_ids", "reason", "expected_run_epochs"]); this.#ids(input.task_ids);
    if (typeof input.reason !== "string" || !input.reason.trim() || [...input.reason].length > 500) bad("Invalid cancel reason.");
    const guards = new Map<string, string>();
    const expected: unknown = input.expected_run_epochs;
    if (expected !== undefined) {
      if (!Array.isArray(expected) || expected.length > 25) return bad("Invalid expected_run_epochs.");
      for (const guard of expected) {
        if (!capsule.metadataObject(guard) || Object.keys(guard).length !== 2
            || !Object.hasOwn(guard, "task_id") || !Object.hasOwn(guard, "run_epoch")) return bad("Invalid expected_run_epochs.");
        const { task_id, run_epoch } = guard;
        if (typeof task_id !== "string" || !input.task_ids.includes(task_id) || guards.has(task_id)
            || typeof run_epoch !== "string" || !run_epoch) return bad("Invalid expected_run_epochs.");
        guards.set(task_id, run_epoch);
      }
    }
    const results = await Promise.all(input.task_ids.map(async task_id => {
      const run = this.#active.get(task_id), s = this.#lookup(task_id);
      if (!s) return { task_id, outcome: "not_found" as const };
      const epoch = guards.get(task_id);
      if (!run || (epoch !== undefined && epoch !== s.run_epoch)) return { task_id, outcome: "already_terminal" as const };
      const terminal = isTerminal(s.status);
      this.#abort(run, input.reason.trim());
      return { task_id, outcome: !await (run.reconcile?.() ?? run.cleaned.promise) ? "cleanup_unconfirmed" as const : terminal ? "already_terminal" as const : "cancelled" as const };
    }));
    return { results, isError: results.some(r => r.outcome === "cleanup_unconfirmed") };
  }
  async status(input: SubagentStatusToolInput = {}): Promise<SubagentStatusOutput> {
    keys(input, ["task_id", "scope", "limit"]);
    if (input.task_id !== undefined) {
      if (input.scope !== undefined || input.limit !== undefined) bad("Exact status does not take scope or limit.");
      const exists = await this.#admitExactHandle(input.task_id);
      const s = this.#lookup(input.task_id);
      if (s) return { runs: [structuredClone(s)], startup_failures: [] };
      if (!exists) throw new LarvaError("LARVA_SESSION_NOT_FOUND", "Session transcript is missing.");
      return { runs: [], startup_failures: [], disk_sessions: [await readDiskSession(this.home, input.task_id, this.#leases)] };
    }
    const { scope = "recent", limit = 10 } = input;
    if (!["recent", "active", "disk"].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 25) bad("Invalid status scope or limit.");
    if (scope === "disk") return { runs: [], startup_failures: [], disk_sessions: (await scanDiskSessions(this.home, this.#leases)).slice(0, limit) };
    const active = [...this.#active.values()].map(r => r.s);
    const runs = scope === "active" ? active : [...new Set([...active, ...this.#outbox.recent()])];
    return structuredClone({ runs: runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit), startup_failures: this.#failures.slice(0, limit) });
  }

  /** Capture the fleet BEFORE the parent's asynchronous route transaction, then commit only on parent success. */
  captureFleet() { return [...this.#active.values()].map(({ s }) => ({ task_id: s.task_id, run_epoch: s.run_epoch })); }
  async commitProfile(profile: string, fleet = this.captureFleet()) {
    if (profile !== "default" && !isValidProfileName(profile)) bad("Invalid profile name.");
    this.#profile = profile; ++this.#generation;
    return Promise.all(fleet.map(async ({ task_id, run_epoch }) => {
      const run = this.#active.get(task_id);
      let state: FleetOutcome;
      if (!run || run.s.run_epoch !== run_epoch || isTerminal(run.s.status)) state = "ended_during_switch";
      else {
        const fenced = !run.prompted;
        try { await run.accepted.promise; state = isTerminal(run.s.status) ? "ended_during_switch" : fenced ? "fenced_for_startup" : "in_flight_until_run_settles"; }
        catch { state = "failed"; }
      }
      return { task_id, run_epoch, state };
    }));
  }
  /** EOF/signals are handled by the transport. Never terminate the host from a tool call. */
  async shutdown(): Promise<{ settled: boolean }> {
    this.#closing = true;
    const owned = [...this.#active.values()];
    for (const run of owned) this.#abort(run, "Supervisor shutdown.");
    const settled = (await Promise.all(owned.map(r => r.reconcile?.() ?? r.cleaned.promise))).every(Boolean);
    const host = process as NodeJS.Process & { [shared]?: SubagentSupervisor };
    if (settled && host[shared] === this) delete host[shared];
    return { settled };
  }
}

const shared = Symbol.for("larva.0.9.native-subagent-supervisor");
export function getNativeSupervisor(options: Options, binding: NativeBinding): SubagentSupervisor {
  const processState = process as NodeJS.Process & { [shared]?: SubagentSupervisor };
  const supervisor = processState[shared] ??= new SubagentSupervisor(options);
  if (supervisor.home !== (options.home ?? resolveLarvaHome(options.env))) throw new LarvaError("LARVA_CONFIG_INVALID", "Cannot rebind supervisor to a different Larva home.");
  supervisor.rebind(binding);
  return supervisor;
}
