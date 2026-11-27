import { isCollection, isMap, isScalar, parseDocument, visit } from "yaml";
import { LarvaError } from "./errors.ts";

const nonPrintable = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f\ufffe\uffff]/gu;
// The parser can also resolve known non-Core tags without a warning.
const coreTags = new Set(["str", "int", "float", "bool", "null", "map", "seq"].map(tag => `tag:yaml.org,2002:${tag}`));

function invalid(message: string): never {
  throw new LarvaError("LARVA_PERSONA_INVALID", `Invalid YAML frontmatter: ${message}`);
}

export function parseYamlFrontmatter(text: string): { fields: unknown; body: string } {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) invalid("expected an opening '---' line");
  const closing = /\n---(?:\n|$)/g;
  closing.lastIndex = 3;
  const match = closing.exec(normalized);
  if (!match) invalid("expected a closing '---' line");
  const header = normalized.slice(4, match.index + 1);
  if (header.search(nonPrintable) !== -1) invalid("unexpected control character");

  const doc = parseDocument(header, { version: "1.2", schema: "core", merge: false, uniqueKeys: true });
  const diagnostic = doc.errors[0] ?? doc.warnings[0];
  if (diagnostic) invalid(`invalid YAML syntax or feature (${diagnostic.code})`);
  if (doc.directives?.docStart || doc.directives?.docEnd) invalid("directives and document markers are not supported");
  if (!isMap(doc.contents)) invalid("expected a map");
  visit(doc, {
    Alias: () => invalid("aliases are not supported"),
    Node(_key, node, path) {
      if (node.anchor) invalid("anchors are not supported");
      if (node.tag !== undefined && !coreTags.has(node.tag)) invalid("only YAML Core tags are supported");
      if (path.filter(isCollection).length > 64) invalid("collections are nested too deeply");
      if (isScalar(node) && typeof node.value === "number" && !Number.isFinite(node.value)) {
        invalid("non-finite numbers are not supported");
      }
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") invalid("map keys must be strings");
      if (pair.key.value === "<<") invalid("merge keys are not supported");
    },
  });
  return { fields: doc.toJS(), body: normalized.slice(closing.lastIndex) };
}

export function serializeYamlFrontmatter(fields: Record<string, unknown>, body: string): string {
  // JSON flow style quotes every string, preserving strings that resemble YAML syntax.
  const header = JSON.stringify(fields).replace(nonPrintable, c =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `---\n${header}\n---\n${body}\n`;
}
