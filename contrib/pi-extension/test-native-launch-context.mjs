// purpose: distinguish supported captured launch identity from ambient overrides,
// verify semver compatibility range (>= 0.85.0), and test 0.86.1 layout and diagnostics.
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
  const cli = join(packageDir, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const alias = join(root, "pi");
  await symlink(cli, alias);
  process.argv = [process.execPath, alias, "--session", "never-copy-me", "private prompt"];
  const supported = await import(pathToFileURL(entry).href + "?supported");
  process.argv = [process.execPath, "/missing/pi", "different parent args"];
  assert.deepEqual(supported.resolvePiCommandPrefix({}), [realpathSync(process.execPath), realpathSync(cli)], "launch identity must be captured once, resolving the installed bin symlink");
  assert.deepEqual(supported.resolvePiCommandPrefix({ LARVA_PI_TEST_CHILD_ARGV_JSON: JSON.stringify(["/usr/bin/true"]), LARVA_PI_REAL_BIN: "/usr/bin/false" }), [realpathSync(process.execPath), realpathSync(cli)], "ambient launch overrides must have no effect");

  // Version compatibility checks (>= 0.85.0)
  assert.equal(supported.isSupportedPiVersionForTests("0.85.0"), true, "0.85.0 must be supported");
  assert.equal(supported.isSupportedPiVersionForTests("0.85.1"), true, "0.85.1 must be supported");
  assert.equal(supported.isSupportedPiVersionForTests("0.86.0"), true, "0.86.0 must be supported");
  assert.equal(supported.isSupportedPiVersionForTests("0.86.1"), true, "0.86.1 must be supported");
  assert.equal(supported.isSupportedPiVersionForTests("0.90.0"), true, "0.90.0 must be supported");
  assert.equal(supported.isSupportedPiVersionForTests("1.0.0"), true, "1.0.0 must be supported");
  assert.equal(supported.isSupportedPiVersionForTests("0.84.1"), false, "0.84.1 must be rejected");
  assert.equal(supported.isSupportedPiVersionForTests("0.80.0"), false, "0.80.0 must be rejected");
  assert.equal(supported.isSupportedPiVersionForTests("invalid"), false, "invalid semver must be rejected");

  // Test 0.86.1 installation layout
  const pkg86Dir = join(root, "pkg-0-86-1");
  await mkdir(join(pkg86Dir, "dist/bundle"), { recursive: true });
  await writeFile(join(pkg86Dir, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "0.86.1",
    bin: { pi: "dist/bundle/cli.js" },
  }));
  const cli86 = join(pkg86Dir, "dist/bundle/cli.js");
  await writeFile(cli86, "#!/usr/bin/env node\nconsole.log('pi 0.86.1');\n");
  await chmod(cli86, 0o755);
  const alias86 = join(root, "pi-86");
  await symlink(cli86, alias86);
  process.argv = [process.execPath, alias86];
  const supported86 = await import(pathToFileURL(entry).href + "?supported-0-86-1");
  assert.deepEqual(supported86.resolvePiCommandPrefix({}), [realpathSync(process.execPath), realpathSync(cli86)], "0.86.1 install layout must be supported and captured");

  // Test unsupported version (0.84.1) layout: fails closed with actionable diagnostic
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
  const unsupported84 = await import(pathToFileURL(entry).href + "?unsupported-0-84-1");
  const err84 = unsupported84.resolvePiCommandPrefix({});
  assert.equal(err84.code, "LARVA_CHILD_START_FAILED", "unsupported Pi version must fail closed");
  assert.match(err84.message, /Detected Pi version '0\.84\.1' is unsupported.*>= 0\.85\.0/, "unsupported version must name detected version and supported range");

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
      "semver-compatibility-range",
      "layout-0-86-1-supported",
      "unsupported-version-diagnosed",
      "bin-mismatch-diagnosed",
      "package-mismatch-diagnosed",
      "impostor-path-diagnosed",
    ],
    passed: 8,
  }));
} finally {
  process.argv = originalArgv;
  await rm(root, { recursive: true, force: true });
}
