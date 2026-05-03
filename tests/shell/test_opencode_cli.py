"""Tests for the ``larva opencode`` launcher."""

from __future__ import annotations

import io
import json
from typing import TYPE_CHECKING, cast

from returns.result import Failure, Success

from larva.shell.cli import run_cli
from larva.shell.opencode import (
    OPENCODE_CONFIG_ENV,
    OPENCODE_PLUGIN_ENV,
    build_opencode_config,
    opencode_command,
    resolve_opencode_plugin_path,
)

if TYPE_CHECKING:
    from pathlib import Path
    from typing import Any

    from returns.result import Result

    from larva.app.facade import LarvaError
    from larva.app.facade_types import (
        AssembleRequest,
        BatchUpdateResult,
        ClearedRegistry,
        DeletedPersona,
        PersonaSummary,
        RegisteredPersona,
    )
    from larva.core.spec import PersonaSpec
    from larva.core.validate import ValidationReport


def _persona(
    persona_id: str,
    *,
    capabilities: dict[str, str] | None = None,
    can_spawn: bool | list[str] | None = None,
) -> PersonaSpec:
    spec: dict[str, object] = {
        "id": persona_id,
        "description": f"{persona_id} description",
        "prompt": f"You are {persona_id}.",
        "model": "openai/gpt-5.5",
        "capabilities": capabilities or {"shell": "read_write"},
        "spec_version": "0.1.0",
    }
    if can_spawn is not None:
        spec["can_spawn"] = can_spawn
    return cast("PersonaSpec", spec)


class ExportFacade:
    def __init__(self, specs: list[PersonaSpec]) -> None:
        self.specs = specs

    def validate(self, spec: PersonaSpec) -> ValidationReport:
        raise AssertionError("not used")

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]:
        raise AssertionError("not used")

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]:
        raise AssertionError("not used")

    def resolve(
        self,
        persona_id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]:
        raise AssertionError("not used")

    def update(
        self,
        persona_id: str,
        patches: dict[str, object],
    ) -> Result[PersonaSpec, LarvaError]:
        raise AssertionError("not used")

    def update_batch(
        self,
        where: dict[str, object],
        patches: dict[str, object],
        dry_run: bool = False,
    ) -> Result[BatchUpdateResult, LarvaError]:
        raise AssertionError("not used")

    def list(self) -> Result[list[PersonaSummary], LarvaError]:
        raise AssertionError("not used")

    def clone(self, source_id: str, new_id: str) -> Result[PersonaSpec, LarvaError]:
        raise AssertionError("not used")

    def delete(self, persona_id: str) -> Result[DeletedPersona, LarvaError]:
        raise AssertionError("not used")

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[ClearedRegistry, LarvaError]:
        raise AssertionError("not used")

    def export_all(self) -> Result[list[PersonaSpec], LarvaError]:
        return Success(self.specs)

    def export_ids(self, ids: list[str]) -> Result[list[PersonaSpec], LarvaError]:
        raise AssertionError("not used")


def test_build_opencode_config_injects_plugin_and_larva_agents() -> None:
    specs = [
        _persona("python-senior", capabilities={"shell": "read_only"}, can_spawn=False),
        _persona("writer"),
    ]

    result = build_opencode_config(
        specs,
        plugin_uri="file:///tmp/larva.ts",
        base_config={"plugin": ["file:///existing.ts"], "agent": {"general": {"mode": "all"}}},
    )

    assert isinstance(result, Success)
    config = result.unwrap()
    assert config["plugin"] == ["file:///existing.ts", "file:///tmp/larva.ts"]
    agents = cast("dict[str, dict[str, object]]", config["agent"])
    assert agents["general"] == {"mode": "all"}
    assert agents["python-senior"] == {
        "description": "[larva] python-senior description",
        "mode": "all",
        "prompt": "[larva:python-senior]",
        "model": "openai/gpt-5.5",
        "permission": {"edit": "deny", "bash": "deny", "task": "deny"},
    }
    assert "permission" not in agents["writer"]


def test_build_opencode_config_uses_active_variant_under_base_id() -> None:
    """Exported active variants register with Larva base ids only."""
    active_variant_spec = _persona("python-senior")
    active_variant_spec["description"] = "active variant description"
    active_variant_spec["prompt"] = "Active variant prompt must stay runtime-only."
    active_variant_spec["model"] = "anthropic/claude-sonnet-4"

    result = build_opencode_config(
        [active_variant_spec],
        plugin_uri="file:///tmp/larva.ts",
        base_config=None,
    )

    assert isinstance(result, Success)
    agents = cast("dict[str, dict[str, object]]", result.unwrap()["agent"])
    assert set(agents) == {"python-senior"}
    assert agents["python-senior"] == {
        "description": "[larva] active variant description",
        "mode": "all",
        "prompt": "[larva:python-senior]",
        "model": "anthropic/claude-sonnet-4",
    }
    assert "Active variant prompt" not in json.dumps(agents["python-senior"])


def test_resolve_opencode_plugin_path_uses_explicit_env(tmp_path: Path) -> None:
    plugin = tmp_path / "larva.ts"
    plugin.write_text("export default {};\n", encoding="utf-8")

    result = resolve_opencode_plugin_path({OPENCODE_PLUGIN_ENV: str(plugin)})

    assert isinstance(result, Success)
    assert result.unwrap() == plugin


def test_resolve_opencode_plugin_path_rejects_missing_explicit_env(tmp_path: Path) -> None:
    missing = tmp_path / "missing.ts"

    result = resolve_opencode_plugin_path({OPENCODE_PLUGIN_ENV: str(missing)})

    assert isinstance(result, Failure)
    assert "does not point to a file" in result.failure()["stderr"]


