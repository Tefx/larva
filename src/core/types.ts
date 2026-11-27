import type { ErrorInfo, LarvaError } from "./errors.ts";

declare global {
  /** Injected into executable bundles by scripts/build.mjs. */
  const __LARVA_VERSION__: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type CanSpawn = boolean | string[];
export type ToolPolicy = { allow: string[]; deny: string[] };
export type PersonaInputFormat = "md" | "json";

/** Canonical output after normalization, defaulting, and digest verification. */
export type PersonaSpec = {
  id: string;
  description: string;
  prompt: string;
  model: string;
  thinking: ThinkingLevel;
  can_spawn: CanSpawn;
  tools: ToolPolicy;
  spec_digest: string;
};
export type PersonaSummary = Omit<PersonaSpec, "prompt" | "tools">;

export type SwitchMode = "manual" | "confirm" | "auto" | "free";
export type RootSessionSpawnMode = "persona" | "allow";
export type SubagentConfig = {
  extension_sources: string[];
  root_session_spawn: RootSessionSpawnMode;
  max_depth?: number;
  max_active_runs?: number;
  stall_alert_ms: number;
};
export type GcConfig = { max_age_days: number; max_bytes?: number };
/** Effective config after defaults are applied. */
export type LarvaConfig = {
  default_persona: string | null;
  switch_mode: SwitchMode;
  confirm_timeout_ms: number;
  subagent: SubagentConfig;
  gc: GcConfig;
};
export type LarvaHomePaths = {
  home: string;
  personas: string;
  config: string;
  model_map: string;
  state: string;
  sessions: string;
  artifacts: string;
  capsules: string;
};

export type ModelMapEntry = { provider: string; model_id: string };
export type ModelMapPrefixRule = { from_prefix: string; to_provider: string; to_model_id_prefix: string };
export type ModelMapDoc = {
  models?: Record<string, ModelMapEntry>;
  prefix_rules?: ModelMapPrefixRule[];
};
export type ResolvedModelRoute = ModelMapEntry;

export type EffectiveCanSpawn = CanSpawn;
export type ToolPolicyDecision = { action: "allow" } | { action: "deny"; error: LarvaError };

/** The first borrow's pre-image; later borrows in the same turn do not replace it. */
export type PersonaLease = {
  origin_persona_id: string | null;
  origin_model: ModelMapEntry | null;
  origin_thinking: ThinkingLevel;
  origin_profile_generation: number;
};
export type SwitchConfirmationChoice = "borrow_once" | "deny" | "auto_borrow" | "switch_persistently";
export type PersonaSwitchResult =
  | { ok: true; persona_id: string; persistent: boolean }
  | { ok: false; error: LarvaError };

export type SessionLeaseState = "reserving" | "spawning" | "running" | "unreconciled" | "gc_unlinking";
export type SessionLeaseRecord = {
  lease_id: string;
  owner_pid: number;
} & (
  | { state: "reserving" | "gc_unlinking"; child_pid: null; capsule_root: null }
  | { state: "spawning"; child_pid: null; capsule_root: string }
  | { state: "running"; child_pid: number; capsule_root: string }
  | { state: "unreconciled"; child_pid: number | null; capsule_root: string }
);
export type DiskLockState = "unlocked" | "active_local" | "active_external" | "unreconciled";
export type DiskSessionSummary = {
  task_id: string;
  cwd: string;
  cwd_exists: boolean;
  lock_state: DiskLockState;
};

export type SubagentTerminalStatus = "success" | "failed" | "cancelled";
export type SubagentStatus = "accepted" | "running" | "cancelling" | SubagentTerminalStatus;
export type SubagentPhase = "starting" | "waiting_for_child" | "stall_suspected" | "cancelling" | SubagentTerminalStatus;
export type OutputState = "pending" | "inline" | "artifactized" | "delivery_failed" | "evicted";
export type CancelOutcome = "cancelled" | "already_terminal" | "not_found" | "cleanup_unconfirmed";
export type ArtifactRef = { path: string; bytes: number; sha256?: string; lines?: number };
export type OutputSnapshot = {
  output_state: OutputState;
  result_text?: string;
  result_preview?: string;
  full_output_artifact?: ArtifactRef;
  output_diagnostic?: ErrorInfo;
};
export type RunSnapshot = OutputSnapshot & {
  task_id: string;
  run_epoch: string;
  cwd: string;
  persona_id: string;
  status: SubagentStatus;
  phase: SubagentPhase;
  started_at: string;
  updated_at: string;
  error?: ErrorInfo;
  /** Live telemetry supplied by the producer; previews are bounded. */
  model?: string;
  thinking?: ThinkingLevel;
  task_preview?: string;
  active_tool?: { tool_call_id: string; name: string; status: "running" | "done" | "error" } | null;
  live_thinking?: boolean;
  live_assistant_preview?: string;
  /** At most the 25 most recent tools, with bounded argument previews. */
  tool_snapshots?: ReadonlyArray<{ tool_call_id: string; name: string; status: "running" | "done" | "error"; args_preview?: string }>;
};
export type StartupFailureRecord = {
  startup_id: string;
  persona_id: string;
  status: "failed";
  phase: "startup_failed";
  updated_at: string;
  error: ErrorInfo;
};

export type ActivityQuery = {
  task_id: string;
  limit?: number;
  cursor?: string;
  tool_name?: string;
  since_timestamp?: string;
  until_timestamp?: string;
  tool_call_id?: string;
  disambiguation_index?: number;
  entry_id?: string;
  result_index?: number;
  segment_part?: "args" | "result";
  offset?: number;
  length?: number;
  source_version?: string;
};
export type ActivityCallItem = {
  call_id: string;
  action: string;
  action_truncated?: boolean;
  result?: string;
  is_error?: boolean;
  result_state?: "ambiguous" | "incomplete" | "not_observed" | "present_omitted";
  result_truncated?: boolean;
  disambiguation_index?: number;
  result_candidates_count?: number;
  result_selection?: string;
  has_image?: boolean;
  has_details?: boolean;
  non_text?: boolean;
  upstream_truncated?: boolean;
  result_association?: "ambiguous";
  unassociated_results_count?: number;
};
export type ActivitySegment = {
  part: "args" | "result";
  encoding: "json";
  offset_units: "UTF-16 code units";
  text: string;
  offset: number;
  length: number;
  total_chars: number;
  has_more: boolean;
  continuation_offset?: number;
  source_version: string;
  upstream_truncated?: boolean;
};
export type ActivityLocation = {
  entry_id?: string;
  parent_id?: string | null;
  byte_offset: number;
  line_byte_length: number;
  line_number: number;
  content_index?: number;
};
export type ActivityCallCandidate = ActivityLocation & { index: number; call_timestamp?: string };
export type ActivityResultCandidate = ActivityLocation & { index: number; result_timestamp?: string; is_error?: boolean };
export type ActivityCallDetail = Pick<ActivityCallItem,
  "call_id" | "result_state" | "is_error" | "upstream_truncated" | "result_candidates_count"
  | "result_association" | "unassociated_results_count"
> & {
  tool_name: string;
  call_location: ActivityLocation;
  call_timestamp?: string;
  call_message_timestamp?: number;
  result_location?: ActivityLocation;
  result_timestamp?: string;
  result_message_timestamp?: number;
  result_candidates?: ActivityResultCandidate[];
  selected_result_index?: number;
  segment?: ActivitySegment;
};
export type ActivityResponse = {
  inspection_complete?: false;
  diagnostics?: (Partial<ActivityLocation> & { kind: string; message: string })[];
  total_diagnostics_count?: number;
  diagnostics_truncated?: boolean;
} & (
  | { status: "success"; items: ActivityCallItem[]; has_more: boolean; cursor: string }
  | { status: "success"; session_id: string; call: ActivityCallDetail }
  | { status: "ambiguous"; candidates: ActivityCallCandidate[]; total_candidates_count: number; candidates_truncated: boolean; selection: string }
  | { status: "failed" | "not_found" | "partial"; error: ErrorInfo & { byte_offset?: number } }
);

export type PersonasToolInput = { query?: string; limit?: number };
export type PersonasToolOutput = PersonaSummary[];
export type PersonaSwitchToolInput = { persona_id: string; reason: string; continue_task?: boolean };
export type PersonaSwitchToolOutput = PersonaSwitchResult;
export type SubagentToolInput = {
  persona_id: string;
  task: string;
  task_id?: string;
  cwd?: string;
  no_progress_timeout_ms?: number;
  stall_alert_ms?: number;
};
export type McpSubagentToolInput = SubagentToolInput & { wait_for_completion?: boolean; parent_persona_id?: string };
export type SubagentAcceptedReceipt = { status: "accepted"; task_id: string; run_epoch: string; cwd: string };
export type SubagentTerminalOutput = OutputSnapshot & {
  task_id: string;
  run_epoch: string;
  status: SubagentTerminalStatus;
  error?: ErrorInfo;
};
export type SubagentToolOutput = SubagentAcceptedReceipt;
export type McpSubagentToolOutput = SubagentToolOutput | SubagentTerminalOutput;
export type SubagentWaitCondition = "all" | "any" | "first_error";
export type SubagentWaitToolInput = { task_ids: string[]; return_when?: SubagentWaitCondition; timeout_ms?: number };
export type SubagentWaitOutput = {
  ready: boolean;
  timed_out: boolean;
  runs: RunSnapshot[];
};
export type McpSubagentWaitOutput = SubagentWaitOutput & { terminal_outputs: Record<string, SubagentTerminalOutput> };
export type SubagentStatusScope = "active" | "recent" | "disk";
export type SubagentStatusToolInput =
  | { task_id: string; scope?: never; limit?: never }
  | { task_id?: never; scope?: SubagentStatusScope; limit?: number };
export type SubagentStatusOutput = {
  runs: RunSnapshot[];
  startup_failures: StartupFailureRecord[];
  disk_sessions?: DiskSessionSummary[];
};
export type SubagentActivityToolInput = ActivityQuery;
export type SubagentActivityOutput = ActivityResponse;
export type RunEpochGuard = { task_id: string; run_epoch: string };
export type SubagentCancelToolInput = { task_ids: string[]; reason: string; expected_run_epochs?: RunEpochGuard[] };
export type SubagentCancelItem = { task_id: string; outcome: CancelOutcome; error?: ErrorInfo };
export type SubagentCancelOutput = { results: SubagentCancelItem[]; isError: boolean };
export type SubagentPanelToolInput = SubagentStatusToolInput & { run_epochs?: RunEpochGuard[] };
export type SubagentPanelOutput = SubagentStatusOutput & { terminal_outputs?: Record<string, SubagentTerminalOutput> };
export type SearchMentionsToolInput = { query: string; preload?: boolean; path?: string[] };
export type SearchMentionsToolOutput = {
  items: {
    type: "resource_link";
    uri: string;
    name: string;
    title: string;
    searchTerms: string[];
    description?: string;
    mimeType: "text/markdown";
  }[];
};

export type GcReport = {
  deleted_sessions: number;
  deleted_artifacts: number;
  freed_bytes: number;
  remaining_bytes: number;
  protected_bytes: number;
  budget_met: boolean;
  unreconciled_capsules?: string[];
};
export type DoctorReport = {
  ok: boolean;
  larva_home: string;
  profile: string;
  pi: { path: string; version?: string } | null;
  personas_checked: number;
  diagnostics: (ErrorInfo & { path?: string; persona_id?: string })[];
};
