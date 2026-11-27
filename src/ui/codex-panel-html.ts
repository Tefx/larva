export const CODEX_PANEL_URI = "ui://larva-pi-subagent/panel-v4";
export const CODEX_PANEL_DISPLAY_MODES = ["fullscreen"] as const;

export function renderCodexPanelHtml(version?: string): string {
  return renderCodexAppHtml("panel", CODEX_PANEL_DISPLAY_MODES, version);
}

/** Shared observer for both app resources; the iframe needs no modules or network. */
export function renderCodexAppHtml(surface: "panel" | "widget", modes: readonly string[], version = "source"): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Larva Subagents</title><style>${styles}</style></head>
<body><div id="app"></div><script>(${app})(${JSON.stringify(surface)},${JSON.stringify(modes)},${JSON.stringify(version)});</script></body></html>`;
}

const styles = `
:root {
  color-scheme: light dark;
  --background: var(--color-background-primary, light-dark(#ffffff, #181818));
  --foreground: var(--color-text-primary, light-dark(#1a1c1f, #ffffff));
  --secondary: var(--color-background-secondary, light-dark(rgba(255,255,255,.96), rgba(54,54,54,.96)));
  --tertiary: var(--color-background-tertiary, color-mix(in srgb, var(--foreground) 4%, var(--background)));
  --card: color-mix(in srgb, var(--foreground) 5%, var(--background));
  --muted: color-mix(in srgb, var(--foreground) 8%, transparent);
  --muted-foreground: var(--color-text-secondary, light-dark(rgba(26,28,31,.55), rgba(255,255,255,.55)));
  --border: var(--color-border-secondary, light-dark(rgba(26,28,31,.09), rgba(255,255,255,.09)));
  --input: var(--color-border-primary, light-dark(rgba(26,28,31,.13), rgba(255,255,255,.13)));
  --primary: var(--color-text-info, light-dark(#339cff, #83c3ff));
  --accent: var(--color-background-info, color-mix(in srgb, var(--primary) 14%, transparent));
  --success: var(--color-text-success, light-dark(#16a34a, #4ade80));
  --success-bg: var(--color-background-success, color-mix(in srgb, var(--success) 14%, transparent));
  --warning: var(--color-text-warning, light-dark(#d97706, #fbbf24));
  --warning-bg: var(--color-background-warning, color-mix(in srgb, var(--warning) 14%, transparent));
  --danger: var(--color-text-danger, light-dark(#dc2626, #f87171));
  --danger-bg: var(--color-background-danger, color-mix(in srgb, var(--danger) 14%, transparent));
  --ring: var(--color-ring-primary, var(--primary));
  --radius-sm: var(--border-radius-sm, 6px);
  --radius-md: var(--border-radius-md, 8px);
  --radius-lg: var(--border-radius-lg, 12px);
  --app-font-sans: var(--font-sans, -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif);
  --app-font-mono: var(--font-mono, ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace);
  font: 13px/1.5 var(--app-font-sans);
  color: var(--foreground);
  background: var(--background);
}
[data-theme=light] { color-scheme: light }
[data-theme=dark] { color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0 }
/* Keep inline height intrinsic even after the host resizes the iframe. */
#app { padding: calc(12px + var(--safe-top, 0px)) calc(12px + var(--safe-right, 0px)) calc(12px + var(--safe-bottom, 0px)) calc(12px + var(--safe-left, 0px)); overflow-wrap: anywhere }
[data-mode=fullscreen] #app { display: flex; flex-direction: column; height: 100dvh }
button { font: inherit; color: inherit; cursor: pointer; background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 9px; min-height: 30px }
button:hover { background: var(--muted) }
button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }
button:disabled { opacity: .5; cursor: wait }
button[aria-pressed=true] { background: var(--accent); border-color: var(--primary) }
.toolbar, .row, .controls, .tabs { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
.toolbar { padding-bottom: 10px }
.toolbar > :is(h1, strong) { margin-inline-end: auto }
.toolbar > strong, .run-card strong, .tool-row strong, .preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.model, .badge { border-radius: 999px; background: var(--muted); padding: 1px 6px; font-size: 11px }
.elapsed { font-variant-numeric: tabular-nums; white-space: nowrap; margin-inline-start: auto; color: var(--muted-foreground) }
.summary, .muted { color: var(--muted-foreground) }
.status { display: inline-flex; flex: none; color: var(--muted-foreground) }
.status svg { display: block }
.status[data-status=running], .status[data-status=accepted] { color: var(--primary) }
.status[data-status=running] { animation: pulse 2s ease-in-out infinite }
@keyframes pulse { 50% { opacity: .45 } }
@media (prefers-reduced-motion: reduce) { .status[data-status=running] { animation: none } }
.status[data-status=success] { color: var(--success) }
.status[data-status=failed], .error, .cancel { color: var(--danger) }
.status[data-status=cancelled], .status[data-status=stall_suspected], .warning { color: var(--warning) }
.workbench { display: grid; grid-template-columns: minmax(220px, 30%) minmax(0, 1fr); flex: 1; min-height: 280px; border-top: 1px solid var(--border) }
.run-list { min-width: 0; overflow: auto; padding: 12px 12px 12px 0; border-inline-end: 1px solid var(--border) }
.run-card { display: block; width: 100%; text-align: start; padding: 10px; margin-bottom: 6px; background: var(--tertiary); border-radius: var(--radius-md); overflow: hidden }
.run-card .row { flex-wrap: nowrap }
.run-card .preview { display: block; color: var(--muted-foreground); margin-top: 4px }
.inspector { overflow: auto; padding: 16px; min-width: 0 }
.detail-header { margin-bottom: 16px }
h1, h2 { font-size: 17px; margin: 0 }
h3 { font-size: 12px; margin: 14px 0 8px }
h4 { font-size: 11px; color: var(--muted-foreground); margin: 10px 0 4px }
p { margin: 0 0 8px }
.tabs { border-bottom: 1px solid var(--border); padding-bottom: 8px; position: sticky; top: 0; background: var(--background); z-index: 1; flex-wrap: nowrap }
.tabs button { flex: 1 1 0; min-width: 0 }
.tab-body { padding-top: 12px; min-width: 0 }
code, pre { font: 12px/1.6 var(--app-font-mono) }
pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; margin: 6px 0 12px }
.stream, .result { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--tertiary) }
.stream { max-height: 160px }
.result { max-height: 55dvh }
.activity { color: var(--primary); background: var(--accent); border-radius: var(--radius-sm); padding: 8px }
.drawer { margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--secondary); box-shadow: 0 2px 6px var(--muted); max-height: 340px; overflow-y: auto }
[data-mode=inline] .result { max-height: 220px }
.telemetry { list-style: none; padding: 0; margin: 0 }
.telemetry li { border: 1px solid var(--border); border-radius: var(--radius-md); margin: 6px 0 }
.tool-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: start; border: 0 }
.tool-row .preview { flex: 1; color: var(--muted-foreground) }
.tool-content { padding: 0 12px 12px }
.tool-content pre { max-height: 260px }
.metadata { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content minmax(0, 1fr); gap: 4px 10px; font-size: 11px }
.metadata dt { color: var(--muted-foreground) }
.metadata dd { margin: 0; overflow-wrap: anywhere }
.metadata .session-label { grid-column: 1 }
.metadata .session-value { grid-column: 2 / -1 }
.section-card { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--tertiary); padding: 10px; margin-bottom: 10px }
.section-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap }
.section-header h3 { margin: 0 auto 0 0 }
.section-header button { font-size: 11px; min-height: 26px; padding: 3px 7px }
.prompt-box { max-height: 110px; overflow: auto; padding: 8px; background: var(--background); border: 1px solid var(--border); border-radius: var(--radius-sm) }
.prompt-box[data-expanded=true] { max-height: none }
.compact-list, .switcher { max-height: 180px; overflow: auto; padding: 3px }
.compact-list .run-card { display: flex; gap: 12px; padding: 6px }
.compact-list .run-card > .row { flex: 0 1 auto; min-width: 0 }
.compact-list .run-card:has(> .preview) > .row { max-inline-size: 50% }
.compact-list .run-card > .preview { flex: 1 }
.switcher { display: flex; gap: 6px; margin-top: 8px }
.switcher .run-card { flex: 0 0 180px }
.notice { padding: 8px 10px; background: var(--muted); border-inline-start: 3px solid }
.notice.warning { background: var(--warning-bg) }
.notice.error { background: var(--danger-bg) }
@media (max-width: 679px) {
  .workbench { display: flex; flex-direction: column }
  .run-list { flex: 0 0 auto; max-height: 148px; overflow-y: auto; border-inline-end: 0; border-bottom: 1px solid var(--border); padding: 8px 0 }
  .inspector { flex: 1; min-height: 0; padding: 12px 0 }
  .toolbar { gap: 6px }
}
`;

// Keep this script as JavaScript source: the Node bundler must not inject
// helpers that aren't available in the sandboxed app document.
const app = String.raw`function (surface, modes, version) {
  const panel = surface === 'panel';
  const root = document.getElementById('app');
  const terminal = new Set(['success', 'failed', 'cancelled']);
  const active = run => run.status === 'accepted' || run.status === 'running';
  const scopes = ['active', 'recent', 'disk'];
  const pair = row => typeof row?.task_id === 'string' && row.task_id.length > 0 &&
    typeof row.run_epoch === 'string' && row.run_epoch.length > 0;
  const key = row => JSON.stringify([row.task_id, row.run_epoch]);
  const phase = run => ({ starting: 'Starting', waiting_for_child: 'Working', stall_suspected: 'Stall suspected',
    cancelling: 'Cancelling', success: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[run.phase] ?? run.status;
  const same = (a, b) => pair(a) && pair(b) && a.task_id === b.task_id && a.run_epoch === b.run_epoch;
  const captured = new Map();
  const cancelling = new Set();
  const detailsOpen = new Set();
  const expandedPrompts = new Set();
  const collapsedTools = new Map();
  const requests = new Map();
  const cancelNotices = new Map();
  const tabs = ['All', 'Timeline', 'Result', 'Task & Session'];
  let tab = tabs[0], doneOnly = false, activity, textRead;
  let sequence = 0, view = 0, renderVersion = 0, pollTimer, clockTimer, poll, displayRequest, mode = modes[0], availableModes = modes;
  let connection = 'connecting';
  let target = { kind: 'pending' };
  let toolInput, initialResult, waitOutcome, renderDeferred = false;
  let rows = [], failures = [], selected, loading = true, readError;

  const visible = () => document.visibilityState !== 'hidden';
  const observing = () => connection === 'ready' && visible();
  const post = message => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params = {}) => post({ method, params });

  function rpc(method, params, kind = 'observer') {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error('The host did not respond.'));
        if (kind === 'initialize') disconnect();
      }, 15000);
      requests.set(id, { resolve, reject, timer, kind });
      try { post({ id, method, params }); }
      catch (error) { disconnect(); }
    });
  }

  function retireRequests(predicate) {
    for (const [id, request] of requests) {
      if (!predicate(request.kind)) continue;
      requests.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error('View closed.'));
    }
  }

  function clearActivity() {
    if (!activity) return;
    activity = undefined;
    retireRequests(kind => kind === 'activity');
  }

  function stopObserving() {
    view++;
    clearTimeout(pollTimer);
    clearInterval(clockTimer);
    clockTimer = undefined;
    poll = undefined;
    clearActivity();
    clearTextRead();
    retireRequests(kind => kind === 'observer');
  }

  function disconnect() {
    if (connection === 'closed' || connection === 'lost') return;
    connection = 'lost';
    finishInvocation();
    stopObserving();
    retireRequests(() => true);
    observer.disconnect();
    render();
  }

  function applyContext(context) {
    if (Array.isArray(context?.availableDisplayModes)) availableModes = modes.filter(candidate => context.availableDisplayModes.includes(candidate));
    if (availableModes.includes(context?.displayMode)) mode = context.displayMode;
    else if (!availableModes.includes(mode) && availableModes.length) mode = availableModes[0];
    const html = document.documentElement;
    if (context?.theme === 'light' || context?.theme === 'dark') html.dataset.theme = context.theme;
    for (const [name, value] of Object.entries(context?.styles?.variables ?? {})) {
      if (name.startsWith('--') && typeof value === 'string') html.style.setProperty(name, value);
    }
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const size = context?.safeAreaInsets?.[side];
      if (Number.isFinite(size) && size >= 0) html.style.setProperty('--safe-' + side, size + 'px');
    }
    render();
  }

  function queryFor(input, fallbackScope) {
    if (typeof input.task_id === 'string' && input.task_id) return { task_id: input.task_id };
    return {
      ...(scopes.includes(input.scope) ? { scope: input.scope } : fallbackScope ? { scope: fallbackScope } : {}),
      ...(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 25 ? { limit: input.limit } : {}),
    };
  }

  function invocationFor(args) {
    if ('task_ids' in args) return { kind: 'wait', taskIds: Array.isArray(args.task_ids) ? args.task_ids.slice(0, 25) : [] };
    if ('task' in args || 'persona_id' in args) return { kind: 'spawn', personaId: typeof args.persona_id === 'string' ? args.persona_id : undefined };
    return { kind: 'status', query: queryFor(args) };
  }

  const dataOf = result => result?.structuredContent ?? result?.details ?? result;
  const errorOf = result => dataOf(result)?.error?.message ?? result?.content?.find?.(item => item.type === 'text')?.text;
  const tool = (name, args, kind) => rpc('tools/call', { name, arguments: args }, kind);

  function terminalOutput(run, outputs) {
    const output = outputs && Object.hasOwn(outputs, run.task_id) ? outputs[run.task_id] : undefined;
    if (!same(run, output) || !terminal.has(output.status)) return run;
    // Do not carry the run's stale preview/artifact into a different output state.
    const { output_state, result_text, result_preview, full_output_artifact, output_diagnostic, ...metadata } = run;
    return { ...metadata, ...output };
  }

  function isCaptured(run) {
    return terminal.has(run.status) && ['inline', 'artifactized', 'delivery_failed', 'evicted'].includes(run.output_state);
  }

  function acceptSnapshot(data, pinRefresh = false) {
    const runs = (Array.isArray(data?.runs) ? data.runs : []).filter(pair);
    if (target.kind === 'pinned') {
      rows = Array.from(target.pairs, ([id, epoch]) => {
        const run = runs.find(row => row.task_id === id && row.run_epoch === epoch);
        if (run) {
          const current = terminalOutput(run, data.terminal_outputs);
          if (isCaptured(current)) captured.set(id, current);
          const saved = captured.get(id);
          return { kind: 'run', run: saved ? { ...saved, ...current, ...(!isCaptured(current) && {
            output_state: saved.output_state, result_text: saved.result_text, result_preview: saved.result_preview,
            full_output_artifact: saved.full_output_artifact, output_diagnostic: saved.output_diagnostic,
          }) } : current };
        }
        const saved = captured.get(id);
        const previous = rows.find(row => row.run?.task_id === id && row.run?.run_epoch === epoch)?.run ?? saved;
        const error = data.row_errors?.find(item => item.task_id === id && item.run_epoch === epoch)?.error;
        if (error) return { kind: 'fault', run: previous ?? { task_id: id, run_epoch: epoch }, error };
        return saved ? { kind: 'run', run: saved }
          : { kind: pinRefresh ? 'expired' : 'run', run: { task_id: id, run_epoch: epoch, output_state: 'pending' } };
      });
      return;
    }
    if (target.kind !== 'latest') return;
    const query = target.query;
    failures = query.task_id || query.scope === 'disk' ? []
      : (Array.isArray(data?.startup_failures) ? data.startup_failures.slice(0, 25) : []);
    const live = runs.filter(run => !query.task_id || query.task_id === run.task_id)
      .map(run => terminalOutput(run, data.terminal_outputs));
    if (query.scope === 'disk' || (query.task_id && !live.length)) {
      const disk = Array.isArray(data?.disk_sessions) ? data.disk_sessions.slice(0, 25) : [];
      rows = disk.filter(row => typeof row?.task_id === 'string' && typeof row.cwd === 'string' &&
        (!query.task_id || query.task_id === row.task_id)).map(disk => ({
        kind: 'disk', disk, run: disk.lock_state === 'active_local' ? live.find(run => run.task_id === disk.task_id) : undefined,
      }));
    } else {
      rows = live.filter(run => query.scope !== 'active' || !terminal.has(run.status) || run.cleanup_unconfirmed).map(run => ({ kind: 'run', run }));
    }
  }

  function applyInvocation() {
    if (target.kind !== 'pending' || !toolInput || initialResult === undefined) return;
    const data = dataOf(initialResult);
    const runs = Array.isArray(data?.runs) ? data.runs.slice(0, 25) : [];
    // The app notifications carry arguments and a result, not necessarily the
    // tool name. Use the disjoint spawn/wait receipt shapes, never input IDs
    // alone, as the authority for binding an epoch.
    const waitResult = toolInput.kind === 'wait' && !initialResult.isError &&
      typeof data?.ready === 'boolean' && typeof data.timed_out === 'boolean';
    if (waitResult) waitOutcome = [data.ready ? 'Wait ready' : 'Wait not ready', data.timed_out && 'Timed out'].filter(Boolean).join(' · ');
    let snapshots = [];
    if (toolInput.kind === 'spawn' && pair(data) &&
        (terminal.has(data.status) || (!initialResult.isError && data.status === 'accepted'))) {
      snapshots = [{ persona_id: toolInput.personaId, phase: data.status === 'accepted' ? 'starting' : data.status,
        output_state: 'pending', ...data }];
    } else if (waitResult) {
      snapshots = runs.filter(row => toolInput.taskIds.includes(row?.task_id));
    }
    const pairs = new Map(snapshots.filter(pair).map(row => [row.task_id, row.run_epoch]));
    if (pairs.size) {
      target = { kind: 'pinned', pairs };
      acceptSnapshot({ runs: snapshots, terminal_outputs: data.terminal_outputs });
    } else if (initialResult.isError || data?.error || waitResult) {
      const message = errorOf(initialResult) ?? (waitResult ? 'No run snapshot was returned for this wait.' : 'The tool call was rejected.');
      target = { kind: 'rejected', message };
    } else if (toolInput.kind === 'status' && Array.isArray(data?.runs) && Array.isArray(data.startup_failures)) {
      target = { kind: 'latest', query: toolInput.query };
      acceptSnapshot(data);
    } else {
      return;
    }
    finishInvocation();
    loading = false;
    render();
    void refresh();
  }

  function finishInvocation() {
    toolInput = undefined;
    initialResult = undefined;
  }

  async function refresh() {
    if (!observing() || poll || (target.kind !== 'pinned' && target.kind !== 'latest')) return;
    clearTimeout(pollTimer);
    const ticket = poll = { stale: false };
    const args = target.kind === 'pinned' ? { run_epochs: Array.from(target.pairs, ([task_id, run_epoch]) => ({ task_id, run_epoch })) } : target.query;
    try {
      const read = async query => {
        const response = await tool('larva_subagent_panel', query);
        if (response?.isError) throw new Error(errorOf(response) ?? 'Could not refresh runs.');
        const data = dataOf(response);
        if (!Array.isArray(data?.runs)) throw new Error('Invalid run snapshot from the host.');
        return data;
      };
      const grouped = target.kind === 'latest' && !args.task_id && (!args.scope || args.scope === 'recent') && mode === 'fullscreen';
      if (grouped) {
        const results = await Promise.allSettled([read({ ...args, scope: 'active', limit: args.limit ?? 25 }), read({ ...args, limit: args.limit ?? 25 })]);
        if (poll !== ticket || ticket.stale) return;
        const [live, recent] = results;
        const combined = new Map();
        // Without a fresh side, preserve its existing rows rather than reporting their disappearance.
        for (const [side, outcome] of results.entries()) {
          const source = outcome.status === 'fulfilled' ? outcome.value.runs
            : rows.filter(row => row.kind === 'run' && (side === 0 ? !terminal.has(row.run.status) : terminal.has(row.run.status))).map(row => row.run);
          for (const run of source) if (pair(run)) {
            const id = key(run), previous = combined.get(id);
            if (!previous || previous.updated_at < run.updated_at) combined.set(id, run);
          }
        }
        acceptSnapshot({ runs: [...combined.values()], startup_failures: recent.value?.startup_failures ?? live.value?.startup_failures ?? failures });
        readError = results.flatMap((outcome, index) => outcome.status === 'rejected' ? [(index ? 'Done: ' : 'Active: ') + outcome.reason.message] : []).join(' ') || undefined;
      } else {
        const data = await read(args);
        if (poll !== ticket || ticket.stale) return;
        acceptSnapshot(data, true);
        readError = undefined;
      }
    } catch (error) {
      if (poll === ticket && !ticket.stale) readError = error.message;
    } finally {
      if (poll === ticket) {
        poll = undefined;
        if (ticket.stale) void refresh();
        else {
          loading = false;
          render(true);
          if (target.kind === 'latest' || readError || rows.some(row => row.kind === 'fault' ||
              row.kind === 'run' && (!isCaptured(row.run) || row.run.cleanup_unconfirmed))) {
            pollTimer = setTimeout(refresh, 1000);
          }
        }
      }
    }
  }

  function reopen() {
    render();
    void refresh();
  }

  function setQuery(query, showDone = false) {
    doneOnly = showDone;
    stopObserving();
    target = { kind: 'latest', query };
    rows = []; failures = []; selected = undefined; readError = undefined;
    loading = true;
    reopen();
  }

  async function changeMode() {
    const requested = mode === 'inline' ? 'fullscreen' : 'inline';
    if (!observing() || displayRequest || !availableModes.includes(requested)) return;
    const ticket = displayRequest = {};
    const token = view;
    render();
    try {
      const result = await rpc('ui/request-display-mode', { mode: requested });
      if (token !== view || !observing()) return;
      applyContext({ displayMode: result?.mode });
      void refresh();
    } catch (error) {
      if (token === view && observing()) readError = error.message;
    } finally {
      if (displayRequest === ticket) { displayRequest = undefined; render(); }
    }
  }

  async function cancel(run) {
    const id = key(run);
    const owns = row => row.kind === 'run' && same(row.run, run) && (active(row.run) || row.run.cleanup_unconfirmed);
    if (!observing() || loading || cancelling.has(id) || !rows.some(owns)) return;
    const token = view;
    cancelling.add(id);
    cancelNotices.delete(id);
    render();
    try {
      const response = await tool('larva_subagent_cancel', {
        task_ids: [run.task_id], reason: 'Cancelled from Larva Subagents',
        expected_run_epochs: [{ task_id: run.task_id, run_epoch: run.run_epoch }],
      }, 'cancel');
      if (token !== view || !observing()) return;
      const item = dataOf(response)?.results?.find?.(result => result?.task_id === run.task_id);
      switch (item?.outcome) {
        case 'cancelled':
        case 'already_terminal': break;
        case 'cleanup_unconfirmed':
          cancelNotices.set(id, { text: 'Cancellation cleanup could not be confirmed.', style: 'warning' }); break;
        case 'not_found':
          cancelNotices.set(id, { text: 'Run not found for cancellation. No newer run was targeted.', style: 'error' }); break;
        default: throw new Error(errorOf(response) ?? 'Cancellation outcome unavailable.');
      }
      if (item.outcome !== 'cleanup_unconfirmed') {
        loading = true;
        if (poll) poll.stale = true;
      }
    } catch (error) {
      if (token === view && observing()) cancelNotices.set(id, { text: error.message, style: 'error' });
    } finally {
      cancelling.delete(id);
      if (token === view && observing()) {
        render();
        void refresh();
      }
    }
  }

  function element(tag, text, parent = root) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }

  function button(name, action, parent, options = {}) {
    const node = element('button', name, parent);
    const version = renderVersion;
    const current = () => version === renderVersion && visible() && connection !== 'closed';
    node.type = 'button';
    node.onclick = () => { if (current() && !node.disabled) action(current); };
    node.disabled = options.disabled ?? false;
    node.dataset.focusKey = options.key ?? name;
    if (options.pressed !== undefined) node.setAttribute('aria-pressed', String(options.pressed));
    if (options.expanded !== undefined) node.setAttribute('aria-expanded', String(options.expanded));
    return node;
  }

  function copyButton(label, text, parent, id) {
    if (typeof text !== 'string' || !text) return;
    const feedback = element('span', '', parent);
    feedback.setAttribute('role', 'status');
    button(label, async current => {
      let copied = false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch { /* A sandbox may deny Clipboard API access. */ }
      if (!current()) return;
      if (!copied) {
        const focus = document.activeElement;
        const field = element('textarea', undefined, parent);
        field.value = text;
        field.readOnly = true;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        try {
          field.select();
          copied = document.execCommand?.('copy') === true;
        } catch { /* Fall back to user selection. */ }
        finally { field.remove(); focus?.focus({ preventScroll: true }); }
      }
      feedback.textContent = copied ? 'Copied.' : 'Copy unavailable. Select the text to copy it manually.';
    }, parent, { key: label + ':' + id });
  }

  function notice(text, style, parent = root) {
    const node = element('p', text, parent);
    node.className = 'notice ' + style;
    node.setAttribute('role', style === 'error' ? 'alert' : 'status');
  }

  function pathLine(label, path, parent) {
    if (typeof path !== 'string' || !path) return;
    const line = element('p', label + ': ', parent);
    element('code', path, line);
  }

  function section(title, parent) {
    const card = element('section', undefined, parent);
    card.className = 'section-card';
    const heading = element('div', undefined, card);
    heading.className = 'section-header';
    element('h3', title, heading);
    return { card, heading };
  }

  function clearTextRead() {
    textRead = undefined;
    retireRequests(kind => kind === 'slice');
  }

  async function readText(run, source, offset) {
    if (!observing()) return;
    const previous = offset !== undefined ? textRead : undefined;
    clearTextRead();
    const request = textRead = { runKey: key(run), source, state: 'loading' };
    render();
    try {
      let text = '';
      do {
        const response = await tool('larva_subagent_panel', { slice: {
          task_id: run.task_id, ...(run.run_epoch && { run_epoch: run.run_epoch }), source,
          offset: offset ?? 0,
        } }, 'slice');
        if (textRead !== request || !observing()) return;
        const page = dataOf(response)?.slice;
        if (response?.isError) throw new Error(errorOf(response) ?? 'Could not read text.');
        if (page?.state !== 'ok') throw new Error('Full ' + source + ' is unavailable.');
        if (page.offset !== (offset ?? 0) || typeof page.text !== 'string' ||
            (page.continuation_offset !== undefined && (!Number.isSafeInteger(page.continuation_offset) || page.continuation_offset <= page.offset))) {
          throw new Error('Invalid text page from host.');
        }
        text += page.text;
        offset = page.continuation_offset;
      } while (source === 'prompt' && offset !== undefined);
      Object.assign(request, { state: 'ready', text, next: offset, start: previous?.next ?? 0 });
    } catch (error) {
      if (textRead !== request || !observing()) return;
      Object.assign(request, { state: 'error', message: error.message });
    }
    render(true);
  }

  function textReader(run, source, parent) {
    const current = textRead?.source === source && textRead.runKey === key(run) ? textRead : undefined;
    const label = source === 'prompt' ? 'Load full prompt' : 'Read full output';
    button(label, () => void readText(run, source), parent, { disabled: !observing() || current?.state === 'loading' });
    if (current?.state === 'loading') notice('Reading ' + source + '…', '', parent);
    if (current?.state === 'error') notice(current.message, 'error', parent);
    if (current?.state !== 'ready') return;
    const page = element('pre', current.text, parent);
    page.className = source === 'prompt' ? 'prompt-box' : 'result';
    page.dataset.scrollKey = 'full:' + source + ':' + key(run);
    if (source === 'prompt') copyButton('Copy full prompt', current.text, parent, key(run));
    else {
      copyButton('Copy output page', current.text, parent, key(run));
      if (current.next !== undefined) button('Next output page', () => void readText(run, source, current.next), parent, { disabled: !observing() });
      if (current.start) button('First output page', () => void readText(run, source), parent, { disabled: !observing() });
    }
  }

  function output(run, container) {
    const { card: parent, heading } = section('Result', container);
    if (run.error?.message) notice(run.error.message, 'error', parent);
    const artifact = run.full_output_artifact?.path;
    const text = run.result_text ?? run.result_preview;
    const preview = run.result_preview ?? run.result_text;
    const show = value => {
      const pre = element('pre', value, parent);
      pre.className = 'result';
      pre.dataset.scrollKey = 'output:' + key(run);
    };
    switch (run.output_state) {
      case 'inline':
        show(text ?? '');
        copyButton('Copy output', text, heading, key(run));
        break;
      case 'artifactized':
        if (preview) show(preview);
        copyButton('Copy output preview', preview, heading, key(run));
        pathLine(artifact ? 'Full output artifact' : 'Recorded transcript', artifact ?? run.task_id, parent);
        textReader(run, 'output', parent);
        break;
      case 'delivery_failed':
        notice((run.status === 'success' ? 'Execution succeeded, but output delivery failed.' : 'Output delivery failed.') +
          (run.output_diagnostic?.message ? ' ' + run.output_diagnostic.message : ''), 'warning', parent);
        if (run.result_preview) show(run.result_preview);
        copyButton('Copy output preview', run.result_preview, heading, key(run));
        pathLine('Recorded transcript', run.task_id, parent);
        break;
      case 'evicted':
        notice('Output evicted from the live snapshot.', 'warning', parent);
        pathLine(artifact ? 'Full output artifact' : 'Recorded transcript', artifact ?? run.task_id, parent);
        break;
      default: notice('Output pending…', '', parent);
    }
  }

  async function inspect(run, callId, part, selection = {}) {
    if (!observing()) return;
    clearActivity();
    const request = activity = { runKey: key(run), callId, part, selection, state: 'loading' };
    render();
    try {
      const result = await tool('larva_subagent_activity', {
        task_id: run.task_id, tool_call_id: callId, segment_part: part, ...selection,
      }, 'activity');
      if (activity !== request || !observing()) return;
      const data = dataOf(result);
      const segment = data?.call?.segment;
      if (result?.isError || data?.error) throw new Error(errorOf(result) ?? 'Recorded activity unavailable.');
      if (data?.status === 'ambiguous') {
        Object.assign(request, { state: 'choose', candidates: data.candidates, coordinate: 'disambiguation_index' });
      } else if (!segment && part === 'result' && data?.call?.result_state === 'ambiguous') {
        Object.assign(request, { state: 'choose', candidates: data.call.result_candidates, coordinate: 'result_index' });
      } else {
        if (data?.status !== 'success' || data.call?.call_id !== callId || segment?.part !== part || typeof segment.text !== 'string') {
          throw new Error('No recorded ' + part + ' available for this call yet.');
        }
        Object.assign(request, { state: 'ready', segment, partial: segment.upstream_truncated || data.inspection_complete === false });
      }
    } catch (error) {
      if (activity !== request || !observing()) return;
      Object.assign(request, { state: 'error', text: error.message });
    }
    render(true);
  }

  function recentTools(run, parent) {
    if (!run.tool_snapshots?.length) return;
    element('h3', 'Recent tool calls', parent);
    const list = element('ul', undefined, parent);
    list.className = 'telemetry';
    // One live summary per call ID; the recording inspector owns duplicate candidates.
    const calls = new Map(run.tool_snapshots.map(call => [call.tool_call_id, call]));
    for (const call of [...calls.values()].reverse()) {
      const item = element('li', undefined, list);
      const callKey = JSON.stringify([key(run), call.tool_call_id]);
      const current = activity?.callId === call.tool_call_id ? activity : undefined;
      const collapsed = collapsedTools.get(key(run));
      const open = !collapsed?.has(call.tool_call_id);
      const control = button(undefined, () => {
        if (current) clearActivity();
        if (open) {
          const next = collapsed ?? new Set();
          next.add(call.tool_call_id);
          collapsedTools.set(key(run), next);
        } else collapsed.delete(call.tool_call_id);
        render();
      }, item, { key: 'tool:' + callKey, expanded: open });
      control.className = 'tool-row';
      control.setAttribute('aria-label', call.name + ' (' + call.status + ')');
      element('strong', call.name, control);
      element('span', call.status, control).className = 'badge';
      if (!open && call.args_preview) element('span', call.args_preview, control).className = 'preview';
      if (!open) continue;
      const content = element('div', undefined, item);
      content.className = 'tool-content';
      for (const [label, text] of [['Arguments', call.args_preview], ['Output', call.output_preview], ['Error', call.error_preview]]) {
        if (text) { element('h4', label, content); element('pre', text, content); }
      }
      const controls = element('div', undefined, content);
      controls.className = 'controls';
      for (const part of ['args', 'result']) button(part === 'args' ? 'Recorded args' : 'Recorded result', () => void inspect(run, call.tool_call_id, part), controls, {
        key: part + ':' + callKey, disabled: !observing() || (current?.part === part && current.state === 'loading'),
      });
      if (!current) continue;
      button('Close recording', () => { clearActivity(); render(); }, controls, { key: 'close:' + callKey });
      if (current.state === 'loading') notice('Loading recorded ' + current.part + '…', '', content);
      else if (current.state === 'error') notice(current.text, 'error', content);
      else if (current.state === 'choose') {
        notice('Multiple recordings match; select a candidate.', 'warning', content);
        for (const candidate of current.candidates ?? []) button('Recording ' + (candidate.index + 1) + ' · line ' + candidate.line_number,
          () => void inspect(run, current.callId, current.part, { ...current.selection, [current.coordinate]: candidate.index }), content,
          { disabled: !observing() });
      } else {
        element('h3', 'Recorded ' + current.part, content);
        const segment = current.segment;
        element('pre', segment.text, content).dataset.scrollKey = current.part + ':' + callKey;
        if (Number.isSafeInteger(segment.continuation_offset) && segment.continuation_offset > segment.offset && segment.source_version) {
          button('Next recorded page', () => void inspect(run, current.callId, current.part, { ...current.selection,
            offset: segment.continuation_offset, source_version: segment.source_version }), content, { disabled: !observing() });
        }
        if (current.partial) notice('Partial recording. Inspect the transcript for more.', 'warning', content);
      }
    }
  }

  const rowKey = row => row.kind === 'disk' ? 'disk:' + row.disk.task_id : key(row.run);
  const activeRow = row => row.kind === 'run' && !terminal.has(row.run.status);
  const doneRow = row => row.kind !== 'disk' && !activeRow(row);
  const shownRows = () => doneOnly ? rows.filter(doneRow) : rows;
  const selectedRow = (items = shownRows()) => items.find(row => rowKey(row) === selected) ?? items[0];
  const diskStatus = disk => ['active_external', 'unreconciled'].includes(disk.lock_state) ? 'Busy' : '';
  function rowLabel(row) {
    if (row.kind === 'disk') return [row.disk.task_id, row.disk.cwd, diskStatus(row.disk),
      row.disk.cwd_exists === false ? 'Missing workspace' : ''].filter(Boolean).join(' · ');
    const run = row.run;
    return [run.persona_id, run.task_id.split('/').pop(), run.run_epoch?.slice(0, 8),
      row.kind === 'expired' ? 'Snapshot expired' : row.kind === 'fault' ? 'Refresh failed' : phase(run) ?? 'Pending'].filter(Boolean).join(' · ');
  }

  const route = run => [run.model, run.thinking && 'thinking: ' + run.thinking].filter(Boolean).join(' · ');
  function summary(run) {
    const livePreview = run.live_assistant_preview?.trim() ||
      (active(run) && !run.active_tool && !run.live_thinking ? run.task_preview : undefined);
    return [run.error?.message, run.output_diagnostic?.message, run.active_tool?.name,
      run.result_text ?? run.result_preview ?? livePreview].filter(Boolean).map(text => text.slice(0, 180)).join(' · ').replace(/\s+/g, ' ');
  }

  function statusIcon(run, parent) {
    const node = element('span', undefined, parent);
    const status = run.phase === 'stall_suspected' ? 'stall_suspected' : run.status ?? 'pending';
    node.className = 'status'; node.dataset.status = status; node.title = phase(run) ?? 'Pending';
    node.setAttribute('aria-hidden', 'true'); // The adjacent text carries the label.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' })) svg.setAttribute(name, value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', ({ success: 'M3 8l3 3 7-7', failed: 'M4 4l8 8M12 4l-8 8',
      cancelled: 'M5 5h6v6H5z', stall_suspected: 'M8 2l6 11H2zM8 6v3m0 1v1' })[status] ?? 'M8 2a6 6 0 1 0 6 6');
    svg.append(path); node.append(svg);
  }

  function elapsed(run, parent) {
    if (!Number.isFinite(Date.parse(run.started_at)) || terminal.has(run.status)) return;
    const node = element('span', undefined, parent);
    node.className = 'elapsed'; node.dataset.startedAt = run.started_at;
  }

  function runCard(row, selectedRow, list, compact = false) {
    const control = button(undefined, () => { selected = rowKey(row); render(); }, list, {
      key: rowKey(row), pressed: row === selectedRow,
    });
    const label = rowLabel(row);
    control.className = 'run-card';
    control.setAttribute('aria-label', label);
    control.title = [row.run?.task_id ?? row.disk?.task_id, row.run?.run_epoch].filter(Boolean).join(' · ');
    const top = element('span', undefined, control); top.className = 'row';
    const run = row.run;
    if (row.kind === 'run') statusIcon(run, top);
    element('strong', compact && row.kind === 'run' ? (run.persona_id ?? 'Subagent run') : label, top).dir = 'auto';
    if (row.kind === 'run') {
      const model = !compact && route(run), preview = summary(run);
      if (model) element('span', model, control).className = 'model';
      if (preview) element('span', preview, control).className = 'preview';
    }
  }

  function taskAndSession(run, parent) {
    const id = key(run);
    const { card, heading } = section('Task preview', parent);
    if (run.task_preview) {
      copyButton('Copy prompt preview', run.task_preview, heading, id);
      const open = expandedPrompts.has(id);
      button(open ? 'Collapse prompt' : 'Expand prompt', () => {
        if (open) expandedPrompts.delete(id);
        else expandedPrompts.add(id);
        render();
      }, heading, { expanded: open, key: 'prompt:' + id });
      const preview = element('pre', run.task_preview, card);
      preview.className = 'prompt-box'; preview.dataset.expanded = String(open); preview.dataset.scrollKey = 'prompt:' + id;
    }
    textReader(run, 'prompt', card);
    const { card: session, heading: sessionHeader } = section('Session Metadata', parent);
    copyButton('Copy task_id', run.task_id, sessionHeader, id);
    const grid = element('dl', undefined, session); grid.className = 'metadata';
    for (const [label, value] of [['Persona', run.persona_id], ['Status', run.status], ['Phase', phase(run)],
      ['Model', run.model], ['Thinking', run.thinking], ['Started', run.started_at], ['Updated', run.updated_at],
      ['Workspace', run.cwd], ['Epoch', run.run_epoch], ['Session', run.task_id]]) {
      const term = element('dt', label, grid), description = element('dd', value ?? '—', grid);
      if (label === 'Session') { term.className = 'session-label'; description.className = 'session-value'; }
    }
  }

  function tick() {
    for (const elapsed of root.querySelectorAll('[data-started-at]')) {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(elapsed.dataset.startedAt)) / 1000));
      elapsed.textContent = Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's elapsed';
    }
  }

  function renderContent() {
    const header = element('header');
    header.className = 'toolbar';
    element('h1', 'Larva Subagents', header);
    const controls = element('div', undefined, header);
    controls.className = 'controls';
    if (panel && target.kind === 'latest') {
      const query = target.query;
      const filters = element('nav', undefined, controls);
      filters.className = 'controls'; filters.setAttribute('aria-label', 'Run filters');
      const all = !query.task_id && (!query.scope || query.scope === 'recent');
      const filter = (label, focusKey, scope, pressed, done = false) => button(label, () => {
        if (scope === 'recent' && all) { doneOnly = done; render(); }
        else setQuery({ scope, ...(query.limit ? { limit: query.limit } : {}) }, done);
      }, filters, { key: 'filter:' + focusKey, pressed, disabled: !observing() });
      filter('All', 'all', 'recent', all && !doneOnly);
      filter('Active · ' + rows.filter(activeRow).length, 'active', 'active', !query.task_id && query.scope === 'active');
      filter('Done · ' + rows.filter(doneRow).length, 'done', 'recent', all && doneOnly, true);
      filter('Disk', 'disk', 'disk', !query.task_id && query.scope === 'disk');
    }
    if (target.kind === 'latest' || target.kind === 'pinned') button('Refresh', refresh, controls, { disabled: !observing() });
    if (!panel && availableModes.includes(mode === 'inline' ? 'fullscreen' : 'inline')) button(mode === 'inline' ? 'Fullscreen' : 'Inline', changeMode, controls, {
      key: 'display', disabled: !observing() || !!displayRequest,
    });
    if (connection === 'lost') notice('Connection lost. This view is read-only.', 'warning');
    if (readError) notice(readError, 'error');
    if (waitOutcome) notice(waitOutcome, '');
    if (target.kind === 'pending') { notice(panel ? 'Waiting for panel input…' : 'Waiting for this tool call…', ''); return; }
    if (target.kind === 'rejected') { notice(target.message, 'error'); return; }
    for (const failure of failures) {
      if (failure?.error?.message) notice('Startup failed · ' + failure.persona_id + ' · ' + failure.error.message, 'error');
    }
    const items = shownRows(), row = selectedRow(items);
    if (!row) {
      if (!readError) notice(loading ? 'Loading runs…' : 'No runs in this view.', '');
      return;
    }
    const fullscreen = mode === 'fullscreen';
    const run = row.run;
    const id = run ? key(run) : rowKey(row);
    const open = detailsOpen.has(id);
    const main = element('main');
    if (fullscreen) main.className = 'workbench';
    selected = rowKey(row);
    if (fullscreen || items.length > 1) {
      const list = element('nav', undefined, main);
      list.className = fullscreen ? 'run-list' : open ? 'switcher' : 'compact-list';
      list.dataset.scrollKey = 'list';
      list.setAttribute('aria-label', 'Subagent runs');
      const group = (title, groupRows) => {
        if (!groupRows.length) return;
        element('h3', title + ' · ' + groupRows.length, list);
        for (const item of groupRows) runCard(item, row, list);
      };
      if (fullscreen) {
        group('Active', items.filter(activeRow));
        group('Done', items.filter(doneRow));
        group('Disk', items.filter(item => item.kind === 'disk'));
      } else for (const item of items) runCard(item, row, list, !open);
    }
    const detail = element('article', undefined, main);
    if (fullscreen) {
      detail.className = 'inspector'; detail.dataset.scrollKey = 'detail:' + id;
    }
    if (row.kind === 'expired') {
      notice('Run snapshot expired (inspect recorded transcript)', 'warning', detail);
      pathLine('Recorded transcript', row.run.task_id, detail);
      copyButton('Copy task_id', row.run.task_id, detail, key(row.run));
      return;
    }
    if (row.kind === 'fault') notice(row.error.message, 'error', detail);
    if (row.kind === 'disk') {
      element('h2', 'Recorded session', detail);
      pathLine('Workspace', row.disk.cwd, detail);
      pathLine('Recorded transcript', row.disk.task_id, detail);
      if (diskStatus(row.disk)) notice('Busy', 'warning', detail);
      if (row.disk.cwd_exists === false) notice('Missing workspace', 'warning', detail);
      if (!run) {
        copyButton('Copy task_id', row.disk.task_id, detail, rowKey(row));
        const { card } = section('Task prompt', detail);
        textReader(row.disk, 'prompt', card);
        return;
      }
    }
    const bar = element('div', undefined, detail);
    bar.className = fullscreen ? 'row detail-header' : 'toolbar';
    statusIcon(run, bar);
    const heading = element(fullscreen ? 'h2' : 'strong', run.persona_id ?? 'Subagent run', bar);
    heading.dir = 'auto';
    const status = ({ accepted: 'Accepted', running: 'Running' })[run.status];
    element('span', [status, phase(run) ?? 'Pending'].filter(Boolean).join(' · '), bar)
      .className = run.phase === 'stall_suspected' ? 'badge warning' : 'badge';
    elapsed(run, bar);
    if (Number.isSafeInteger(run.tool_call_count)) element('span', run.tool_call_count + ' tool calls', bar).className = 'badge';
    for (const [state, label] of [['delivery_failed', 'Delivery failed'], ['evicted', 'Output evicted']]) {
      if (run.output_state === state) element('span', label, bar).className = 'badge warning';
    }
    if (run.cleanup_unconfirmed) element('span', 'Cleanup unconfirmed', bar).className = 'badge warning';
    const model = route(run);
    if (model) element('span', model, bar).className = 'model';
    if (run.active_tool) element('span', run.active_tool.name + ' (' + run.active_tool.status + ')', bar);
    if (run.live_thinking) element('span', 'Thinking…', bar);
    if (row.kind === 'run' && pair(run) && (active(run) || run.cleanup_unconfirmed) && observing()) {
      button(run.cleanup_unconfirmed ? 'Retry cleanup' : 'Cancel', () => void cancel(run), bar, {
        key: 'cancel:' + id, disabled: loading || cancelling.has(id),
      }).className = 'cancel';
    }
    const cancelNotice = cancelNotices.get(id);
    if (cancelNotice) notice(cancelNotice.text, cancelNotice.style, detail);
    if (!fullscreen) {
      button(open ? 'Hide details' : 'Details', () => {
        if (open) detailsOpen.delete(id);
        else detailsOpen.add(id);
        render();
      }, bar, { key: 'details:' + id, expanded: open });
      if (!open) {
        const preview = summary(run);
        if (preview) element('p', preview, detail).className = 'preview summary';
        return;
      }
    } else {
      const inspector = element('nav', undefined, detail);
      inspector.className = 'tabs';
      inspector.setAttribute('aria-label', 'Run inspector');
      for (const label of tabs) button(label, () => { tab = label; render(); }, inspector, { key: 'tab:' + label, pressed: tab === label });
    }
    const body = element('div', undefined, detail);
    body.className = fullscreen ? 'tab-body' : 'drawer';
    if (!fullscreen) body.dataset.scrollKey = 'drawer:' + id;
    const shows = label => !fullscreen || tab === 'All' || tab === label;
    if (shows('Task & Session')) taskAndSession(run, body);
    if (shows('Timeline')) {
      const { card } = section('Timeline', body);
      if (active(run)) element('p', run.active_tool ? 'Active tool: ' + run.active_tool.name
        : run.live_thinking ? 'Thinking…' : phase(run), card).className = 'activity';
      if (run.live_assistant_preview) {
        element('h3', 'Live assistant preview', card);
        const preview = element('pre', run.live_assistant_preview, card);
        preview.className = 'stream'; preview.dataset.scrollKey = 'stream:' + id;
      }
      if (run.tool_snapshots?.length) recentTools(run, card);
      else element('p', 'No tool calls yet.', card).className = 'muted';
    }
    if (shows('Result')) output(run, body);
  }

  function render(background = false) {
    if (!visible() || connection === 'closed') return;
    const selection = document.getSelection?.();
    if (background && selection && !selection.isCollapsed && root.contains(selection.anchorNode)) {
      renderDeferred = true;
      return;
    }
    renderDeferred = false;
    renderVersion++;
    const liveRuns = new Map(rows.filter(row => row.kind !== 'expired' && row.run).map(row => [key(row.run), row.run]));
    for (const state of [detailsOpen, expandedPrompts, cancelNotices]) {
      for (const id of state.keys()) if (!liveRuns.has(id)) state.delete(id);
    }
    for (const [id, collapsed] of collapsedTools) {
      const calls = liveRuns.get(id)?.tool_snapshots;
      for (const callId of collapsed) if (!calls?.some(call => call.tool_call_id === callId)) collapsed.delete(callId);
      if (!collapsed.size) collapsedTools.delete(id);
    }
    if (textRead) {
      const row = selectedRow(), run = row?.run ?? row?.disk;
      if (!run || row.kind === 'expired' || key(run) !== textRead.runKey) clearTextRead();
    }
    if (activity) {
      const row = selectedRow();
      const run = row?.run;
      if (row?.kind === 'expired' || !run || key(run) !== activity.runKey || (mode === 'inline' && !detailsOpen.has(activity.runKey)) ||
          !run.tool_snapshots?.some(call => call.tool_call_id === activity.callId)) clearActivity();
    }
    const focus = document.activeElement?.dataset?.focusKey;
    const scroll = new Map(Array.from(root.querySelectorAll('[data-scroll-key]'), node => [node.dataset.scrollKey, node.scrollTop]));
    document.documentElement.dataset.mode = mode;
    root.replaceChildren();
    renderContent();
    for (const node of root.querySelectorAll('[data-scroll-key]')) if (scroll.has(node.dataset.scrollKey)) node.scrollTop = scroll.get(node.dataset.scrollKey);
    if (focus) Array.from(root.querySelectorAll('button')).find(node => node.dataset.focusKey === focus)?.focus({ preventScroll: true });
    tick();
    measure();
    if (observing() && clockTimer === undefined) clockTimer = setInterval(tick, 1000);
  }

  let lastHeight;
  function measure() {
    if (!observing() || mode !== 'inline') { lastHeight = undefined; return; }
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height !== lastHeight) { lastHeight = height; notify('ui/notifications/size-changed', { height }); }
  }
  const observer = new ResizeObserver(measure);
  observer.observe(root, { box: 'border-box' });
  document.addEventListener('selectionchange', () => { if (renderDeferred) render(true); });
  document.addEventListener('visibilitychange', () => {
    if (!visible()) { stopObserving(); lastHeight = undefined; }
    else {
      loading = true;
      reopen();
    }
  });
  window.addEventListener('messageerror', event => { if (event.source === window.parent) disconnect(); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || message?.jsonrpc !== '2.0' || connection === 'closed') return;
    if (message.method === 'ui/resource-teardown') {
      connection = 'closed';
      finishInvocation();
      stopObserving();
      retireRequests(() => true);
      observer.disconnect();
      if (Object.hasOwn(message, 'id')) post({ id: message.id, result: {} });
      return;
    }
    if (connection === 'lost') return;
    if (!message.method) {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    switch (message.method) {
      case 'ui/notifications/host-context-changed':
        applyContext(message.params?.hostContext ?? message.params); break;
      case 'ui/notifications/tool-input':
        if (message.params?.arguments && typeof message.params.arguments === 'object' && !Array.isArray(message.params.arguments)) {
          if (panel && (target.kind === 'pending' || target.kind === 'latest')) setQuery(queryFor(message.params.arguments, 'recent'));
          else if (target.kind === 'pending' && toolInput === undefined) {
            toolInput = invocationFor(message.params.arguments);
            applyInvocation();
          }
        }
        break;
      case 'ui/notifications/tool-result':
        if (!panel && target.kind === 'pending' && initialResult === undefined && message.params && typeof message.params === 'object') {
          initialResult = message.params;
          applyInvocation();
        }
        break;
      case 'ui/notifications/tool-cancelled':
        if (target.kind === 'pending') {
          target = { kind: 'rejected', message: message.params?.reason ?? 'The tool call was cancelled before binding a run.' };
          finishInvocation();
          render();
        }
        break;
    }
  });
  render();
  rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Larva Subagents', version },
    appCapabilities: { availableDisplayModes: modes } }, 'initialize').then(result => {
    if (connection !== 'connecting') return;
    connection = 'ready';
    notify('ui/notifications/initialized');
    applyContext(result?.hostContext);
    void refresh();
  }).catch(disconnect);
}`;
