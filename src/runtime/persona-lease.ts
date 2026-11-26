import { LarvaError } from "../core/errors.ts";
import { isValidPersonaId } from "../core/persona.ts";
import type {
  PersonaLease, PersonaSwitchToolInput, PersonaSwitchToolOutput, SwitchConfirmationChoice, SwitchMode,
} from "../core/types.ts";

const SWITCH_CHAIN_LIMIT = 8;
const CHOICES = [
  { id: "borrow_once", label: "Borrow once" },
  { id: "deny", label: "Deny" },
  { id: "auto_borrow", label: "Auto-borrow for this session" },
  { id: "switch_persistently", label: "Switch persistently" },
] as const;

export const PERSONA_SWITCH_AUDIT = "larva-agent-persona-switch-audit";
export type PersonaSwitchContext = {
  mode: "tui" | "rpc" | "print";
  signal?: AbortSignal;
  toolCallId?: string;
  /** Include the complete assistant message, including calls Pi has not dispatched yet. */
  toolBatch?: () => {
    assistantCallIds: readonly string[];
    activeCallIds: readonly string[];
    observedCallIds: readonly string[];
  };
  /** Escape / Ctrl+C respond with null. AbortSignal closes a pending dialog on expiry or preemption. */
  confirm?: (request: PersonaSwitchToolInput & {
    choices: typeof CHOICES;
    signal: AbortSignal;
    respond: (choice: SwitchConfirmationChoice | null) => void;
  }) => void | Promise<void>;
};
export type Continuation = { persona_id: string; reason: string };
export type PersonaSwitchOutcome = PersonaSwitchToolOutput & { terminate?: true };

function badInput(message: string): LarvaError {
  return new LarvaError("LARVA_BAD_INPUT", message);
}

function parseSwitch(input: unknown): PersonaSwitchToolInput {
  const invalid = () => badInput("Expected persona_id, a non-blank reason, and optional boolean continue_task; no other fields are supported.");
  if (typeof input !== "object" || input === null || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      || Object.keys(input).some(key => !["persona_id", "reason", "continue_task"].includes(key))
      || !("persona_id" in input) || typeof input.persona_id !== "string" || input.persona_id.length > 255
      || !("reason" in input) || typeof input.reason !== "string" || input.reason.length > 1_000
      || ("continue_task" in input && typeof input.continue_task !== "boolean")) throw invalid();
  const persona_id = input.persona_id.trim();
  const reason = input.reason.trim();
  if (!isValidPersonaId(persona_id) || !reason) throw invalid();
  return { persona_id, reason, continue_task: "continue_task" in input && input.continue_task === true };
}

export function assertSoloCall(input: PersonaSwitchToolInput, ctx: PersonaSwitchContext): void {
  if (!input.continue_task) return;
  const batch = ctx.toolBatch?.();
  const id = ctx.toolCallId;
  if (!id || !batch || batch.assistantCallIds.length !== 1 || batch.assistantCallIds[0] !== id
      || batch.activeCallIds.some(other => other !== id) || batch.observedCallIds.some(other => other !== id)) {
    throw badInput("continue_task requires a solo tool call in the assistant turn.");
  }
}

export async function larva_persona_switch(
  input: unknown,
  ctx: PersonaSwitchContext,
  execute: (request: PersonaSwitchToolInput) => Promise<PersonaSwitchOutcome>,
): Promise<PersonaSwitchOutcome> {
  try {
    const request = parseSwitch(input);
    assertSoloCall(request, ctx);
    return await execute(request);
  } catch (error) {
    return { ok: false, error: error instanceof LarvaError ? error : new LarvaError("LARVA_INTERNAL_ERROR", "Persona switch failed.") };
  }
}

export async function confirmSwitch(
  ctx: PersonaSwitchContext, request: PersonaSwitchToolInput, timeoutMs: number, signal: AbortSignal,
): Promise<Exclude<SwitchConfirmationChoice, "deny">> {
  const confirm = ctx.confirm;
  if (ctx.mode !== "tui" || !confirm) {
    throw new LarvaError("LARVA_CONFIRMATION_UNAVAILABLE", "Persona switch confirmation requires a TUI dialog.");
  }
  const dialog = new AbortController();
  const deadline = timeoutMs === 0 ? Infinity : performance.now() + timeoutMs;
  const choice = await new Promise<SwitchConfirmationChoice | null>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: SwitchConfirmationChoice | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      dialog.abort();
      resolve(value);
    };
    const abort = () => finish(null);
    const unavailable = () => {
      if (settled) return;
      reject(new LarvaError("LARVA_CONFIRMATION_UNAVAILABLE", "Could not present persona switch confirmation."));
      abort();
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== 0) timer = setTimeout(abort, timeoutMs);
    try {
      const respond = (value: SwitchConfirmationChoice | null) => finish(performance.now() < deadline ? value : null);
      void Promise.resolve(confirm({ ...request, choices: CHOICES, signal: dialog.signal, respond })).catch(unavailable);
    } catch { unavailable(); }
  });
  if (signal.aborted || (choice !== "borrow_once" && choice !== "auto_borrow" && choice !== "switch_persistently")) {
    throw badInput("Persona switch was denied or cancelled.");
  }
  return choice;
}

/** Tracks the first borrow pre-image and one outstanding continuation dispatch. */
export class PersonaLeaseState {
  origin: PersonaLease | null = null;
  #count = 0;
  #continuation: Continuation | null = null;

  assertAllowed(mode: SwitchMode): void {
    if (mode === "manual") throw new LarvaError("LARVA_TOOL_DENIED", "Autonomous persona switching is disabled.");
    if (this.#count === SWITCH_CHAIN_LIMIT) {
      throw new LarvaError("LARVA_SWITCH_CHAIN_LIMIT", "Persona switch chain limit reached for this user turn.");
    }
  }

  recordSwitch(input: PersonaSwitchToolInput, origin: PersonaLease | null): void {
    this.#count++;
    this.origin ??= origin;
    if (input.continue_task) this.#continuation = { persona_id: input.persona_id, reason: input.reason };
  }

  takeContinuation(): Continuation | null {
    const next = this.#continuation;
    this.#continuation = null;
    return next;
  }

  clearLease(): void {
    this.origin = null;
    this.#continuation = null;
  }

  beginUserTurn(): void {
    this.#count = 0;
    this.#continuation = null;
  }
}
