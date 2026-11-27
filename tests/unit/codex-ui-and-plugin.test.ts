import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { PersonaStore } from "../../src/store/persona-store.ts";
import type { RunSnapshot } from "../../src/core/types.ts";
import { CODEX_PANEL_URI, renderCodexPanelHtml } from "../../src/ui/codex-panel-html.ts";
import { CODEX_WIDGET_URI, renderCodexWidgetHtml } from "../../src/ui/codex-widget-html.ts";
import { buildSearchMentionsOutput, CODEX_INITIALIZE_INSTRUCTIONS, CODEX_PERSONA_URI_TEMPLATE, parsePersonaResourceUri,
  personaResourceUri } from "../../src/ui/codex-mentions.ts";

// Execute the shipped script with a deterministic iframe host, virtual timers,
// and a DOM tree. Drive only the public bridge, visibility, and rendered buttons.
class Element {
  #text = "";
  children: Element[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  disabled = false;
  onclick?: () => void;
  scrollTop = 0;
  value = "";
  parent?: Element;
  style = { setProperty: () => {} };
  readonly tag: string;
  readonly #focusNode: (node: Element) => void;
  constructor(tag: string, focusNode: (node: Element) => void) {
    this.tag = tag;
    this.#focusNode = focusNode;
  }
  set textContent(value: string) { this.#text = String(value); }
  get textContent(): string { return [this.#text, ...this.children.map(node => node.textContent)].filter(Boolean).join(" "); }
  append(node: Element) { node.parent = this; this.children.push(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  replaceChildren() { this.children = []; this.#text = ""; }
  select() { this.focus(); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  focus() { this.#focusNode(this); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(node => {
      const matches = selector === "[data-scroll-key]" ? !!node.dataset.scrollKey
        : selector === "[data-started-at]" ? !!node.dataset.startedAt : selector === node.tag;
      return [...(matches ? [node] : []), ...node.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
  contains(node: Element): boolean { return node === this || this.children.some(child => child.contains(node)); }
}

type Rpc = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function mount(html: string, clipboard: "native" | "legacy" | "unavailable" = "unavailable") {
  const sent: Rpc[] = [];
  const copied: string[] = [];
  const winEvents = new Map<string, (event: unknown) => void>();
  const docEvents = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let sequence = 0;
  let focus: Element | undefined;
  let resizeDisconnected = false, measuredHeight = 300;
  let selected: Element | undefined, now = Date.parse("2026-01-01T00:00:05Z");
  let resize: () => void, clock: (() => void) | undefined;
  const create = (tag: string) => new Element(tag, node => { focus = node; });
  const root = Object.assign(create("div"), { getBoundingClientRect: () => ({ height: measuredHeight }) });
  const parent = { postMessage: (message: Rpc) => sent.push(JSON.parse(JSON.stringify(message))) };
  const doc = {
    getElementById: () => root, createElement: create, documentElement: create("html"),
    createElementNS: (namespaceURI: string, tag: string) => Object.assign(create(tag), { namespaceURI }),
    get activeElement() { return focus; }, visibilityState: "visible",
    getSelection: () => ({ isCollapsed: !selected, anchorNode: selected }),
    addEventListener: (name: string, fn: () => void) => docEvents.set(name, fn),
    ...(clipboard === "legacy" && { execCommand(command: string) {
      assert.equal(command, "copy");
      assert.equal(focus?.tag, "textarea");
      copied.push(focus!.value);
      return true;
    } }),
  };
  const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    document: doc, window: { parent, addEventListener: (name: string, fn: (event: unknown) => void) => winEvents.set(name, fn) },
    ...(clipboard === "native" && { navigator: { clipboard: { async writeText(value: string) { copied.push(value); } } } }),
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() { resizeDisconnected = true; } },
    Date: class extends Date { static now() { return now; } },
    setInterval(callback: () => void, delay: number) { assert.equal(delay, 1000); clock = callback; return 1; },
    clearInterval() { clock = undefined; },
    setTimeout(callback: () => void, delay: number) { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout(id: number) { timers.delete(id); },
  }, { timeout: 1000 });
  function send(message: Rpc, source: object = parent) {
    winEvents.get("message")?.({ data: { jsonrpc: "2.0", ...message }, source });
  }
  function button(name: string) { return root.querySelectorAll("button").find(node => (node.attributes.get("aria-label") ?? node.textContent) === name); }
  const calls = (name: string) => sent.filter(message => message.method === "tools/call" && message.params?.name === name);
  function lastCall(name: string) { const request = calls(name).at(-1); assert.ok(request); return request; }
  const answered = new Set<Rpc>();
  async function reply(request: Rpc, result: unknown) {
    answered.add(request);
    send({ id: request.id, result });
    await turn();
  }
  const input = (args: object) => send({ method: "ui/notifications/tool-input", params: { arguments: args } });
  return {
    root, sent, calls, lastCall, reply, button, copied, input,
    async grouped(result: unknown, active: unknown = snapshot([])) {
      const requests = calls(panelTool).filter(request => !answered.has(request));
      const recent = requests.findLast(request => (request.params?.arguments as { scope?: string }).scope === 'recent');
      assert.ok(recent);
      const live = requests.at(requests.indexOf(recent) - 1);
      assert.ok(live && (live.params?.arguments as { scope?: string }).scope === 'active');
      await reply(live, active);
      await reply(recent, result);
    },
    get focus() { return focus; },
    select(node?: Element) { selected = node; docEvents.get("selectionchange")?.(); },
    resize(height: number) { measuredHeight = height; resize(); },
    tick() { now += 1000; clock?.(); },
    disconnect() { winEvents.get("messageerror")?.({ source: parent }); },
    get text() { return root.textContent; }, get timerCount() { return timers.size; },
    get mode() { return doc.documentElement.dataset.mode; }, get resizeDisconnected() { return resizeDisconnected; },
    async init(modes: string[], autoInput = true) {
      const init = sent[0];
      assert.equal(init.method, "ui/initialize");
      assert.deepEqual(init.params?.appCapabilities, { availableDisplayModes: modes });
      await reply(init, { hostContext: { displayMode: modes[0] } });
      assert.ok(sent.some(message => message.method === "ui/notifications/initialized"));
      if (autoInput && modes.length === 1) input({});
    },
    notify(method: string, params: Record<string, unknown>) { send({ method, params }); },
    foreign(message: Rpc) { send(message, {}); },
    result(data: object, isError = false) {
      send({ method: "ui/notifications/tool-result", params: { structuredContent: data, isError } });
    },
    click(name: string) { const node = button(name); assert.ok(node && !node.disabled, name); node.onclick?.(); },
    visibility(value: "visible" | "hidden") { doc.visibilityState = value; docEvents.get("visibilitychange")?.(); },
    fire(delay: number) {
      const next = Array.from(timers).find(([, timer]) => timer.delay === delay);
      assert.ok(next, `timer ${delay}`);
      timers.delete(next[0]); next[1].callback();
    },
    teardown() { send({ id: 600, method: "ui/resource-teardown" }); },
  };
}

const panelTool = "larva_subagent_panel", cancelTool = "larva_subagent_cancel";
const id = "/example/sessions/a.jsonl", second = "/example/sessions/b.jsonl";
function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return { task_id: id, run_epoch: "old", persona_id: "reviewer", cwd: "/repo", status: "running",
    phase: "waiting_for_child", output_state: "pending", tool_call_count: 0, started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z", ...overrides };
}
function snapshot(runs: RunSnapshot[], extras = {}) {
  return { structuredContent: { runs, startup_failures: [], ...extras } };
}
function accept(app: ReturnType<typeof mount>) {
  app.input({ task: "Review", persona_id: "reviewer", task_id: id });
  app.result({ status: "accepted", task_id: id, run_epoch: "old", cwd: "/repo" });
}

test("spawn and wait cards do not query or show other runs before acceptance or on rejection", async () => {
  for (const input of [{ task: "resume", persona_id: "reviewer", task_id: id }, { task_ids: [id] }]) {
    const app = mount(renderCodexWidgetHtml());
    await app.init(["inline", "fullscreen"]);
    app.input(input);
    assert.match(app.text, /Waiting for this tool call/);
    app.foreign({ method: "ui/notifications/tool-result", params: { structuredContent: run({ status: "accepted" }) } });
    app.notify("ui/notifications/host-context-changed", { displayMode: "fullscreen" });
    assert.match(app.text, /Waiting for this tool call/);
    assert.equal(app.button("Cancel"), undefined);
    app.result({ status: "failed", runs: [run()], error: { message: "Access denied" } }, true);
    assert.match(app.text, /Access denied/);
    assert.doesNotMatch(app.text, /reviewer|Subagent run|Output pending/);
    assert.equal(app.button("Cancel"), undefined);
    assert.deepEqual(app.calls(panelTool), []);
  }
});

test("a wait without snapshots remains unbound after its result", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  app.input({ task_ids: [id] });
  app.result({ ready: false, timed_out: true, runs: [], terminal_outputs: {} });
  assert.match(app.text, /No run snapshot was returned for this wait/);
  assert.equal(app.button("Cancel"), undefined);
  assert.deepEqual(app.calls(panelTool), []);
});

test("a resumed spawn card ignores a hidden reply and expires rather than following a new epoch", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  accept(app);
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { run_epochs: [{ task_id: id, run_epoch: "old" }] });
  await app.reply(app.lastCall(panelTool), snapshot([run({ phase: "stall_suspected" })]));
  assert.match(app.text, /Stall suspected/);
  app.fire(1000);
  const retired = app.lastCall(panelTool);
  const beforeHide = app.text;
  app.visibility("hidden");
  assert.equal(app.timerCount, 0);
  await app.reply(retired, snapshot([run({ status: "success", phase: "success", output_state: "inline", result_text: "late output" })]));
  assert.equal(app.text, beforeHide);
  app.visibility("visible");
  assert.equal(app.button("Cancel")?.disabled, true);
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { run_epochs: [{ task_id: id, run_epoch: "old" }] });
  await app.reply(app.lastCall(panelTool), snapshot([run({ run_epoch: "new", persona_id: "new persona" })], {
    terminal_outputs: { [id]: run({ run_epoch: "new", status: "success", output_state: "inline", result_text: "new output" }) },
  }));
  assert.ok(app.text.includes("Run snapshot expired (inspect recorded transcript)"));
  assert.ok(app.text.includes(id));
  assert.doesNotMatch(app.text, /new persona|new output|late output|Stall suspected/);
  assert.equal(app.button("Cancel"), undefined);
  assert.deepEqual(app.calls(cancelTool), []);
});

test("wait cards pin every initiating pair and recover retained terminal output on reopen", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  app.input({ task_ids: [id, second], return_when: "any" });
  app.result({ ready: false, timed_out: true, runs: [run(), run({ task_id: second, run_epoch: "second", persona_id: "tester" })], terminal_outputs: {} });
  const pins = { run_epochs: [{ task_id: id, run_epoch: "old" }, { task_id: second, run_epoch: "second" }] };
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, pins);
  app.visibility("hidden");
  app.visibility("visible");
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, pins);
  const done = run({ status: "success", phase: "success", output_state: "pending" });
  const terminalOutput = { task_id: id, run_epoch: "old", status: "success", output_state: "inline", result_text: "original output" };
  await app.reply(app.lastCall(panelTool), snapshot([run({ run_epoch: "new", persona_id: "new persona" }), done], {
    terminal_outputs: { [id]: terminalOutput },
  }));
  app.click("Details");
  assert.match(app.text, /original output/);
  assert.doesNotMatch(app.text, /new persona/);
  assert.equal(app.button("Cancel"), undefined);
  app.click("Refresh");
  await app.reply(app.lastCall(panelTool), snapshot([done]));
  assert.match(app.text, /original output/);
  app.click("b.jsonl · second · Snapshot expired");
  assert.match(app.text, /Run snapshot expired/);
  app.visibility("hidden");
  app.visibility("visible");
  await app.reply(app.lastCall(panelTool), snapshot([run({ run_epoch: "new" })]));
  app.click("reviewer · a.jsonl · old · Completed");
  assert.match(app.text, /original output/);
});

test("a terminal spawn failure with a receipt stays attached to its own epoch", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  app.input({ task: "Review", persona_id: "reviewer" });
  app.result({ task_id: id, run_epoch: "old", status: "failed", output_state: "inline", result_text: "Partial result",
    error: { code: "LARVA_CHILD_PROTOCOL_FAILED", message: "Child stopped" } }, true);
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { run_epochs: [{ task_id: id, run_epoch: "old" }] });
  await app.reply(app.lastCall(panelTool), snapshot([]));
  app.click("Details");
  assert.match(app.text, /Failed.*Child stopped.*Partial result/);
  assert.equal(app.button("Cancel"), undefined);
});

