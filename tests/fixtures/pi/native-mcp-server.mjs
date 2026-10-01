#!/usr/bin/env node
// purpose: local stdio MCP transport, effects, resources and dynamic tool-list fixture
// usage: node native-mcp-server.mjs <owned-log.jsonl> [initialize-delay-ms]
// effects: owned log only, JSON-RPC stdout and diagnostics stderr; no network
// requires: Node; launched and reaped by native Pi in an isolated fixture
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, delay = "0"] = process.argv.slice(2);
let dynamic = false;
const record = (event, data = {}) => appendFileSync(log, JSON.stringify({ event, pid: process.pid, ...data }) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const schema = { type: "object", properties: { value: { type: "string" } }, additionalProperties: false };
const names = ["direct", "disabled", "deferred", "scripted", "denied_direct", "denied_deferred", "denied_scripted", "hidden", "mutate"];
const tool = (name) => ({ name, description: `Exact ${name} operation for native MCP acceptance`, inputSchema: schema, annotations: { readOnlyHint: true } });
record("start");
console.error(`Native MCP fixture started pid=${process.pid}`);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  const { id, method, params } = request;
  record(method, { params });
  if (id === undefined) continue;
  let result;
  if (method === "initialize") {
    if (Number(delay)) await new Promise((resolve) => setTimeout(resolve, Number(delay)));
    result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: "native-fixture", version: "1" }, instructions: "Local deterministic MCP fixture." };
  } else if (method === "tools/list") {
    result = { tools: [...names, ...(dynamic ? ["dynamic"] : [])].map(tool) };
  } else if (method === "tools/call") {
    const name = params.name;
    record("effect", { name, args: params.arguments });
    if (name === "mutate") {
      dynamic = params.arguments.value !== "withdraw";
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    result = { content: [{ type: "text", text: `${name}:${params.arguments?.value ?? "ok"}` }] };
  } else if (method === "resources/list") {
    result = { resources: [{ uri: "fixture://text", name: "fixture-text", mimeType: "text/plain" }] };
  } else if (method === "resources/templates/list") {
    result = { resourceTemplates: [{ uriTemplate: "fixture://{name}", name: "fixture-template" }] };
  } else if (method === "resources/read") {
    record("resource_effect", { uri: params.uri });
    result = { contents: [{ uri: params.uri, mimeType: "text/plain", text: "Local MCP resource." }] };
  } else if (method === "ping") result = {};
  else { send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported fixture method" } }); continue; }
  send({ jsonrpc: "2.0", id, result });
}
record("closed");
