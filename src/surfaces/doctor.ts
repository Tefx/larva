import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadLarvaConfig } from "../core/config.ts";
import { LarvaError, toErrorEnvelope } from "../core/errors.ts";
import { isValidProfileName, resolveModelRoute } from "../core/model-map.ts";
import { getLarvaHomePaths, modelMapProfilePath, resolveLarvaHome } from "../core/paths.ts";
import type { DoctorReport, ModelMapDoc, PersonaSpec } from "../core/types.ts";
import { discoverPiInstallation, resolveModelInRegistry } from "../runtime/pi-binary.ts";
import { isErrno } from "../store/capsule.ts";
import { entryExists, loadDiskModelMap, readBoundedRegularText } from "../store/model-map.ts";
import { PersonaStore } from "../store/persona-store.ts";

type DoctorOptions = { env?: NodeJS.ProcessEnv; profile?: string };
type Diagnostic = DoctorReport["diagnostics"][number];

export async function readConfigTextIfPresent(path: string): Promise<string | undefined> {
  if (await entryExists(path)) return readBoundedRegularText(path);
  return undefined;
}

export async function runDoctor({ env = process.env, profile }: DoctorOptions = {}): Promise<DoctorReport> {
  const report: DoctorReport = {
    ok: false, larva_home: "", profile: profile ?? "default", pi: null, personas_checked: 0, diagnostics: [],
  };
  function diagnose(error: unknown, location: Pick<Diagnostic, "path" | "persona_id"> = {}): void {
    report.diagnostics.push({ ...toErrorEnvelope(error).error, ...location });
  }

  let home: string;
  try {
    report.larva_home = home = resolveLarvaHome(env);
  } catch (error) {
    diagnose(error);
    return report;
  }

  const paths = getLarvaHomePaths(home);
  try {
    await loadLarvaConfig(home, readConfigTextIfPresent);
  } catch (error) {
    diagnose(error, { path: paths.config });
  }

  let personas: PersonaSpec[] = [];
  try {
    const store = new PersonaStore(home);
    personas = await store.list({ full: true });
    report.personas_checked = personas.length;
    report.diagnostics.push(...store.diagnostics);
  } catch (error) {
    diagnose(error, { path: paths.personas });
  }

  const defaultPath = paths.model_map;
  let selectedPath: string | undefined;
  if (profile === undefined) selectedPath = defaultPath;
  else if (isValidProfileName(profile)) selectedPath = modelMapProfilePath(home, profile);
  else diagnose(new LarvaError("LARVA_MODEL_MAP_INVALID", "Invalid model-map profile name."));

  const mapPaths = new Set([defaultPath]);
  if (selectedPath !== undefined) mapPaths.add(selectedPath);
  try {
    for (const name of (await readdir(home)).sort()) {
      if (name.startsWith("model-map") && name.endsWith(".json")) mapPaths.add(join(home, name));
    }
  } catch (error) {
    // A genuinely absent home is an empty store. A dangling link or an
    // unreadable/non-directory home is not evidence that no maps exist.
    if (!isErrno(error, "ENOENT") || await entryExists(home).catch(() => true)) {
      diagnose(new LarvaError("LARVA_CONFIG_INVALID", "Cannot enumerate LARVA_HOME."), { path: home });
    }
  }

  let selected: { map: ModelMapDoc | undefined } | undefined;
  for (const path of mapPaths) {
    try {
      const map = await loadDiskModelMap(home, path);
      if (path === selectedPath) selected = { map };
    } catch (error) {
      diagnose(error, { path });
    }
  }

  try {
    const pi = await discoverPiInstallation(env);
    report.pi = { path: pi.path, ...(pi.version === undefined ? {} : { version: pi.version }) };
    if (selected !== undefined) {
      const userHome = env.HOME || homedir();
      const configuredDir = env.PI_CODING_AGENT_DIR;
      const agentDir = configuredDir?.startsWith("~/") ? join(userHome, configuredDir.slice(2))
        : configuredDir || join(userHome, ".pi", "agent");
      for (const persona of personas) {
        try {
          const route = resolveModelRoute(persona.model, selected.map);
          if (await resolveModelInRegistry(pi, route, agentDir) === null) {
            throw new LarvaError("LARVA_MODEL_UNAVAILABLE", "The resolved Persona model is not in the Pi registry.");
          }
        } catch (error) {
          diagnose(error, { persona_id: persona.id });
        }
      }
    }
  } catch (error) {
    diagnose(error);
  }

  report.ok = report.diagnostics.length === 0;
  return report;
}