test("status cards follow the exact requested task, including a newer epoch and disk fallback", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  app.result({ runs: [run({ task_id: second, persona_id: "unrelated" }), run()], startup_failures: [] });
  assert.equal(app.calls(panelTool).length, 0); // Result before input must not widen the query.
  app.input({ task_id: id });
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { task_id: id });
  await app.reply(app.lastCall(panelTool), snapshot([run({ run_epoch: "new", persona_id: "new persona" })], {
    terminal_outputs: { [id]: run({ status: "success", output_state: "inline", result_text: "old terminal output" }) },
  }));
  assert.match(app.text, /new persona/);
  assert.doesNotMatch(app.text, /unrelated|old terminal output/);
  app.click("Cancel");
  assert.deepEqual(app.lastCall(cancelTool).params?.arguments, {
    task_ids: [id], reason: "Cancelled from Larva Subagents", expected_run_epochs: [{ task_id: id, run_epoch: "new" }],
  });
  await app.reply(app.lastCall(cancelTool), { structuredContent: { results: [{ task_id: id, outcome: "already_terminal" }] } });
  await app.reply(app.lastCall(panelTool), snapshot([], { disk_sessions: [
    { task_id: id, cwd: "/recorded", cwd_exists: false, lock_state: "unreconciled" },
    { task_id: second, cwd: "/unrelated", cwd_exists: true, lock_state: "unlocked" },
  ] }));
  assert.match(app.text, /Recorded session.*\/recorded.*Busy.*Missing workspace/);
  assert.doesNotMatch(app.text, /unrelated/);
  assert.equal(app.button("Cancel"), undefined);
});

