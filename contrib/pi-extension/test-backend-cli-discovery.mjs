// purpose: verify Larva CLI backend resolution via env, settings.json, and auto-discovery
// usage: node contrib/pi-extension/test-backend-cli-discovery.mjs
// effects: disposable scratch directories only; no global configuration changes
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const key of Object.keys(process.env)) {
  if (/^(LARVA_|PI_)/.test(key) && !key.startsWith("LARVA_TEST_")) delete process.env[key];
}

const root = await mkdtemp(join(tmpdir(), "larva-backend-discovery-"));
try {
  const extensionPath = new URL("./larva.ts", import.meta.url).pathname;
  const mod = await import(pathToFileURL(extensionPath).href);

  // Create fake executable binaries
  const fakeBinA = join(root, "fake-larva-a");
  const fakeBinB = join(root, "fake-larva-b");
  const fakeScript = '#!/bin/sh\necho \'{"data":[{"id":"test-persona","description":"test"}]}\'\n';
  await writeFile(fakeBinA, fakeScript, { mode: 0o755 });
  await writeFile(fakeBinB, fakeScript, { mode: 0o755 });
  await chmod(fakeBinA, 0o755);
  await chmod(fakeBinB, 0o755);

  // 1. Precedence: LARVA_CLI_ARGV_JSON overrides settings.json
  const settingsDir = join(root, "agent");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({ larva: { cliPath: fakeBinB } })
  );

  const envWithBoth = {
    HOME: root,
    PI_CODING_AGENT_DIR: settingsDir,
    LARVA_CLI_ARGV_JSON: JSON.stringify([fakeBinA]),
  };
  mod.resetPersonaCompletionCache();
  const listWithBoth = await mod.listPersonas({ env: envWithBoth });
  assert.equal(listWithBoth.length, 1);
  assert.equal(listWithBoth[0].id, "test-persona");

  // 2. Settings fallback: When LARVA_CLI_ARGV_JSON is absent, settings.json is used
  const envWithSettingsOnly = {
    HOME: root,
    PI_CODING_AGENT_DIR: settingsDir,
  };
  mod.resetPersonaCompletionCache();
  const listWithSettings = await mod.listPersonas({ env: envWithSettingsOnly });
  assert.equal(listWithSettings.length, 1);
  assert.equal(listWithSettings[0].id, "test-persona");

  // Also test larva.cliArgv format in settings.json
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({ larva: { cliArgv: [fakeBinB, "--extra-flag"] } })
  );
  mod.resetPersonaCompletionCache();
  const listWithArgv = await mod.listPersonas({ env: envWithSettingsOnly });
  assert.equal(listWithArgv.length, 1);

  // 3. Auto-discovery fallback: ~/.local/bin/larva
  const emptySettingsDir = join(root, "empty-agent");
  await mkdir(emptySettingsDir, { recursive: true });
  await writeFile(join(emptySettingsDir, "settings.json"), "{}");

  const localBinDir = join(root, ".local", "bin");
  await mkdir(localBinDir, { recursive: true });
  const localBin = join(localBinDir, "larva");
  await writeFile(localBin, fakeScript, { mode: 0o755 });
  await chmod(localBin, 0o755);

  const envWithLocalBin = {
    HOME: root,
    PI_CODING_AGENT_DIR: emptySettingsDir,
    PATH: "/usr/bin:/bin",
  };
  mod.resetPersonaCompletionCache();
  const listWithAuto = await mod.listPersonas({ env: envWithLocalBin });
  assert.equal(listWithAuto.length, 1);
  assert.equal(listWithAuto[0].id, "test-persona");

  // 4. PATH auto-discovery fallback
  const pathBinDir = join(root, "path-bin");
  await mkdir(pathBinDir, { recursive: true });
  const pathBin = join(pathBinDir, "larva");
  await writeFile(pathBin, fakeScript, { mode: 0o755 });
  await chmod(pathBin, 0o755);
  await rm(localBin);

  const envWithPath = {
    HOME: root,
    PI_CODING_AGENT_DIR: emptySettingsDir,
    PATH: `${pathBinDir}:/usr/bin:/bin`,
  };
  mod.resetPersonaCompletionCache();
  const listWithPath = await mod.listPersonas({ env: envWithPath });
  assert.equal(listWithPath.length, 1);
  assert.equal(listWithPath[0].id, "test-persona");

  // 5. Fail-closed: When none of the above exist, listPersonas returns [] and openPersonaSelector throws helpful error
  const emptyEnv = {
    HOME: root,
    PI_CODING_AGENT_DIR: emptySettingsDir,
    PATH: "/usr/bin:/bin",
  };
  mod.resetPersonaCompletionCache();
  const listEmpty = await mod.listPersonas({ env: emptyEnv });
  assert.equal(listEmpty.length, 0);

  let selectorError = null;
  try {
    await mod.openPersonaSelector({
      env: emptyEnv,
      mode: "tui",
      hasUI: true,
      ui: { select: async () => null },
    });
  } catch (err) {
    selectorError = err;
  }
  assert.ok(selectorError !== null, "openPersonaSelector must throw when no backend available");
  assert.equal(selectorError.code, "LARVA_PERSONA_NOT_FOUND");
  assert.match(selectorError.message, /Larva backend CLI is not configured or found/);

  console.log("test-backend-cli-discovery: PASS (env precedence, settings.json, ~/.local/bin, PATH, fail-closed diagnostic)");
} finally {
  await rm(root, { recursive: true, force: true });
}
