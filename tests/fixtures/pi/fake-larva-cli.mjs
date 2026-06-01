#!/usr/bin/env node

const [, , command, idOrFlag, maybeFlag] = process.argv;
const scenario = process.env.FAKE_LARVA_SCENARIO || "ok";

const personas = [
  { id: "ok", description: "Deterministic success persona", model: "openai/gpt-5.5" },
  { id: "startup", description: "Deterministic startup persona", model: "openai/gpt-5.5" },
  { id: "vectl-planner", description: "Plan with vectl", spec_digest: "sha256:vectl-planner", model: "openai/gpt-5.5" },
  { id: "vectl-reviewer", description: "Review with vectl", spec_digest: "sha256:vectl-reviewer", model: "openai/gpt-5.5" },
  { id: "qa-dev", description: "Non-prefix developer match", spec_digest: "sha256:qa-dev", model: "openai/gpt-5.5" },
  { id: "DevOps", description: "Mixed-case prefix match", spec_digest: "sha256:DevOps", model: "openai/gpt-5.5" },
  { id: "devrel", description: "Second prefix match", spec_digest: "sha256:devrel", model: "openai/gpt-5.5" },
  { id: "backend-dev", description: "Second non-prefix developer match", spec_digest: "sha256:backend-dev", model: "openai/gpt-5.5" },
];

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordListInvocation() {
  const countFile = process.env.FAKE_LARVA_COUNT_FILE;
  if (!countFile) return;
  const { readFile, writeFile } = await import("node:fs/promises");
  let current = 0;
  try {
    current = Number.parseInt(await readFile(countFile, "utf8"), 10) || 0;
  } catch {
    current = 0;
  }
  await writeFile(countFile, String(current + 1), "utf8");
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

if (command === "list" && idOrFlag === "--json") {
  await recordListInvocation();
  const delayMs = Number.parseInt(process.env.FAKE_LARVA_LIST_DELAY_MS || "0", 10);
  if (delayMs > 0) await sleep(delayMs);
  if (scenario === "list-exit") process.exit(17);
  if (scenario === "list-malformed") {
    process.stdout.write("{not json");
    process.exit(0);
  }
  writeJson({ data: personas });
  process.exit(0);
}

if (command === "resolve" && maybeFlag === "--json") {
  if (scenario === "resolve-exit" || idOrFlag === "missing") process.exit(19);
  if (scenario === "resolve-malformed" || idOrFlag === "unparseable") {
    process.stdout.write("{not json");
    process.exit(0);
  }
  if (!personas.some((persona) => persona.id === idOrFlag)) process.exit(20);
  writeJson({
    data: {
      id: idOrFlag,
      description: `Fake persona ${idOrFlag}`,
      prompt: `You are fake persona ${idOrFlag}.`,
      model: "openai/gpt-5.5",
      capabilities: {},
      spec_version: "1.0.0",
      spec_digest: `digest-${idOrFlag}`,
      can_spawn: true,
    },
  });
  process.exit(0);
}

process.exit(64);
