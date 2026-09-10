// purpose: distinguish supported captured launch identity from ambient overrides
// usage: node contrib/pi-extension/test-native-launch-context.mjs
// effects: disposable source copy with private inspection exports; no child spawn
// requires: Node 26.7.0 and npm ci
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const packageDir = fileURLToPath(new URL(".", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "larva-launch-contract-"));
const originalArgv = process.argv;
try {
  await symlink(join(packageDir, "node_modules"), join(root, "node_modules"));
  const source = await readFile(join(packageDir, "larva.ts"), "utf8");
  const entry = join(root, "larva.ts");
  await writeFile(entry, source + "\nexport { resolvePiCommandPrefix };\n");
  const cli = join(packageDir, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const alias = join(root, "pi");
  await symlink(cli, alias);
  process.argv = [process.execPath, alias, "--session", "never-copy-me", "private prompt"];
  const supported = await import(pathToFileURL(entry).href + "?supported");
  process.argv = [process.execPath, "/missing/pi", "different parent args"];
  assert.deepEqual(supported.resolvePiCommandPrefix({}), [realpathSync(process.execPath), realpathSync(cli)], "launch identity must be captured once, resolving the installed bin symlink");
  assert.deepEqual(supported.resolvePiCommandPrefix({ LARVA_PI_TEST_CHILD_ARGV_JSON: JSON.stringify(["/usr/bin/true"]), LARVA_PI_REAL_BIN: "/usr/bin/false" }), [realpathSync(process.execPath), realpathSync(cli)], "ambient launch overrides must have no effect");
  const impostor = join(root, "other", "pi");
  await (await import("node:fs/promises")).mkdir(join(root, "other"));
  await writeFile(impostor, "console.log('unrelated program');\n");
  process.argv = [process.execPath, impostor];
  const unsupported = await import(pathToFileURL(entry).href + "?unsupported");
  assert.equal(unsupported.resolvePiCommandPrefix({ LARVA_PI_TEST_CHILD_ARGV_JSON: JSON.stringify([cli]) }).code, "LARVA_CHILD_START_FAILED", "a file named pi without the installed package identity must fail closed");
  console.log(JSON.stringify({ checks: ["captured-native-bin", "no-ambient-launch-override", "unsupported-basename-rejected"], passed: 3 }));
} finally {
  process.argv = originalArgv;
  await rm(root, { recursive: true, force: true });
}
