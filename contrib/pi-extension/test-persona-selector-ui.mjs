import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const extensionUrl = pathToFileURL(join(root, "contrib", "pi-extension", "larva.ts")).href;
const fakeCli = join(root, "tests", "fixtures", "pi", "fake-larva-cli.mjs");
const mod = await import(extensionUrl);

const theme = {
  fg: (_token, text) => text,
  bold: (text) => text,
};

const keybindings = {
  matches(data, keybindingId) {
    const mapped = {
      "tui.select.cancel": ["escape", "\x1b"],
      "app.interrupt": ["ctrl+c"],
      "tui.select.confirm": ["enter", "\n", "\r"],
      "tui.input.submit": ["enter", "\n", "\r"],
      "tui.select.down": ["down", "arrowdown"],
      "tui.editor.cursorDown": ["down", "arrowdown"],
      "tui.select.up": ["up", "arrowup"],
      "tui.editor.cursorUp": ["up", "arrowup"],
    };
    return mapped[keybindingId]?.includes(data) === true;
  },
};

function baseEnv(home, interactive = "1") {
  return {
    HOME: home,
    LARVA_CLI_ARGV_JSON: JSON.stringify([process.execPath, fakeCli]),
    LARVA_PI_INITIAL_PERSONA_ID: "",
    LARVA_PI_INTERACTIVE_TUI: interactive,
    LARVA_PI_LAUNCHED: "0",
  };
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "larva-persona-selector-"));
}

function stripSelectorFrame(line) {
  if (line.startsWith("│ ") && line.endsWith(" │")) return line.slice(2, -2).trimEnd();
  return line;
}

function linesContaining(lines, tokens) {
  return lines.map(stripSelectorFrame).filter((line) => tokens.some((token) => line.includes(token)));
}

function allLinesFit(lines, width) {
  return lines.every((line) => visibleWidth(line) <= width);
}

function selectorLinesBoxed(lines, width) {
  return lines.length >= 3
    && lines[0].startsWith("╭─ Select Larva persona")
    && lines.at(-1).startsWith("╰")
    && lines.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith(" │"))
    && allLinesFit(lines, width);
}

function selectorFrameStable(renderedStates) {
  const [first, ...rest] = renderedStates;
  return Boolean(first)
    && rest.every((lines) => lines.length === first.length && lines[0] === first[0] && lines.at(-1) === first.at(-1));
}

function makePiRecorder(env, custom) {
  const calls = {
    models: [],
    activeTools: [],
    statuses: [],
    modelFinds: [],
    customCalls: 0,
    selectCalls: 0,
    openSelectorCalls: 0,
  };
  const ctx = {
    env,
    hasUI: true,
    modelRegistry: {
      find(provider, modelId) {
        calls.modelFinds.push([provider, modelId]);
        return { provider, modelId };
      },
    },
    getAllTools() {
      return [{ name: "read" }, { name: "bash" }, { name: "edit" }];
    },
    setActiveTools(tools) {
      calls.activeTools.push([...tools]);
      return true;
    },
    setModel(model) {
      calls.models.push(model);
      return true;
    },
    ui: {
      setStatus(key, status) {
        calls.statuses.push([key, status]);
      },
      notify() {},
      custom,
    },
  };
  return { ctx, calls };
}

