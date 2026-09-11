import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export async function proveSessionReplacement(pi, options) {
  const { agentDir, modelRuntime, model, extensionPath, tempRoot } = options;
  // A separate SDK runtime starts in its own cwd; previous single-session SDK
  // fixtures do not own this runtime's extension factory cache or lifecycle.
  const cwd = join(tempRoot, "replacement-project");
  await mkdir(cwd);
  const eventBus = pi.createEventBus();
  const reasonLog = [];
  const replies = () => {
    const values = [];
    eventBus.emit("larva:resolve-system-prompt:v1", { scope: "main", systemPrompt: "lifecycle base", reply: r => values.push(r) });
    return values;
  };
  let sidecarCalls = 0;
  const unsub = eventBus.on("proof:sidecar", () => sidecarCalls++);
  const errors = [];
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await pi.createAgentSessionServices({
      cwd, agentDir, modelRuntime,
      settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: {
        eventBus, additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [api => { api.on("session_start", event => { reasonLog.push(event.reason); }); }],
      },
    });
    const result = await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", tools: [] });
    assert.equal(result.extensionsResult.errors.length, 0);
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: pi.SessionManager.create(cwd, join(tempRoot, "replacement-sessions")) });
  const bind = session => session.bindExtensions({ onError: e => errors.push(e) });
  let retirements = 0;
  runtime.setBeforeSessionInvalidate(() => {
    assert.deepEqual(replies(), [], "old listener retired before runtime invalidation");
    retirements++;
  });
  runtime.setRebindSession(bind);
  const assertCurrent = id => {
    const values = replies();
    assert.equal(values.length, 1);
    assert.equal(values[0].status, "ok");
    if (id === null) assert.equal(values[0].systemPrompt, "lifecycle base");
    else assert.ok(values[0].systemPrompt.includes(`<!-- larva-spec: ${id}@`));
    eventBus.emit("proof:sidecar", {});
  };
  const originalInitial = process.env.LARVA_PI_INITIAL_PERSONA_ID;
  try {
    await bind(runtime.session);
    await runtime.session.prompt("/larva-persona lifecycle-origin");
    await runtime.session.prompt("Persist origin session in loopback.");
    assertCurrent("lifecycle-origin");
    const saved = runtime.session.sessionFile;
    assert.ok(saved);
    const oldSession = runtime.session;
    const oldManager = runtime.session.sessionManager;
    delete process.env.LARVA_PI_INITIAL_PERSONA_ID;
    assert.equal((await runtime.newSession()).cancelled, false);
    assert.notEqual(runtime.session, oldSession);
    assert.notEqual(runtime.session.sessionManager, oldManager);
    assertCurrent(null);
    await runtime.session.prompt("/larva-persona lifecycle-target");
    await runtime.session.prompt("Persist target session in loopback.");
    assertCurrent("lifecycle-target");
    const beforeFork = runtime.session;
    const leaf = runtime.session.sessionManager.getLeafId();
    assert.equal((await runtime.fork(leaf, { position: "at" })).cancelled, false);
    assert.notEqual(runtime.session, beforeFork);
    assertCurrent("lifecycle-target");
    const beforeResume = runtime.session;
    assert.equal((await runtime.switchSession(saved)).cancelled, false);
    assert.notEqual(runtime.session, beforeResume);
    assertCurrent("lifecycle-origin");
    assert.deepEqual(reasonLog, ["startup", "new", "fork", "resume"]);
    assert.equal(retirements, 3);
    assert.equal(sidecarCalls, 5);
    assert.deepEqual(errors, []);
    await Promise.resolve();
    assert.equal(replies().length, 1);
  } finally {
    const beforeDisposeSidecar = sidecarCalls;
    await runtime.dispose();
    assert.deepEqual(replies(), []);
    eventBus.emit("proof:sidecar", {});
    assert.equal(sidecarCalls, beforeDisposeSidecar + 1);
    unsub();
    if (originalInitial === undefined) delete process.env.LARVA_PI_INITIAL_PERSONA_ID;
    else process.env.LARVA_PI_INITIAL_PERSONA_ID = originalInitial;
  }
}
