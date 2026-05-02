"""OpenCode launcher shell adapter for larva personas."""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.shell.cli_runtime import _critical_error, _map_facade_error, cli_exit_code_for_error
from larva.shell.cli_types import EXIT_CRITICAL, EXIT_OK, CliCommandResult, CliFailure

if TYPE_CHECKING:
    from larva.app.facade import LarvaError, LarvaFacade
    from larva.core.spec import PersonaSpec

OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT"
OPENCODE_PLUGIN_ENV = "LARVA_OPENCODE_PLUGIN"
OPENCODE_PLUGIN_RELATIVE_PATH = Path("contrib/opencode-plugin/larva.ts")
OPENCODE_EXECUTABLE = "opencode"

_READ_ONLY_POSTURES = frozenset({"none", "read_only"})

ExecVpe = Callable[[str, list[str], dict[str, str]], object]


# @shell_orchestration: maps launcher setup failures to CLI transport envelopes
def _opencode_failure(
    message: str, details: dict[str, object] | None = None
) -> Result[CliFailure, object]:
    envelope = _critical_error(message, details or {}).unwrap()
    return Success(
        {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"OpenCode launch failed: {message}\n",
            "error": envelope,
        }
    )


# @shell_orchestration: maps facade errors into launcher CLI failures
def _facade_failure(error: LarvaError) -> Result[CliFailure, object]:
    envelope = _map_facade_error(error).unwrap()
    return Success(
        {
            "exit_code": cli_exit_code_for_error(envelope),
            "stderr": f"OpenCode launch failed: {envelope['message']}\n",
            "error": envelope,
        }
    )


# @shell_orchestration: OpenCode prompt placeholder is transport-specific glue
def _placeholder(persona_id: str) -> Result[str, object]:
    return Success(f"[larva:{persona_id}]")


# @shell_orchestration: projects canonical capabilities to OpenCode permissions
def _to_permissions(spec: PersonaSpec) -> Result[dict[str, str], object]:
    permissions: dict[str, str] = {}
    capabilities = spec.get("capabilities", {})
    if capabilities and all(posture in _READ_ONLY_POSTURES for posture in capabilities.values()):
        permissions["edit"] = "deny"
        permissions["bash"] = "deny"
    if spec.get("can_spawn") is False:
        permissions["task"] = "deny"
    return Success(permissions)


# @shell_orchestration: projects a PersonaSpec into an OpenCode agent block
def _agent_entry(spec: PersonaSpec) -> Result[dict[str, object], object]:
    entry: dict[str, object] = {
        "description": f"[larva] {spec.get('description') or spec['id']}",
        "mode": "all",
        "prompt": _placeholder(spec["id"]).unwrap(),
    }
    model = spec.get("model")
    if model:
        entry["model"] = model
    permissions = _to_permissions(spec).unwrap()
    if permissions:
        entry["permission"] = permissions
    return Success(entry)


def _load_base_config(environ: Mapping[str, str]) -> Result[dict[str, object], CliFailure]:
    content = environ.get(OPENCODE_CONFIG_ENV)
    if not content:
        return Success({})
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as error:
        return Failure(
            _opencode_failure(
                f"invalid {OPENCODE_CONFIG_ENV}",
                {"error": str(error)},
            ).unwrap()
        )
    if not isinstance(parsed, dict):
        return Failure(
            _opencode_failure(f"{OPENCODE_CONFIG_ENV} must be a JSON object").unwrap()
        )
    return Success(cast("dict[str, object]", parsed))


# @shell_orchestration: normalizes OpenCode config plugin field for env injection
def _plugin_values(value: object) -> Result[list[object], CliFailure]:
    if value is None:
        return Success([])
    if isinstance(value, str):
        return Success([value])
    if isinstance(value, list):
        return Success(list(value))
    return Failure(
        _opencode_failure("OpenCode config field 'plugin' must be a string or list").unwrap()
    )


# @shell_orchestration: builds the temporary OpenCode config consumed by the child process
# @shell_complexity: merging existing config plus dynamic persona agents requires
# validation branches
def build_opencode_config(
    specs: Sequence[PersonaSpec],
    *,
    plugin_uri: str,
    base_config: Mapping[str, object] | None = None,
) -> Result[dict[str, object], CliFailure]:
    config: dict[str, object] = dict(base_config or {})
    config.setdefault("$schema", "https://opencode.ai/config.json")

    plugin_result = _plugin_values(config.get("plugin"))
    if isinstance(plugin_result, Failure):
        return Failure(plugin_result.failure())
    plugins = plugin_result.unwrap()
    if plugin_uri not in plugins:
        plugins.append(plugin_uri)
    config["plugin"] = plugins

    existing_agents = config.get("agent", {})
    if not isinstance(existing_agents, dict):
        return Failure(
            _opencode_failure("OpenCode config field 'agent' must be a JSON object").unwrap()
        )
    agents = dict(cast("dict[str, object]", existing_agents))
    for spec in specs:
        agents[spec["id"]] = _agent_entry(spec).unwrap()
    config["agent"] = agents
    return Success(config)