test("a rejected exact handle stays scoped to its error instead of following a canonical row", async () => {
  const alias = "/example/sessions/contained-link.jsonl";
  const error = { code: "LARVA_SESSION_INVALID", message: "Invalid Pi session header or transcript path." };
  const widget = mount(renderCodexWidgetHtml());
  await widget.init(["inline", "fullscreen"]);
  widget.input({ task_id: alias });
  widget.result({ error }, true);
  assert.match(widget.text, /Invalid Pi session header or transcript path/);
  assert.deepEqual(widget.calls(panelTool), []);
  assert.equal(widget.button("Cancel"), undefined);

  const panel = mount(renderCodexPanelHtml());
  await panel.init(["fullscreen"]);
  await panel.grouped(snapshot([run()]));
  panel.input({ task_id: alias });
  assert.deepEqual(panel.lastCall(panelTool).params?.arguments, { task_id: alias });
  await panel.reply(panel.lastCall(panelTool), { isError: true, structuredContent: { error } });
  assert.match(panel.text, /Invalid Pi session header or transcript path/);
  assert.doesNotMatch(panel.text, /reviewer/);
  assert.equal(panel.button("Cancel"), undefined);
  panel.teardown();
  widget.teardown();
});

test("a scoped status card keeps its requested scope and limit when reopened", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  const query = { scope: "disk", limit: 3 };
  app.input(query);
  app.result({ runs: [], startup_failures: [], disk_sessions: [] });
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, query);
  app.visibility("hidden");
  app.visibility("visible");
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, query);
  await app.reply(app.lastCall(panelTool), snapshot([], {
    disk_sessions: [{ task_id: id, cwd: "/repo", cwd_exists: true, lock_state: "unlocked" }],
  }));
  assert.match(app.text, /Recorded session.*\/repo/);
  assert.equal(app.button("Cancel"), undefined);
});

test("standalone workbench switches scopes, shows disk metadata and does not cancel non-local sessions", async () => {
  const app = mount(renderCodexPanelHtml());
  await app.init(["fullscreen"]);
  assert.equal(app.mode, "fullscreen");
  assert.equal(app.button("Inline"), undefined);
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { scope: "recent", limit: 25 });
  await app.grouped(snapshot([run({ phase: "stall_suspected" })]));
  assert.match(app.text, /Stall suspected/);
  app.click("Active · 1");
  const previousScope = app.lastCall(panelTool);
  assert.deepEqual(previousScope.params?.arguments, { scope: "active" });
  app.click("Disk");
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { scope: "disk" });
  await app.reply(previousScope, snapshot([run({ persona_id: "old scope response" })]));
  const disk = [
    { task_id: id, cwd: "/missing", cwd_exists: false, lock_state: "active_external" },
    { task_id: second, cwd: "/busy", cwd_exists: true, lock_state: "unreconciled" },
  ];
  await app.reply(app.lastCall(panelTool), snapshot([run()], { disk_sessions: disk }));
  assert.match(app.text, /\/missing · Busy · Missing workspace/);
  assert.match(app.text, /\/busy · Busy/);
  assert.doesNotMatch(app.text, /old scope response|Stall suspected/);
  assert.equal(app.button("Cancel"), undefined);
  app.click(`${second} · /busy · Busy`);
  assert.equal(app.button("Cancel"), undefined);
  assert.equal(app.root.querySelector("article").textContent.includes("Missing workspace"), false);
});

test("fullscreen waits for input, merges both groups, and preserves selected text and focus during polling", async () => {
  const app = mount(renderCodexPanelHtml());
  await app.init(["fullscreen"], false);
  assert.match(app.text, /Waiting for panel input/);
  assert.equal(app.calls(panelTool).length, 0);
  app.input({});
  const completed = Array.from({ length: 25 }, (_, index) => run({ task_id: `/example/sessions/done-${index}.jsonl`,
    status: "success", phase: "success", output_state: "inline", result_text: "done" }));
  const live = run({ task_preview: "Original preview", tool_call_count: 42 });
  await app.grouped(snapshot(completed), snapshot([live]));
  assert.match(app.text, /Active.*reviewer · a\.jsonl · old · Working.*Done.*done-24/);
  assert.match(app.text, /5s elapsed.*42 tool calls/);
  app.tick();
  assert.match(app.text, /6s elapsed/);
  app.click("Task & Session");
  assert.equal(app.button("Result")?.attributes.get("aria-pressed"), "false");
  assert.equal(app.root.querySelectorAll("h3").some(node => node.textContent === "Result"), false);
  app.button("Task & Session")?.focus();
  app.select(app.root.querySelector("pre"));
  app.fire(1000);
  const before = app.calls(panelTool).length;
  app.click("Refresh");
  assert.equal(app.calls(panelTool).length, before);
  await app.grouped({ isError: true, structuredContent: { error: { message: "Catalog unavailable" } } },
    snapshot([{ ...live, task_preview: "Updated preview" }]));
  assert.match(app.text, /Original preview/);
  app.select();
  assert.match(app.text, /Updated preview/);
  assert.match(app.text, /Done: Catalog unavailable/);
  assert.ok(app.button("Cancel") && !app.button("Cancel")?.disabled);
  assert.equal(app.focus, app.button("Task & Session"));
  app.teardown();
});

