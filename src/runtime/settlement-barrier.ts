import { isRecord } from "../core/predicates.ts";

export type CallbackKind = "larva-subagent-result" | "larva-subagent-alert";
export type CallbackDelivery = "pending" | "delivered" | "failed" | "suppressed" | "stale";
type Frame = Record<string, unknown>;
export type FrameBridge = {
  configure(transform: (frame: Frame) => readonly Frame[]): void;
  emit(frames: readonly Frame[]): void;
};

/** Child-side adapter. Supply Pi's current branch, not the whole (possibly forked) transcript. */
export function childSettlementBarrier() {
  const pending = new Map<string, "reserved" | "queued" | "redriven">();
  let continuation: { isIdle(): boolean; triggerTurn(): void | Promise<void> } | undefined;
  let scheduled = false;
  let parked: Frame | undefined;
  let bridge: FrameBridge | undefined;
  let branch: () => readonly unknown[] = () => [];
  let lastHeartbeat = -Infinity;

  function release() {
    if (parked === undefined || pending.size) return;
    const frame = parked;
    parked = undefined;
    bridge?.emit([frame]);
  }

  // A late steer can land after Pi's last queue drain. Wake the idle agent once,
  // without resending the callback. A successful wake is not proof of consumption.
  function wake() {
    if (scheduled || !continuation || parked === undefined) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (parked === undefined || !continuation?.isIdle()) return;
      const queued = [...pending].filter(([, state]) => state === "queued");
      if (!queued.length) return;
      for (const [id] of queued) pending.set(id, "redriven");
      // Failure of a wake is not evidence that delivery of the original steer failed.
      try { void Promise.resolve(continuation.triggerTurn()).catch(() => {}); } catch { /* retain obligations */ }
    });
  }

  return {
    /** Reserve before asynchronous child admission, so an intervening agent_settled cannot escape. */
    register(kind: CallbackKind, callbackId: string) {
      if (kind === "larva-subagent-result") pending.set(callbackId, "reserved");
    },
    delivery(callbackId: string, state: CallbackDelivery) {
      if (state === "delivered" && pending.get(callbackId) === "reserved") { pending.set(callbackId, "queued"); wake(); }
      if (state === "failed" || state === "suppressed" || state === "stale") {
        pending.delete(callbackId);
        release();
      }
    },
    unbind() { continuation = undefined; },
    retire() { pending.clear(); parked = undefined; },
    relayProgress() {
      const time = performance.now();
      if (!bridge || time - lastHeartbeat < 1000) return;
      lastHeartbeat = time;
      bridge.emit([{ type: "larva_descendant_progress" }]);
    },
    bind(next: FrameBridge, getBranch: () => readonly unknown[], getActivePersona?: () => string | null, idleContinuation?: typeof continuation) {
      bridge = next;
      continuation = idleContinuation;
      wake();
      branch = getBranch;
      next.configure(frame => {
        if (getActivePersona && frame.type === "response" && frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
          return [{ ...frame, data: { ...frame.data, persona_id: getActivePersona() } }];
        }
        if (frame.type === "agent_start") parked = undefined;
        if (pending.size && frame.type === "extension_error" && frame.extensionPath === "<runtime>" && frame.event === "send_message") {
          pending.clear();
          parked = undefined;
          return [{ type: "larva_rpc_frame_error", error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "Could not correlate a child callback delivery error." } }];
        }
        if (frame.type !== "agent_settled" || !pending.size) return [frame];
        if (frame.aborted === true) {
          parked = undefined;
          pending.clear();
          return [frame];
        }
        // A recorded callback at the tip is only queued evidence. Require an assistant
        // entry AFTER it on this branch, and the enclosing native settlement event.
        let assistant = false;
        const entries = branch();
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (!isRecord(e)) continue;
          if (e.type === "message" && isRecord(e.message) && e.message.role === "assistant") assistant = true;
          const details = e.type === "custom_message" ? e.details : e.type === "custom" ? e.data : undefined;
          if (assistant && e.customType === "larva-subagent-result" && isRecord(details)
              && typeof details.callback_id === "string") pending.delete(details.callback_id);
        }
        if (!pending.size) { parked = undefined; return [frame]; }
        parked = frame;
        wake();
        return [];
      });
    },
  };
}
