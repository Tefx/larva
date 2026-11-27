import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadLarvaConfig } from "../core/config.ts";
import { LarvaError, toErrorEnvelope } from "../core/errors.ts";
import { isValidProfileName, resolveModelRoute } from "../core/model-map.ts";
import { getLarvaHomePaths, modelMapProfilePath, resolveBasePiAgentDir, resolveLarvaHome } from "../core/paths.ts";
import type { DoctorReport, ModelMapDoc, PersonaSpec } from "../core/types.ts";
import { discoverPiInstallation, loadModelRegistry } from "../runtime/pi-binary.ts";
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
    // The store treats ENOENT from readdir as an empty store, including when
    // personas/ is a symlink to a missing target.
    const link = await lstat(paths.personas).catch(() => undefined);
    if (link?.isSymbolicLink()) {
      try {
        await stat(paths.personas);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          throw new LarvaError("LARVA_PERSONA_INVALID", "The persona directory is a dangling symlink.");
        }
        throw new LarvaError("LARVA_PERSONA_INVALID", "Cannot access the persona directory.");
      }
    }
    const store = new PersonaStore(home);
    personas = await store.list({ full: true });
    report.personas_checked = personas.length;
    report.diagnostics.push(...store.diagnostics);
  } catch (error) {
    diagnose(error, { path: paths.personas });
  }

  for (const path of [paths.sessions, paths.capsules, paths.artifacts]) {
    try {
      const info = await lstat(path);
      const mode = info.mode & 0o7777;
      if (!info.isDirectory()) {
        diagnose(new LarvaError("LARVA_CONFIG_INVALID", "Expected a real state directory."), { path });
      } else if (mode !== 0o700) {
        diagnose(new LarvaError("LARVA_CONFIG_INVALID", `Insecure directory permissions: expected 0700, found ${mode.toString(8).padStart(4, "0")}.`), { path });
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        diagnose(new LarvaError("LARVA_CONFIG_INVALID", "Cannot inspect state directory permissions."), { path });
      }
    }
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
    if (selected !== undefined && personas.length) {
      const findModel = await loadModelRegistry(pi, resolveBasePiAgentDir(env));
      for (const persona of personas) {
        try {
          const route = resolveModelRoute(persona.model, selected.map);
          if (findModel(route) === null) {
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
