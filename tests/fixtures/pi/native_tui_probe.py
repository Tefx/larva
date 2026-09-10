"""Native terminal interaction journey, with observed state and real key input.

purpose: selector/shortcut/completion/mentions/console cancellation and theme persistence
usage: python native_tui_probe.py NODE CLI CONTROL (scratch env supplied by Node driver)
effects: one owned PTY process group at a time; scratch snapshots and terminal log
requires: macOS PTY, Pi 0.85.1; deterministic loopback held-child provider
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

ROOT = Path(os.environ.get("NATIVE_AUDIT_ROOT", "."))
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


class Terminal:
    def __init__(self, extra: tuple | list = (), env: dict | None = None) -> None:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 140, 0, 0))
        self.master = master
        self.output = ""
        self.proc = subprocess.Popen([sys.argv[1], sys.argv[2], "--offline", "--approve", "--no-skills", "--no-prompt-templates", "--session-dir", str(ROOT / "sessions"), "-e", sys.argv[3], *extra], stdin=slave, stdout=slave, stderr=slave, cwd=ROOT / "project", env=env or os.environ, start_new_session=True)
        os.close(slave)

    def pump(self, duration: float = 0.1) -> None:
        if select.select([self.master], [], [], duration)[0]:
            try:
                data = os.read(self.master, 65536).decode("utf-8", errors="replace")
                self.output += data
                # Answer the native terminal capability probe; never synthesize UI results.
                if "\x1b[6n" in data:
                    os.write(self.master, b"\x1b[1;1R")
            except OSError:
                pass

    def send(self, value: str) -> None:
        os.write(self.master, value.encode())

    def rows(self, event: str) -> list[dict]:
        try:
            return [json.loads(line) for line in (ROOT / "observations.jsonl").read_text().splitlines() if line and json.loads(line)["pid"] == self.proc.pid and json.loads(line)["event"] == event]
        except FileNotFoundError:
            return []

    def wait(self, predicate, description: str, timeout: float = 15) -> object:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            value = predicate()
            if value:
                return value
            assert self.proc.poll() is None, f"Pi exited {self.proc.returncode}: {self.output[-2000:]}"
        raise AssertionError(f"TUI timeout: {description}\n{ANSI.sub('', self.output[-5000:])}")

    def visible(self, expected: str, after: int = 0) -> str:
        return self.wait(lambda: expected if expected in ANSI.sub("", self.output[after:]) else "", f"rendered {expected}")

    def command(self, value: str) -> None:
        self.send(value + "\r")

    def snapshot(self) -> dict:
        count = len(self.rows("snapshot"))
        self.command("/audit-snapshot")
        return self.wait(lambda: self.rows("snapshot")[-1]["value"] if len(self.rows("snapshot")) > count else None, "public SDK snapshot")

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.command("/audit-stop")
                deadline = time.monotonic() + 5
                while self.proc.poll() is None and time.monotonic() < deadline:
                    self.pump()
            if self.proc.poll() is None:
                os.killpg(self.proc.pid, signal.SIGTERM)
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait(timeout=5)
        finally:
            (ROOT / f"terminal-{self.proc.pid}.log").write_text(self.output)
            os.close(self.master)


def journey() -> dict:
    result = {}
    terminal = Terminal()
    try:
        terminal.wait(lambda: terminal.rows("session_start"), "session startup")
        terminal.visible("larva: none")
        terminal.command("/larva-persona --refresh-cache")
        terminal.visible("cache refreshed")
        # Submit the actual slash selector and select a filtered persona.
        offset = len(terminal.output)
        terminal.command("/larva-persona")
        terminal.visible("Select Larva persona", offset)
        terminal.send("startup")
        terminal.visible("Filter: > startup", offset)
        terminal.send("\r")
        terminal.visible("Larva persona active: startup", offset)
        selected = terminal.snapshot()
        assert selected["model"]["id"] == "persona"
        assert selected["entries"][-1]["data"]["persona_id"] == "startup"
        result["selector"] = selected
        # Shortcut opens the same actual overlay; Escape preserves state.
        offset = len(terminal.output)
        terminal.send("\x1b[112;7u")
        terminal.visible("Select Larva persona", offset)
        terminal.send("\x1b")
        terminal.visible("Persona selection cancelled", offset)
        shortcut = terminal.snapshot()
        assert [e for e in shortcut["entries"] if e.get("customType") == "larva-active-persona-commit"] == [e for e in selected["entries"] if e.get("customType") == "larva-active-persona-commit"]
        result["shortcutPreservedCommit"] = True
        # Completion inserted into the real editor, then dispatched as a command.
        terminal.send("/larva-persona chil\t")
        terminal.pump(0.3)
        terminal.send("\r")
        terminal.visible("Larva persona active: child")
        completed = terminal.snapshot()
        assert [e for e in completed["entries"] if e.get("customType") == "larva-active-persona-commit"][-1]["data"]["persona_id"] == "child"
        result["completion"] = "child"
        # Mention completion uses canonical insertion and has no persona side effect.
        offset = len(terminal.output)
        terminal.send("@persona:star\t")
        terminal.visible("@persona:startup", offset)
        terminal.send("\r")
        terminal.wait(lambda: terminal.rows("settled"), "mention turn")
        mention = terminal.snapshot()
        assert [e for e in mention["entries"] if e.get("customType") == "larva-active-persona-commit"][-1]["data"]["persona_id"] == "child"
        result["mention"] = {"inserted": "@persona:startup", "activeUnchanged": True}
        terminal.command("/larva-persona ok")
        terminal.visible("Larva persona active: ok")
        terminal.command("/larva-mode confirm")
        terminal.command("/audit-model manual high")
        settled_before = len(terminal.rows("settled"))
        offset = len(terminal.output)
        terminal.command("NATIVE_TUI_BORROW")
        for label in ["Borrow once", "Deny", "Auto-borrow for this session", "Switch persistently"]:
            terminal.visible(label, offset)
        terminal.send("\r")
        terminal.wait(lambda: len(terminal.rows("settled")) > settled_before, "confirmed borrow completion")
        confirmed = terminal.snapshot()
        assert confirmed["model"]["id"] == "manual"
        assert confirmed["thinking"] == "high"
        assert [e for e in confirmed["entries"] if e.get("customType") == "larva-active-persona-commit"][-1]["data"]["persona_id"] == "ok"
        result["confirmation"] = {"fourChoicesRendered": True, "borrowOnceSelected": True, "originModelRestored": "manual", "originThinkingRestored": "high"}
        # Native theme API persists into the same base settings directory.
        terminal.command("/audit-theme light")
        terminal.wait(lambda: terminal.rows("theme"), "theme API")
        terminal.command("NATIVE_TUI_START_CHILD")
        terminal.wait(lambda: any(r["value"].get("toolName") == "larva_subagent" for r in terminal.rows("tool_end")), "actual subagent tool result")
        terminal.visible("subagents: 1 running")
        offset = len(terminal.output)
        terminal.command("/larva-subagent")
        terminal.visible("Larva subagent log", offset)
        terminal.send("\r")  # choose exact task from console selector
        terminal.send("5")
        terminal.visible("Startup model", offset)
        terminal.send("c")
        terminal.visible("CANCEL SUBAGENT?", offset)
        settled_before = len(terminal.rows("settled"))
        terminal.send("y")
        terminal.visible("LARVA_CHILD_CANCELLED", offset)
        terminal.wait(lambda: len(terminal.rows("settled")) > settled_before, "callback continuation after user cancel")
        terminal.send("q")
        terminal.pump(0.1)
        result["console"] = {"opened": True, "metadataRendered": True, "cancelConfirmed": True}
        result["beforeExit"] = terminal.snapshot()
    finally:
        terminal.close()
        result["exit"] = terminal.proc.returncode
    assert result["exit"] == 0, result
    terminal = Terminal()
    try:
        terminal.wait(lambda: terminal.rows("session_start"), "theme restart")
        result["relaunch"] = terminal.snapshot()
        assert result["relaunch"]["theme"] == "light", result["relaunch"]
        assert result["relaunch"]["env"]["capsule"] is None
    finally:
        terminal.close()
        result["relaunchExit"] = terminal.proc.returncode
    assert result["relaunchExit"] == 0
    return result


def admission(cases: list[dict]) -> list[dict]:
    results = []
    for case in cases:
        terminal = Terminal(case["args"], {**os.environ, **case.get("env", {})})
        try:
            deadline = time.monotonic() + 15
            while terminal.proc.poll() is None and time.monotonic() < deadline:
                terminal.pump()
            code = terminal.proc.poll()
            terminal.pump(0.05)
            assert code == case["code"], terminal.output
            assert case["diagnostic"] in terminal.output, terminal.output
            results.append({"case": case["name"], "exit": code, "pid": terminal.proc.pid, "transcript": terminal.output})
        finally:
            terminal.close()
    return results


if __name__ == "__main__":
    assert "NATIVE_AUDIT_ROOT" in os.environ, "requires an owned native fixture root"
    print(json.dumps(admission(json.loads(sys.argv[5])) if len(sys.argv) > 4 and sys.argv[4] == "--admission" else journey()))
