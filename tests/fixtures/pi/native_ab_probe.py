"""Actual native-tool target probe; all activation comes from the Pi caller.

purpose: prepare disposable backend A/project B or execute an observed native build
usage: python native_ab_probe.py --prepare ROOT WORKTREE; --tool ROOT LABEL
 effects: only the supplied scratch root; subprocesses inherit observed environment
requires: uv, Rust toolchain, Python 3.12; cached/downloadable maturin 1.15.0
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def run(argv: list[str], cwd: Path | None = None) -> dict[str, object]:
    proc = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=180)
    return {"argv": argv, "exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}


def prepare(root: Path, worktree: Path) -> dict[str, object]:
    root.mkdir(parents=True, exist_ok=True)
    rows = []
    for name in ("A", "B"):
        rows.append(run(["uv", "venv", "--python", sys.executable, str(root / name)]))
    rows.append(run(["uv", "pip", "install", "--python", str(root / "A/bin/python"), str(worktree)]))
    rows.append(run(["uv", "pip", "install", "--python", str(root / "B/bin/python"), "maturin==1.15.0"]))
    assert all(row["exit"] == 0 for row in rows), json.dumps(rows)
    for label in ("main", "child", "red", "no-main", "no-child"):
        crate = root / f"crate-{label}"
        (crate / "src").mkdir(parents=True)
        (crate / "Cargo.toml").write_text(f'[package]\nname = "larva-native-{label}"\nversion = "0.1.0"\nedition = "2021"\n')
        (crate / "src/main.rs").write_text('fn main() { println!("native binary executed"); }\n')
    # Observe the real backend interpreter and env, then call its installed public CLI.
    # No synthetic list/resolve responses and no activation.
    backend = root / "backend.py"
    backend.write_text(
        'import json,os,sys\nfrom larva.shell.cli import main\n'
        f'with open({str(root / "backend.jsonl")!r}, "a") as f:\n'
        ' f.write(json.dumps({"argv":sys.argv[1:],"prefix":sys.prefix,"virtualEnv":os.environ.get("VIRTUAL_ENV"),"path":os.environ.get("PATH")})+"\\n")\n'
        'main()\n'
    )
    for persona in ("ok", "child"):
        spec = root / f"{persona}.json"
        spec.write_text(json.dumps({"id": persona, "description": "Native environment fixture", "prompt": "Native fixture persona.", "model": "openai/gpt-5.5", "capabilities": {}, "spec_version": "0.1.0", "can_spawn": True}))
        registered = run([str(root / "A/bin/larva"), "register", str(spec), "--json"])
        assert registered["exit"] == 0, registered
        rows.append(registered)
    return {"setup": rows, "versions": [run([str(root / "B/bin/python"), "-m", "maturin", "--version"]), run(["rustc", "--version"])]}


def native_tool(root: Path, label: str) -> dict[str, object]:
    observation = {"pid": os.getpid(), "ppid": os.getppid(), "label": label, "virtualEnv": os.environ.get("VIRTUAL_ENV"), "path": os.environ.get("PATH"), "prefix": sys.prefix, "piSession": os.environ.get("PI_SESSION_FILE")}
    result = run([str(root / "B/bin/python"), "-m", "maturin", "develop", "--bindings", "bin", "--offline"], root / f"crate-{label}")
    targets = {name: (root / name / "bin" / f"larva-native-{label}").exists() for name in ("A", "B")}
    observation.update(result=result, targets=targets)
    (root / f"{label}-tool.json").write_text(json.dumps(observation, indent=2))
    return observation


if __name__ == "__main__":
    if sys.argv[1] == "--prepare":
        result = prepare(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "--tool":
        result = native_tool(Path(sys.argv[2]), sys.argv[3])
    else:
        raise SystemExit("expected --prepare or --tool")
    print(json.dumps(result))
