import { randomUUID } from "node:crypto";
import type { OutputSnapshot, RunSnapshot, SubagentTerminalOutput, SubagentTerminalStatus } from "../core/types.ts";

export const mintRunEpoch = () => randomUUID();

export function isTerminal(status: RunSnapshot["status"]): status is SubagentTerminalStatus {
  return status === "success" || status === "failed" || status === "cancelled";
}

/** A wait holds the snapshot object it observed at ingress, never a latest-by-task lookup. */
export class RunOutbox {
  #completed = new Map<string, { snapshot: RunSnapshot; prompt?: string }>();

  retain(snapshot: RunSnapshot, prompt?: string): void {
    this.#completed.set(snapshot.run_epoch, { snapshot, prompt });
    if (this.#completed.size <= 25) return;
    const { snapshot: oldest } = this.#completed.values().next().value!;
    this.#completed.delete(oldest.run_epoch);
    delete oldest.result_text;
    delete oldest.result_preview;
    delete oldest.full_output_artifact;
    delete oldest.output_diagnostic;
    oldest.output_state = "evicted";
  }

  publish(snapshot: RunSnapshot, output: OutputSnapshot): void {
    if (this.#completed.get(snapshot.run_epoch)?.snapshot === snapshot) Object.assign(snapshot, output);
  }

  prompt(epoch: string): string | undefined { return this.#completed.get(epoch)?.prompt; }
  recent(): RunSnapshot[] { return [...this.#completed.values()].reverse().map(entry => entry.snapshot); }

  lookup(taskId: string, epoch?: string): RunSnapshot | undefined {
    if (epoch === undefined) return this.recent().find(s => s.task_id === taskId);
    const s = this.#completed.get(epoch)?.snapshot;
    return s?.task_id === taskId ? s : undefined;
  }
}

export function terminalOutput(snapshot: RunSnapshot, output: OutputSnapshot = snapshot): SubagentTerminalOutput & Pick<RunSnapshot, "persona_id" | "phase"> {
  const { task_id, run_epoch, persona_id, phase, status, error } = snapshot;
  const { output_state, result_text, result_preview, full_output_artifact, output_diagnostic } = output;
  if (!isTerminal(status)) throw new Error("Expected terminal execution status.");
  return structuredClone({ task_id, run_epoch, persona_id, phase, status, output_state, ...(error && { error }),
    ...(result_text !== undefined && { result_text }), ...(result_preview !== undefined && { result_preview }),
    ...(full_output_artifact && { full_output_artifact }), ...(output_diagnostic && { output_diagnostic }) });
}
