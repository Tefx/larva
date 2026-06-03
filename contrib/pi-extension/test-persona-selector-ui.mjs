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

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SELECTOR_SURFACE_BG = "\x1b[48;5;235m";
const SELECTOR_BORDER_FG = "\x1b[38;5;116m";
const SELECTOR_SHADOW_FG = "\x1b[38;5;232m";

function stripAnsi(line) {
  return line.replace(ANSI_RE, "");
}

function selectorSurfaceRows(lines) {
  const lastPlain = stripAnsi(lines.at(-1) ?? "");
  return /^ ▀+$/.test(lastPlain) ? lines.slice(0, -1) : lines;
}

function stripSelectorShadow(line) {
  const plain = stripAnsi(line);
  return plain.endsWith("█") ? plain.slice(0, -1) : plain;
}

function stripSelectorFrame(line) {
  const plain = stripSelectorShadow(line);
  if (plain.startsWith("│ ") && plain.endsWith(" │")) return plain.slice(2, -2).trimEnd();
  return plain;
}

function linesContaining(lines, tokens) {
  return selectorSurfaceRows(lines).map(stripSelectorFrame).filter((line) => tokens.some((token) => line.includes(token)));
}

function allLinesFit(lines, width) {
  return lines.every((line) => visibleWidth(line) <= width);
}

function selectorLinesBoxed(lines, width) {
  const surfaceRows = selectorSurfaceRows(lines);
  const plainRows = surfaceRows.map(stripSelectorShadow);
  return lines.length >= 4
    && plainRows[0].startsWith("╭─ Select Larva persona")
    && plainRows.at(-1).startsWith("╰")
    && plainRows.slice(1, -1).every((line) => (line.startsWith("│ ") && line.endsWith(" │")) || (line.startsWith("├") && line.endsWith("┤")))
    && allLinesFit(lines, width);
}

function selectorSurfaceDistinct(lines) {
  const surfaceRows = selectorSurfaceRows(lines);
  return surfaceRows.length > 0
    && surfaceRows.every((line) => line.includes(SELECTOR_SURFACE_BG))
    && surfaceRows.some((line) => line.includes(SELECTOR_BORDER_FG));
}

function selectorDropShadow(lines) {
  const surfaceRows = selectorSurfaceRows(lines);
  const bottomShadow = stripAnsi(lines.at(-1) ?? "");
  return surfaceRows.length + 1 === lines.length
    && /^ ▀+$/.test(bottomShadow)
    && surfaceRows.every((line) => line.includes(SELECTOR_SHADOW_FG) && stripAnsi(line).endsWith("█"));
}

function selectorListRows(lines) {
  const contentRows = selectorSurfaceRows(lines).map(stripSelectorFrame);
  const dividerIndex = contentRows.findIndex((line) => line.startsWith("├"));
  return dividerIndex >= 0 ? contentRows.slice(3, dividerIndex) : [];
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
    notifications: [],
    commands: [],
    shortcuts: [],
    tools: [],
    handlers: [],
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
      notify(message, notifyType) {
        calls.notifications.push([message, notifyType]);
      },
      custom,
    },
    registerCommand(name, options) {
      calls.commands.push([name, options]);
    },
    registerShortcut(shortcut, options) {
      calls.shortcuts.push([shortcut, options]);
    },
    registerTool(tool) {
      calls.tools.push(tool);
    },
    on(event, handler) {
      calls.handlers.push([event, handler]);
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
    allLinesFit: [initial, filtered, afterDown, afterClick].every((lines) => allLinesFit(lines, 96)) && [narrowInitial, narrowFiltered, narrowAfterDown].every((lines) => allLinesFit(lines, 40)),
    selectorBoxed: [initial, filtered, afterDown, afterUp, afterClick].every((lines) => selectorLinesBoxed(lines, 96)) && [narrowInitial, narrowFiltered, narrowAfterDown].every((lines) => selectorLinesBoxed(lines, 40)),
    selectorSurfaceDistinct: [initial, filtered, afterDown, afterUp, afterClick, narrowInitial, narrowFiltered, narrowAfterDown].every(selectorSurfaceDistinct),
    selectorDropShadow: [initial, filtered, afterDown, afterUp, afterClick, narrowInitial, narrowFiltered, narrowAfterDown].every(selectorDropShadow),
    selectorFrameStable: selectorFrameStable([initial, filtered, afterDown, afterUp, afterClick]) && selectorFrameStable([narrowInitial, narrowFiltered, narrowAfterDown]),
    renderedLineCounts: [initial, filtered, afterDown, afterUp, afterClick].map((lines) => lines.length),
    narrowRenderedLineCounts: [narrowInitial, narrowFiltered, narrowAfterDown].map((lines) => lines.length),
    capabilitySummaryShown: afterFilterDetail.some((line) => line.includes("deploy:read_write") || line.includes("shell:read_only")),
    digestShown: afterFilterDetail.some((line) => line.includes("sha256:DevOps")),
  };
}

