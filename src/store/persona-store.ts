import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LarvaError, type ErrorInfo } from "../core/errors.ts";
import { getLarvaHomePaths, resolveLarvaHome } from "../core/paths.ts";
import { isValidPersonaId, parsePersonaInput, toPersonaSummary } from "../core/persona.ts";
import { isRecord } from "../core/predicates.ts";
import type { PersonaInputFormat, PersonaSpec, PersonaSummary, PersonasToolInput } from "../core/types.ts";
import { entryExists, isErrno, readBoundedRegularBytes, requireRealDirectory } from "./bounded-read.ts";
import { isPid, pidExited, readMetadata, writeMetadata } from "./capsule.ts";
import { withReclaimClaim } from "./session-lease.ts";

const MAX_PERSONA_BYTES = 1_048_576;

const formats = ["md", "json"] as const;
const maxDiagnostics = 100;
const maxCachedPersonas = 128;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Candidate = { path: string; id: string; format: PersonaInputFormat };
type Input = { spec: PersonaSpec; format: PersonaInputFormat; bytes: Buffer };
type CacheEntry = { fingerprint: string; spec: PersonaSpec };
export type PersonaDiagnostic = ErrorInfo & { path?: string; persona_id?: string };
export type PersonaListOptions = PersonasToolInput & { full?: boolean };
export type PersonaPutOptions = { prune?: boolean; stdinText?: string };
export type PersonaPutResult = { committed_ids: string[]; pruned_ids: string[] };

const isMissing = (error: unknown) => isErrno(error, "ENOENT");

async function personaNames(directory: string): Promise<Set<string>> {
  try {
    await requireRealDirectory(directory);
    return new Set(await readdir(directory));
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw new LarvaError("LARVA_PERSONA_INVALID", `Cannot read persona directory: ${directory}`);
  }
}

async function lockOwner(path: string) {
  await requireRealDirectory(path);
  const value = await readMetadata(join(path, "owner.json"));
  if (!isRecord(value) || !isPid(value.pid) || typeof value.id !== "string" || !value.id) {
    throw new Error("Invalid persona write lock owner.");
  }
  return { pid: value.pid, id: value.id };
}

