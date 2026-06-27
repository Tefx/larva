# Security Bug Report: PersonaSpec Prompt Stored XSS

Date: 2026-06-27
Repository: `larva`
Scan mode: Codex Security standard repository scan
Status: Fixed and archived

## Resolution

Fixed by rendering PersonaSpec `prompt` detail panes as inert text in both local
web UIs:

- `src/larva/shell/web_ui.html` now binds prompt display with Alpine `x-text`
  and preserves formatting with CSS `white-space: pre-wrap`.
- `contrib/web/index.html` uses the same inert text rendering policy.
- The unused `marked` dependency and `renderMarkdown(...)` prompt rendering
  helpers were removed from both HTML artifacts.
- Regression tests assert that prompt display does not use `x-html`,
  `renderMarkdown`, or `marked.parse`, and that HTML-like prompt strings remain
  valid stored PersonaSpec data.

The original report is retained below for audit history.

## Summary

The scan found two stored cross-site scripting issues in the local web UIs. In both cases, PersonaSpec `prompt` content is parsed with `marked.parse(...)` and inserted into the page with Alpine `x-html` without HTML sanitization.

An attacker who can get a user to import or view a malicious PersonaSpec can execute JavaScript in the local registry management UI origin. That script can call same-origin registry APIs exposed by the UI.

## Finding 1: Packaged Web UI Renders Prompt Markdown As Unsanitized HTML

Severity: Medium

Affected files:

- `src/larva/shell/web_ui.html:685`
- `src/larva/shell/web_ui.html:1135`
- `src/larva/shell/web_ui.html:1284`
- `src/larva/core/validation_field_shapes.py:181`
- `src/larva/shell/web_routes.py:231`

### Root Cause

The packaged UI inserts rendered prompt content with `x-html`:

```html
<div class="prompt-display prompt-md" x-html="renderMarkdown(getVal('prompt'))"></div>
```

`renderMarkdown` returns raw `marked.parse(text)` output when `marked` is available:

```js
marked.setOptions({ breaks: false, gfm: true });
return marked.parse(text);
```

The prompt admission check only validates that `prompt` is a string. It does not reject or sanitize HTML-capable content before the UI renders it.

### Attack Path

1. Attacker supplies a PersonaSpec with active HTML or script-capable markup in `prompt`.
2. User imports/registers the PersonaSpec through the packaged web UI.
3. User selects or views that persona.
4. The UI passes the stored prompt through `marked.parse(...)`.
5. Alpine inserts the result through `x-html`.
6. Script executes in the local UI origin and can call same-origin registry APIs.

### Impact

The injected script can read or mutate local registry state available to the web UI, including persona registration, export, update, activation, deletion, or clear operations.

The default server binds to `127.0.0.1`, and exploitation requires user interaction, so this was rated Medium rather than High.

### Recommended Fix

- Render PersonaSpec prompts as text with `x-text`, or
- Disable raw HTML in Markdown rendering, or
- Sanitize Markdown output with a strict allowlist sanitizer before passing it to `x-html`.

Add a regression test that imports a PersonaSpec prompt containing active HTML and verifies the UI renders it inertly.

## Finding 2: Contrib Web UI Has The Same Unsanitized Prompt Markdown Path

Severity: Low

Affected files:

- `contrib/web/index.html:608`
- `contrib/web/index.html:1079`
- `contrib/web/index.html:1192`
- `contrib/web/server.py:58`

### Root Cause

The contrib UI repeats the same pattern:

```html
<div class="prompt-display prompt-md" x-html="renderMarkdown(getVal('prompt'))"></div>
```

and:

```js
marked.setOptions({ breaks: false, gfm: true });
return marked.parse(text);
```

`contrib/web/server.py` serves this HTML through the canonical FastAPI app.

### Attack Path

1. Attacker supplies a malicious PersonaSpec prompt.
2. User launches the contrib web UI and imports/registers the PersonaSpec.
3. User views the persona.
4. Prompt content is parsed as Markdown and inserted with `x-html`.
5. Script executes in the local contrib UI origin.

### Impact

Impact is similar to the packaged UI, but the affected surface is a contrib convenience UI that requires explicit local launch, so this was rated Low.

### Recommended Fix

Use the same safe renderer as the packaged UI fix. Avoid direct `x-html` for registry-controlled fields, or sanitize output before insertion.

## Rejected Candidate

The scan also reviewed `contrib/opencode-plugin/larva.ts`, where project-level `.opencode/tool-policy.json` is searched before `~/.config/opencode/tool-policy.json`.

This was not reported as a vulnerability because the README explicitly documents project-level policy first. The repository does not promise that the global file is a non-overridable hard-deny layer. This may still be worth clarifying as a product/documentation hardening item.

## Verification Notes

Validation was static source tracing. No browser proof-of-concept was run because the source-to-sink paths are direct in source:

- untrusted/stored PersonaSpec prompt
- string-only prompt validation
- `marked.parse(...)`
- `x-html`
- same-origin registry routes

Final scan artifacts:

- `report.md`
- `scan-manifest.json`
- `coverage.json`
- `findings.json`
