export const ALL_LARVA_ERROR_CODES = [
  "LARVA_BAD_INPUT",
  "LARVA_CONFIG_INVALID",
  "LARVA_MODEL_MAP_INVALID",
  "LARVA_MODEL_UNAVAILABLE",
  "LARVA_PERSONA_INVALID",
  "LARVA_PERSONA_NOT_FOUND",
  "LARVA_PERSONA_CONFLICT",
  "LARVA_STORE_WRITE_FAILED",
  "LARVA_NO_ACTIVE_PERSONA",
  "LARVA_TOOL_DENIED",
  "LARVA_SPAWN_NOT_ALLOWED",
  "LARVA_CONFIRMATION_UNAVAILABLE",
  "LARVA_SWITCH_CHAIN_LIMIT",
  "LARVA_ROUTE_UNCERTAIN",
  "LARVA_RESTORE_FAILED",
  "LARVA_CWD_REQUIRED",
  "LARVA_SESSION_INVALID",
  "LARVA_SESSION_NOT_FOUND",
  "LARVA_SESSION_BUSY",
  "LARVA_CHILD_START_FAILED",
  "LARVA_CHILD_PROTOCOL_FAILED",
  "LARVA_CHILD_CANCELLED",
  "LARVA_INTERNAL_ERROR",
  "LARVA_CLI_USAGE",
] as const;

export type LarvaErrorCode = (typeof ALL_LARVA_ERROR_CODES)[number];

export class LarvaError extends Error {
  readonly code: LarvaErrorCode;
  readonly details?: unknown;
  readonly exitCode: 1 | 2;

  constructor(code: LarvaErrorCode, message: string, details?: unknown, exitCode?: 1 | 2) {
    super(message);
    this.name = "LarvaError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode ?? (code === "LARVA_CLI_USAGE" ? 2 : 1);
  }
}

export type ErrorInfo = { code: string; message: string; details?: unknown };
export type CliErrorEnvelope = { ok: false; error: ErrorInfo };
export type CliSuccessEnvelope<T> = { ok: true; data: T };
export type CliJsonEnvelope<T> = CliSuccessEnvelope<T> | CliErrorEnvelope;

/** Project an expected error to the wire format without exposing foreign errors. */
export function toErrorEnvelope(err: unknown): CliErrorEnvelope {
  if (!(err instanceof LarvaError)) {
    return { ok: false, error: { code: "LARVA_INTERNAL_ERROR", message: "An internal error occurred." } };
  }
  const { code, message, details } = err;
  return { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function toSuccessEnvelope<T>(data: T): CliSuccessEnvelope<T> {
  return { ok: true, data };
}

/** Pass no argument for a successful command. */
export function exitCodeForError(...errors: [] | [unknown]): 0 | 1 | 2 {
  if (errors.length === 0) return 0;
  const [err] = errors;
  return err instanceof LarvaError ? err.exitCode : 1;
}