async function withPersonaLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const path = join(directory, ".write.lock");
  const id = randomUUID();
  const stage = join(directory, `.write.${process.pid}.${id}.tmp`);
  const retired = join(directory, `.write.${process.pid}.${id}.retired`);
  async function detach() {
    await rename(path, retired);
    await rm(retired, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(stage, { mode: 0o700 });
  try {
    await writeMetadata(join(stage, "owner.json"), { id, pid: process.pid });
    const deadline = performance.now() + 5_000;
    for (;;) {
      try {
        await rename(stage, path);
        break;
      } catch (error) {
        if (!isErrno(error, "EEXIST") && !isErrno(error, "ENOTEMPTY")) throw error;
      }
      const observed = await lockOwner(path).catch(error => { if (!isMissing(error)) throw error; });
      if (observed && pidExited(observed.pid) && await withReclaimClaim(path, observed.id, async () => {
        const current = await lockOwner(path).catch(error => { if (!isMissing(error)) throw error; });
        if (current?.id !== observed.id || !pidExited(current.pid)) return false;
        await detach();
        return true;
      })) continue;
      if (performance.now() >= deadline) throw new Error("Timed out waiting for the persona write lock.");
      await delay(20);
    }
    const result = await operation().catch(async error => {
      await detach().catch(() => {});
      throw error;
    });
    await detach();
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fileFormat(path: string): PersonaInputFormat | undefined {
  const ext = extname(path);
  return ext === ".md" ? "md" : ext === ".json" ? "json" : undefined;
}

function candidates(directory: string, names: Iterable<string>): Candidate[] {
  const files: Candidate[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const format = fileFormat(name);
    if (!format) continue;
    files.push({ path: join(directory, name), id: basename(name, `.${format}`), format });
  }
  return files.sort((a, b) => compareIds(a.id, b.id) || compareIds(a.format, b.format));
}

function conflict(id: string): LarvaError {
  return new LarvaError("LARVA_PERSONA_CONFLICT", `Both formats exist for persona ${id}.`);
}

function notFound(id: string): LarvaError {
  return new LarvaError("LARVA_PERSONA_NOT_FOUND", `Persona ${id} was not found.`);
}

function unreadable(path: string): LarvaError {
  return new LarvaError("LARVA_PERSONA_INVALID", `Cannot read persona input: ${path}`);
}

function assertId(id: string): void {
  if (!isValidPersonaId(id)) throw new LarvaError("LARVA_BAD_INPUT", "Expected a lowercase kebab-case persona ID.");
}

async function readPersonaFile(path: string, installed = false) {
  try {
    return await readBoundedRegularBytes(path, {
      maxBytes: MAX_PERSONA_BYTES,
      flags: installed ? constants.O_NOFOLLOW : 0,
    });
  } catch {
    throw unreadable(path);
  }
}

function parseFile(bytes: Buffer, path: string): PersonaSpec {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new LarvaError("LARVA_PERSONA_INVALID", `Persona input is not UTF-8: ${path}`);
  }
  return parsePersonaInput(text, path);
}

async function loadInput(target: string, { prune, stdinText }: PersonaPutOptions): Promise<Input[]> {
  const badPrune = () => new LarvaError("LARVA_BAD_INPUT", "Prune requires a persona input directory.");
  if (target === "-") {
    if (prune) throw badPrune();
    if (stdinText === undefined) throw new LarvaError("LARVA_BAD_INPUT", "Persona stdin text is required.");
    if (Buffer.byteLength(stdinText, "utf8") > MAX_PERSONA_BYTES) {
      throw new LarvaError("LARVA_PERSONA_INVALID", "Persona stdin exceeds 1 MiB.");
    }
    const spec = parsePersonaInput(stdinText);
    return [{ spec, format: stdinText.trimStart().startsWith("{") ? "json" : "md", bytes: Buffer.from(stdinText, "utf8") }];
  }

  let files: string[];
  try {
    const targetStat = await stat(target);
    if (prune && !targetStat.isDirectory()) throw badPrune();
    files = [target];
    if (targetStat.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      const batch = candidates(target, entries.filter(entry => !entry.isDirectory()).map(entry => entry.name));
      // Each valid named input binds its ID to its stem; a repeated stem is a conflict
      // even when one of the two representations is malformed.
      for (let i = 1; i < batch.length; i++) {
        if (batch[i - 1].id === batch[i].id && isValidPersonaId(batch[i].id)) throw conflict(batch[i].id);
      }
      files = batch.map(file => file.path);
    } else if (!(await readdir(dirname(target))).includes(basename(target))) {
      throw new LarvaError("LARVA_PERSONA_INVALID", `Persona filename must match ${basename(target)} exactly.`);
    }
  } catch (error) {
    if (error instanceof LarvaError) throw error;
    throw unreadable(target);
  }

  const inputs: Input[] = [];
  for (const path of files) {
    const format = fileFormat(path);
    if (!format) throw new LarvaError("LARVA_PERSONA_INVALID", "Expected a .md or .json persona filename.");
    const { bytes } = await readPersonaFile(path);
    inputs.push({ spec: parseFile(bytes, path), format, bytes });
  }
  return inputs;
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function stageAndRename(directory: string, { spec, format, bytes }: Input): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, `${spec.id}.${format}`));
  } catch (error) {
    await unlinkIfPresent(temporary).catch(() => undefined);
    throw error;
  }
}

function rank(spec: PersonaSummary, query: string): number {
  if (spec.id === query) return 0;
  if (spec.id.startsWith(query)) return 1;
  if (spec.id.includes(query)) return 2;
  return [spec.description, spec.model].some(value => value.toLowerCase().includes(query)) ? 3 : Infinity;
}

