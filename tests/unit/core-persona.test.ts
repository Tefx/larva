import assert from "node:assert/strict";
import { test } from "node:test";
import { LarvaError } from "../../src/core/errors.ts";
import {
  computePersonaDigest, isValidPersonaId, parsePersonaFile, parsePersonaInput,
  serializePersonaJson, serializePersonaMarkdown, toPersonaSummary,
} from "../../src/core/persona.ts";
import { parseYamlFrontmatter, serializeYamlFrontmatter } from "../../src/core/yaml-frontmatter.ts";

const minimal = { id: "review-2", description: "Inspect entries.", model: "provider/model", prompt: "Check the rubric." };
const json = (fields: Record<string, unknown> = {}) => JSON.stringify({ ...minimal, ...fields });
const md = (header: string, prompt = minimal.prompt) => `---\n${header}\n---\n${prompt}\n`;
const basicHeader = `description: ${minimal.description}\nmodel: ${minimal.model}`;
const invalid = (action: () => unknown, context?: string) => assert.throws(action,
  error => error instanceof LarvaError && error.code === "LARVA_PERSONA_INVALID", context);

test("canonical Markdown and JSON round-trip through the same normalized spec and digest", () => {
  const markdown = md([
    'description: "  Inspect café\\r\\nReview entries.  "',
    "model: provider/group/model",
    "can_spawn:",
    "  - zebra # ignored",
    "  - alpha",
    "tools:",
    "  allow: ['search*', read]",
    "  deny:",
    "  - write*",
    "  - delete",
  ].join("\n"), "  # Instructions\nUse the rubric.  ");
  const input = {
    ...minimal, model: "provider/group/model", description: "  Inspect café\rReview entries. \t",
    prompt: "\n # Instructions\r\nUse the rubric.\r ", can_spawn: ["zebra", "alpha"],
    tools: { deny: ["write*", "delete"], allow: ["search*", "read"] },
  };
  const spec = parsePersonaFile(markdown.replaceAll("\n", "\r\n"), "/tmp/review-2.md");
  assert.deepEqual(spec, parsePersonaFile(JSON.stringify(input), "/tmp/review-2.json"));
  assert.deepEqual(spec, {
    id: "review-2", description: "Inspect café\nReview entries.", model: "provider/group/model",
    prompt: "# Instructions\nUse the rubric.", thinking: "medium", can_spawn: ["alpha", "zebra"],
    tools: { allow: ["read", "search*"], deny: ["delete", "write*"] },
    spec_digest: "sha256:47c5c54e700f9ac38e8c6e15505671528037d996b8cfe5c8da2fd02886a2435f",
  });
  assert.deepEqual(parsePersonaInput(serializePersonaMarkdown(spec)), spec);
  assert.deepEqual(parsePersonaInput(serializePersonaJson(spec)), spec);
  assert.deepEqual(toPersonaSummary(spec), {
    id: spec.id, description: spec.description, model: spec.model, thinking: "medium",
    can_spawn: ["alpha", "zebra"], spec_digest: spec.spec_digest,
  });
  assert.equal(computePersonaDigest({ ...spec, can_spawn: input.can_spawn, tools: input.tools }), spec.spec_digest);
  assert.deepEqual(input.can_spawn, ["zebra", "alpha"]);
  assert.deepEqual(input.tools, { deny: ["write*", "delete"], allow: ["search*", "read"] });
});

test("digest defaults match their explicit forms and supplied digests are verified", () => {
  const defaults = parsePersonaInput(json());
  assert.equal(defaults.thinking, "medium");
  assert.equal(defaults.can_spawn, false);
  assert.deepEqual(defaults.tools, { allow: [], deny: [] });
  assert.equal(computePersonaDigest(minimal), defaults.spec_digest);
  assert.deepEqual(parsePersonaInput(json({ thinking: "medium", can_spawn: false, tools: {} })), defaults);
  assert.deepEqual(parsePersonaInput(json({ spec_digest: defaults.spec_digest })), defaults);
  invalid(() => parsePersonaInput(json({ spec_digest: `sha256:${"0".repeat(64)}` })));
  invalid(() => parsePersonaInput(json({ spec_digest: null })));
  assert.notEqual(parsePersonaInput(json({ thinking: "max" })).spec_digest, defaults.spec_digest);
});