test("widget uses host modes and reports shrinking intrinsic height with collapsed wait telemetry", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  app.notify("ui/notifications/host-context-changed", { displayMode: "fullscreen", availableDisplayModes: ["inline", "pip"] });
  assert.equal(app.mode, "inline");
  assert.equal(app.button("Fullscreen"), undefined);
  app.result({ ready: true, timed_out: false, runs: [run()] });
  assert.equal(app.calls(panelTool).length, 0);
  app.input({ task_ids: [id] });
  const done = run({ status: "success", phase: "success", output_state: "delivery_failed", tool_call_count: 30,
    output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Disk quota exceeded" } });
  await app.reply(app.lastCall(panelTool), snapshot([done]));
  assert.match(app.text, /Wait ready.*30 tool calls.*Delivery failed.*Disk quota exceeded/);
  app.click("Details");
  app.resize(504.1);
  app.click("Hide details");
  app.resize(120);
  const heights = app.sent.filter(item => item.method === "ui/notifications/size-changed").map(item => item.params?.height);
  assert.deepEqual(heights, [300, 505, 120]);
});

test("fullscreen inspector pages epoch-bound text and disambiguates recorded segments", async () => {
  const app = mount(renderCodexPanelHtml(), "legacy");
  await app.init(["fullscreen"]);
  const finished = { ...telemetry, status: "success", phase: "success", output_state: "artifactized", cleanup_unconfirmed: true,
    result_preview: "Bounded output" } satisfies RunSnapshot;
  await app.grouped(snapshot([finished]));
  app.click("Task & Session");
  app.click("Load full prompt");
  const query = { task_id: id, run_epoch: "old", source: "prompt" };
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { slice: { ...query, offset: 0 } });
  const page = (text: string, offset: number, continuation_offset?: number) =>
    ({ structuredContent: { slice: { state: "ok", text, offset, length: Array.from(text).length, continuation_offset } } });
  await app.reply(app.lastCall(panelTool), page("原\n\n", 0, 3));
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { slice: { ...query, offset: 3 } });
  await app.reply(app.lastCall(panelTool), page("文", 3));
  app.click("Copy full prompt");
  assert.deepEqual(app.copied, ["原\n\n文"]);
  app.click("Result");
  assert.match(app.text, /Bounded output/);
  app.click("Read full output");
  await app.reply(app.lastCall(panelTool), page("page one", 0, 8));
  app.click("Next output page");
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { slice: { ...query, source: "output", offset: 8 } });
  await app.reply(app.lastCall(panelTool), page("page two", 8));
  assert.match(app.text, /page two/);
  assert.doesNotMatch(app.text, /page one/);

  app.click("Timeline");
  app.click("Recorded args");
  await app.reply(app.lastCall(activityTool), { structuredContent: { status: "ambiguous", candidates: [{ index: 1, line_number: 12 }] } });
  app.click("Recording 2 · line 12");
  const exact = { task_id: id, tool_call_id: "read-42", segment_part: "args", disambiguation_index: 1 };
  assert.deepEqual(app.lastCall(activityTool).params?.arguments, exact);
  const segment = (text: string, offset: number, continuation_offset?: number) => ({ structuredContent: { status: "success",
    call: { call_id: "read-42", segment: { part: "args", text, source_version: "fixed", offset, continuation_offset } } } });
  await app.reply(app.lastCall(activityTool), segment("first", 0, 5));
  app.click("Next recorded page");
  assert.deepEqual(app.lastCall(activityTool).params?.arguments, { ...exact, source_version: "fixed", offset: 5 });
  await app.reply(app.lastCall(activityTool), segment("second", 5));
  assert.match(app.text, /Recorded args.*second/);
  app.click("Retry cleanup");
  assert.deepEqual((app.lastCall(cancelTool).params?.arguments as { expected_run_epochs?: unknown }).expected_run_epochs,
    [{ task_id: id, run_epoch: "old" }]);
  app.teardown();
});

test("all output states are distinct and progress clears a visible stall", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  accept(app);
  await app.reply(app.lastCall(panelTool), snapshot([run({ phase: "stall_suspected" })]));
  assert.match(app.text, /Stall suspected/);
  app.click("Details");
  assert.match(app.text, /Output pending/);
  app.fire(1000);
  await app.reply(app.lastCall(panelTool), snapshot([run()]));
  assert.doesNotMatch(app.text, /Stall suspected/);
  const path = "/example/artifacts/full.txt";
  const artifact = { path, bytes: 4000 };
  const cases: [Partial<RunSnapshot>, string[]][] = [
    [{ output_state: "inline", result_text: "<img src=x>\ninline output" }, ["<img src=x>\ninline output"]],
    [{ output_state: "artifactized", result_preview: "Bounded preview", full_output_artifact: artifact }, ["Bounded preview", path]],
    [{ output_state: "delivery_failed", output_diagnostic: { code: "LARVA_STORE_WRITE_FAILED", message: "Artifact quota exceeded" } },
      ["Execution succeeded, but output delivery failed.", "Artifact quota exceeded", id]],
    [{ output_state: "evicted", full_output_artifact: artifact }, ["Output evicted", path]],
    [{ output_state: "evicted" }, ["Output evicted", "Recorded transcript", id]],
  ];
  for (const [properties, expected] of cases) {
    app.click("Refresh");
    await app.reply(app.lastCall(panelTool), snapshot([run({ status: "success", phase: "success", ...properties })]));
    for (const text of expected) assert.ok(app.text.includes(text), text);
    assert.doesNotMatch(app.text, /No terminal output yet|Output pending/);
    assert.equal(app.button("Cancel"), undefined);
  }
  assert.equal(app.root.querySelectorAll("img").length, 0);
});

const activityTool = "larva_subagent_activity";
const telemetry = run({ model: "fixture/model", thinking: "high", task_preview: "Widget task preview", live_thinking: true,
  active_tool: { tool_call_id: "read-42", name: "read", status: "running" }, live_assistant_preview: "Working <em>safely</em>",
  tool_snapshots: [{ tool_call_id: "read-42", name: "read", status: "running", args_preview: '{"path":"example.ts"}' }],
});
function recording(part: "args" | "result", text: string) {
  return { structuredContent: { status: "success", call: { call_id: "read-42", segment: { part, text } } } };
}