function selectorComponentEvidence() {
  let doneValue = undefined;
  const personas = [
    {
      id: "qa-dev",
      description: "Quality developer non-prefix match",
      model: "openrouter/qa-dev",
      spec_digest: "sha256:qa-dev",
      capabilities: { shell: "read_only", edit: "read_write", browser: "none" },
    },
    {
      id: "DevOps",
      description: "Operations developer prefix match",
      model: "openrouter/devops",
      spec_digest: "sha256:DevOps",
      capabilities: { deploy: "read_write", shell: "read_only" },
    },
    {
      id: "devrel",
      description: "Developer relations prefix match",
      model: "openrouter/devrel",
      spec_digest: "sha256:devrel",
      capabilities: { docs: "read_write", browser: "read_only" },
    },
    {
      id: "backend-dev",
      description: "Backend developer non-prefix match",
      model: "openrouter/backend-dev",
      spec_digest: "sha256:backend-dev",
      capabilities: {},
    },
  ];
  const tui = { renderRequests: 0, requestRender() { this.renderRequests += 1; } };
  const selector = new mod.LarvaPersonaSelector({ personas, theme, keybindings, tui, done: (value) => { doneValue = value; } });
  const initial = selector.render(96);
  const narrowInitial = selector.render(40);
  selector.handleInput("dev");
  const filtered = selector.render(96);
  const narrowFiltered = selector.render(40);
  const afterFilterDetail = linesContaining(filtered, ["ID:", "Model:", "Description:", "Capabilities:", "Digest:"]);
  selector.handleInput("down");
  const afterDown = selector.render(96);
  const narrowAfterDown = selector.render(40);
  const afterDownDetail = linesContaining(afterDown, ["ID:", "Model:", "Description:", "Capabilities:", "Digest:"]);
  selector.handleInput("up");
  const afterUp = selector.render(96);
  selector.handleInput("down");
  selector.handleInput("\x1b[<0;12;4M");
  const afterClick = selector.render(96);
  selector.handleInput("enter");
  return {
    className: selector.constructor.name,
    initialUsesFilterInput: initial.some((line) => line.includes("Filter:")),
    initialUsesDetailPanel: initial.some((line) => line.includes("Detail")),
    filteredOrder: mod.rankPersonasForSelector(personas, "dev").map((persona) => persona.id),
    afterFilterDetail,
    afterDownDetail,
    clickNoOp: JSON.stringify(afterClick) === JSON.stringify(afterDown),
    enterResult: doneValue,
    renderRequests: tui.renderRequests,
    allLinesFit: [initial, filtered, afterDown, afterClick].every((lines) => allLinesFit(lines, 96)) && allLinesFit(narrowInitial, 40),
    selectorBoxed: [initial, filtered, afterDown, afterUp, afterClick].every((lines) => selectorLinesBoxed(lines, 96)) && [narrowInitial, narrowFiltered, narrowAfterDown].every((lines) => selectorLinesBoxed(lines, 40)),
    selectorFrameStable: selectorFrameStable([initial, filtered, afterDown, afterUp, afterClick]) && selectorFrameStable([narrowInitial, narrowFiltered, narrowAfterDown]),
    renderedLineCounts: [initial, filtered, afterDown, afterUp, afterClick].map((lines) => lines.length),
    narrowRenderedLineCounts: [narrowInitial, narrowFiltered, narrowAfterDown].map((lines) => lines.length),
    capabilitySummaryShown: afterFilterDetail.some((line) => line.includes("deploy:read_write") || line.includes("shell:read_only")),
    digestShown: afterFilterDetail.some((line) => line.includes("sha256:DevOps")),
  };
}

async function commitThroughCommandEvidence() {
  mod.resetPersonaCompletionCache();
  const env = baseEnv(await tempHome(), "1");
  let componentName = null;
  let beforeFilter = [];
  let afterFilter = [];
  let selectedByCustom = null;
  const { ctx, calls } = makePiRecorder(env, async (factory) => {
    calls.customCalls += 1;
    let doneValue = null;
    const tui = { requestRender() {} };
    const component = factory(tui, theme, keybindings, (value) => { doneValue = value; });
    componentName = component.constructor.name;
    beforeFilter = component.render(100);
    component.handleInput("vectl");
    afterFilter = component.render(100);
    component.handleInput("enter");
    selectedByCustom = doneValue;
    return doneValue;
  });
  const result = await mod.handlePersonaCommand("", ctx, ctx);
  return {
    ok: result.ok,
    envelopePersona: result.ok ? result.envelope.persona_id : null,
    selectedByCustom,
    componentName,
    beforeFilterHasInput: beforeFilter.some((line) => line.includes("Filter:")),
    afterFilterShowsVectlPlanner: afterFilter.some((line) => line.includes("vectl-planner")),
    afterFilterShowsDigest: afterFilter.some((line) => line.includes("sha256:vectl-planner")),
    customCalls: calls.customCalls,
    modelFinds: calls.modelFinds,
    modelSetCount: calls.models.length,
    activeToolsSetCount: calls.activeTools.length,
    statuses: calls.statuses,
  };
}

async function cancelEvidence() {
  mod.resetPersonaCompletionCache();
  const env = baseEnv(await tempHome(), "1");
  const { ctx, calls } = makePiRecorder(env, async (factory) => {
    calls.customCalls += 1;
    let doneValue = "not-called";
    const component = factory({ requestRender() {} }, theme, keybindings, (value) => { doneValue = value; });
    component.handleInput("escape");
    return doneValue;
  });
  const initial = await mod.commitPersona("ok", ctx, ctx);
  const modelCountAfterInitial = calls.models.length;
  const toolCountAfterInitial = calls.activeTools.length;
  const cancelled = await mod.handlePersonaCommand("", ctx, ctx);
  return {
    initialOk: initial.ok,
    cancelledOk: cancelled.ok,
    cancelCode: cancelled.ok ? null : cancelled.error.code,
    activePersonaAfterCancel: mod.getActiveEnvelope()?.persona_id ?? null,
    noAdditionalModelSet: calls.models.length === modelCountAfterInitial,
    noAdditionalToolSet: calls.activeTools.length === toolCountAfterInitial,
    customCalls: calls.customCalls,
  };
}

