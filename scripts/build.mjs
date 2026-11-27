import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const plugin = join(root, "plugins/codex");
const tui = "@earendil-works/pi-tui";
const entries = {
  "pi-extension.js": "src/pi-extension.ts",
  "cli.mjs": "src/cli.ts",
  "mcp-server.mjs": "src/mcp-server.ts",
  "child-rpc-preload.mjs": "src/child-rpc-preload.ts",
};
const shebang = "#!/usr/bin/env node";
const nodeBuiltins = {
  name: "node-builtins",
  setup(build) {
    build.onResolve({ filter: /^[a-z]/ }, ({ path }) => {
      if (!path.startsWith("node:") && isBuiltin(path)) return { path: `node:${path}`, external: true };
    });
  },
};
const requireBridge = 'import { createRequire as larvaCreateRequire } from "node:module";'
  + '\nconst require = larvaCreateRequire(import.meta.url);';
// import.meta.main arrived after Node 22.0. Compare canonical paths on older Node,
// so a direct entry through a symlink works without starting on ordinary imports.
const mainBridge = `import { realpathSync as larvaRealpath } from "node:fs";
import { fileURLToPath as larvaFilePath } from "node:url";
const larvaIsMain = import.meta.main ?? (() => {
  try {
    return process.argv[1] !== undefined && larvaRealpath(process.argv[1]) === larvaFilePath(import.meta.url);
  } catch { return false; }
})();`;

async function optional(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return undefined;
  }
}

function validateManifest(pkg) {
  const exactVersion = value => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
  const pinned = ["typescript", "esbuild", "@types/node", "@earendil-works/pi-coding-agent", tui, "yaml"];
  const files = pkg.files;
  if (pkg.name !== "pi-larva" || pkg.type !== "module" || pkg.license !== "AGPL-3.0-or-later"
    || !exactVersion(pkg.version) || pkg.engines?.node !== ">=22.0.0"
    || !pinned.every(name => exactVersion(pkg.devDependencies?.[name]))
    || pkg.bin?.larva !== "./dist/cli.mjs" || Object.keys(pkg.bin).length !== 1
    || pkg.pi?.extensions?.length !== 1 || pkg.pi.extensions[0] !== "./dist/pi-extension.js"
    || !Array.isArray(files) || files.length !== 3 || !["dist/", "README.md", "LICENSE"].every(file => files.includes(file))
    || pkg.peerDependencies?.[tui] !== "*" || Object.keys(pkg.peerDependencies).length !== 1
    || (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).length !== 0)
    || (pkg.optionalDependencies !== undefined && Object.keys(pkg.optionalDependencies).length !== 0)) {
    throw new Error("package.json does not match the Larva package contract.");
  }
}

function assertNoTui(text, path) {
  if (text.includes(tui)) throw new Error(`${relative(root, path)} must not reference ${tui}.`);
}

async function scan(dir, includes) {
  for (const entry of (await optional(readdir(dir, { withFileTypes: true }))) ?? []) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scan(path, includes);
    else if (includes(path)) assertNoTui(await readFile(path, "utf8"), path);
  }
}

async function bundle(name, entry, packageVersion) {
  const path = join(dist, name);
  const allowedExternal = name === "pi-extension.js" ? ["node:*", tui] : ["node:*"];
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: path,
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "node",
    target: "node22",
    external: allowedExternal,
    plugins: [nodeBuiltins],
    banner: { js: name === "mcp-server.mjs" ? `${requireBridge}\n${mainBridge}` : requireBridge },
    define: {
      __LARVA_VERSION__: JSON.stringify(packageVersion),
      // Bundling MCP into CLI gives the imported code the CLI's import.meta.
      // Only the standalone MCP bundle may start the server at module entry.
      ...(name === "cli.mjs" ? { "import.meta.main": "false" } : {}),
      ...(name === "mcp-server.mjs" ? { "import.meta.main": "larvaIsMain" } : {}),
    },
    metafile: true,
    write: false,
  });
  const [output] = result.outputFiles;
  if (result.outputFiles.length !== 1 || output.path !== resolve(path)) {
    throw new Error(`Expected only dist/${name} from esbuild.`);
  }
  for (const built of Object.values(result.metafile.outputs)) {
    for (const item of built.imports) {
      if (!item.external) continue;
      if (!(item.path.startsWith("node:") && isBuiltin(item.path)) && !(name === "pi-extension.js" && item.path === tui)) {
        throw new Error(`dist/${name} has a forbidden external import: ${item.path}.`);
      }
    }
  }
  if (name === "child-rpc-preload.mjs" && Object.keys(result.metafile.inputs).some(input => /(?:^|[\\/])node_modules[\\/]yaml[\\/]/.test(resolve(root, input)))) {
    throw new Error(`dist/${name} must not include YAML modules.`);
  }
  if (name.endsWith(".mjs")) assertNoTui(output.text, path);
  if (name !== "cli.mjs") return output.text;
  if (!output.text.startsWith("#!")) return `${shebang}\n${output.text}`;
  if (output.text.split("\n", 1)[0] !== shebang) throw new Error(`dist/${name} must begin with ${shebang}.`);
  return output.text;
}

async function main(args) {
  const [mode] = args;
  if (args.length > 1 || (mode !== undefined && !["--check-only", "--dist-only"].includes(mode))) {
    throw new Error("Usage: node scripts/build.mjs [--check-only | --dist-only]");
  }
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  validateManifest(pkg);

  for (const dir of ["core", "store", "runtime", "activity"]) {
    await scan(join(root, "src", dir), () => true);
  }
  const codexDist = join(plugin, "dist");
  if (mode === "--check-only") {
    for (const dir of [dist, codexDist]) await scan(dir, path => path.endsWith(".mjs"));
  }

  const outputs = new Map();
  for (const [name, entry] of Object.entries(entries)) {
    if (mode === "--check-only" && !await optional(stat(join(root, entry)))) continue;
    outputs.set(name, await bundle(name, entry, pkg.version));
  }
  if (mode === "--check-only") return;

  const pluginManifestPath = join(plugin, ".codex-plugin/plugin.json");
  const raw = mode === "--dist-only" ? undefined : await optional(readFile(pluginManifestPath, "utf8"));
  const manifest = raw === undefined ? undefined : JSON.parse(raw);
  if (raw !== undefined && (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))) {
    throw new Error("Expected a Codex plugin manifest object.");
  }

  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  for (const [name, text] of outputs) await writeFile(join(dist, name), text);
  await chmod(join(dist, "cli.mjs"), 0o755);
  if (mode === "--dist-only") return;

  await rm(codexDist, { recursive: true, force: true });
  await mkdir(codexDist, { recursive: true });
  for (const [name, text] of outputs) {
    if (name !== "cli.mjs") await writeFile(join(codexDist, name), text);
  }
  await writeFile(join(codexDist, "package.json"), '{"type":"module"}\n');
  if (manifest !== undefined && manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    await writeFile(pluginManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

await main(process.argv.slice(2));
