import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { LarvaError } from "../../src/core/errors.ts";
import { discoverPiInstallation } from "../../src/runtime/pi-binary.ts";
import { createCapsule } from "../../src/store/capsule.ts";

const preload = fileURLToPath(new URL("../../src/child-rpc-preload.ts", import.meta.url));
const npmBin = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const limit = 1_048_576;
const cap = {
  capability: "larva-child-rpc-frame-preload-v1",
  max_record_bytes: limit,
  framing: "lf-only",
  terminal: "agent_settled",
};

function temporaryRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "larva-preload-")));
}

function fixture(root: string, capsule = join(root, "larva", "state", "capsules", `child-${process.pid}-0000000000000000`)) {
  const home = join(root, "larva");
  const agent = join(capsule, "agent");
  mkdirSync(agent, { recursive: true });
  const env = {
    HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
    PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", LARVA_HOME: home, LARVA_PI_CAPSULE_ROOT: capsule, LARVA_PI_LAUNCHED: "1",
  };
  const args = ["--mode", "rpc", "--larva-persona", "fixture"];
  const script = join(root, "writer.mjs");
  function run(source: string, override: NodeJS.ProcessEnv = env, argv = args) {
    writeFileSync(script, source);
    return spawnSync(process.execPath, ["--import", preload, script, ...argv], {
      cwd: root, env: override, encoding: "utf8", timeout: 10_000, maxBuffer: 3 * limit,
    });
  }
  return { home, capsule, agent, env, args, run };
}

const protocolError = {
  type: "larva_rpc_frame_error",
  error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "Child RPC frame exceeds 1048576 bytes." },
};