test("widget keeps only compact telemetry visible until Details is opened, per run epoch", async () => {
  const app = mount(renderCodexWidgetHtml(), "legacy");
  await app.init(["inline", "fullscreen"]);
  app.input({ task_id: id });
  app.result(snapshot([telemetry]).structuredContent);
  await app.reply(app.lastCall(panelTool), snapshot([telemetry]));
  assert.match(app.text, /reviewer.*Working.*fixture\/model · thinking: high.*read \(running\).*Thinking…/);
  assert.ok(app.button("Cancel"));
  assert.equal(app.button("Details")?.attributes.get("aria-expanded"), "false");
  assert.doesNotMatch(app.text, /Widget task preview|example\.ts|Output pending/);
  assert.equal(app.button("Copy task_id"), undefined);
  app.click("Details");
  assert.equal(app.button("Hide details")?.attributes.get("aria-expanded"), "true");
  assert.match(app.text, /Widget task preview.*Working <em>safely<\/em>.*example\.ts.*Output pending/);
  assert.equal(app.root.querySelectorAll("em").length, 0);
  app.click("Copy task_id");
  app.click("Copy prompt preview");
  assert.deepEqual(app.copied, [id, telemetry.task_preview]);
  assert.equal(app.root.querySelectorAll("textarea").length, 0);

  const replaced = app.button("Recorded args");
  app.fire(1000);
  const done = run({ ...telemetry, status: "success", phase: "success", active_tool: null, live_thinking: false,
    tool_snapshots: [{ ...telemetry.tool_snapshots![0], status: "done" }], output_state: "inline", result_text: "Completed output" });
  await app.reply(app.lastCall(panelTool), snapshot([done]));
  assert.ok(app.button("Hide details"));
  assert.ok(app.button("read (done)"));
  assert.match(app.text, /Completed output/);
  assert.doesNotMatch(app.text, /Thinking…/);
  replaced?.onclick?.();
  assert.deepEqual(app.calls(activityTool), []);
  app.click("Copy output");
  assert.deepEqual(app.copied, [id, telemetry.task_preview, done.result_text]);
  app.click("Hide details");
  assert.match(app.text, /Completed output/);
  assert.equal(app.root.querySelector("pre"), undefined);
  app.click("Details");
  app.click("Recorded args");
  assert.deepEqual(app.lastCall(activityTool).params?.arguments, { task_id: id, tool_call_id: "read-42", segment_part: "args" });
  await app.reply(app.lastCall(activityTool), recording("args", "Exact recorded args"));
  assert.match(app.text, /Exact recorded args/);
  app.click("Recorded result");
  const late = app.lastCall(activityTool);
  assert.deepEqual(late.params?.arguments, { task_id: id, tool_call_id: "read-42", segment_part: "result" });
  app.fire(1000);
  await app.reply(app.lastCall(panelTool), snapshot([{ ...telemetry, run_epoch: "new" }]));
  assert.equal(app.button("Hide details"), undefined);
  app.click("Details");
  await app.reply(late, recording("result", "Result from superseded epoch"));
  assert.doesNotMatch(app.text, /superseded epoch|Loading recorded|Exact recorded args/);
  app.teardown();
});

test("panel shows recorded tool results on demand and retires inspection on teardown or disconnect", async () => {
  for (const close of ["teardown", "disconnect"] as const) {
    const app = mount(renderCodexPanelHtml(), close === "teardown" ? "native" : "unavailable");
    await app.init(["fullscreen"]);
    await app.grouped(snapshot([telemetry]));
    app.click("Copy prompt preview");
    await turn();
    if (close === "teardown") assert.deepEqual(app.copied, [telemetry.task_preview]);
    else assert.match(app.text, /Copy unavailable/);
    app.click("Recorded result");
    const result = app.lastCall(activityTool);
    app.fire(1000);
    await app.grouped(snapshot([telemetry]));
    assert.equal(app.calls(activityTool).length, 1, "polling must not request activity");
    assert.equal(app.button("Recorded result")?.disabled, true);
    await app.reply(result, recording("result", "Exact recorded result"));
    assert.match(app.text, /Exact recorded result/);
    app.click("Recorded args");
    const pending = app.lastCall(activityTool);
    app[close]();
    assert.equal(app.timerCount, 0);
    assert.equal(app.resizeDisconnected, true);
    await app.reply(pending, recording("args", "Late recorded args"));
    assert.doesNotMatch(app.text, /Late recorded args/);
    if (close === "disconnect") assert.equal(app.button("Recorded result")?.disabled, true);
  }
});

test("cancel sends an epoch guard and remains disabled across polling and display modes", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  accept(app);
  await app.reply(app.lastCall(panelTool), snapshot([run()]));
  const oldButton = app.button("Cancel");
  app.click("Cancel");
  const cancel = app.lastCall(cancelTool);
  assert.deepEqual(cancel.params?.arguments, { task_ids: [id], reason: "Cancelled from Larva Subagents", expected_run_epochs: [{ task_id: id, run_epoch: "old" }] });
  assert.equal(app.button("Cancel")?.disabled, true);
  app.fire(1000);
  await app.reply(app.lastCall(panelTool), snapshot([run()]));
  app.click("Fullscreen");
  const display = app.sent.find(message => message.method === "ui/request-display-mode");
  assert.ok(display);
  await app.reply(display, { mode: "fullscreen" });
  assert.equal(app.mode, "fullscreen");
  assert.equal(app.button("Cancel")?.disabled, true);
  oldButton?.onclick?.(); // A queued callback from a replaced DOM control must be harmless.
  assert.equal(app.calls(cancelTool).length, 1);
  await app.reply(cancel, { isError: true, structuredContent: { results: [{ task_id: id, outcome: "cleanup_unconfirmed" }] } });
  assert.match(app.text, /Cancellation cleanup could not be confirmed/);
  await app.reply(app.lastCall(panelTool), snapshot([run()]));
  app.click("Cancel");
  await app.reply(app.lastCall(cancelTool), { isError: true, structuredContent: { results: [{ task_id: id, outcome: "not_found" }] } });
  assert.match(app.text, /Run not found for cancellation/);
  await app.reply(app.lastCall(panelTool), snapshot([]));
  assert.equal(app.button("Cancel"), undefined);
});

test("teardown silences all polling and a disconnected bridge leaves the view read-only", async () => {
  const app = mount(renderCodexPanelHtml());
  await app.init(["fullscreen"]);
  await app.grouped(snapshot([run()]));
  app.fire(1000);
  const pending = app.lastCall(panelTool), shown = app.text;
  app.teardown();
  assert.equal(app.resizeDisconnected, true);
  assert.equal(app.timerCount, 0);
  assert.deepEqual(app.sent.at(-1), { jsonrpc: "2.0", id: 600, result: {} });
  await app.reply(pending, snapshot([run({ persona_id: "late reply" })]));
  app.visibility("hidden");
  app.visibility("visible");
  assert.equal(app.text, shown);
  assert.equal(app.lastCall(panelTool), pending);
  assert.equal(app.calls(cancelTool).length, 0);

  const lost = mount(renderCodexWidgetHtml());
  await lost.init(["inline", "fullscreen"]);
  accept(lost);
  await lost.reply(lost.lastCall(panelTool), snapshot([run()]));
  lost.fire(1000);
  const unanswered = lost.lastCall(panelTool);
  lost.disconnect();
  await lost.reply(unanswered, snapshot([run({ persona_id: "late after connection loss" })]));
  assert.match(lost.text, /Connection lost. This view is read-only/);
  assert.match(lost.text, /reviewer/);
  assert.doesNotMatch(lost.text, /late after connection loss/);
  assert.equal(lost.button("Cancel"), undefined);
  assert.equal(lost.button("Refresh")?.disabled, true);
  assert.equal(lost.timerCount, 0);
  assert.equal(lost.calls(cancelTool).length, 0);
});

