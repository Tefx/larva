#!/usr/bin/env node
// purpose: stay-alive Pi RPC stand-in for parent-shutdown-with-active-child tests
// usage: spawned as child Pi by the Larva extension
// effects: writes LARVA_BLOCKING_CHILD_PID_FILE and answers get_state; never exits
// requires: stdin JSONL RPC frames
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const pidFile = process.env.LARVA_BLOCKING_CHILD_PID_FILE;
if (typeof pidFile === "string" && pidFile.length > 0) writeFileSync(pidFile, String(process.pid));

const sessionFile = process.env.LARVA_BLOCKING_CHILD_SESSION_FILE || "";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === "get_state") {
    const route = process.env.LARVA_PI_INITIAL_PERSONA_MODEL_FROM_CLI || "openai/gpt-5.5";
    const slash = route.indexOf("/");
    const thinkingLevel = process.env.LARVA_PI_CHILD_REQUESTED_THINKING || "medium";
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
  }
});