test("standalone preload caps complete and fragmented UTF-8 frames, signaling loss and resuming at LF", () => {
  const root = temporaryRoot();
  try {
    const { run, capsule } = fixture(root);
    const child = run(String.raw`
      const prefix = '{"text":"';
      const exact = Buffer.from(prefix + 'é'.repeat(524282) + 'a"}');
      const split = exact.indexOf(0xc3) + 1;
      await new Promise(resolve => process.stdout.write(exact.subarray(0, split), resolve));
      process.stdout.write(exact.subarray(split));
      process.stdout.write('\n');
      process.stdout.write(exact);
      process.stdout.write('x');
      process.stdout.write('discarded-tail\n{"type":"following"}\n');
      process.stdout.write(Buffer.from([0xff, 0x0a]));
      const bridge = globalThis[Symbol.for('larva.pi.child-rpc-frame-preload.v1')];
      bridge.emit([JSON.stringify({extra: 'z'.repeat(1048576)})]);
      process.stdout.write('{"type":"last"}\n');
    `);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    const lines = child.stdout.trimEnd().split("\n");
    assert.equal(Buffer.byteLength(lines[0]!), limit);
    assert.equal(JSON.parse(lines[0]!).text, "é".repeat(524282) + "a");
    assert.deepEqual(lines.slice(1).map(line => JSON.parse(line)), [
      protocolError, { type: "following" },
      { ...protocolError, error: { ...protocolError.error, message: "Child RPC frame is not a UTF-8 JSON object." } },
      protocolError, { type: "last" },
    ]);
    const file = join(capsule, "child_self.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pid: child.pid });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(capsule).sort(), ["agent", "child_self.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone handshake and terminal synthesis preserve the definitive Pi settlement boundary", () => {
  const root = temporaryRoot();
  try {
    const { run } = fixture(root);
    const child = run(`
      const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
      send({ type: 'response', command: 'get_state', id: 'state', success: true, data: { model: 'sample' } });
      send({ type: 'response', command: 'get_state', id: 'failed', success: false });
      send({ type: 'agent_end', willRetry: true });
      send({ type: 'agent_end', willRetry: false });
      send({ type: 'agent_settled', aborted: true, ignored: 'redundant' });
      send({ type: 'agent_settled', aborted: false });
    `);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(child.stdout.trimEnd().split("\n").map(line => JSON.parse(line)), [
      { type: "response", command: "get_state", id: "state", success: true, data: { model: "sample", larvaChildRpcFrame: cap } },
      { type: "response", command: "get_state", id: "failed", success: false },
      { type: "agent_end", willRetry: true },
      { type: "agent_end", willRetry: false },
      { type: "agent_settled", aborted: true },
      { type: "agent_settled", aborted: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone preload publishes its PID and advertises get_state capability in a store-created capsule", async () => {
  const root = temporaryRoot();
  try {
    const { root: capsule } = await createCapsule({
      home: join(root, "larva"), pi_agent_dir: join(root, "pi"), extension_sources: [],
    });
    const { run } = fixture(root, capsule);
    const response = { type: "response", command: "get_state", id: "state", success: true, data: {} };
    const child = run(`process.stdout.write(${JSON.stringify(JSON.stringify(response) + "\n")});`);
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(capsule, "child_self.json"), "utf8")), { pid: child.pid });
    assert.deepEqual(JSON.parse(child.stdout), { ...response, data: { larvaChildRpcFrame: cap } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capsule PID publication rejects escaped, occupied, and foreign roots; non-RPC tools are untouched", () => {
  const root = temporaryRoot();
  try {
    const { run, home, capsule, env } = fixture(root);
    const outside = join(root, "outside");
    mkdirSync(outside);
    const outsideCapsule = join(outside, `child-${process.pid}-0000000000000000`);
    mkdirSync(outsideCapsule);
    const escaped = join(home, "state", "capsules", `child-${process.pid}-0000000000000001`);
    symlinkSync(outsideCapsule, escaped);
    const target = join(outside, "protected.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(capsule, "child_self.json"));
    const foreign = join(home, "state", "capsules", `child-${process.pid + 1}-0000000000000000`);
    mkdirSync(foreign);
    for (const invalid of [outsideCapsule, escaped, capsule, foreign]) {
      const child = run("process.stdout.write('not reached');", { ...env, LARVA_PI_CAPSULE_ROOT: invalid });
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /could not record child_self\.json/);
      assert.equal(child.stdout, "");
    }
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.deepEqual(readdirSync(outsideCapsule), []);
    assert.deepEqual(readdirSync(foreign), []);
    assert.deepEqual(readdirSync(capsule).sort(), ["agent", "child_self.json"]);
    const inherited = run("process.stdout.write('ordinary output');", { ...env, LARVA_PI_CAPSULE_ROOT: outsideCapsule }, []);
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.equal(inherited.stdout, "ordinary output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function packageBin(directory: string, pkg: unknown): string {
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(pkg));
  const path = join(directory, "dist", "cli.js");
  writeFileSync(path, "throw new Error('discovery must not execute a CLI');\n", { mode: 0o700 });
  return path;
}

const wrongPackage = { name: "not-pi", bin: { pi: "dist/cli.js" } };
const piPackage = { name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" }, version: "999.1.0-beta" };
const startFailure = (error: unknown) => error instanceof LarvaError && error.code === "LARVA_CHILD_START_FAILED";

test("Pi discovery verifies authoritative overrides, then chooses the first verified PATH identity", async () => {
  const root = temporaryRoot();
  try {
    const fakePath = join(root, "bad");
    const verifiedPath = join(root, "good");
    for (const dir of [fakePath, verifiedPath]) mkdirSync(dir);
    const fake = packageBin(join(root, "bad-package"), wrongPackage);
    const verified = packageBin(join(root, "good-package"), piPackage);
    const wrongBin = join(root, "good-package", "dist", "other.js");
    writeFileSync(wrongBin, "// not bin.pi");
    symlinkSync(fake, join(fakePath, "pi"));
    symlinkSync(verified, join(verifiedPath, "pi"));
    const PATH = ["relative", "", fakePath, verifiedPath, npmBin].join(delimiter);
    assert.deepEqual(await discoverPiInstallation({ PATH }), { path: verified, version: piPackage.version });
    assert.equal((await discoverPiInstallation({ PATH, LARVA_PI_CLI_SCRIPT: join(npmBin, "pi") })).path, realpathSync(join(npmBin, "pi")));
    for (const LARVA_PI_CLI_SCRIPT of ["", "   ", "./pi", fake, wrongBin, join(root, "missing")]) {
      await assert.rejects(discoverPiInstallation({ PATH, LARVA_PI_CLI_SCRIPT }), startFailure);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed launcher discovery verifies the selected release and refuses traversal or bin symlink escape", async () => {
  const root = temporaryRoot();
  try {
    const binDir = join(root, "agent", "bin");
    const install = join(root, "agent", "install");
    const nodeModules = join(install, "releases", "fixture", "node_modules");
    const binLink = join(nodeModules, ".bin", "pi");
    const version = join(install, "current-version");
    const verified = packageBin(join(nodeModules, "@earendil-works", "pi-coding-agent"), piPackage);
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(nodeModules, ".bin"));
    writeFileSync(join(binDir, "pi"), "#!/bin/sh\nexit 77\n", { mode: 0o700 });
    symlinkSync(verified, binLink);
    writeFileSync(version, "fixture\n");
    assert.equal((await discoverPiInstallation({ PATH: binDir })).path, verified);
    chmodSync(verified, 0o600);
    await assert.rejects(discoverPiInstallation({ PATH: binDir }), startFailure);
    chmodSync(verified, 0o700);
    writeFileSync(version, "../fixture\n");
    await assert.rejects(discoverPiInstallation({ PATH: binDir }), startFailure);
    writeFileSync(version, "fixture\n");
    rmSync(binLink);
    symlinkSync(packageBin(join(root, "elsewhere"), piPackage), binLink);
    await assert.rejects(discoverPiInstallation({ PATH: binDir }), startFailure);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry uses the base Pi agent dir instead of the capsule and rereads private models without writes", () => {
  const root = temporaryRoot();
  try {
    const { agent: capsuleAgent, env, run } = fixture(root);
    const agent = join(root, "base-agent");
    mkdirSync(agent);
    const moduleUrl = new URL("../../src/runtime/pi-binary.ts", import.meta.url).href;
    const models = join(agent, "models.json");
    const settings = join(agent, "settings.json");
    writeFileSync(settings, "{}\n");
    const child = run(`
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { discoverPiInstallation, resolveModelInRegistry } from ${JSON.stringify(moduleUrl)};
      const pi = await discoverPiInstallation();
      const models = ${JSON.stringify(models)};
      const route = { provider: 'fixture-provider', model_id: 'org/test-model' };
      const config = JSON.stringify({ providers: { [route.provider]: {
        baseUrl: 'https://id.example.com', api: 'openai-completions', models: [{ id: route.model_id }],
      } } });
      writeFileSync(models, config);
      assert.deepEqual(await resolveModelInRegistry(pi, route), route);
      assert.deepEqual(await resolveModelInRegistry(pi, route, '~/base-agent'), route);
      assert.equal(await resolveModelInRegistry(pi, route, process.env.PI_CODING_AGENT_DIR), null);
      assert.equal(await resolveModelInRegistry(pi, { ...route, model_id: 'test-model' }), null);
      assert.equal(readFileSync(models, 'utf8'), config);
      writeFileSync(models, '{"providers":{}}');
      assert.equal(await resolveModelInRegistry(pi, route), null);
      writeFileSync(models, '{"private-data":');
      await assert.rejects(resolveModelInRegistry(pi, route), error =>
        error.code === 'LARVA_MODEL_UNAVAILABLE' && !error.message.includes('private-data'));
    `, { ...env, PATH: npmBin, LARVA_PI_BASE_AGENT_DIR: "~/base-agent" }, []);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(readdirSync(capsuleAgent), []);
    assert.deepEqual(readdirSync(agent).sort(), ["models.json", "settings.json"]);
    assert.equal(readFileSync(settings, "utf8"), "{}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real Pi RPC writer advertises preload capability with a private agent directory", async () => {
  const root = temporaryRoot();
  try {
    const { capsule, env, args } = fixture(root);
    const pi = await discoverPiInstallation({ PATH: npmBin });
    const bundledPreload = join(root, "child-rpc-preload.mjs");
    const built = await build({ entryPoints: [preload], outfile: bundledPreload, bundle: true,
      platform: "node", format: "esm", metafile: true });
    const imports = Object.values(built.metafile.outputs).flatMap(output => output.imports);
    assert.ok(imports.every(item => item.external && item.path.startsWith("node:")));
    const extension = join(root, "flag.mjs");
    writeFileSync(extension, `export default pi => pi.registerFlag('larva-persona', { type: 'string' });\n`);
    const child = spawnSync(process.execPath, ["--import", bundledPreload, pi.path,
      "--no-extensions", "--no-session", "-e", extension, ...args], {
      cwd: root, env, encoding: "utf8", timeout: 15_000,
      input: JSON.stringify({ id: "probe", type: "get_state" }) + "\n",
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message || "Pi exited unsuccessfully.");
    const frames = child.stdout.trimEnd().split("\n").map(line => JSON.parse(line));
    const state = frames.find(frame => frame.id === "probe");
    assert.equal(state?.success, true, child.stderr);
    assert.deepEqual(state.data.larvaChildRpcFrame, cap);
    assert.ok(existsSync(join(capsule, "child_self.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
