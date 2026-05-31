#!/usr/bin/env node

const [, , command, idOrFlag, maybeFlag] = process.argv;
const scenario = process.env.FAKE_LARVA_SCENARIO || "ok";

const personas = [
  { id: "ok", description: "Deterministic success persona", model: "fake/model" },
  { id: "startup", description: "Deterministic startup persona", model: "fake/model" },
  { id: "vectl-planner", description: "Plan with vectl" },
  { id: "vectl-reviewer", description: "Review with vectl" },
];

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

if (command === "list" && idOrFlag === "--json") {
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
      model: "fake/model",
      capabilities: {},
      spec_version: "1.0.0",
      spec_digest: `digest-${idOrFlag}`,
      can_spawn: true,
    },
  });
  process.exit(0);
}

process.exit(64);