export class PersonaStore {
  readonly #directory: string;
  readonly #cache = new Map<string, CacheEntry>();
  #diagnostics: PersonaDiagnostic[] = [];

  constructor(home = resolveLarvaHome()) {
    this.#directory = getLarvaHomePaths(home).personas;
  }

  /** Diagnostics from the most recently completed list scan, independent of search and limit. */
  get diagnostics(): PersonaDiagnostic[] {
    return this.#diagnostics.map(item => ({ ...item }));
  }

  async validate(target: string, stdinText?: string): Promise<PersonaSpec[]> {
    return (await loadInput(target, { stdinText })).map(input => input.spec);
  }

  async #installed(id: string, names: ReadonlySet<string>): Promise<Candidate[]> {
    const found: Candidate[] = [];
    for (const format of formats) {
      const name = `${id}.${format}`;
      const path = join(this.#directory, name);
      if (names.has(name)) found.push({ path, id, format });
      else if (await entryExists(path).catch(error => { if (!isErrno(error, "ENAMETOOLONG")) throw unreadable(path); })) {
        // An entry that appeared after a concurrent rename is not a case alias.
        if ((await personaNames(this.#directory)).has(name)) found.push({ path, id, format });
        else if (await entryExists(path)) throw new LarvaError("LARVA_PERSONA_INVALID", `Persona filename must match ${name} exactly.`);
      }
    }
    return found;
  }

  async get(id: string): Promise<PersonaSpec> {
    assertId(id);
    return this.#get(id, await personaNames(this.#directory));
  }

  async #get(id: string, names: ReadonlySet<string>): Promise<PersonaSpec> {
    try {
      const found = await this.#installed(id, names);
      if (found.length === 0) throw notFound(id);
      if (found.length > 1) throw conflict(id);
      const [{ path, format }] = found;
      const { bytes, metadata } = await readPersonaFile(path, true);
      // Stat alone cannot detect same-size edits with restored timestamps. Hash the bytes
      // from the same descriptor as the metadata before reusing a parsed Persona.
      const hash = createHash("sha256").update(bytes).digest("hex");
      const fingerprint = `${format}:${metadata.dev}:${metadata.ino}:${metadata.mtimeNs}:${hash}`;
      const cached = this.#cache.get(id);
      if (cached?.fingerprint === fingerprint) return structuredClone(cached.spec);
      const spec = parseFile(bytes, path);
      this.#cache.delete(id);
      if (this.#cache.size === maxCachedPersonas) {
        const oldest = this.#cache.keys().next();
        if (!oldest.done) this.#cache.delete(oldest.value);
      }
      this.#cache.set(id, { fingerprint, spec });
      return structuredClone(spec);
    } catch (error) {
      this.#cache.delete(id);
      throw error;
    }
  }

  async list(options: PersonaListOptions & { full: true }): Promise<PersonaSpec[]>;
  async list(options?: PersonaListOptions & { full?: false }): Promise<PersonaSummary[]>;
  async list(options: PersonaListOptions): Promise<PersonaSpec[] | PersonaSummary[]>;
  async list({ full, query, limit }: PersonaListOptions = {}): Promise<PersonaSpec[] | PersonaSummary[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new LarvaError("LARVA_BAD_INPUT", "Persona list limit must be a positive integer.");
    }
    const diagnostics: PersonaDiagnostic[] = [];
    let names: Set<string>;
    try {
      names = await personaNames(this.#directory);
    } catch (error) {
      if (!(error instanceof LarvaError)) throw error;
      this.#diagnostics = [{ code: error.code, message: error.message, path: this.#directory }];
      return [];
    }

    const valid: (PersonaSpec | PersonaSummary)[] = [];
    const checked = new Set<string>();
    for (const { id, path } of candidates(this.#directory, names)) {
      if (!isValidPersonaId(id)) {
        if (diagnostics.length < maxDiagnostics) diagnostics.push({
          code: "LARVA_PERSONA_INVALID", message: "Invalid persona filename stem.", path,
        });
        continue;
      }
      if (checked.has(id)) continue;
      checked.add(id);
      try {
        const spec = await this.#get(id, names);
        valid.push(full ? spec : toPersonaSummary(spec));
      } catch (error) {
        if (!(error instanceof LarvaError)) throw error;
        if (diagnostics.length < maxDiagnostics) diagnostics.push({
          code: error.code, persona_id: id,
          message: error.message,
          ...(error.code === "LARVA_PERSONA_CONFLICT" ? {} : { path }),
        });
      }
    }
    this.#diagnostics = diagnostics;

    const needle = query?.trim().toLowerCase();
    const matches = needle ? valid.map(spec => ({ spec, score: rank(spec, needle) }))
      .filter(item => Number.isFinite(item.score))
      .sort((a, b) => a.score - b.score || compareIds(a.spec.id, b.spec.id))
      .map(item => item.spec) : valid;
    const selected = matches.slice(0, limit);
    return full ? selected.filter(spec => "prompt" in spec) : selected;
  }

  async put(target: string, options: PersonaPutOptions = {}): Promise<PersonaPutResult> {
    const prune = options.prune;
    const inputs = await loadInput(target, options);
    const committed_ids: string[] = [];
    const pruned = new Set<string>();
    let failed_id: string | null = inputs[0]?.spec.id ?? null;
    try {
      await mkdir(dirname(this.#directory), { recursive: true, mode: 0o700 });
      await requireRealDirectory(this.#directory, true);
      return await withPersonaLock(this.#directory, async () => {
        const names = await personaNames(this.#directory);
        for (const { spec } of inputs) {
          failed_id = spec.id;
          await this.#installed(spec.id, names); // Check spelling, without validating the old contents.
        }
        for (const input of inputs) {
          failed_id = input.spec.id;
          this.#cache.delete(failed_id);
          await stageAndRename(this.#directory, input);
          committed_ids.push(failed_id);
          const other = input.format === "md" ? "json" : "md";
          const otherName = `${failed_id}.${other}`;
          if (names.has(otherName)) await unlinkIfPresent(join(this.#directory, otherName));
        }
        if (prune) {
          failed_id = null;
          const incoming = new Set(committed_ids);
          const files = candidates(this.#directory, await readdir(this.#directory));
          // Report IDs with an observed unlink, even if a later unlink of the same ID fails.
          // Include invalid names and both sides of conflicts; no parse is needed to prune.
          for (const { path, id } of files) {
            if (incoming.has(id)) continue;
            failed_id = id;
            this.#cache.delete(id);
            if (await unlinkIfPresent(path)) pruned.add(id);
          }
        }
        failed_id = null;
        return { committed_ids, pruned_ids: [...pruned] };
      });
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Could not finish writing the persona store.${detail}`, {
        committed_ids, pruned_ids: [...pruned], failed_id,
      });
    }
  }

  async rm(ids: readonly string[]): Promise<void> {
    const requested = [...new Set(ids)];
    requested.forEach(assertId);
    if (requested.length === 0) return;
    let failed_id = requested[0];
    try {
      await requireRealDirectory(this.#directory);
    } catch (error) {
      if (isMissing(error)) throw notFound(failed_id);
      throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Cannot access persona directory: ${this.#directory}`);
    }
    try {
      await withPersonaLock(this.#directory, async () => {
        const names = await personaNames(this.#directory);
        const removal: Candidate[] = [];
        for (const id of requested) {
          const files = await this.#installed(id, names);
          if (files.length === 0) throw notFound(id);
          removal.push(...files);
        }
        for (const { id, path } of removal) {
          failed_id = id;
          this.#cache.delete(id);
          await unlinkIfPresent(path);
        }
      });
    } catch (error) {
      if (error instanceof LarvaError) throw error;
      throw new LarvaError("LARVA_STORE_WRITE_FAILED", `Could not remove persona ${failed_id}.`, { failed_id });
    }
  }
}
