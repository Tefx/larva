import { LarvaError } from "./errors.ts";
import type { EffectiveCanSpawn, PersonaSpec, RootSessionSpawnMode } from "./types.ts";

type SpawnPersona = Pick<PersonaSpec, "can_spawn">;
type SpawnContext = {
  parent_persona_id?: string;
  env?: { LARVA_PI_INITIAL_PERSONA_ID?: string; LARVA_MCP_PARENT_PERSONA?: string };
  /** Lookup in the supplied persona snapshot; return undefined for an unknown ID. */
  resolvePersona: (id: string) => SpawnPersona | undefined;
} & (
  | { surface: "pi"; isLaunchedChild: boolean; activePersona: SpawnPersona | null; rootSessionSpawn: RootSessionSpawnMode }
  | { surface: "mcp"; depth: number }
);

export function evaluateEffectiveCanSpawn(context: SpawnContext): EffectiveCanSpawn {
  const { parent_persona_id: explicitParent, env, resolvePersona } = context;
  const descendant = context.surface === "pi" ? context.isLaunchedChild : context.depth >= 1;
  if (descendant) {
    const initial = env?.LARVA_PI_INITIAL_PERSONA_ID;
    if (!initial?.trim() || (explicitParent !== undefined && explicitParent !== initial)) {
      throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "Descendant spawn authority requires the launch-bound persona.");
    }
    const persona = resolvePersona(initial);
    if (!persona) throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "The launch-bound persona could not be resolved.");
    return persona.can_spawn;
  }
  if (context.surface === "pi") {
    if (context.activePersona === null) return false;
    const capability = context.activePersona.can_spawn;
    return capability === false && context.rootSessionSpawn === "allow" ? true : capability;
  }

  const parent = explicitParent ?? (env?.LARVA_MCP_PARENT_PERSONA?.trim() || undefined);
  if (parent === undefined) return true;
  if (!parent.trim()) throw new LarvaError("LARVA_BAD_INPUT", "parent_persona_id must not be blank.");
  const persona = resolvePersona(parent);
  if (!persona) throw new LarvaError("LARVA_PERSONA_NOT_FOUND", "The MCP parent persona could not be resolved.");
  return persona.can_spawn;
}

export function assertCanSpawnTarget(effectiveCanSpawn: EffectiveCanSpawn, targetPersonaId: string): void {
  if (effectiveCanSpawn !== true && (effectiveCanSpawn === false || !effectiveCanSpawn.includes(targetPersonaId))) {
    throw new LarvaError("LARVA_SPAWN_NOT_ALLOWED", "The effective spawn policy does not allow this target persona.");
  }
}