function adaptiveSelectorEvidence() {
  const personas = Array.from({ length: 62 }, (_, index) => ({
    id: `persona-${String(index + 1).padStart(2, "0")}`,
    description: `Adaptive height candidate ${index + 1}`,
    model: "openrouter/adaptive-model",
    spec_digest: `sha256:adaptive-${index + 1}`,
    capabilities: { shell: "read_only" },
  }));
  const smallTui = { terminal: { rows: 30 }, renderRequests: 0, requestRender() { this.renderRequests += 1; } };
  const tallTui = { terminal: { rows: 50 }, renderRequests: 0, requestRender() { this.renderRequests += 1; } };
  const smallSelector = new mod.LarvaPersonaSelector({ personas, theme, keybindings, tui: smallTui, done: () => {} });
  const tallSelector = new mod.LarvaPersonaSelector({ personas, theme, keybindings, tui: tallTui, done: () => {} });
  const smallInitial = smallSelector.render(96);
  smallSelector.handleInput("down");
  const smallAfterDown = smallSelector.render(96);
  const tallInitial = tallSelector.render(96);
  tallSelector.handleInput("down");
  const tallAfterDown = tallSelector.render(96);
  const tallListRows = selectorListRows(tallInitial);
  const smallListRows = selectorListRows(smallInitial);
  return {
    smallLineCount: smallInitial.length,
    tallLineCount: tallInitial.length,
    smallSurfaceLineCount: selectorSurfaceRows(smallInitial).length,
    tallSurfaceLineCount: selectorSurfaceRows(tallInitial).length,
    smallListViewportRows: smallListRows.length,
    tallListViewportRows: tallListRows.length,
    tallCandidateRows: tallListRows.filter((line) => line.includes("persona-")).length,
    frameStableSmall: selectorFrameStable([smallInitial, smallAfterDown]),
    frameStableTall: selectorFrameStable([tallInitial, tallAfterDown]),
    surfaceDistinct: [smallInitial, smallAfterDown, tallInitial, tallAfterDown].every(selectorSurfaceDistinct),
    dropShadow: [smallInitial, smallAfterDown, tallInitial, tallAfterDown].every(selectorDropShadow),
    widthSafe: [smallInitial, smallAfterDown, tallInitial, tallAfterDown].every((lines) => allLinesFit(lines, 96)),
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

async function shortcutEvidence() {
  mod.resetPersonaCompletionCache();
  const env = baseEnv(await tempHome(), "1");
  let componentName = null;
  let selectedByCustom = null;
  const { ctx, calls } = makePiRecorder(env, async (factory) => {
    calls.customCalls += 1;
    let doneValue = null;
    const component = factory({ requestRender() {} }, theme, keybindings, (value) => { doneValue = value; });
    componentName = component.constructor.name;
    component.handleInput("vectl");
    component.handleInput("enter");
    selectedByCustom = doneValue;
    return doneValue;
  });
  await mod.initializeExtension(ctx, ctx);
  const shortcut = calls.shortcuts.find(([key]) => key === "ctrl+alt+p");
  await shortcut?.[1]?.handler?.({
    ui: ctx.ui,
    modelRegistry: ctx.modelRegistry,
    isIdle: () => true,
  });
  return {
    registeredShortcut: shortcut?.[0] ?? null,
    description: shortcut?.[1]?.description ?? null,
    commandRegistered: calls.commands.some(([name]) => name === "larva-persona"),
    componentName,
    selectedByCustom,
    activePersona: mod.getActiveEnvelope()?.persona_id ?? null,
    customCalls: calls.customCalls,
    modelSetCount: calls.models.length,
    activeToolsSetCount: calls.activeTools.length,
    statusUpdated: calls.statuses.some((status) => status.includes("larva: vectl-planner") || status.includes("vectl-planner")),
  };
}

async function shortcutNonIdleEvidence() {
  mod.resetPersonaCompletionCache();
  const env = baseEnv(await tempHome(), "1");
  const { ctx, calls } = makePiRecorder(env, async () => {
    calls.customCalls += 1;
    throw new Error("selector should not open while non-idle");
  });
  await mod.initializeExtension(ctx, ctx);
  const initial = await mod.commitPersona("ok", ctx, ctx);
  const modelCountAfterInitial = calls.models.length;
  const toolCountAfterInitial = calls.activeTools.length;
  const shortcut = calls.shortcuts.find(([key]) => key === "ctrl+alt+p");
  await shortcut?.[1]?.handler?.({
    ui: ctx.ui,
    modelRegistry: ctx.modelRegistry,
    isIdle: () => false,
  });
  return {
    initialOk: initial.ok,
    registeredShortcut: shortcut?.[0] ?? null,
    activePersonaAfterShortcut: mod.getActiveEnvelope()?.persona_id ?? null,
    customCalls: calls.customCalls,
    noAdditionalModelSet: calls.models.length === modelCountAfterInitial,
    noAdditionalToolSet: calls.activeTools.length === toolCountAfterInitial,
    warningShown: calls.notifications.some(([message, notifyType]) => notifyType === "warning" && String(message).includes("available when Pi is idle")),
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

function subagentLogOverlayExpectedRedEvidence() {
  mod.resetSubagentPresentationStateForTests();
  mod.recordSubagentPresentationEntryForTests("/tmp/ui-running.jsonl", "runner", "running", {
    phase: "waiting_for_child",
    task_preview: "wide selector row ".repeat(40),
    task_prompt: "full prompt must stay out of selector row",
    updated_at: "2026-06-03T00:00:00.000Z",
  });
  mod.recordSubagentPresentationEntryForTests("/tmp/ui-final.jsonl", "finisher", "success", {
    phase: "success",
    result_text: "final output must stay out of selector row",
    task_preview: "newest final",
    updated_at: "2026-06-04T00:00:00.000Z",
  });
  const list = mod.larva_subagent_log({ list: true, limit: 5 });
  const component = new mod.SubagentPresentationLogOverlay({
    entry: list.details.entries[0],
    generation: 1,
    tui: { terminal: { rows: 100 } },
  });
  const detail = component.render(96);
  component.handleInput("s");
  const selector = component.render(96);
  component.handleInput("4");
  const fourthTab = component.render(96);
  component.handleInput("5");
  const fifthTab = component.render(96);
  const beforeClick = component.render(96);
  component.handleInput("\x1b[<0;12;4M");
  const afterClick = component.render(96);
  component.dispose?.();
  const small = new mod.SubagentPresentationLogOverlay({ entry: list.details.entries[0], generation: 1, tui: { terminal: { rows: 24 } } }).render(96);
  const tall = new mod.SubagentPresentationLogOverlay({ entry: list.details.entries[0], generation: 1, tui: { terminal: { rows: 100 } } }).render(96);
  const plain = (lines) => lines.map(stripAnsi).join("\n");
  const detailPlain = plain(detail);
  const selectorPlain = plain(selector);
  const fourthPlain = plain(fourthTab);
  const fifthPlain = plain(fifthTab);
  return {
    renderedLineCounts: { small: small.length, tall: tall.length, detail: detail.length, selector: selector.length, fourthTab: fourthTab.length, fifthTab: fifthTab.length },
    assertions: {
      selectorModeViaS: /selector|select subagent/i.test(selectorPlain) && !selectorPlain.includes("● 1 Summary"),
      runningFirstOrdering: list.details.entries[0]?.status === "running",
      tabOrderIncludesEvents: /1 Summary.*2 Prompt.*3 Output.*4 Events.*5 Metadata/s.test(detailPlain),
      fourthTabIsEvents: fourthPlain.includes("● 4 Events"),
      fifthTabIsMetadata: fifthPlain.includes("● 5 Metadata"),
      tallTerminalUsesNinetyPercent: tall.length >= 85 && tall.length <= 91,
      stableFrameAcrossSelectorAndTabs: [selector, fourthTab, fifthTab].every((lines) => lines.length === detail.length && lines[0] === detail[0] && lines.at(-1) === detail.at(-1)),
      mouseClickNoop: JSON.stringify(beforeClick) === JSON.stringify(afterClick),
      allLinesFit: [detail, selector, fourthTab, fifthTab, small, tall].every((lines) => lines.every((line) => visibleWidth(line) <= 96)),
    },
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
const adaptive = adaptiveSelectorEvidence();
const subagentLogExpectedRed = subagentLogOverlayExpectedRedEvidence();
const commit = await commitThroughCommandEvidence();
const shortcut = await shortcutEvidence();
const shortcutNonIdle = await shortcutNonIdleEvidence();
const cancel = await cancelEvidence();
const fallback = await fallbackEvidence();

console.log(JSON.stringify({
  detail,
  adaptive,
  subagentLogExpectedRed,
  commit,
  shortcut,
  shortcutNonIdle,
  cancel,
  fallback,
  assertions: {
    enhancedComponentUsesInputSelectListDetail: detail.className === "LarvaPersonaSelector" && detail.initialUsesFilterInput && detail.initialUsesDetailPanel,
    detailPanelHasCapabilitiesAndDigest: detail.capabilitySummaryShown && detail.digestShown,
    filteringRankingDeterministic: JSON.stringify(detail.filteredOrder) === JSON.stringify(["DevOps", "devrel", "qa-dev", "backend-dev"]),
    enterCommitsThroughCommand: commit.ok && commit.envelopePersona === "vectl-planner" && commit.selectedByCustom === "vectl-planner" && commit.modelSetCount >= 1 && commit.activeToolsSetCount >= 1,
    ctrlAltPShortcutRegistered: shortcut.registeredShortcut === "ctrl+alt+p" && shortcut.description === "Open Larva persona selector" && shortcut.commandRegistered,
    ctrlAltPShortcutOpensSelectorAndCommits: shortcut.componentName === "LarvaPersonaSelector" && shortcut.selectedByCustom === "vectl-planner" && shortcut.activePersona === "vectl-planner" && shortcut.customCalls === 1 && shortcut.modelSetCount >= 1 && shortcut.activeToolsSetCount >= 1 && shortcut.statusUpdated,
    ctrlAltPShortcutNonIdlePreservesState: shortcutNonIdle.initialOk && shortcutNonIdle.registeredShortcut === "ctrl+alt+p" && shortcutNonIdle.activePersonaAfterShortcut === "ok" && shortcutNonIdle.customCalls === 0 && shortcutNonIdle.noAdditionalModelSet && shortcutNonIdle.noAdditionalToolSet && shortcutNonIdle.warningShown,
    escCancelPreservesActiveState: cancel.initialOk && !cancel.cancelledOk && cancel.cancelCode === "LARVA_BAD_INPUT" && cancel.activePersonaAfterCancel === "ok" && cancel.noAdditionalModelSet && cancel.noAdditionalToolSet,
    fallbackPreserved: fallback.uiSelectResult === "ok" && fallback.customThrowFallsBackToSelect === "startup" && fallback.openSelectorResult === "child" && !fallback.nonInteractiveOk && fallback.nonInteractiveCode === "LARVA_BAD_INPUT" && fallback.nonInteractiveCalls.custom === 0 && fallback.nonInteractiveCalls.select === 0 && fallback.nonInteractiveCalls.openSelector === 0 && !fallback.missingUiOk && fallback.missingUiCode === "LARVA_BAD_INPUT",
    mouseClickUnsupportedNoOp: detail.clickNoOp,
    renderLinesWithinWidth: detail.allLinesFit && adaptive.widthSafe,
    selectorOverlayBordered: detail.selectorBoxed,
    selectorSurfaceDistinct: detail.selectorSurfaceDistinct && adaptive.surfaceDistinct,
    selectorAdaptiveHeightUtilization: adaptive.tallLineCount > adaptive.smallLineCount && adaptive.tallListViewportRows > adaptive.smallListViewportRows && adaptive.tallCandidateRows >= 16,
    selectorDropShadow: detail.selectorDropShadow && adaptive.dropShadow,
    selectorFrameStableDuringNavigation: detail.selectorFrameStable && adaptive.frameStableSmall && adaptive.frameStableTall,
  },
}, null, 2));