# @shell_orchestration: derives source-tree plugin candidates from this shell module path
def _source_tree_plugin_candidates(start_path: Path) -> Result[list[Path], object]:
    resolved = start_path.resolve()
    parents = [resolved if resolved.is_dir() else resolved.parent, *resolved.parents]
    return Success([parent / OPENCODE_PLUGIN_RELATIVE_PATH for parent in parents])


# @shell_orchestration: resolves user override or source-tree plugin path for OpenCode
# @shell_complexity: explicit env and source-tree fallback must produce specific diagnostics
def resolve_opencode_plugin_path(
    environ: Mapping[str, str],
    *,
    start_path: Path | None = None,
) -> Result[Path, CliFailure]:
    explicit = environ.get(OPENCODE_PLUGIN_ENV)
    if explicit:
        path = Path(explicit).expanduser()
        if path.is_file():
            return Success(path)
        return Failure(
            _opencode_failure(
                f"{OPENCODE_PLUGIN_ENV} does not point to a file", {"path": str(path)}
            ).unwrap()
        )

    for candidate in _source_tree_plugin_candidates(start_path or Path(__file__)).unwrap():
        if candidate.is_file():
            return Success(candidate)

    return Failure(
        _opencode_failure(
            "could not locate larva OpenCode plugin; set LARVA_OPENCODE_PLUGIN",
            {"relative_path": str(OPENCODE_PLUGIN_RELATIVE_PATH)},
        ).unwrap()
    )


# @shell_orchestration: strips optional separator before forwarding to OpenCode
def _normalize_forwarded_args(args: Sequence[str]) -> Result[list[str], object]:
    forwarded = list(args)
    if forwarded[:1] == ["--"]:
        return Success(forwarded[1:])
    return Success(forwarded)


def build_opencode_environment(
    specs: Sequence[PersonaSpec],
    *,
    plugin_path: Path,
    environ: Mapping[str, str],
) -> Result[dict[str, str], CliFailure]:
    base_result = _load_base_config(environ)
    if isinstance(base_result, Failure):
        return Failure(base_result.failure())
    config_result = build_opencode_config(
        specs,
        plugin_uri=plugin_path.resolve().as_uri(),
        base_config=base_result.unwrap(),
    )
    if isinstance(config_result, Failure):
        return Failure(config_result.failure())
    child_env = dict(environ)
    child_env[OPENCODE_CONFIG_ENV] = json.dumps(config_result.unwrap(), separators=(",", ":"))
    return Success(child_env)


# @shell_complexity: launcher coordinates plugin resolution, facade export, env
# build, and exec errors
def opencode_command(
    opencode_args: Sequence[str],
    *,
    facade: LarvaFacade,
    environ: Mapping[str, str] | None = None,
    execvpe: ExecVpe | None = None,
) -> Result[CliCommandResult, CliFailure]:
    active_environ = os.environ if environ is None else environ
    plugin_result = resolve_opencode_plugin_path(active_environ)
    if isinstance(plugin_result, Failure):
        return Failure(plugin_result.failure())

    export_result = facade.export_all()
    if isinstance(export_result, Failure):
        return Failure(_facade_failure(export_result.failure()).unwrap())

    env_result = build_opencode_environment(
        export_result.unwrap(),
        plugin_path=plugin_result.unwrap(),
        environ=active_environ,
    )
    if isinstance(env_result, Failure):
        return Failure(env_result.failure())

    argv = [OPENCODE_EXECUTABLE, *_normalize_forwarded_args(opencode_args).unwrap()]
    try:
        (execvpe or os.execvpe)(OPENCODE_EXECUTABLE, argv, env_result.unwrap())
    except FileNotFoundError:
        return Failure(_opencode_failure("opencode executable not found in PATH").unwrap())
    except OSError as error:
        return Failure(
            _opencode_failure("opencode execution failed", {"error": str(error)}).unwrap()
        )

    return Success({"exit_code": EXIT_OK})


__all__ = [
    "OPENCODE_CONFIG_ENV",
    "OPENCODE_PLUGIN_ENV",
    "build_opencode_config",
    "build_opencode_environment",
    "opencode_command",
    "resolve_opencode_plugin_path",
]
