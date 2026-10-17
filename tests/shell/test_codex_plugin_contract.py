"""Codex package structure and real stdio configuration contract.

Skill examples are validated as tool inputs, not as evidence of routing judgment.
No check installs a plugin or inherits provider credentials.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from xml.etree import ElementTree

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "contrib/codex-plugin"
REQUIRED_ENV = {
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR",
    "LARVA_CLI_ARGV_JSON", "LARVA_PI_CLI_SCRIPT", "LARVA_PI_MODEL_MAP_FILE",
    "LARVA_PI_SUBAGENT_CONFIG_FILE", "LARVA_PI_CHILD_SESSION_DIR",
    "LARVA_MCP_PARENT_PERSONA",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
}
TOOLS = {
    "larva_personas", "larva_subagent", "larva_subagent_wait",
    "larva_subagent_select", "larva_subagent_status", "larva_subagent_events",
    "larva_subagent_sessions", "larva_subagent_cancel", "larva_subagent_activity",
}


def test_manifest_and_mcp_config() -> None:
    """Pin required host fields and resolve paths from the plugin root."""
    manifest = json.loads((PLUGIN / ".codex-plugin/plugin.json").read_text())
    jsonschema.validate(manifest, {
        "type": "object",
        "required": ["name", "version", "description", "skills", "mcpServers", "interface", "keywords"],
        "properties": {
            "name": {"const": "larva-subagent"},
            "version": {"const": "0.8.9"},
            "description": {"type": "string", "minLength": 1},
            "keywords": {"const": ["larva", "persona", "subagent", "pi"]},
            "skills": {"const": "./skills/"},
            "mcpServers": {"const": "./.mcp.json"},
            "interface": {
                "type": "object",
                "required": ["displayName", "shortDescription", "composerIcon", "logo"],
                "additionalProperties": {"type": "string", "minLength": 1},
            },
        },
    })
    assert (PLUGIN / manifest["skills"] / "larva-subagent/SKILL.md").is_file()
    for key in ("composerIcon", "logo"):
        asset = manifest["interface"][key]
        assert asset.startswith("./assets/")
        assert ElementTree.parse(PLUGIN / asset).getroot().tag == (
            "{http://www.w3.org/2000/svg}svg"
        )
    config = json.loads((PLUGIN / manifest["mcpServers"]).read_text())
    assert set(config) == {"mcpServers"}
    assert set(config["mcpServers"]) == {"larva-pi-subagent"}
    server = config["mcpServers"]["larva-pi-subagent"]
    jsonschema.validate(server, {
        "type": "object",
        "required": ["command", "args", "cwd", "tool_timeout_sec", "env_vars"],
        "additionalProperties": False,
        "properties": {
            "command": {"const": "node"},
            "args": {"type": "array", "minItems": 1, "maxItems": 1,
                     "items": {"type": "string"}},
            "cwd": {"const": "."},
            "tool_timeout_sec": {"const": 3600},
            "env_vars": {"type": "array", "uniqueItems": True,
                         "items": {"type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"}},
        },
    })
    assert REQUIRED_ENV <= set(server["env_vars"])
    script = (PLUGIN / server["cwd"] / server["args"][0]).resolve()
    assert server["args"] == ["./subagent-mcp-server.mjs"]
    assert script == PLUGIN / "subagent-mcp-server.mjs"
    assert script.is_file()


def test_marketplace_and_runtime_parity() -> None:
    """The local marketplace resolves a self-contained, byte-identical runtime."""
    marketplace = json.loads((ROOT / ".agents/plugins/marketplace.json").read_text())
    jsonschema.validate(marketplace, {
        "type": "object", "additionalProperties": False,
        "required": ["name", "interface", "plugins"],
        "properties": {
            "name": {"const": "larva"},
            "interface": {"const": {"displayName": "Larva"}},
            "plugins": {"const": [{
                "name": "larva-subagent",
                "source": {"source": "local", "path": "./contrib/codex-plugin"},
                "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                "category": "Productivity",
            }]},
        },
    })
    assert (ROOT / marketplace["plugins"][0]["source"]["path"]).resolve() == PLUGIN
    for name in ("subagent-mcp-server.mjs", "larva.ts", "activity.ts",
                 "child-rpc-frame-preload.mjs", "session-timeline-worker.mjs"):
        bundled = PLUGIN / name
        assert bundled.is_file() and not bundled.is_symlink()
        assert hashlib.sha256(bundled.read_bytes()).digest() == hashlib.sha256(
            (ROOT / "contrib/pi-extension" / name).read_bytes()
        ).digest(), name


def test_configured_stdio_and_skill_examples(tmp_path: Path) -> None:
    """Launch the declared command, check nine tools, validate skill calls, reap."""
    server = json.loads((PLUGIN / ".mcp.json").read_text())["mcpServers"]["larva-pi-subagent"]
    node = shutil.which(server["command"])
    assert node is not None, "Node is required for the configured runtime"
    env = {"PATH": os.path.dirname(node)}
    for name in ("HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
                 "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR", "LARVA_PI_CHILD_SESSION_DIR"):
        path = tmp_path / name.lower()
        path.mkdir()
        env[name] = str(path)
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "codex-plugin-contract", "version": "1"},
        }},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "resources/templates/list"},
    ]
    # Match Codex's regular-file-only cache copy, without the source sibling.
    cached = tmp_path / "cache" / "larva-subagent"
    shutil.copytree(PLUGIN, cached, ignore=lambda directory, names: [
        name for name in names if (Path(directory) / name).is_symlink()
    ])
    assert not (cached / "node_modules").exists()
    assert not (cached.parent / "pi-extension").exists()
    # communicate closes stdin after writing: this exercises the real EOF cleanup.
    # No tools/call is sent, so no registry, provider, or child launch is needed.
    process = subprocess.Popen(
        [node, *server["args"]], cwd=cached / server["cwd"], env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr = process.communicate(
            "\n".join(json.dumps(item) for item in requests) + "\n", timeout=30,
        )
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    assert process.returncode == 0, stderr
    replies = [json.loads(line) for line in stdout.splitlines()]
    assert len(replies) == 3, stdout
    by_id = {reply["id"]: reply for reply in replies}
    assert by_id[1]["result"]["protocolVersion"] == "2024-11-05"
    assert by_id[1]["result"]["capabilities"] == {
        "tools": {}, "resources": {},
        "extensions": {"openai/mentions": {"searchTool": "search_mentions"}},
        "experimental": {"openai/mentions": {"searchTool": "search_mentions"}},
    }
    assert by_id[1]["result"]["serverInfo"]["title"] == "Larva Subagents"
    assert by_id[3]["result"] == {"resourceTemplates": [{
        "uriTemplate": "larva://personas/{persona_id}", "name": "larva-persona",
        "title": "Larva Persona",
        "description": "Resolved Larva persona metadata and delegation guidance.",
        "mimeType": "text/markdown",
    }]}
    assert by_id[1]["result"]["serverInfo"]["name"] == "larva-pi-subagent"
    definitions = by_id[2]["result"]["tools"]
    assert len(definitions) == 10
    mention_tool = next(tool for tool in definitions if tool["name"] == "search_mentions")
    assert mention_tool["annotations"] == {
        "readOnlyHint": True, "destructiveHint": False, "openWorldHint": False,
    }
    assert mention_tool["_meta"] == {
        "openai/extensions": {"mentions/search": {}}, "ui": {"visibility": ["app"]},
    }
    # tools/list is the deployed, harness-neutral description contract.
    descriptions = {tool["name"]: tool["description"] for tool in definitions}
    for description in descriptions.values():
        assert "codex" not in description.lower()
        assert "spawn_agent" not in description.lower()
    for name in ("larva_subagent", "larva_subagent_wait",
                 "larva_subagent_select", "larva_subagent_cancel"):
        assert ".jsonl" in descriptions[name]
        assert "task_id" in descriptions[name]
    schemas = {tool["name"]: tool["inputSchema"] for tool in definitions}
    assert set(schemas) == TOOLS | {"search_mentions"}
    assert {tool["name"] for tool in definitions if tool.get("_meta", {}).get("ui", {}).get("visibility") != ["app"]} == TOOLS

    skill = (PLUGIN / "skills/larva-subagent/SKILL.md").read_text()
    # These text checks pin the installed guidance, not model routing judgment.
    assert "## When to use Larva vs. native Codex subagents" in skill
    assert "Default to Codex native subagents" in skill
    assert all(f"`{name}`" in skill for name in (
        "spawn_agent", "wait", "send_input", "close_agent", "larva_subagent",
        "model-map.json", "can_spawn", "larva_subagent_activity",
    ))
    assert "Strict handle separation" in skill
    assert "Never pass Codex `agent_id` handles to `larva_subagent_*` tools" in skill
    frontmatter = re.match(r"\A---\n(.*?)\n---\n", skill, re.DOTALL)
    assert frontmatter is not None
    metadata = yaml.safe_load(frontmatter.group(1))
    jsonschema.validate(metadata, {
        "type": "object", "required": ["name", "description"],
        "additionalProperties": False,
        "properties": {"name": {"const": "larva-subagent"},
                       "description": {"type": "string", "minLength": 1}},
    })
    examples = re.search(r"```json\n(.*?)\n```", skill, re.DOTALL)
    assert examples is not None
    calls = json.loads(examples.group(1))
    assert {call["name"] for call in calls} == {
        "larva_personas", "larva_subagent", "larva_subagent_wait",
        "larva_subagent_select", "larva_subagent_activity",
    }
    for call in calls:
        jsonschema.validate(call["arguments"], schemas[call["name"]])
    spawns = [c["arguments"] for c in calls if c["name"] == "larva_subagent"]
    assert {c["wait_for_completion"] for c in spawns} == {True, False}
    resume = next(c for c in spawns if "task_id" in c)
    wait = next(c["arguments"] for c in calls if c["name"] == "larva_subagent_wait")
    activity = next(c["arguments"] for c in calls if c["name"] == "larva_subagent_activity")
    assert wait["task_ids"] == [resume["task_id"]] == [activity["task_id"]]

    # The operator workflow uses the real advertised schemas, so renamed keys,
    # wrong types, and invalid wait modes in runnable examples fail here.
    usage = (ROOT / "docs/guides/USAGE.md").read_text()
    workflow = usage.split("### Workflow E:", 1)[1].split("\n## ", 1)[0]
    example = re.search(r"```json\n(.*?)\n```", workflow, re.DOTALL)
    assert example is not None
    workflow_calls = json.loads(example.group(1))
    for call in workflow_calls:
        jsonschema.validate(call["arguments"], schemas[call["name"]])
    fanout = [call["arguments"] for call in workflow_calls
              if call["name"] == "larva_subagent"
              and call["arguments"].get("wait_for_completion") is False]
    waits = [call["arguments"] for call in workflow_calls
             if call["name"] in {"larva_subagent_wait", "larva_subagent_select"}]
    assert len(fanout) == 2
    assert len(waits) == 2
    assert waits[0]["task_ids"] == waits[1]["task_ids"]
    assert len(waits[0]["task_ids"]) == len(fanout)
    continuation = next(call["arguments"] for call in workflow_calls
                        if call["name"] == "larva_subagent"
                        and "task_id" in call["arguments"])
    inspection = next(call["arguments"] for call in workflow_calls
                      if call["name"] == "larva_subagent_activity")
    assert continuation["task_id"] in waits[0]["task_ids"]
    assert inspection["task_id"] == continuation["task_id"]
    assert all(Path(task_id).is_absolute() and task_id.endswith(".jsonl")
               for task_id in waits[0]["task_ids"])
