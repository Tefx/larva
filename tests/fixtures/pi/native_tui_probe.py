"""Native terminal interaction journey, with observed state and real key input.

purpose: selector/shortcut/completion/mentions/console cancellation and theme persistence
usage: python native_tui_probe.py NODE CLI CONTROL (scratch env supplied by Node driver)
effects: one owned PTY process group at a time; scratch snapshots and terminal log
requires: macOS PTY, native Pi; deterministic loopback held-child provider
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

    def visible_any(self, candidates: tuple[str, ...], after: int = 0) -> str:
        return self.wait(lambda: next((c for c in candidates if c in ANSI.sub("", self.output[after:])), ""), f"rendered any of {candidates}")

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
        terminal.visible_any(("🎭 none", "larva: none"))
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
        before_borrow = terminal.snapshot()
        assert {"read", "bash", "edit", "write"} <= set(before_borrow["activeTools"])
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
        borrowed_tools = terminal.rows("switch_loadout")[-1]["value"]["activeTools"]
        assert "read" in borrowed_tools
        assert not {"bash", "edit", "write"} & set(borrowed_tools)
        assert {"read", "bash", "edit", "write"} <= set(confirmed["activeTools"])
        result["confirmation"] = {"fourChoicesRendered": True, "borrowOnceSelected": True, "originModelRestored": "manual", "originThinkingRestored": "high", "borrowedTools": borrowed_tools, "restoredTools": confirmed["activeTools"]}
        # Native theme API persists into the same base settings directory.
        terminal.command("/audit-theme light")
        terminal.wait(lambda: terminal.rows("theme"), "theme API")
        terminal.command("NATIVE_TUI_START_CHILD")
        terminal.wait(lambda: any(r["value"].get("toolName") == "larva_subagent" for r in terminal.rows("tool_end")), "actual subagent tool result")
        terminal.visible_any(("🤖 1", "subagents: 1 running"))
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


def panel_journey() -> list[dict]:
    """Actual host routing/render, distinct fresh messages and asynchronous Worker ingestion."""
    results = []
    for mode in ("fullscreen", "regular"):
        terminal = Terminal(["--no-extensions", "--tui-mode", mode])
        case = {"mode": mode, "pid": terminal.proc.pid, "actions": [], "batches": []}
        results.append(case)
        try:
            terminal.wait(lambda: terminal.rows("session_start"), "panel startup")
            terminal.command("/audit-panel stream")
            terminal.wait(lambda: terminal.rows("panel_created"), "fresh stream panel")
            task = terminal.rows("panel_created")[-1]["value"]["task"]

            def frame() -> dict:
                return terminal.rows("panel_render")[-1]["value"]

            def action(label: str, data: str, expected: int | None = None) -> dict:
                before = frame()
                counts = {name: len(terminal.rows(name)) for name in ("panel_input", "panel_mouse")}
                start = len(terminal.output)
                terminal.send(data)
                terminal.wait(lambda: any(len(terminal.rows(name)) > count for name, count in counts.items()), label + " dispatch")
                dispatched = [row for name, count in counts.items() for row in terminal.rows(name)[count:]]
                assert len(dispatched) == 1, (label, dispatched)
                row = dispatched[0]
                if "wheel" in label:
                    assert row["event"] == ("panel_mouse" if mode == "fullscreen" else "panel_input"), row
                    if mode == "fullscreen":
                        assert row["value"]["event"]["type"] == "wheel", row
                        assert row["value"]["result"]["handled"] is True, row
                        expected = row["value"]["event"]["wheelDelta"]
                if expected is not None:
                    target = before["offsets"]["timeline"] + expected
                    terminal.wait(lambda: frame()["offsets"]["timeline"] == target, label + " single scroll")
                    assert row["value"]["after"]["offsets"]["timeline"] == target, row
                else:
                    terminal.wait(lambda: frame()["following"], label + " follows")
                after = frame()
                observation = {"case": label, "dispatch": row, "before": before, "after": after, "nativeMarkers": re.findall(r"MSG_\d+", terminal.output[start:])}
                case["actions"].append(observation)
                return after

            def close_panel() -> None:
                ended = len(terminal.rows("ui_prompt_end"))
                start = len(terminal.output)
                terminal.send("q")
                terminal.wait(lambda: len(terminal.rows("ui_prompt_end")) > ended, "panel close acknowledged")
                mouse_disabled = "\x1b[?1006l\x1b[?1000l" in terminal.output[start:]
                if mode == "fullscreen":
                    assert not mouse_disabled, "panel close disabled fullscreen mouse tracking"
                else:
                    assert mouse_disabled, "panel close did not release regular-mode mouse tracking"

            terminal.send("4")
            for batch in range(1, 6):
                if batch == 5:
                    terminal.send("\x1b[1~")
                    terminal.wait(lambda: not frame()["following"] and frame()["offsets"]["timeline"] == 0, "pause before new messages")
                start = len(terminal.output)
                terminal.send("v")
                terminal.wait(lambda: len(terminal.rows("panel_batch")) >= batch or terminal.rows("panel_error"), "Worker batch")
                assert not terminal.rows("panel_error"), terminal.rows("panel_error")
                observed = terminal.rows("panel_batch")[-1]["value"]
                assert observed["task"] == task
                assert observed["retained"] == min(80, batch * 21), observed
                assert f"tool_{batch - 1}" in observed["tools"], observed
                assert f"m{batch * 20 - 1}" in observed["messages"], observed
                assert observed["worker"]["inFlight"] == 0, observed
                marker = f"MSG_{batch * 20 - 1:03}"
                if batch == 5:
                    terminal.wait(lambda: frame()["newActivity"] and not frame()["following"], "paused activity signal")
                    assert marker not in frame()["markers"], frame()
                    terminal.visible("new activity", start)
                    action("End after updates", "\x1b[4~")
                    terminal.wait(lambda: marker in frame()["markers"], "End reaches latest message")
                    terminal.visible(marker, start)
                else:
                    terminal.wait(lambda: marker in frame()["markers"] and frame()["following"], "newest rendered message")
                    terminal.visible(marker, start)
                case["batches"].append({**observed, "render": frame()})
                if batch == 2:
                    action("up", "\x1b[A", -1)
                    action("down", "\x1b[B", 1)
                    action("wheel-up", "\x1b[<64;20;15M", -3)
                    action("wheel-down", "\x1b[<65;20;15M", 3)
            # Returning to the bottom with an ordinary arrow resumes following.
            action("up before bottom", "\x1b[A", -1)
            assert action("down to bottom", "\x1b[B", 1)["following"] is True
            before_click = frame()
            raw = len(terminal.rows("panel_raw"))
            terminal.send("\x1b[<0;20;15M\x1b[<0;20;15m")
            terminal.wait(lambda: len(terminal.rows("panel_raw")) > raw, "click delivered")
            terminal.pump(.15)
            assert frame()["offsets"] == before_click["offsets"]
            close_panel()
            terminal.command("/audit-panel short")
            terminal.wait(lambda: len(terminal.rows("panel_created")) == 2, "short pane")
            terminal.send("4")
            terminal.wait(lambda: frame()["rows"] == 42 and "MSG_017" in frame()["markers"], "fitting short pane")
            assert frame()["max"]["timeline"] == 0, frame()
            start = len(terminal.output)
            fcntl.ioctl(terminal.master, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 140, 0, 0))
            os.kill(terminal.proc.pid, signal.SIGWINCH)
            terminal.wait(lambda: frame()["rows"] == 14, "42 to 14 actual resize")
            shrunk = frame()
            assert shrunk["lineCount"] <= min(int(14 * .9), 14 - 2), shrunk
            assert shrunk["viewport"] == shrunk["lineCount"] - 7, shrunk
            assert shrunk["max"]["timeline"] > 0 and "MSG_017" in shrunk["markers"], shrunk
            terminal.visible("MSG_017", start)
            case["shrink"] = {"beforeRows": 42, "after": shrunk, "nativeMarkers": re.findall(r"MSG_\d+", terminal.output[start:])}
            action("shrink-up", "\x1b[A", -1)
            action("shrink-down", "\x1b[B", 1)
            action("shrink-wheel-up", "\x1b[<64;20;7M", -3)
            action("shrink-wheel-down", "\x1b[<65;20;7M", 3)
            close_panel()
            fcntl.ioctl(terminal.master, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 140, 0, 0))
            os.kill(terminal.proc.pid, signal.SIGWINCH)
            terminal.command("/audit-panel output")
            terminal.wait(lambda: len(terminal.rows("panel_created")) == 3, "single-message Output pane")
            terminal.send("3")
            terminal.wait(lambda: frame()["max"]["output"] > 0, "Output overflow")
            start = len(terminal.output)
            terminal.send("f")
            terminal.wait(lambda: frame()["outputTailRetained"], "Output delta retained")
            assert "OUTPUT_LATEST" not in frame()["markers"], "Output still needs explicit navigation"
            terminal.send("\x1b[4~")
            terminal.wait(lambda: "OUTPUT_LATEST" in frame()["markers"], "Output End")
            terminal.visible("OUTPUT_LATEST", start)
            case["output"] = {"tailRetained": True, "EndRender": frame()}
            close_panel()
        finally:
            if len(terminal.rows("ui_prompt_start")) > len(terminal.rows("ui_prompt_end")):
                close_panel()
            terminal.close()
            case["exit"] = terminal.proc.returncode
            case["cleanup"] = terminal.rows("panel_cleanup")
        assert case["exit"] == 0, {key: case[key] for key in ("mode", "pid", "exit", "cleanup")}
        assert case["cleanup"] and case["cleanup"][-1]["value"]["active"] is False, case["cleanup"]
    return results


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
    if len(sys.argv) > 4 and sys.argv[4] == "--panel":
        print(json.dumps(panel_journey()))
    else:
        print(json.dumps(admission(json.loads(sys.argv[5])) if len(sys.argv) > 4 and sys.argv[4] == "--admission" else journey()))