test("Chrome renders the ported workbench and measures widget growth and shrinkage", {
  skip: !process.env.LARVA_TEST_CHROME && "Set LARVA_TEST_CHROME to a Chromium executable.", timeout: 30_000,
}, async t => {
  const home = mkdtempSync(join(tmpdir(), "larva-codex-ui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "browser.html");
  const literal = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
  const running = { ...telemetry, task_preview: "Preview\n".repeat(30), tool_call_count: 1 };
  const completed = (["success", "failed", "cancelled"] as const).map(status => run({
    task_id: `/example/${status}.jsonl`, persona_id: status, status, phase: status,
    output_state: status === "success" ? "artifactized" : "inline",
    result_preview: "Output\n".repeat(30), cleanup_unconfirmed: status === "success",
  }));
  const stalled = { ...running, task_id: second, persona_id: "stalled", phase: "stall_suspected" };
  const recent = [
    run({ task_preview: "Quiet run task preview", live_assistant_preview: "", active_tool: null, live_thinking: false }),
    run({ task_id: "/example/sessions/2026-11-27T14-32-18-123Z_7c7f13dd-f466-4322-9f19-afcc1c0ae196.jsonl",
      run_epoch: "completed-epoch", persona_id: "reviewer", status: "success", phase: "success", output_state: "inline",
      model: "openai-codex/gpt-5.4-mini", result_preview: "Actual completed output" }),
  ];
  writeFileSync(file, String.raw`<!doctype html><meta charset="utf-8"><div id="report">waiting</div><script>
const report = document.querySelector('#report');
const assert = (value, label) => { if (!value) throw Error(label); };
const until = async (predicate, label) => {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Timed out: ' + label);
};
const running = ${literal(running)}, stalled = ${literal(stalled)}, done = ${literal(completed)};
const snapshot = runs => ({ structuredContent: { runs, startup_failures: [] } });
function mount(html, displayMode, width, recent = done) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'height:600px;width:' + width + 'px';
  const state = { frame, ready: false, heights: [], calls: [], expire: false };
  const send = data => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...data }, '*');
  state.notify = (method, params) => send({ method, params });
  window.addEventListener('message', ({ source, data }) => {
    if (source !== frame.contentWindow) return;
    const reply = result => send({ id: data.id, result });
    if (data.method === 'ui/initialize') {
      reply({ hostContext: { displayMode, theme: 'light', availableDisplayModes: [displayMode, 'pip'] } });
    } else if (data.method === 'ui/notifications/initialized') {
      state.ready = true;
    } else if (data.method === 'ui/notifications/size-changed') {
      state.heights.push(data.params.height);
      frame.style.height = data.params.height + 'px';
    } else if (data.method === 'tools/call') {
      const { name, arguments: args } = data.params;
      state.calls.push({ name, args });
      if (name === 'larva_subagent_panel') {
        if (args.slice) {
          const { source, offset } = args.slice;
          reply({ structuredContent: { slice: { state: 'ok', offset, text: source + '-' + offset, ...(offset === 0 && { continuation_offset: 8 }) } } });
        } else if (args.scope === 'disk') reply({ structuredContent: { runs: [], startup_failures: [], disk_sessions: [
          { task_id: '/example/recorded.jsonl', cwd: '/example', cwd_exists: true, lock_state: 'unlocked' },
        ] } });
        else if (args.run_epochs) reply(snapshot(state.expire ? [{ ...running, run_epoch: 'replacement' }] : [running, stalled]));
        else reply(snapshot(args.scope === 'active' ? [running, stalled] : recent));
      } else if (name === 'larva_subagent_activity') {
        const { tool_call_id, segment_part, disambiguation_index, offset = 0 } = args;
        const data = disambiguation_index === undefined ? { status: 'ambiguous', candidates: [{ index: 1, line_number: 12 }] }
          : { status: 'success', call: { call_id: tool_call_id, segment: { part: segment_part, text: 'Recording page ' + offset,
            offset, source_version: 'fixed', ...(offset === 0 && { continuation_offset: 16 }) } } };
        reply({ structuredContent: data });
      } else if (name === 'larva_subagent_cancel') {
        reply({ structuredContent: { results: [{ task_id: args.task_ids[0], outcome: 'cleanup_unconfirmed' }] } });
      }
    }
  });
  frame.srcdoc = html;
  document.body.append(frame);
  state.find = selector => [...frame.contentDocument.querySelectorAll(selector)];
  state.get = selector => state.find(selector)[0];
  state.button = (text, within = '') => state.find(within ? within + ' button' : 'button').find(b => b.textContent === text);
  state.click = (text, within) => {
    const control = state.button(text, within);
    assert(control && !control.disabled, 'Missing enabled ' + text);
    control.click();
  };
  state.text = () => state.get('#app').textContent;
  return state;
}
(async () => {
  const panel = mount(${literal(renderCodexPanelHtml())}, 'fullscreen', 960);
  const widget = mount(${literal(renderCodexWidgetHtml())}, 'inline', 420);
  await until(() => panel.ready && widget.ready, 'initialization');
  assert(!panel.calls.length && !widget.calls.length, 'Poll before tool input');
  panel.notify('ui/notifications/tool-input', { arguments: {} });
  widget.notify('ui/notifications/tool-result', { structuredContent: { ready: true, timed_out: false, runs: [running, stalled] } });
  await until(() => panel.get('.workbench') && widget.heights.length, 'panel data and widget sizing');
  assert(!widget.calls.length, 'Widget polled before tool input');
  widget.notify('ui/notifications/tool-input', { arguments: { task_ids: [running.task_id, stalled.task_id] } });
  await until(() => widget.get('.compact-list') && widget.calls.length, 'pinned widget data');
  assert(widget.calls[0].args.run_epochs?.every(pair => pair.run_epoch === running.run_epoch) && widget.calls[0].args.run_epochs.length === 2, 'Widget did not poll both pinned epochs');
  assert(!widget.button('Fullscreen'), 'Host mode intersection');

  const css = node => node.ownerDocument.defaultView.getComputedStyle(node);
  const root = panel.get('html');
  const tokens = 'background foreground secondary tertiary card muted muted-foreground border input primary accent success success-bg warning warning-bg danger danger-bg ring radius-sm radius-md radius-lg app-font-sans app-font-mono';
  for (const token of tokens.split(' ')) assert(css(root).getPropertyValue('--' + token).trim(), 'Missing token ' + token);
  assert(css(root).backgroundColor === 'rgb(255, 255, 255)' && css(root).fontSize === '13px', 'Light palette/font');
  const layout = panel.get('.workbench');
  const columns = css(layout).gridTemplateColumns.split(' ').map(parseFloat);
  assert(css(layout).display === 'grid' && columns.length === 2 && Math.abs(columns[0] / layout.clientWidth - .30) < .01, 'Wide 30% workbench column');
  panel.frame.style.width = '700px';
  assert(css(layout).display === 'grid' && parseFloat(css(layout).gridTemplateColumns) === 220, '220px minimum track');
  panel.frame.style.width = '679px';
  assert(css(layout).display === 'flex' && css(layout).flexDirection === 'column' && css(panel.get('.run-list')).maxHeight === '148px', '679px stacking');
  panel.frame.style.width = '960px';
  const colors = { running: 'rgb(51, 156, 255)', success: 'rgb(22, 163, 74)', failed: 'rgb(220, 38, 38)', cancelled: 'rgb(217, 119, 6)', stall_suspected: 'rgb(217, 119, 6)' };
  const paths = new Set();
  for (const [status, color] of Object.entries(colors)) {
    const icon = panel.get('.run-card .status[data-status=' + status + ']');
    const path = icon?.querySelector('svg path');
    assert(path?.namespaceURI === 'http://www.w3.org/2000/svg' && css(path).stroke === color, 'SVG/color for ' + status);
    paths.add(path.getAttribute('d'));
  }
  assert(paths.size === 5, 'Status glyphs must be distinct');
  const reduced = panel.frame.contentWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
  assert(css(panel.get('.status[data-status=running]')).animationName === (reduced ? 'none' : 'pulse'), 'Running animation');
  assert(css(panel.get('.status[data-status=stall_suspected]')).animationName === 'none', 'Stall should not pulse');
  panel.notify('ui/notifications/host-context-changed', { theme: 'dark' });
  await until(() => css(root).backgroundColor === 'rgb(24, 24, 24)', 'dark palette');
  panel.notify('ui/notifications/host-context-changed', { styles: { variables: { '--color-background-primary': '#233344' } } });
  await until(() => css(root).backgroundColor === 'rgb(35, 51, 68)', 'host theme override');

  const tabs = panel.find('.tabs button');
  assert(tabs.map(b => b.textContent).join('/') === 'All/Timeline/Result/Task & Session' && css(panel.get('.tabs')).position === 'sticky', 'Four sticky tabs');
  assert(tabs.every(b => Math.abs(b.offsetWidth - tabs[0].offsetWidth) <= 1 && b.offsetWidth > 0), 'Equal visible tab widths');
  assert(panel.get('.metadata').tagName === 'DL' && css(panel.get('.metadata')).gridTemplateColumns.split(' ').length === 4, 'Metadata grid');
  assert(css(panel.get('.elapsed')).fontVariantNumeric === 'tabular-nums' && css(panel.get('.model')).borderTopLeftRadius === '999px', 'Toolbar telemetry chips');
  assert(panel.find('.section-card .section-header').length >= 4 && css(panel.get('.stream')).borderTopWidth === '1px', 'Section and stream styling');
  assert(css(panel.get('.prompt-box')).maxHeight === '110px', 'Collapsed prompt');
  panel.click('Expand prompt');
  assert(css(panel.get('.prompt-box')).maxHeight === 'none', 'Expanded prompt');
  panel.click('Load full prompt');
  await until(() => panel.button('Copy full prompt'), 'full prompt copy control');
  assert(panel.text().includes('prompt-0prompt-8') && panel.calls.filter(call => call.args.slice?.source === 'prompt')
    .every(call => call.args.slice.run_epoch === running.run_epoch), 'Prompt pages combined for the selected epoch');
  panel.click('Timeline', '.tabs');
  assert(!panel.get('.prompt-box') && panel.button('Recorded args'), 'Isolated Timeline tab');
  panel.get('.tool-row').click();
  assert(panel.get('.tool-row').getAttribute('aria-expanded') === 'false' && !panel.get('.tool-content'), 'Collapsed tool row');
  panel.get('.tool-row').click();
  assert(panel.button('Recorded args') && panel.button('Recorded result'), 'Expanded tool controls');
  for (const part of ['args', 'result']) {
    panel.click('Recorded ' + part);
    await until(() => panel.button('Recording 2 · line 12'), 'duplicate call candidate');
    panel.click('Recording 2 · line 12');
    await until(() => panel.button('Next recorded page'), 'recorded page cursor');
    panel.click('Next recorded page');
    await until(() => panel.text().includes('Recording page 16'), 'recorded page rendered');
    const { args } = panel.calls.filter(call => call.name === 'larva_subagent_activity').at(-1);
    assert(args.segment_part === part && args.disambiguation_index === 1 && args.source_version === 'fixed' && args.offset === 16, 'Recording cursor/identity');
  }
  panel.click('Done · 3', '.toolbar');
  assert(panel.find('.run-card').length === 3 && !panel.get('.run-card .status[data-status=running]'), 'Done filters merged rows');
  panel.click('Result', '.tabs');
  assert(css(panel.get('.result')).borderTopWidth === '1px' && !panel.button('Copy task_id'), 'Isolated bordered Result');
  panel.click('Read full output');
  await until(() => panel.button('Next output page'), 'output page cursor');
  panel.click('Next output page');
  await until(() => panel.text().includes('output-8'), 'second output page rendered');
  assert(!panel.text().includes('output-0'), 'Output pages are displayed separately');
  panel.click('Retry cleanup');
  await until(() => panel.calls.some(call => call.name === 'larva_subagent_cancel'), 'retry cleanup');
  const retry = panel.calls.find(call => call.name === 'larva_subagent_cancel').args;
  assert(retry.expected_run_epochs[0].task_id === done[0].task_id && retry.expected_run_epochs[0].run_epoch === done[0].run_epoch, 'Cleanup epoch guard');
  panel.click('Disk');
  await until(() => panel.text().includes('Recorded session'), 'separate Disk scope');
  assert(panel.find('.run-card').length === 1 && !panel.button('Cancel'), 'Disk rows not merged with live runs');

  await until(() => widget.button('Details') && widget.get('.preview.summary'), 'collapsed widget');
  assert(css(widget.get('.compact-list .run-card')).display === 'flex' && widget.get('.toolbar .model'), 'Compact cards and toolbar');
  const before = widget.heights.at(-1);
  widget.click('Details');
  await until(() => widget.heights.at(-1) > before, 'widget growth');
  assert(widget.get('.drawer') && css(widget.get('.drawer')).maxHeight === '340px' && widget.get('.switcher'), 'Elevated drawer and switcher');
  widget.click('Hide details');
  await until(() => widget.heights.at(-1) === before, 'widget shrink after host resize');
  widget.expire = true;
  widget.click('Refresh');
  await until(() => widget.text().includes('Run snapshot expired'), 'expired pinned epoch');
  assert(!widget.text().includes('replacement') && !widget.button('Cancel'), 'Expired widget followed replacement');
  for (const app of [panel, widget]) app.notify('ui/resource-teardown', {});

  const recent = ${literal(recent)};
  const status = mount(${literal(renderCodexWidgetHtml())}, 'inline', 420, recent);
  await until(() => status.ready, 'recent status initialization');
  status.notify('ui/notifications/tool-input', { arguments: { scope: 'recent' } });
  status.notify('ui/notifications/tool-result', snapshot(recent));
  await until(() => status.find('.compact-list .run-card').length === 2, 'recent status rows');
  const [quiet, finished] = status.find('.compact-list .run-card');
  const result = finished.querySelector('.preview');
  assert(result?.textContent === recent[1].result_preview && css(result).whiteSpace === 'nowrap' &&
    result.clientWidth >= result.scrollWidth && result.clientWidth > 0,
    'Completed preview must fit on one line: ' + result?.clientWidth + 'px available, ' + result?.scrollWidth + 'px needed');
  assert(quiet.querySelector('.preview')?.textContent === recent[0].task_preview, 'Missing quiet run row preview');
  assert(status.get('.preview.summary')?.textContent === recent[0].task_preview, 'Missing quiet run inspector preview');
  assert(finished.title.includes(recent[1].task_id) && finished.title.includes(recent[1].run_epoch) &&
    finished.getAttribute('aria-label').includes(recent[1].task_id.split('/').pop()), 'Missing compact run identity');
  assert(finished.querySelector('.status[data-status=success] svg path')?.getBoundingClientRect().width > 0, 'Missing compact status icon');
  finished.click();
  assert(status.get('.preview.summary')?.textContent === recent[1].result_preview &&
    status.get('article .model')?.textContent === recent[1].model, 'Missing completed run inspector metadata');
  status.notify('ui/resource-teardown', {});
  report.textContent = 'verified';
})().catch(error => { report.textContent = error.message; });
</script>`);
  const { stdout } = await promisify(execFile)(process.env.LARVA_TEST_CHROME!, ["--headless", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--use-mock-keychain", `--user-data-dir=${join(home, "profile")}`,
    "--virtual-time-budget=8000", "--dump-dom", pathToFileURL(file).href], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }).catch(error => {
    if (error.code === 2 && error.stdout && error.stderr?.includes("Teardown watchdog expired")) return { stdout: String(error.stdout) };
    throw error;
  });
  assert.equal(/<div id="report">([^<]*)<\/div>/.exec(stdout)?.[1], "verified");
});

test("persona resource links share the store's ranking and do not leak prompts", async t => {
  const home = mkdtempSync(join(tmpdir(), "larva-mentions-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "personas"));
  const persona = (id: string, description = "Component owner", model = "provider/model") =>
    writeFileSync(join(home, "personas", id + ".json"), JSON.stringify({ id, description, model, prompt: "private prompt" }));
  persona("designer", "Review interfaces"); persona("ui-review"); persona("reviewer"); persona("review");
  persona("tester", "Component owner", "provider/review");
  const personas = new PersonaStore(home);
  const { items } = await buildSearchMentionsOutput(personas, { query: " @LaRVa:REVIEW " });
  assert.deepEqual(items.map(item => item.name), ["review", "reviewer", "ui-review", "designer", "tester"]);
  assert.deepEqual(items[0], { type: "resource_link", uri: "larva://personas/review", name: "review", title: "@larva:review",
    searchTerms: ["review", "@larva:review", "Component owner", "provider/model"], mimeType: "text/markdown", description: "Component owner" });
  assert.doesNotMatch(JSON.stringify(items), /prompt/i);
  assert.equal(CODEX_PERSONA_URI_TEMPLATE, "larva://personas/{persona_id}");
  assert.equal(parsePersonaResourceUri(personaResourceUri("editor-2")), "editor-2");
  for (const uri of ["larva://personas", "larva://personas/a?b", "larva://personas/a#b", "larva://personas/%2f", "larva://personas/a\n"]) {
    assert.equal(parsePersonaResourceUri(uri), undefined);
  }
  for (let index = 0; index < 205; index++) persona(`engineer-${index}`);
  assert.equal((await buildSearchMentionsOutput(personas, { query: "@Larva Subagents" })).items.length, 30);
  assert.equal((await buildSearchMentionsOutput(personas, { query: "", preload: true })).items.length, 200);
});

test("Codex manifests target the 0.9 bundle, forward approved environments, and ship the canonical skill", () => {
  assert.equal(CODEX_PANEL_URI, "ui://larva-pi-subagent/panel-v4");
  assert.equal(CODEX_WIDGET_URI, "ui://larva-pi-subagent/widget-v4");
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const manifest = JSON.parse(read("plugins/codex/.codex-plugin/plugin.json"));
  assert.equal(manifest.version, "0.9.0");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.logo, "./assets/larva.svg");
  assert.equal(manifest.interface.composerIcon, "./assets/larva.svg");
  assert.match(read("plugins/codex/assets/larva.svg"), /^<svg\b[\s\S]*<\/svg>\s*$/);
  const plugin = JSON.parse(read(".agents/plugins/marketplace.json")).plugins.find((item: { name: string }) => item.name === manifest.name);
  assert.deepEqual(plugin?.source, { source: "local", path: "./plugins/codex" });
  const mcp = JSON.parse(read("plugins/codex/.mcp.json")).mcpServers["larva-pi-subagent"];
  assert.equal(mcp.command, "node");
  assert.deepEqual(mcp.args, ["./dist/mcp-server.mjs"]);
  assert.equal(mcp.cwd, ".");
  assert.deepEqual(readdirSync(new URL("../../plugins/codex/dist/", import.meta.url)).sort(), [
    "child-rpc-preload.mjs", "mcp-server.mjs", "package.json", "pi-extension.js",
  ]);
  const env = new Set<string>(mcp.env_vars);
  for (const name of ["LARVA_HOME", "LARVA_PI_CLI_SCRIPT", "LARVA_MCP_PARENT_PERSONA", "PI_CODING_AGENT_DIR", "PATH", "HOME", "USER",
    "LOGNAME", "SHELL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "HTTP_PROXY",
    "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "OPENAI_API_KEY", "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
    "OPENROUTER_API_KEY", "MISTRAL_API_KEY", "AWS_PROFILE", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "ANTHROPIC_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME", "COPILOT_GITHUB_TOKEN", "DEEPSEEK_API_KEY", "GOOGLE_CLOUD_API_KEY", "HF_TOKEN", "KIMI_API_KEY", "ZAI_API_KEY"]) {
    assert.ok(env.has(name), name);
  }
  assert.equal(env.size, mcp.env_vars.length);
  assert.deepEqual(Array.from(env).filter(name => name.startsWith("LARVA_")).sort(), ["LARVA_HOME", "LARVA_MCP_PARENT_PERSONA", "LARVA_PI_CLI_SCRIPT"]);
  assert.equal(CODEX_INITIALIZE_INSTRUCTIONS, read("plugins/codex/skills/larva-subagent/SKILL.md"));
});
