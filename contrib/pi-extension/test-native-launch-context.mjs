// purpose: distinguish captured package/bin identity from ambient overrides
// and reject mismatched scripts without restricting runtime versions.
// usage: node contrib/pi-extension/test-native-launch-context.mjs
// effects: disposable source copy with private inspection exports; no child spawn
// requires: Node 26.7.0 and npm ci
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, chmod } from "node:fs/promises";
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
  await symlink(join(packageDir, "activity.ts"), join(root, "activity.ts"));
  const cli = join(packageDir, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const alias = join(root, "pi");
  await symlink(cli, alias);
  process.argv = [process.execPath, alias, "--session", "never-copy-me", "private prompt"];
  const supported = await import(pathToFileURL(entry).href + "?supported");
  process.argv = [process.execPath, "/missing/pi", "different parent args"];
  assert.deepEqual(supported.resolvePiCommandPrefix({}), [realpathSync(process.execPath), realpathSync(cli)], "launch identity must be captured once, resolving the installed bin symlink");
  assert.deepEqual(supported.resolvePiCommandPrefix({ LARVA_PI_TEST_CHILD_ARGV_JSON: JSON.stringify(["/usr/bin/true"]), LARVA_PI_REAL_BIN: "/usr/bin/false" }), [realpathSync(process.execPath), realpathSync(cli)], "ambient launch overrides must have no effect");

  // Version metadata cannot veto an otherwise valid captured package/bin.
  const pkg84Dir = join(root, "pkg-0-84-1");
  await mkdir(join(pkg84Dir, "dist/bundle"), { recursive: true });
  await writeFile(join(pkg84Dir, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.1",
    bin: { pi: "dist/bundle/cli.js" },
  }));
  const cli84 = join(pkg84Dir, "dist/bundle/cli.js");
  await writeFile(cli84, "#!/usr/bin/env node\nconsole.log('pi 0.84.1');\n");
  await chmod(cli84, 0o755);
  const alias84 = join(root, "pi-84");
  await symlink(cli84, alias84);
  process.argv = [process.execPath, alias84];
  const metadataOnly = await import(pathToFileURL(entry).href + "?metadata-only");
  assert.deepEqual(metadataOnly.resolvePiCommandPrefix({}), [realpathSync(process.execPath), realpathSync(cli84)]);

  // Test bin mapping mismatch layout
  const pkgMismatchDir = join(root, "pkg-bin-mismatch");
  await mkdir(join(pkgMismatchDir, "dist/bundle"), { recursive: true });
  await writeFile(join(pkgMismatchDir, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "0.86.1",
    bin: { pi: "dist/bundle/cli.js" },
  }));
  const expectedCli = join(pkgMismatchDir, "dist/bundle/cli.js");
  await writeFile(expectedCli, "#!/usr/bin/env node\nconsole.log('expected');\n");
  await chmod(expectedCli, 0o755);
  const otherCli = join(pkgMismatchDir, "dist/bundle/other.js");
  await writeFile(otherCli, "#!/usr/bin/env node\nconsole.log('other');\n");
  await chmod(otherCli, 0o755);
  process.argv = [process.execPath, otherCli];
  const unsupportedMismatch = await import(pathToFileURL(entry).href + "?bin-mismatch");
  const errMismatch = unsupportedMismatch.resolvePiCommandPrefix({});
  assert.equal(errMismatch.code, "LARVA_CHILD_START_FAILED", "bin mismatch must fail closed");
  assert.match(errMismatch.message, /does not match package bin\.pi path/, "bin mismatch diagnostic must be explicit");

  // Test package name mismatch layout
  const pkgWrongNameDir = join(root, "pkg-wrong-name");
  await mkdir(pkgWrongNameDir, { recursive: true });
  await writeFile(join(pkgWrongNameDir, "package.json"), JSON.stringify({
    name: "@other/pi-clone",
    version: "0.86.1",
    bin: { pi: "cli.js" },
  }));
  const wrongCli = join(pkgWrongNameDir, "cli.js");
  await writeFile(wrongCli, "#!/usr/bin/env node\nconsole.log('wrong');\n");
  await chmod(wrongCli, 0o755);
  process.argv = [process.execPath, wrongCli];
  const unsupportedWrongName = await import(pathToFileURL(entry).href + "?wrong-name");
  const errWrongName = unsupportedWrongName.resolvePiCommandPrefix({});
  assert.equal(errWrongName.code, "LARVA_CHILD_START_FAILED", "wrong package name must fail closed");
  assert.match(errWrongName.message, /expected '@earendil-works\/pi-coding-agent'/, "package name mismatch diagnostic must be explicit");

  // Test impostor script (no package.json)
  const impostor = join(root, "other", "pi");
  await mkdir(join(root, "other"), { recursive: true });
  await writeFile(impostor, "console.log('unrelated program');\n");
  process.argv = [process.execPath, impostor];
  const unsupported = await import(pathToFileURL(entry).href + "?unsupported");
  const errImpostor = unsupported.resolvePiCommandPrefix({ LARVA_PI_TEST_CHILD_ARGV_JSON: JSON.stringify([cli]) });
  assert.equal(errImpostor.code, "LARVA_CHILD_START_FAILED", "a file named pi without the installed package identity must fail closed");
  assert.match(errImpostor.message, /No package\.json manifest found/i, "path abnormality diagnostic must state manifest missing");

  console.log(JSON.stringify({
    checks: [
      "captured-native-bin",
      "no-ambient-launch-override",
      "version-metadata-does-not-veto-launch",
      "bin-mismatch-diagnosed",
      "package-mismatch-diagnosed",
      "impostor-path-diagnosed",
    ],
    passed: 6,
  }));
} finally {
  process.argv = originalArgv;
  await rm(root, { recursive: true, force: true });
}
