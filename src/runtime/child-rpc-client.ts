/// <reference lib="es2024.promise" />
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { LarvaError } from "../core/errors.ts";
import { BASE_PI_AGENT_DIR_ENV } from "../core/paths.ts";
import type { ResolvedModelRoute, ThinkingLevel } from "../core/types.ts";
import { metadataObject } from "../store/capsule.ts";

const MAX_RECORD = 1_048_576;
const GRACE_MS = 1500;
const protocol = (message: string) => new LarvaError("LARVA_CHILD_PROTOCOL_FAILED", message);
type Frame = Record<string, unknown>;
export type ChildLaunch = {
  piScript: string; extension: string; preload: string; extensionSources: readonly string[];
  env: NodeJS.ProcessEnv; home: string; basePiAgentDir: string; capsule: string; cwd: string; taskId: string;
  depth: number; ancestors: readonly string[]; persona: string; route: ResolvedModelRoute; thinking: ThinkingLevel;
};

/** Synchronous spawn: caller must already have published lease state 'spawning'. */
export function launchChild(options: ChildLaunch, progress: () => void): ChildRpcClient {
  const { piScript, extension, preload, extensionSources, env, home, basePiAgentDir, capsule, cwd, taskId, depth, ancestors, persona, route, thinking } = options;
  const child = spawn(process.execPath, [piScript, "--mode", "rpc", "--no-extensions", "-e", extension,
    ...extensionSources.flatMap(source => ["-e", source]), "--larva-persona", persona, "--larva-mode", "manual",
    "--model", `${route.provider}/${route.model_id}`, "--thinking", thinking, "--session-dir", dirname(taskId), "--session", taskId], {
    cwd, stdio: "pipe", env: { ...env, NODE_OPTIONS: [`--import=${pathToFileURL(preload).href}`, env.NODE_OPTIONS].filter(Boolean).join(" "),
      LARVA_HOME: home, LARVA_PI_LAUNCHED: "1", LARVA_PI_INITIAL_PERSONA_ID: persona, LARVA_PI_CAPSULE_ROOT: capsule,
      [BASE_PI_AGENT_DIR_ENV]: basePiAgentDir, PI_CODING_AGENT_DIR: capsule,
      LARVA_PI_SUBAGENT_DEPTH: String(depth), LARVA_PI_ANCESTOR_TASK_IDS: JSON.stringify(ancestors) },
  });
  return new ChildRpcClient(child, progress);
}

