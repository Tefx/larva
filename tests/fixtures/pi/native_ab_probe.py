# purpose: disposable Python venv A/B native-tool install destination vs bound Larva CLI
# usage: python tests/fixtures/pi/native_ab_probe.py --root <scratch>
# effects: creates A/B venvs, compiles a tiny C extension, records install prefixes only under --root
# requires: uv, a C compiler, worktree larva package; no user/global venv mutation
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def run(argv: list[str], env: dict[str, str], cwd: Path, timeout: int = 180) -> dict[str, object]:
    completed = subprocess.run(argv, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return {
        "argv": argv,
        "cwd": str(cwd),
        "exit": completed.returncode,
        "stdout": completed.stdout[-4000:],
        "stderr": completed.stderr[-4000:],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--worktree", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    worktree = Path(args.worktree).resolve()
    uv = "/opt/homebrew/bin/uv"
    host_python = sys.executable
    base_env = {
        "HOME": str(root / "home"),
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "TMPDIR": str(root / "tmp"),
        "UV_CACHE_DIR": str(root / "uv-cache"),
        "UV_PYTHON_DOWNLOADS": "never",
        "PYTHONDONTWRITEBYTECODE": "1",
        "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_CONFIG_HOME": str(root / "config"),
    }
    for name in ("home", "tmp", "uv-cache", "cache", "config", "A", "B", "crate"):
        (root / name).mkdir(parents=True, exist_ok=True)
    records: dict[str, object] = {"root": str(root)}
    records["venv_a"] = run([uv, "venv", "--python", host_python, str(root / "A")], base_env, root)
    records["venv_b"] = run([uv, "venv", "--python", host_python, str(root / "B")], base_env, root)
    a_python = root / "A" / "bin" / "python"
    b_python = root / "B" / "bin" / "python"
    crate = root / "crate"
    (crate / "probe.c").write_text(
        """#define PY_SSIZE_T_CLEAN
#include <Python.h>
static PyObject* where(PyObject* self, PyObject* args) {
    return PyUnicode_FromString(Py_GetPrefix());
}
static PyMethodDef methods[] = {{"where", where, METH_NOARGS, NULL}, {NULL, NULL, 0, NULL}};
static struct PyModuleDef module = {PyModuleDef_HEAD_INIT, "larva_ab_probe", NULL, -1, methods};
PyMODINIT_FUNC PyInit_larva_ab_probe(void) { return PyModule_Create(&module); }
""",
        encoding="utf-8",
    )
    (crate / "setup.py").write_text(
        "from setuptools import Extension, setup\n"
        "setup(name='larva-ab-probe', version='0.0.1', ext_modules=[Extension('larva_ab_probe', ['probe.c'])])\n",
        encoding="utf-8",
    )
    def probe(python: Path) -> dict[str, object]:
        return run(
            [str(python), "-c", "import larva_ab_probe, sys; print(larva_ab_probe.where()); print(sys.prefix)"],
            base_env,
            root,
        )

    records["pip_a"] = run([uv, "pip", "install", "--python", str(a_python), "pip", "setuptools", "wheel"], base_env, root)
    records["pip_b"] = run([uv, "pip", "install", "--python", str(b_python), "pip", "setuptools", "wheel"], base_env, root)
    leaked = dict(base_env, VIRTUAL_ENV=str(root / "A"), PATH=f"{root / 'A' / 'bin'}:{base_env['PATH']}")
    records["install_leaked_a"] = run(
        [str(b_python), "-m", "pip", "install", "--force-reinstall", "--no-deps", "."],
        leaked,
        crate,
    )
    records["probe_after_leaked"] = {
        "a": probe(a_python),
        "b": probe(b_python),
    }
    no_venv = dict(base_env)
    no_venv.pop("VIRTUAL_ENV", None)
    records["install_no_venv"] = run(
        [str(b_python), "-m", "pip", "install", "--force-reinstall", "--no-deps", "."],
        no_venv,
        crate,
    )
    explicit_b = dict(base_env, VIRTUAL_ENV=str(root / "B"), PATH=f"{root / 'B' / 'bin'}:{base_env['PATH']}")
    records["install_explicit_b"] = run(
        [str(b_python), "-m", "pip", "install", "--force-reinstall", "--no-deps", "."],
        explicit_b,
        crate,
    )

    records["probe_a"] = probe(a_python)
    records["probe_b"] = probe(b_python)
    records["larva_in_a"] = run(
        [uv, "pip", "install", "--python", str(a_python), str(worktree)],
        base_env,
        root,
        timeout=240,
    )
    larva = root / "A" / "bin" / "larva"
    records["bound_cli_no_activation"] = run(
        [str(larva), "list", "--json"] if larva.exists() else [str(a_python), "-c", "import shutil; print(shutil.which('larva'))"],
        no_venv,
        root,
    )
    a_has = records["probe_a"]["exit"] == 0
    b_has = records["probe_b"]["exit"] == 0
    records["assertions"] = {
        "a_created": (root / "A" / "bin" / "python").exists(),
        "b_created": (root / "B" / "bin" / "python").exists(),
        "native_present_in_b_after_explicit": b_has,
        "native_absent_from_a_after_explicit": not a_has or str(root / "A") not in str(records["probe_a"].get("stdout", "")),
        "bound_cli_exists": larva.exists(),
        "bound_cli_ran_without_virtual_env": records["bound_cli_no_activation"]["exit"] == 0,
        "no_venv_key_in_clean_env": "VIRTUAL_ENV" not in no_venv,
    }
    records["pass"] = all(records["assertions"].values()) and records["install_explicit_b"]["exit"] == 0
    (root / "ab-result.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(json.dumps({
        "pass": records["pass"],
        "assertions": records["assertions"],
        "install_explicit_b_exit": records["install_explicit_b"]["exit"],
        "install_b_stderr": str(records["install_explicit_b"].get("stderr", ""))[-800:],
        "probe_b": {"exit": records["probe_b"]["exit"], "stdout": records["probe_b"]["stdout"], "stderr": str(records["probe_b"].get("stderr", ""))[-500:]},
        "leaked": {
            "a_exit": records["probe_after_leaked"]["a"]["exit"],
            "b_exit": records["probe_after_leaked"]["b"]["exit"],
            "a_stdout": records["probe_after_leaked"]["a"]["stdout"],
            "b_stdout": records["probe_after_leaked"]["b"]["stdout"],
        },
        "result": str(root / "ab-result.json"),
    }))
    return 0 if records["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
