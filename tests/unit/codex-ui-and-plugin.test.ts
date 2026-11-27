import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
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
      const matches = selector === "[data-scroll-key]" ? !!node.dataset.scrollKey : selector === node.tag;
      return [...(matches ? [node] : []), ...node.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
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
  let resizeDisconnected = false;
  const create = (tag: string) => new Element(tag, node => { focus = node; });
  const root = create("div");
  const parent = { postMessage: (message: Rpc) => sent.push(JSON.parse(JSON.stringify(message))) };
  const doc = {
    getElementById: () => root, createElement: create, documentElement: create("html"),
    get activeElement() { return focus; }, visibilityState: "visible",
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
    ResizeObserver: class { observe() {} disconnect() { resizeDisconnected = true; } },
    setTimeout(callback: () => void, delay: number) { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout(id: number) { timers.delete(id); },
  }, { timeout: 1000 });
  function send(message: Rpc, source: object = parent) {
    winEvents.get("message")?.({ data: { jsonrpc: "2.0", ...message }, source });
  }
  function button(name: string) { return root.querySelectorAll("button").find(node => node.textContent === name); }
  const calls = (name: string) => sent.filter(message => message.method === "tools/call" && message.params?.name === name);
  function lastCall(name: string) { const request = calls(name).at(-1); assert.ok(request); return request; }
  async function reply(request: Rpc, result: unknown) { send({ id: request.id, result }); await turn(); }
  return {
    root, sent, calls, lastCall, reply, button, copied,
    disconnect() { winEvents.get("messageerror")?.({ source: parent }); },
    get text() { return root.textContent; }, get timerCount() { return timers.size; },
    get mode() { return doc.documentElement.dataset.mode; }, get resizeDisconnected() { return resizeDisconnected; },
    async init(modes: string[]) {
      const init = sent[0];
      assert.equal(init.method, "ui/initialize");
      assert.deepEqual(init.params?.appCapabilities, { availableDisplayModes: modes });
      await reply(init, { hostContext: { displayMode: modes[0] } });
      assert.ok(sent.some(message => message.method === "ui/notifications/initialized"));
    },
    notify(method: string, params: Record<string, unknown>) { send({ method, params }); },
    foreign(message: Rpc) { send(message, {}); },
    input(args: object) { send({ method: "ui/notifications/tool-input", params: { arguments: args } }); },
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
    phase: "waiting_for_child", output_state: "pending", started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z", ...overrides };
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
  app.fire(2500);
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
  app.click(`${second} · Snapshot expired`);
  assert.match(app.text, /Run snapshot expired/);
  app.visibility("hidden");
  app.visibility("visible");
  await app.reply(app.lastCall(panelTool), snapshot([run({ run_epoch: "new" })]));
  app.click("reviewer · Completed");
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
  await panel.reply(panel.lastCall(panelTool), snapshot([run()]));
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
  assert.deepEqual(app.lastCall(panelTool).params?.arguments, { scope: "recent" });
  await app.reply(app.lastCall(panelTool), snapshot([run({ phase: "stall_suspected" })]));
  assert.match(app.text, /Stall suspected/);
  app.click("Active");
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

test("all output states are distinct and progress clears a visible stall", async () => {
  const app = mount(renderCodexWidgetHtml());
  await app.init(["inline", "fullscreen"]);
  accept(app);
  await app.reply(app.lastCall(panelTool), snapshot([run({ phase: "stall_suspected" })]));
  assert.match(app.text, /Stall suspected/);
  app.click("Details");
  assert.match(app.text, /Output pending/);
  app.fire(2500);
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
  assert.doesNotMatch(app.text, /Widget task preview|Working <em>|example\.ts|Output pending/);
  assert.equal(app.button("Copy task_id"), undefined);
  app.click("Details");
  assert.equal(app.button("Hide details")?.attributes.get("aria-expanded"), "true");
  assert.match(app.text, /Widget task preview.*Working <em>safely<\/em>.*example\.ts.*Output pending/);
  assert.equal(app.root.querySelectorAll("em").length, 0);
  app.click("Copy task_id");
  app.click("Copy prompt");
  assert.deepEqual(app.copied, [id, telemetry.task_preview]);
  assert.equal(app.root.querySelectorAll("textarea").length, 0);

  const replaced = app.button("Recorded args");
  app.fire(2500);
  const done = run({ ...telemetry, status: "success", phase: "success", active_tool: null, live_thinking: false,
    tool_snapshots: [{ ...telemetry.tool_snapshots![0], status: "done" }], output_state: "inline", result_text: "Completed output" });
  await app.reply(app.lastCall(panelTool), snapshot([done]));
  assert.ok(app.button("Hide details"));
  assert.match(app.text, /read \(done\).*Completed output/);
  assert.doesNotMatch(app.text, /Thinking…/);
  replaced?.onclick?.();
  assert.deepEqual(app.calls(activityTool), []);
  app.click("Copy output");
  assert.deepEqual(app.copied, [id, telemetry.task_preview, done.result_text]);
  app.click("Hide details");
  assert.doesNotMatch(app.text, /Completed output/);
  app.click("Details");
  app.click("Recorded args");
  assert.deepEqual(app.lastCall(activityTool).params?.arguments, { task_id: id, tool_call_id: "read-42", segment_part: "args" });
  await app.reply(app.lastCall(activityTool), recording("args", "Exact recorded args"));
  assert.match(app.text, /Exact recorded args/);
  app.click("Recorded result");
  const late = app.lastCall(activityTool);
  assert.deepEqual(late.params?.arguments, { task_id: id, tool_call_id: "read-42", segment_part: "result" });
  app.fire(2500);
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
    await app.reply(app.lastCall(panelTool), snapshot([telemetry]));
    app.click("Copy prompt");
    await turn();
    if (close === "teardown") assert.deepEqual(app.copied, [telemetry.task_preview]);
    else assert.match(app.text, /Copy unavailable/);
    app.click("Recorded result");
    const result = app.lastCall(activityTool);
    app.fire(2500);
    await app.reply(app.lastCall(panelTool), snapshot([telemetry]));
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
  app.fire(2500);
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
  await app.reply(app.lastCall(panelTool), snapshot([run()]));
  app.fire(2500);
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
  lost.fire(2500);
  const unanswered = lost.lastCall(panelTool);
  lost.fire(15000);
  await lost.reply(unanswered, snapshot([run({ persona_id: "late after connection loss" })]));
  assert.match(lost.text, /Connection lost. This view is read-only/);
  assert.match(lost.text, /reviewer/);
  assert.doesNotMatch(lost.text, /late after connection loss/);
  assert.equal(lost.button("Cancel"), undefined);
  assert.equal(lost.button("Refresh")?.disabled, true);
  assert.equal(lost.timerCount, 0);
  assert.equal(lost.calls(cancelTool).length, 0);
});

test("persona resource links rank exact, prefix, substring and description matches without leaking prompts", () => {
  const persona = (id: string, description = "Component owner") => ({ id, description, model: "provider/model", prompt: "private prompt" });
  const personas = [persona("designer", "Review interfaces"), persona("ui-review"), persona("reviewer"), persona("review"), persona("tester")];
  const { items } = buildSearchMentionsOutput(personas, { query: " @LaRVa:REVIEW " });
  assert.deepEqual(items.map(item => item.name), ["review", "reviewer", "ui-review", "designer"]);
  assert.deepEqual(items[0], { type: "resource_link", uri: "larva://personas/review", name: "review", title: "@larva:review",
    searchTerms: ["review", "@larva:review", "Component owner", "provider/model"], mimeType: "text/markdown", description: "Component owner" });
  assert.doesNotMatch(JSON.stringify(items), /prompt/i);
  assert.equal(CODEX_PERSONA_URI_TEMPLATE, "larva://personas/{persona_id}");
  assert.equal(parsePersonaResourceUri(personaResourceUri("editor-2")), "editor-2");
  for (const uri of ["larva://personas", "larva://personas/a?b", "larva://personas/a#b", "larva://personas/%2f", "larva://personas/a\n"]) {
    assert.equal(parsePersonaResourceUri(uri), undefined);
  }
  const catalog = Array.from({ length: 205 }, (_, index) => persona(`engineer-${index}`));
  assert.equal(buildSearchMentionsOutput(catalog, { query: "@larva" }).items.length, 30);
  assert.equal(buildSearchMentionsOutput(catalog, { query: "", preload: true }).items.length, 200);
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
    "AZURE_OPENAI_API_KEY", "COPILOT_GITHUB_TOKEN", "DEEPSEEK_API_KEY", "GOOGLE_CLOUD_API_KEY", "HF_TOKEN", "KIMI_API_KEY", "ZAI_API_KEY"]) {
    assert.ok(env.has(name), name);
  }
  assert.equal(env.size, mcp.env_vars.length);
  assert.deepEqual(Array.from(env).filter(name => name.startsWith("LARVA_")).sort(), ["LARVA_HOME", "LARVA_MCP_PARENT_PERSONA", "LARVA_PI_CLI_SCRIPT"]);
  assert.equal(CODEX_INITIALIZE_INSTRUCTIONS, read("plugins/codex/skills/larva-subagent/SKILL.md"));
});
