#!/usr/bin/env node
// purpose: finite Pi RPC stand-in so child terminal cleanup can be observed
// usage: spawned as child Pi by the Larva extension
// effects: answers get_state/prompt/get_last_assistant_text then exits
// requires: stdin JSONL RPC frames
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const pidFile = process.env.LARVA_COMPLETING_CHILD_PID_FILE;
if (typeof pidFile === "string" && pidFile.length > 0) writeFileSync(pidFile, String(process.pid));

const sessionFile = process.env.LARVA_COMPLETING_CHILD_SESSION_FILE || "";
if (sessionFile) writeFileSync(sessionFile, "", { flag: "a" });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const route = process.env.LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI || "openai/gpt-5.5";
  const slash = route.indexOf("/");
  const thinkingLevel = process.env.LARVA_PI_CHILD_REQUESTED_THINKING || "medium";
  if (message.type === "get_state") {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      success: true,
      data: {
        sessionFile,
        model: { provider: route.slice(0, slash), id: route.slice(slash + 1) },
        thinkingLevel,
      },
    })}\n`);
  }
  if (message.type === "prompt") {
    process.stdout.write(`${JSON.stringify({ id: message.id, success: true, data: {} })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  }
  if (message.type === "get_last_assistant_text") {
    process.stdout.write(`${JSON.stringify({ id: message.id, success: true, data: { text: "capsule-complete" } })}\n`);
    process.exit(0);
  }
});
