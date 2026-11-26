import { LarvaError } from "./errors.ts";
import type { EffectiveCanSpawn, PersonaSpec, SwitchMode, ToolPolicyDecision } from "./types.ts";

export const SPAWN_TOOLS: ReadonlySet<string> = new Set([
  "larva_subagent",
  "larva_subagent_wait",
  "larva_subagent_status",
  "larva_subagent_activity",
  "larva_subagent_cancel",
]);

type NativeToolPolicy = {
  activePersona: Pick<PersonaSpec, "tools"> | null;
  isLaunchedChild: boolean;
  switchMode: SwitchMode;
  effectiveCanSpawn: EffectiveCanSpawn;
};

function matches(tool: string, pattern: string): boolean {
  return pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
}

function denial(tool: string, context: NativeToolPolicy): LarvaError | undefined {
  const policy = context.activePersona?.tools;
  if (policy && ((policy.allow.length > 0 && !policy.allow.some(pattern => matches(tool, pattern)))
      || policy.deny.some(pattern => matches(tool, pattern)))) {
    return new LarvaError("LARVA_TOOL_DENIED", "The active persona's policy does not allow this tool.");
  }
  if (tool === "larva_persona_switch" && (context.isLaunchedChild || context.switchMode === "manual")) {
    return new LarvaError("LARVA_TOOL_DENIED", "Autonomous persona switching is disabled in this session.");
  }
  if (context.effectiveCanSpawn === false && SPAWN_TOOLS.has(tool)) {
    if (!context.isLaunchedChild && context.activePersona === null) {
      return new LarvaError("LARVA_NO_ACTIVE_PERSONA", "Select an active persona before using subagent tools.");
    }
    return new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Subagent tools are disabled in this session.");
  }
  return undefined;
}

export function composeToolPolicy(baseline: readonly string[], context: NativeToolPolicy): string[] {
  return baseline.filter(tool => denial(tool, context) === undefined);
}

export function evaluateToolInvocation(
  tool: string,
  baseline: readonly string[],
  context: NativeToolPolicy,
): ToolPolicyDecision {
  if (!baseline.includes(tool)) {
    return { action: "deny", error: new LarvaError("LARVA_TOOL_DENIED", "This tool is not in the session baseline.") };
  }
  const error = denial(tool, context);
  return error ? { action: "deny", error } : { action: "allow" };
}