export class ChildRpcClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #terminal = Promise.withResolvers<void>();
  readonly #exit = Promise.withResolvers<void>();
  readonly #requests = new Map<string, { type: string; resolve(data: Frame): void; reject(error: Error): void }>();
  #error?: Error;
  #shutdown?: Promise<boolean>;
  #sequence = 0;
  #promptSent = false;
  get pid() { return this.#child.pid; }
  get settled() { return this.#terminal.promise; }

  constructor(child: ChildProcessWithoutNullStreams, progress: () => void) {
    this.#child = child;
    this.settled.catch(() => {}); // May fail during startup, before a collector attaches.
    child.stderr.resume(); // Never copy provider diagnostics/credentials into public errors.
    child.on("error", () => this.#fail(new LarvaError("LARVA_CHILD_START_FAILED", "Could not launch the Pi child.")));
    child.stdin.on("error", () => this.#fail(protocol("Child RPC input closed.")));
    child.once("exit", () => this.#exit.resolve());
    child.once("close", () => { this.#exit.resolve(); this.#fail(protocol("Child exited before RPC completed.")); });
    void this.#read(progress).catch(() => this.#fail(protocol("Malformed or oversized child RPC frame.")));
  }

  #fail(error: Error) {
    this.#error ??= error;
    this.#terminal.reject(this.#error);
    for (const request of this.#requests.values()) request.reject(this.#error);
    this.#requests.clear();
  }

  async #read(progress: () => void) {
    const buffer = Buffer.allocUnsafe(MAX_RECORD);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let used = 0;
    let stopReason: unknown;
    for await (const chunk of this.#child.stdout as AsyncIterable<Buffer>) {
      for (let start = 0; start < chunk.length;) {
        const lf = chunk.indexOf(10, start);
        const end = lf === -1 ? chunk.length : lf;
        if (end - start > MAX_RECORD - used) throw protocol("Oversized frame.");
        used += chunk.copy(buffer, used, start, end);
        if (lf === -1) break;
        start = lf + 1;
        const frame: unknown = JSON.parse(decoder.decode(buffer.subarray(0, used)));
        used = 0;
        if (!metadataObject(frame) || typeof frame.type !== "string" || frame.type === "larva_rpc_frame_error") throw protocol("Invalid frame.");
        if (frame.type === "response") {
          const request = typeof frame.id === "string" && this.#requests.get(frame.id);
          if (!request) continue;
          if (frame.command !== request.type || typeof frame.success !== "boolean") throw protocol("Invalid response.");
          if (frame.success && frame.data != null && !metadataObject(frame.data)) throw protocol("Invalid response data.");
          this.#requests.delete(frame.id as string);
          if (!frame.success) request.reject(protocol(`Child rejected ${request.type}.`));
          else request.resolve((frame.data ?? {}) as Frame);
        } else if (!this.#promptSent) continue; // Session-switch events cannot settle a new prompt.
        else if (frame.type === "agent_settled") {
          if (typeof frame.aborted !== "boolean") throw protocol("Malformed terminal frame.");
          if (frame.aborted || stopReason === "aborted") this.#terminal.reject(new LarvaError("LARVA_CHILD_CANCELLED", "Child aborted."));
          else if (stopReason === "error") this.#terminal.reject(protocol("Child assistant turn failed."));
          else this.#terminal.resolve();
        } else if (frame.type === "agent_start") stopReason = undefined;
        else if (frame.type === "message_end" && metadataObject(frame.message) && frame.message.role === "assistant") stopReason = frame.message.stopReason;
        else if (frame.type === "agent_end") {
          if (Array.isArray(frame.messages)) stopReason = frame.messages.findLast(m => metadataObject(m) && m.role === "assistant")?.stopReason ?? stopReason;
          progress();
        } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(frame.type)) progress();
        else if (frame.type === "message_update" && metadataObject(frame.assistantMessageEvent)) {
          const e = frame.assistantMessageEvent;
          if (e.type === "thinking_start" || e.type === "thinking_end" ||
              (["text_delta", "thinking_delta", "toolcall_delta"].includes(String(e.type)) && typeof e.delta === "string" && e.delta.trim())) progress();
        }
      }
    }
    this.#fail(protocol("Child RPC stream closed."));
  }

  async #command(type: string, fields: Frame = {}): Promise<Frame> {
    if (this.#error) throw this.#error;
    const id = String(++this.#sequence);
    const response = Promise.withResolvers<Frame>();
    const line = JSON.stringify({ type, id, ...fields });
    if (Buffer.byteLength(line) > MAX_RECORD) throw protocol("RPC command exceeds the record limit.");
    this.#requests.set(id, { type, ...response });
    const timer = setTimeout(() => response.reject(protocol(`Child ${type} timed out.`)), 30_000);
    try {
      this.#child.stdin.write(`${line}\n`);
      return await response.promise;
    } finally { clearTimeout(timer); this.#requests.delete(id); }
  }

  async resume(taskId: string) {
    const reply = await this.#command("switch_session", { sessionPath: taskId });
    if (reply.cancelled !== false) throw protocol("Child did not confirm session switch.");
  }

  async verify(route: ResolvedModelRoute, thinking: ThinkingLevel, taskId: string, persona: string) {
    const s = await this.#command("get_state");
    const cap = s.larvaChildRpcFrame;
    if (!metadataObject(cap) || cap.capability !== "larva-child-rpc-frame-preload-v1" || cap.framing !== "lf-only"
        || cap.max_record_bytes !== MAX_RECORD || cap.terminal !== "agent_settled") throw protocol("Missing child preload capability.");
    if (s.sessionFile !== taskId || s.persona_id !== persona) throw protocol("Child session or persona mismatch.");
    if (!metadataObject(s.model) || s.model.provider !== route.provider || s.model.id !== route.model_id || s.thinkingLevel !== thinking) {
      throw new LarvaError("LARVA_MODEL_UNAVAILABLE", "Child did not verify the required model and thinking level.");
    }
  }

  async setRoute(route: ResolvedModelRoute, thinking: ThinkingLevel) {
    await this.#command("set_model", { provider: route.provider, modelId: route.model_id });
    await this.#command("set_thinking_level", { level: thinking });
  }

  async prompt(message: string) {
    this.#promptSent = true;
    if ((await this.#command("prompt", { message })).disposition === "handled") throw protocol("Child handled prompt without starting a run.");
  }

  async output(): Promise<string> {
    const { text } = await this.#command("get_last_assistant_text");
    if (typeof text !== "string") throw protocol("Child did not return assistant text.");
    return text;
  }

  stop(abort: boolean): Promise<boolean> {
    if (abort) this.#fail(new LarvaError("LARVA_CHILD_CANCELLED", "Child is stopping."));
    return this.#shutdown ??= this.#stop(abort).catch(() => false);
  }

  async #stop(abort: boolean): Promise<boolean> {
    const child = this.#child;
    if (abort && child.stdin.writable) child.stdin.write('{"type":"abort"}\n');
    child.stdin.end();
    const exited = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([this.#exit.promise.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), GRACE_MS); })]); }
      finally { clearTimeout(timer); }
    };
    if (await exited()) return true;
    child.kill("SIGKILL");
    return exited();
  }
}