def test_resolve_opencode_plugin_path_uses_packaged_plugin(tmp_path: Path) -> None:
    shell_dir = tmp_path / "site-packages" / "larva" / "shell"
    plugin = shell_dir / "opencode_plugin" / "larva.ts"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("export default {};\n", encoding="utf-8")
    module_path = shell_dir / "opencode.py"
    module_path.write_text("", encoding="utf-8")

    result = resolve_opencode_plugin_path({}, start_path=module_path)

    assert isinstance(result, Success)
    assert result.unwrap() == plugin


def test_resolve_opencode_plugin_path_falls_back_to_source_tree(tmp_path: Path) -> None:
    project = tmp_path / "project"
    plugin = project / "contrib" / "opencode-plugin" / "larva.ts"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("export default {};\n", encoding="utf-8")
    module_path = project / "src" / "larva" / "shell" / "opencode.py"
    module_path.parent.mkdir(parents=True)
    module_path.write_text("", encoding="utf-8")

    result = resolve_opencode_plugin_path({}, start_path=module_path)

    assert isinstance(result, Success)
    assert result.unwrap() == plugin


def test_opencode_command_execs_with_dynamic_config_and_forwarded_args(tmp_path: Path) -> None:
    plugin = tmp_path / "larva.ts"
    plugin.write_text("export default {};\n", encoding="utf-8")
    calls: list[tuple[str, list[str], dict[str, str]]] = []

    def fake_execvpe(command: str, argv: list[str], env: dict[str, str]) -> None:
        calls.append((command, argv, env))

    environ = {
        OPENCODE_PLUGIN_ENV: str(plugin),
        OPENCODE_CONFIG_ENV: json.dumps({"agent": {"existing": {"mode": "primary"}}}),
    }
    result = opencode_command(
        ["--", "run", "fix this", "--agent", "python-senior"],
        facade=ExportFacade([_persona("python-senior")]),
        environ=environ,
        execvpe=fake_execvpe,
    )

    assert isinstance(result, Success)
    assert calls[0][0] == "opencode"
    assert calls[0][1] == ["opencode", "run", "fix this", "--agent", "python-senior"]
    config = json.loads(calls[0][2][OPENCODE_CONFIG_ENV])
    assert config["plugin"] == [plugin.resolve().as_uri()]
    assert set(config["agent"]) == {"existing", "python-senior"}
    assert config["agent"]["python-senior"]["prompt"] == "[larva:python-senior]"


def test_run_cli_opencode_dispatches_launcher(monkeypatch: Any) -> None:
    calls: list[list[str]] = []

    def fake_opencode_command(
        *args: Any, **kwargs: Any
    ) -> Result[dict[str, int], dict[str, object]]:
        calls.append(list(args[0]))
        return Success({"exit_code": 0})

    monkeypatch.setattr("larva.shell.opencode.opencode_command", fake_opencode_command)

    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = run_cli(
        ["opencode", "run", "fix this", "--agent", "python-senior"],
        facade=ExportFacade([]),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == 0
    assert calls == [["run", "fix this", "--agent", "python-senior"]]
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == ""


# ---------------------------------------------------------------------------
# Active-variant projection smoke tests
#
# Source: design/registry-local-variants-and-assembly-removal.md lines 93-99
# Source: docs/reference/ARCHITECTURE.md line 98
# Source: contrib/opencode-plugin/README.md lines 7-9
# ---------------------------------------------------------------------------


class TestOpenCodeVariantProjection:
    """OpenCode must project active variants only; inactive variants must not
    appear as separate agent entries.

    This class tests the build_opencode_config projection function directly,
    without requiring a running opencode binary.
    """

    def test_projection_creates_one_agent_per_spec(self) -> None:
        """Each spec in export_all maps to exactly one agent key."""
        specs = [
            _persona("code-reviewer", capabilities={"shell": "read_only"}),
            _persona("writer", capabilities={"shell": "read_write"}),
        ]
        result = build_opencode_config(
            specs,
            plugin_uri="file:///tmp/larva.ts",
        )
        assert isinstance(result, Success)
        config = result.unwrap()
        agents = cast("dict[str, dict[str, object]]", config.get("agent", {}))
        assert len(agents) == 2
        assert "code-reviewer" in agents
        assert "writer" in agents

    def test_projection_no_forbidden_keys_in_agent_entry(self) -> None:
        """Agent entries must not contain variant, _registry, or active keys."""
        spec = _persona("projection-leak")
        result = build_opencode_config(
            [spec],
            plugin_uri="file:///tmp/larva.ts",
        )
        assert isinstance(result, Success)
        config = result.unwrap()
        agents = cast("dict[str, dict[str, object]]", config.get("agent", {}))
        for _agent_id, entry in agents.items():
            assert "variant" not in entry, "Agent entry must not contain 'variant'"
            assert "_registry" not in entry, "Agent entry must not contain '_registry'"
            assert "active" not in entry, "Agent entry must not contain 'active'"

    def test_projection_uses_spec_id_as_agent_key(self) -> None:
        """Agent key must be the base persona id, not any variant suffix.

        Source: contrib/opencode-plugin/README.md line 114.
        """
        spec = _persona("my-persona")
        result = build_opencode_config(
            [spec],
            plugin_uri="file:///tmp/larva.ts",
        )
        assert isinstance(result, Success)
        config = result.unwrap()
        agents = cast("dict[str, dict[str, object]]", config.get("agent", {}))
        assert "my-persona" in agents
        # No variant-suffixed keys
        assert "my-persona-tacit" not in agents