test("file stems bind explicit ids and only named Markdown can infer an omitted id", () => {
  assert.equal(parsePersonaInput(md(basicHeader), "/outside/review-2.md").id, "review-2");
  assert.equal(parsePersonaFile(md(`id: review-2\n${basicHeader}`), "/outside/review-2.md").id, "review-2");
  for (const path of ["/outside/Review.md", "/outside/review--2.md", "/outside/review-2.yaml", "/outside/.md"]) {
    invalid(() => parsePersonaFile(md(basicHeader), path), path);
  }
  invalid(() => parsePersonaFile(md(`id: another\n${basicHeader}`), "/outside/review-2.md"));
  invalid(() => parsePersonaFile(md(`id: null\n${basicHeader}`), "/outside/review-2.md"));
  invalid(() => parsePersonaFile(json(), "/outside/another.json"));
  invalid(() => parsePersonaFile(json(), "/outside/Review-2.json"));
  invalid(() => parsePersonaFile(json({ id: undefined }), "/outside/review-2.json"));
  invalid(() => parsePersonaFile(json(), "/outside/review-2.md"));
  invalid(() => parsePersonaFile(md(basicHeader), "/outside/review-2.json"));
  for (const id of ["a", "review-2", "123", "a-0-z"]) assert.equal(isValidPersonaId(id), true);
  for (const id of ["", "-a", "a-", "a--b", "A", "a_b", "café", "a\n", null]) assert.equal(isValidPersonaId(id), false);
});

test("stdin auto-detects either format and requires an explicit id", () => {
  const expected = parsePersonaInput(json());
  assert.deepEqual(parsePersonaInput(` \r\n\t${json()}`, "-"), expected);
  assert.deepEqual(parsePersonaInput(md(`id: review-2\n${basicHeader}`).replaceAll("\n", "\r"), "-"), expected);
  invalid(() => parsePersonaInput(md(basicHeader), "-"));
  invalid(() => parsePersonaInput(json({ id: undefined }), "-"));
  invalid(() => parsePersonaInput("{ broken", "-"));
});

test("YAML subset reads block and flow collections, JSON/Core scalars, and quoted or folded strings", () => {
  const header = [
    "block:",
    "- - nested",
    "  - 0x10",
    "- {octal: 0o17, real: -2.5e2, bool: TRUE, none: ~}",
    "- key: 'don''t'",
    '  text: "a\\u0020b\\nline"',
    "flow: [",
    "  [false, null, 1, 'true'], # comment",
    "  {keep: value#fragment},",
    "  two",
    "    words,",
    "]",
    "literal: |-",
    "  first",
    "  second",
    "folded: >-",
    "  first",
    "  second",
    "",
    "  paragraph",
    "plain: two",
    "  words",
    "empty: |+",
    "",
    "continued: {key",
    "  : value}",
  ].join("\n");
  const { fields, body } = parseYamlFrontmatter(md(header, "# Body\n---\nBody's own marker"));
  assert.deepEqual(fields, {
    block: [["nested", 16], { octal: 15, real: -250, bool: true, none: null }, { key: "don't", text: "a b\nline" }],
    flow: [[false, null, 1, "true"], { keep: "value#fragment" }, "two words"],
    literal: "first\nsecond", folded: "first second\nparagraph", plain: "two words",
    empty: "\n", continued: { key: "value" },
  });
  assert.equal(body, "# Body\n---\nBody's own marker\n");
  assert.deepEqual(parseYamlFrontmatter(serializeYamlFrontmatter(fields, "body")).fields, fields);
});

test("YAML explicit block and flow keys produce the same canonical PersonaSpec as JSON", () => {
  const header = [
    "? description",
    `: ${minimal.description}`,
    '? "model"',
    `: ${minimal.model}`,
    "? >-",
    "  can_spawn",
    ":",
    "- zebra",
    "- alpha",
    "?",
    "  tools",
    ":",
    "  { ? allow: [read],",
    "    ? 'deny'",
    "    : [write*] }",
  ].join("\n");
  const spec = parsePersonaFile(md(header), "/tmp/review-2.md");
  assert.deepEqual(spec, parsePersonaFile(json({
    can_spawn: ["zebra", "alpha"], tools: { allow: ["read"], deny: ["write*"] },
  }), "/tmp/review-2.json"));
  assert.deepEqual(parseYamlFrontmatter(md([
    "? sequences",
    ": - ? key",
    "    : value",
    "  - [? folded",
    "       key: value, ? optional]",
    "? compact",
    ": nested: yes",
    "? optional",
  ].join("\n"))).fields, {
    sequences: [{ key: "value" }, [{ "folded key": "value" }, { optional: null }]],
    compact: { nested: "yes" }, optional: null,
  });
});

