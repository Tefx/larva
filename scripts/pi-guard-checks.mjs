// purpose: run native Python inventory through Invar with a sufficient fixture timeout
// usage: node scripts/pi-guard-checks.mjs [pytest selection ...]
// effects: disposable shadow config/symlinks only; original pyproject and sources untouched
// requires: invar-tools==1.20.3 in the existing locked project venv
import { mkdtemp, readFile, writeFile, readdir, symlink, rm, cp, glob } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./pi-native-support.mjs";
const scratch = await mkdtemp(join(ROOT, "tests/fixtures/pi/.guard-"));
try {
  // Invar's default doctest subprocess deadline is 60s. Native process journeys
  // exceed it. Only that deadline differs in this disposable verification project.
  const config = (await readFile(join(ROOT, "pyproject.toml"), "utf8")).replace("[tool.invar.guard]", "[tool.invar.guard]\ntimeout_doctest = 600");
  await writeFile(join(scratch, "pyproject.toml"), config);
  for (const name of await readdir(ROOT)) {
    if (["pyproject.toml", "tests", ".git", ".vectl"].includes(name)) continue;
    if (name === "src") await cp(join(ROOT, name), join(scratch, name), { recursive: true });
    else await symlink(join(ROOT, name), join(scratch, name));
  }
  // Pass absolute tests rather than linking tests back through this scratch child.
  const selection = [];
  const ignored = new Set(process.argv.slice(2).filter((arg) => arg.startsWith("--ignore=")).map((arg) => arg.slice(9)));
  for (const item of process.argv.slice(2)) {
    // guard adds --doctest-modules; keep ordinary pytest's configured filename
    // inventory rather than importing unrelated manual repro/CLI scripts.
    if (item === "tests") {
      for await (const file of glob(["tests/**/test_*.py", "tests/**/*_test.py"], { cwd: ROOT })) {
        if (!ignored.has(join(ROOT, file))) selection.push(join(ROOT, file));
      }
    } else selection.push(item.startsWith("tests/") ? join(ROOT, item) : item);
  }
  const env = { ...process.env, UV_PYTHON_DOWNLOADS: "never", PYTEST_ADDOPTS: ["--import-mode=importlib", `--deselect=${relative(ROOT, join(scratch, "src"))}/`, "--deselect=src/", ...selection].map((arg) => JSON.stringify(arg)).join(" ") };
  delete env.VIRTUAL_ENV; delete env.UV_PROJECT_ENVIRONMENT; delete env.PYTHONPATH;
  // Copied-source doctest node names differ under importlib. Their authoritative
  // coverage is the separate, unchanged full Invar scan at ROOT; this invocation
  // collects the requested repository test files, not duplicate shadow doctests.
  // Use the project interpreter so tests that spawn sys.executable (MCP stdio)
  // retain their installed package even when the child filters PYTHONPATH.
  const child = spawn(join(ROOT, ".venv/bin/invar-tools"), ["guard", "--all"], { cwd: scratch, env, stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
} finally { await rm(scratch, { recursive: true, force: true }); }