async function fallbackEvidence() {
  mod.resetPersonaCompletionCache();
  const env = baseEnv(await tempHome(), "1");
  const selectCalls = { select: 0, openSelector: 0, custom: 0 };
  const selectCtx = {
    env,
    ui: {
      select: async () => { selectCalls.select += 1; return "ok"; },
    },
  };
  const selectResult = await mod.openPersonaSelector(selectCtx);

  const throwingCtx = {
    env,
    ui: {
      custom: async () => { selectCalls.custom += 1; throw new Error("custom unavailable"); },
      select: async () => { selectCalls.select += 1; return "startup"; },
    },
  };
  const throwingFallback = await mod.openPersonaSelector(throwingCtx);

  const openSelectorCtx = {
    env,
    openSelector: async (options) => {
      selectCalls.openSelector += 1;
      return options.some((option) => option.id === "child") ? "child" : null;
    },
  };
  const openSelectorResult = await mod.openPersonaSelector(openSelectorCtx);

  const nonInteractiveCalls = { custom: 0, select: 0, openSelector: 0 };
  const nonInteractiveCtx = {
    env: baseEnv(await tempHome(), "0"),
    hasUI: true,
    ui: {
      custom: async () => { nonInteractiveCalls.custom += 1; return "ok"; },
      select: async () => { nonInteractiveCalls.select += 1; return "ok"; },
    },
    openSelector: async () => { nonInteractiveCalls.openSelector += 1; return "ok"; },
  };
  const nonInteractive = await mod.handlePersonaCommand("", nonInteractiveCtx, nonInteractiveCtx);

  const missingUiCtx = { env };
  const missingUi = await mod.handlePersonaCommand("", missingUiCtx, missingUiCtx);

  return {
    uiSelectResult: selectResult,
    customThrowFallsBackToSelect: throwingFallback,
    openSelectorResult,
    selectCalls,
    nonInteractiveOk: nonInteractive.ok,
    nonInteractiveCode: nonInteractive.ok ? null : nonInteractive.error.code,
    nonInteractiveCalls,
    missingUiOk: missingUi.ok,
    missingUiCode: missingUi.ok ? null : missingUi.error.code,
  };
}

const detail = selectorComponentEvidence();
const commit = await commitThroughCommandEvidence();
const cancel = await cancelEvidence();
const fallback = await fallbackEvidence();

console.log(JSON.stringify({
  detail,
  commit,
  cancel,
  fallback,
  assertions: {
    enhancedComponentUsesInputSelectListDetail: detail.className === "LarvaPersonaSelector" && detail.initialUsesFilterInput && detail.initialUsesDetailPanel,
    detailPanelHasCapabilitiesAndDigest: detail.capabilitySummaryShown && detail.digestShown,
    filteringRankingDeterministic: JSON.stringify(detail.filteredOrder) === JSON.stringify(["DevOps", "devrel", "qa-dev", "backend-dev"]),
    enterCommitsThroughCommand: commit.ok && commit.envelopePersona === "vectl-planner" && commit.selectedByCustom === "vectl-planner" && commit.modelSetCount >= 1 && commit.activeToolsSetCount >= 1,
    escCancelPreservesActiveState: cancel.initialOk && !cancel.cancelledOk && cancel.cancelCode === "LARVA_BAD_INPUT" && cancel.activePersonaAfterCancel === "ok" && cancel.noAdditionalModelSet && cancel.noAdditionalToolSet,
    fallbackPreserved: fallback.uiSelectResult === "ok" && fallback.customThrowFallsBackToSelect === "startup" && fallback.openSelectorResult === "child" && !fallback.nonInteractiveOk && fallback.nonInteractiveCode === "LARVA_BAD_INPUT" && fallback.nonInteractiveCalls.custom === 0 && fallback.nonInteractiveCalls.select === 0 && fallback.nonInteractiveCalls.openSelector === 0 && !fallback.missingUiOk && fallback.missingUiCode === "LARVA_BAD_INPUT",
    mouseClickUnsupportedNoOp: detail.clickNoOp,
    renderLinesWithinWidth: detail.allLinesFit,
    selectorOverlayBordered: detail.selectorBoxed,
    selectorFrameStableDuringNavigation: detail.selectorFrameStable,
  },
}, null, 2));
