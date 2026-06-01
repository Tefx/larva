import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function migrateToolPolicy(home) {
  const oldPath = join(home, ".pi", "tool-policy.json");
  const canonicalPath = join(home, ".pi", "larva", "tool-policy.json");
  const oldExists = await exists(oldPath);
  const canonicalExists = await exists(canonicalPath);

  if (oldExists && canonicalExists) {
    return {
      status: "conflict",
      action: "none",
      error: "LARVA_TOOL_POLICY_MIGRATION_CONFLICT",
      paths: { old: oldPath, canonical: canonicalPath },
    };
  }

  if (oldExists) {
    await mkdir(join(home, ".pi", "larva"), { recursive: true });
    await rename(oldPath, canonicalPath);
    return {
      status: "moved",
      action: "rename",
      paths: { old: oldPath, canonical: canonicalPath },
    };
  }

  return {
    status: canonicalExists ? "canonical-only" : "absent-both",
    action: "none",
    paths: { old: oldPath, canonical: canonicalPath },
  };
}

async function arrange(home, scenario) {
  await mkdir(join(home, ".pi", "larva"), { recursive: true });
  const oldPath = join(home, ".pi", "tool-policy.json");
  const canonicalPath = join(home, ".pi", "larva", "tool-policy.json");
  if (scenario === "old-only") {
    await writeFile(oldPath, '{"personas":{"p":{"deny":["bash"]}}}\n', "utf8");
  } else if (scenario === "both-files") {
    await writeFile(oldPath, '{"personas":{"p":{"deny":["bash"]}}}\n', "utf8");
    await writeFile(canonicalPath, '{"personas":{"p":{"allow":["read"]}}}\n', "utf8");
  } else if (scenario === "canonical-only") {
    await writeFile(canonicalPath, '{"personas":{"p":{"allow":["read"]}}}\n', "utf8");
  } else if (scenario !== "absent-both") {
    throw new Error(`unknown scenario ${scenario}`);
  }
  return { oldPath, canonicalPath };
}

async function proveScenario(scenario) {
  const root = await mkdtemp(join(tmpdir(), `larva-pi-tool-policy-migration-${scenario}-`));
  const home = join(root, "home");
  const { oldPath, canonicalPath } = await arrange(home, scenario);
  const before = {
    old: await exists(oldPath),
    canonical: await exists(canonicalPath),
    canonicalContent: (await exists(canonicalPath)) ? await readFile(canonicalPath, "utf8") : null,
  };
  const result = await migrateToolPolicy(home);
  const after = {
    old: await exists(oldPath),
    canonical: await exists(canonicalPath),
    canonicalContent: (await exists(canonicalPath)) ? await readFile(canonicalPath, "utf8") : null,
  };

  if (scenario === "old-only") {
    assert.deepEqual(before, { old: true, canonical: false, canonicalContent: null });
    assert.equal(result.status, "moved");
    assert.equal(after.old, false);
    assert.equal(after.canonical, true);
    assert.equal(after.canonicalContent, '{"personas":{"p":{"deny":["bash"]}}}\n');
  } else if (scenario === "both-files") {
    assert.equal(result.status, "conflict");
    assert.equal(result.error, "LARVA_TOOL_POLICY_MIGRATION_CONFLICT");
    assert.equal(after.old, true);
    assert.equal(after.canonical, true);
    assert.equal(after.canonicalContent, before.canonicalContent);
  } else if (scenario === "canonical-only") {
    assert.equal(result.status, "canonical-only");
    assert.equal(after.old, false);
    assert.equal(after.canonical, true);
    assert.equal(after.canonicalContent, before.canonicalContent);
  } else if (scenario === "absent-both") {
    assert.equal(result.status, "absent-both");
    assert.deepEqual(after, { old: false, canonical: false, canonicalContent: null });
  }

  return { scenario, fixture_home: home, before, result, after };
}

const scenarios = ["old-only", "both-files", "canonical-only", "absent-both"];
const matrix = [];
for (const scenario of scenarios) {
  matrix.push(await proveScenario(scenario));
}

console.log(JSON.stringify({
  proof: "larva-pi-tool-policy-operator-migration",
  mutation_scope: "tempdir fixtures only",
  scenarios: matrix,
}, null, 2));
