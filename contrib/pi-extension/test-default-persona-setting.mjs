// purpose: verify defaultPersona parsing and native default/explicit/restore precedence
// usage: node contrib/pi-extension/test-default-persona-setting.mjs
// effects: isolated native fixture only; no installed Pi, user settings or credentials
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createNativeFixture, NativeRpc } from "../../scripts/pi-native-support.mjs";
import { resolveDefaultPersonaFromSettings } from "./larva.ts";
const f = await createNativeFixture();
try {
  const agentDir = join(f.root, "parsing"); await mkdir(agentDir);
  const settings = join(agentDir, "settings.json");
  const env = { HOME: f.home, PI_CODING_AGENT_DIR: agentDir };
  await writeFile(settings, JSON.stringify({ larva: { defaultPersona: "general" } }));
  assert.equal(resolveDefaultPersonaFromSettings(env), "general");
  await writeFile(settings, JSON.stringify({ larvaDefaultPersona: "archimedes" }));
  assert.equal(resolveDefaultPersonaFromSettings(env), "archimedes");
  await mkdir(join(f.cwd, ".pi"));
  await writeFile(join(f.cwd, ".pi/settings.json"), JSON.stringify({ larva: { defaultPersona: "forgemaster" } }));
  const cwd = process.cwd();
  try { process.chdir(f.cwd); assert.equal(resolveDefaultPersonaFromSettings(env), "forgemaster"); }
  finally { process.chdir(cwd); }
  await writeFile(settings, JSON.stringify({ larva: { defaultPersona: "INVALID PERSONA" } }));
  assert.equal(resolveDefaultPersonaFromSettings(env), null);
  // Project/global settings are deliberately controlled; no ambient persona is used.
  await writeFile(join(f.cwd, ".pi/settings.json"), "{}");
  await writeFile(join(f.agent, "settings.json"), JSON.stringify({ ...f.settings, larva: { defaultPersona: "ok" } }));
  const persona = snap => snap.value.entries.filter(x => x.type === "custom" && x.customType === "larva-active-persona-commit").at(-1)?.data.persona_id;
  const fresh = new NativeRpc(f);
  await fresh.command("get_state"); await fresh.prompt("Save fresh default history");
  assert.equal(persona(await fresh.snapshot()), "ok"); await fresh.stop();
  const explicit = new NativeRpc(f, ["--larva-persona", "child"]);
  await explicit.command("get_state"); await explicit.prompt("Save explicit identity history");
  const saved = await explicit.snapshot(); assert.equal(persona(saved), "child");
  await explicit.stop();
  const resumed = new NativeRpc(f, ["--session", saved.value.session]);
  await resumed.command("get_state");
  assert.equal(persona(await resumed.snapshot()), "child", "stored persona overrides the default");
  await resumed.stop();
  assert.deepEqual(f.errors, []);
  console.log("defaultPersona: parsing/project override/validation and native fresh/explicit/restore precedence");
} finally { await f.close(); }
