import { randomUUID } from "node:crypto";
import type { OutputSnapshot, RunSnapshot, SubagentTerminalOutput, SubagentTerminalStatus } from "../core/types.ts";

export const mintRunEpoch = () => randomUUID();

export function isTerminal(status: RunSnapshot["status"]): status is SubagentTerminalStatus {
  return status === "success" || status === "failed" || status === "cancelled";
}

/** A wait holds the snapshot object it observed at ingress, never a latest-by-task lookup. */
export class RunOutbox {
  #completed = new Map<string, RunSnapshot>();

  retain(snapshot: RunSnapshot): void {
    this.#completed.set(snapshot.run_epoch, snapshot);
    if (this.#completed.size <= 25) return;
    const oldest = this.#completed.values().next().value!;
    this.#completed.delete(oldest.run_epoch);
    delete oldest.result_text;
    delete oldest.result_preview;
    delete oldest.full_output_artifact;
    delete oldest.output_diagnostic;
    oldest.output_state = "evicted";
  }

  publish(snapshot: RunSnapshot, output: OutputSnapshot): void {
    if (this.#completed.get(snapshot.run_epoch) === snapshot) Object.assign(snapshot, output);
  }

  recent(): RunSnapshot[] { return [...this.#completed.values()].reverse(); }

  lookup(taskId: string, epoch?: string): RunSnapshot | undefined {
    if (epoch === undefined) return this.recent().find(s => s.task_id === taskId);
    const s = this.#completed.get(epoch);
    return s?.task_id === taskId ? s : undefined;
  }
}

export function terminalOutput(snapshot: RunSnapshot): SubagentTerminalOutput {
  const { task_id, run_epoch, status, error, output_state, result_text, result_preview, full_output_artifact, output_diagnostic } = snapshot;
  if (!isTerminal(status)) throw new Error("Expected terminal execution status.");
  return structuredClone({ task_id, run_epoch, status, output_state, ...(error && { error }),
    ...(result_text !== undefined && { result_text }), ...(result_preview !== undefined && { result_preview }),
    ...(full_output_artifact && { full_output_artifact }), ...(output_diagnostic && { output_diagnostic }) });
}