test("YAML rejects forbidden constructs and malformed document boundaries", () => {
  for (const header of [
    "description: &anchor hi", "description: *alias", "description: !!str hi", "description: !custom hi",
    "description: [&anchor hi]", "description: [{key: *alias}]", "description: {key: !tag hi}",
    "description: {<<: x}", "description:\n  '<<': x", "description: one\ndescription: two",
    'description: one\n"descrip\\u0074ion": two', "tools: {allow: [], 'allow': []}",
    "tools:\n\tallow: []", "tools: {allow: [read}", "tools: [read,,write]", "tools: [\nread\n]",
    'description: "one\ntwo"', "description: |oops\n  text", "description: .inf", "description: 1e500",
    "can_spawn: - worker", "description: >\n    \n  text", "tools: [foo\n  : bar]",
    "? true\n: value", "? [key]\n: value", "? key : value", "?\n: value",
    "? &name key\n: value", "? key\n: *alias", "{? !tag key: value}", "[? 42: value]",
    "? '<<'\n: value", "? key\n: one\nkey: two", "{key: one, ? 'key': two}",
    `? key\n: ${"[".repeat(65)}null${"]".repeat(65)}`,
  ]) invalid(() => parseYamlFrontmatter(md(header)), header);
  for (const bad of [" ---\n", "--- \n", "\n---\n", "----\n", "---\nno closing\n", "---\nkey: val\n--- # not a delimiter\nBody", "---\nkey: val\u2028---\nBody"]) {
    invalid(() => parseYamlFrontmatter(bad), JSON.stringify(bad));
  }
  assert.deepEqual(parseYamlFrontmatter(md("value: '&a *x !tag <<' # &comment")).fields, { value: "&a *x !tag <<" });
});

test("both representations normalize only description and prompt and preserve special strings", () => {
  for (const field of ["description", "prompt"]) {
    invalid(() => parsePersonaInput(json({ [field]: " \t\r\n\r " })));
    invalid(() => parsePersonaInput(json({ [field]: false })));
  }
  invalid(() => parsePersonaInput(md(`id: review-2\nmodel: provider/model\ndescription: '   '`)));
  invalid(() => parsePersonaInput(md(`id: review-2\n${basicHeader}`, " \t\n\n")));
  const spec = parsePersonaInput(json({ description: "true\u2028---\n!tag *alias\u0001\u007f\u0084\uffff", prompt: "---\ntext" }));
  assert.deepEqual(parsePersonaInput(serializePersonaMarkdown(spec)), spec);
  for (const value of [" provider/model", "provider/model ", "provider/mod el", "provider/", "/model", "provider", 1]) {
    invalid(() => parsePersonaInput(json({ model: value })), String(value));
  }
});

test("can_spawn, tool patterns, and thinking enforce strict domains and cardinality", () => {
  const spawnIds = Array.from({ length: 100 }, (_, i) => `worker-${i}`).reverse();
  for (const can_spawn of [true, false, ["worker"], spawnIds]) {
    assert.deepEqual(parsePersonaInput(json({ can_spawn })).can_spawn, Array.isArray(can_spawn) ? [...can_spawn].sort() : can_spawn);
  }
  for (const can_spawn of [[], [...spawnIds, "extra"], ["a", "a"], ["Uppercase"], [1], "true", null]) {
    invalid(() => parsePersonaInput(json({ can_spawn })), JSON.stringify(can_spawn));
  }
  assert.deepEqual(parsePersonaInput(json({ tools: { allow: ["read*", "read"], deny: ["read"] } })).tools,
    { allow: ["read", "read*"], deny: ["read"] });
  for (const key of ["allow", "deny"]) {
    for (const patterns of [["a", "a"], [""], ["*"], ["**"], ["a**"], ["a*b"], ["read\nx"], ["a "], [1], "read", null]) {
      invalid(() => parsePersonaInput(json({ tools: { [key]: patterns } })), `${key}: ${JSON.stringify(patterns)}`);
    }
  }
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(parsePersonaInput(json({ thinking })).thinking, thinking);
  }
  for (const thinking of ["HIGH", "", "high ", "ultra", null, 1]) invalid(() => parsePersonaInput(json({ thinking })));
  for (const tools of [null, [], true, { extra: [] }]) invalid(() => parsePersonaInput(json({ tools })));
});

test("closed schemas reject retired, unknown, and representation-specific fields", () => {
  for (const key of ["capabilities", "model_params", "compaction_prompt", "spec_version", "unexpected", "__proto__"]) {
    invalid(() => parsePersonaInput(json({ [key]: false })), key);
    invalid(() => parsePersonaInput(md(`id: review-2\n${basicHeader}\n${key}: false`)), key);
  }
  invalid(() => parsePersonaInput(md(`id: review-2\n${basicHeader}\nprompt: hidden`)));
  const { spec_digest } = parsePersonaInput(json());
  invalid(() => parsePersonaInput(md(`id: review-2\n${basicHeader}\nspec_digest: ${spec_digest}`)));
  invalid(() => parsePersonaInput(md(`id: review-2\n${basicHeader}\ntools: {extra: []}`)));
  invalid(() => parsePersonaInput(md(`id: review-2\n${basicHeader}\n? unexpected\n: false`)));
});
