"""CLI command dispatcher for pi-model-map."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.core.pi_model_map import (
    ModelMapEntry,
    PiModelInventoryItem,
    PiModelMapDraft,
    PiModelMapDraftResult,
    PrefixRule,
    RegistryModelUse,
    draft_model_map,
)
from larva.shell.cli_helpers import (
    EXIT_CRITICAL,
    EXIT_ERROR,
    EXIT_OK,
    CliCommandResult,
    CliFailure,
    _critical_error,
)

if TYPE_CHECKING:
    from larva.app.facade import LarvaFacade

# Error codes for Pi model map drafting as per design/pi-model-map-draft-helper.md
LARVA_PI_MODELS_UNAVAILABLE = "LARVA_PI_MODELS_UNAVAILABLE"
LARVA_PI_MODEL_MAP_INVALID = "LARVA_PI_MODEL_MAP_INVALID"
LARVA_PI_MODEL_MAP_UNRESOLVED = "LARVA_PI_MODEL_MAP_UNRESOLVED"
LARVA_PI_MODEL_MAP_WRITE_FAILED = "LARVA_PI_MODEL_MAP_WRITE_FAILED"
LARVA_PI_MODEL_MAP_BAD_ARGS = "LARVA_PI_MODEL_MAP_BAD_ARGS"


def _failure(code: str, message: str, details: dict[str, object] | None = None) -> Result[CliFailure, object]:
    envelope = _critical_error(message, details or {}).unwrap()
    envelope["code"] = code
    return Success({
        "exit_code": EXIT_ERROR,
        "stderr": f"pi-model-map draft: {code}: {message}\n",
        "error": envelope,
    })


def _default_model_map_path() -> Result[Path, object]:
    return Success(Path.home() / ".pi" / "larva" / "model-map.json")


def _decode_process_text(value: object) -> Result[str, object]:
    if isinstance(value, bytes):
        return Success(value.decode(errors="replace"))
    if isinstance(value, str):
        return Success(value)
    return Success("")


def _pi_bin() -> Result[str | None, object]:
    return Success(shutil.which("pi"))


def _load_registry_usage(facade: LarvaFacade) -> Result[list[RegistryModelUse], CliFailure]:
    listed = facade.list()
    if isinstance(listed, Failure):
        return Failure(_failure("LARVA_REGISTRY_UNAVAILABLE", "failed to list Larva registry").unwrap())
    grouped: dict[str, set[str]] = {}
    for summary in listed.unwrap():
        model = str(summary.get("model", ""))
        persona_id = str(summary.get("id", ""))
        if not model:
            continue
        grouped.setdefault(model, set()).add(persona_id)
    return Success(
        [
            {"model": model, "used_by": sorted(used_by)}
            for model, used_by in sorted(grouped.items())
        ]
    )


# @shell_complexity: ordered subprocess unavailable/failed/parse failure projection
def _load_pi_inventory() -> Result[list[PiModelInventoryItem], CliFailure]:
    pi = _pi_bin().unwrap()
    if pi is None:
        return Failure(_failure(LARVA_PI_MODELS_UNAVAILABLE, "pi executable not found").unwrap())
    try:
        completed = subprocess.run(
            [pi, "--list-models", "--offline"], capture_output=True, check=False
        )
    except OSError as error:
        return Failure(
            _failure(LARVA_PI_MODELS_UNAVAILABLE, "pi model inventory command failed", {"error": str(error)}).unwrap()
        )
    if completed.returncode != 0:
        return Failure(
            _failure(
                LARVA_PI_MODELS_UNAVAILABLE,
                "pi model inventory command failed",
                {"stderr": _decode_process_text(completed.stderr).unwrap()},
            ).unwrap()
        )
    parsed = _parse_successful_pi_inventory(
        _decode_process_text(completed.stdout).unwrap(),
        _decode_process_text(completed.stderr).unwrap(),
    )
    if isinstance(parsed, Failure):
        return Failure(parsed.failure())
    return parsed


# @shell_complexity: Pi success inventory may arrive on stdout or stderr depending on Pi version
def _parse_successful_pi_inventory(
    stdout: str,
    stderr: str,
) -> Result[list[PiModelInventoryItem], CliFailure]:
    stdout_text = stdout.strip()
    stderr_text = stderr.strip()
    if stdout_text and stderr_text:
        return _parse_pi_inventory(f"{stdout_text}\n{stderr_text}")
    if stdout_text:
        return _parse_pi_inventory(stdout_text)
    return _parse_pi_inventory(stderr_text)


# @shell_complexity: parser validates header, rows, and fail-closed malformed lines
def _parse_pi_inventory(text: str) -> Result[list[PiModelInventoryItem], CliFailure]:
    rows: set[tuple[str, str]] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            return Failure(
                _failure(LARVA_PI_MODELS_UNAVAILABLE, "pi model inventory output is not parseable").unwrap()
            )
        if parts[0].lower() == "provider" and parts[1].lower() in {"model_id", "model"}:
            continue
        rows.add((parts[0], parts[1]))
    if not rows:
        return Failure(
            _failure(LARVA_PI_MODELS_UNAVAILABLE, "pi model inventory output is not parseable").unwrap()
        )
    return Success([{"provider": provider, "model_id": model_id} for provider, model_id in sorted(rows)])


# @shell_complexity: fail-closed JSON/schema validation stays at filesystem boundary
def _load_existing_map(path: Path) -> Result[PiModelMapDraft, CliFailure]:
    if not path.exists():
        return Success({"models": {}, "prefix_rules": []})
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return Failure(
            _failure(LARVA_PI_MODEL_MAP_INVALID, "existing model-map is invalid", {"error": str(error)}).unwrap()
        )
    if not isinstance(loaded, dict) or set(loaded) - {"models", "prefix_rules"}:
        return Failure(_failure(LARVA_PI_MODEL_MAP_INVALID, "existing model-map has invalid shape").unwrap())
    models_obj = loaded.get("models", {})
    rules_obj = loaded.get("prefix_rules", [])
    if not isinstance(models_obj, dict) or not isinstance(rules_obj, list):
        return Failure(_failure(LARVA_PI_MODEL_MAP_INVALID, "existing model-map has invalid shape").unwrap())
    models: dict[str, ModelMapEntry] = {}
    for source, target in models_obj.items():
        if not isinstance(source, str) or not _is_model_entry(target).unwrap():
            return Failure(_failure(LARVA_PI_MODEL_MAP_INVALID, "existing model-map has invalid model entry").unwrap())
        models[source] = {"provider": target["provider"], "model_id": target["model_id"]}
    rules: list[PrefixRule] = []
    for rule in rules_obj:
        if not _is_prefix_rule(rule).unwrap():
            return Failure(_failure(LARVA_PI_MODEL_MAP_INVALID, "existing model-map has invalid prefix rule").unwrap())
        rules.append(
            {
                "from_prefix": rule["from_prefix"],
                "to_provider": rule["to_provider"],
                "to_model_id_prefix": rule["to_model_id_prefix"],
            }
        )
    return Success({"models": models, "prefix_rules": rules})


def _is_model_entry(value: object) -> Result[bool, object]:
    return Success(
        isinstance(value, dict)
        and set(value) == {"provider", "model_id"}
        and isinstance(value["provider"], str)
        and isinstance(value["model_id"], str)
        and value["provider"] != ""
        and value["model_id"] != ""
    )


def _is_prefix_rule(value: object) -> Result[bool, object]:
    return Success(
        isinstance(value, dict)
        and set(value) == {"from_prefix", "to_provider", "to_model_id_prefix"}
        and isinstance(value["from_prefix"], str)
        and isinstance(value["to_provider"], str)
        and isinstance(value["to_model_id_prefix"], str)
        and value["from_prefix"] != ""
        and value["to_provider"] != ""
    )


def _render_draft(draft: PiModelMapDraft) -> Result[str, object]:
    return Success(json.dumps(draft, indent=2, sort_keys=True, ensure_ascii=True) + "\n")


# @shell_complexity: report intentionally lists each finding family separately
def _render_report(result: PiModelMapDraftResult) -> Result[str, object]:
    lines = ["pi-model-map draft report:"]
    for source in result["stale_models"]:
        lines.append(f"stale exact mapping removed: {source}")
    for source in result["invalid_existing_models"]:
        lines.append(f"invalid target for exact mapping: {source}")
    for finding in result["stale_prefix_rules"]:
        lines.append(f"stale prefix rule removed: {finding['rule']['from_prefix']}")
    for finding in result["invalid_prefix_rules"]:
        lines.append(f"invalid prefix target: {finding['rule']['from_prefix']}")
    for finding in result["conflicting_prefix_rules"]:
        lines.append(f"conflicting prefix rule: {finding['rule']['from_prefix']}")
    for item in result["unresolved"]:
        lines.append(f"unresolved model: {item['source_model']} ({item['reason']})")
    return Success("\n".join(lines) + "\n")


# @shell_complexity: prompt supports candidate, manual, and skip branches per design
def _handle_interactive(
    result: PiModelMapDraftResult,
    inventory: list[PiModelInventoryItem],
) -> Result[PiModelMapDraftResult, object]:
    remaining = []
    for unresolved in result["unresolved"]:
        sys.stderr.write(f"Registry model: {unresolved['source_model']}\n")
        sys.stderr.write(f"Used by: {', '.join(unresolved['used_by'])}\n")
        candidates = unresolved["candidates"]
        if candidates:
            for index, candidate in enumerate(candidates, start=1):
                sys.stderr.write(f"  {index}. {candidate['provider']} / {candidate['model_id']}\n")
        sys.stderr.write("Choose target number, 'manual', or 'skip': ")
        choice = sys.stdin.readline().strip()
        if choice.lower() in {"skip", ""}:
            continue
        selected: ModelMapEntry | None = None
        if choice.isdigit() and 1 <= int(choice) <= len(candidates):
            selected = candidates[int(choice) - 1]
        elif choice.lower() == "manual":
            sys.stderr.write("Provider: ")
            provider = sys.stdin.readline().strip()
            sys.stderr.write("Model id: ")
            model_id = sys.stdin.readline().strip()
            if any(item["provider"] == provider and item["model_id"] == model_id for item in inventory):
                selected = {"provider": provider, "model_id": model_id}
        if selected is None:
            remaining.append(unresolved)
            continue
        result["draft"]["models"][unresolved["source_model"]] = selected
        result["draft"]["models"] = dict(sorted(result["draft"]["models"].items()))
        if unresolved["source_model"] not in result["covered_models"]:
            result["covered_models"].append(unresolved["source_model"])
            result["covered_models"].sort()
    result["unresolved"] = remaining
    return Success(result)


def _write_draft(path: Path, draft: PiModelMapDraft) -> Result[None, CliFailure]:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_render_draft(draft).unwrap(), encoding="utf-8")
    except OSError as error:
        return Failure(
            _failure(LARVA_PI_MODEL_MAP_WRITE_FAILED, "failed to write model-map draft", {"error": str(error)}).unwrap()
        )
    return Success(None)


# @shell_complexity: command coordinates facade, Pi subprocess, files, prompting, and rendering
def _draft_command(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Draft the Pi model-map from Larva registry usage and Pi inventory."""
    if getattr(args, "pi_model_map_command", None) != "draft":
        return Failure(_failure(LARVA_PI_MODEL_MAP_BAD_ARGS, "unsupported pi-model-map subcommand").unwrap())

    output_path = Path(cast("str | None", getattr(args, "output", None)) or _default_model_map_path().unwrap()).expanduser()
    model_map_arg = cast("str | None", getattr(args, "model_map", None))
    model_map_path = Path(model_map_arg).expanduser() if model_map_arg else output_path

    registry = _load_registry_usage(facade)
    if isinstance(registry, Failure):
        return Failure(registry.failure())
    inventory = _load_pi_inventory()
    if isinstance(inventory, Failure):
        return Failure(inventory.failure())
    existing = _load_existing_map(model_map_path)
    if isinstance(existing, Failure):
        return Failure(existing.failure())

    planned = draft_model_map(registry.unwrap(), inventory.unwrap(), existing.unwrap()).unwrap()
    planned["output_path"] = str(output_path)

    non_interactive = cast("bool", getattr(args, "non_interactive", False))
    if planned["unresolved"] and not non_interactive:
        planned = _handle_interactive(planned, inventory.unwrap()).unwrap()

    has_blockers = bool(
        planned["unresolved"]
        or planned["invalid_prefix_rules"]
        or planned["conflicting_prefix_rules"]
    )
    if has_blockers:
        details: dict[str, object] = {"result": planned}
        return Failure(
            _failure(
                LARVA_PI_MODEL_MAP_UNRESOLVED,
                "model-map draft has unresolved or invalid mappings",
                details,
            ).unwrap()
            | {"stderr": _render_report(planned).unwrap() + f"{LARVA_PI_MODEL_MAP_UNRESOLVED}\n"}
        )

    if cast("bool", getattr(args, "write", False)):
        written = _write_draft(output_path, planned["draft"])
        if isinstance(written, Failure):
            return Failure(written.failure())
        planned["wrote_file"] = True
        stdout = "" if not as_json else ""
    else:
        stdout = _render_draft(planned["draft"]).unwrap()

    return Success(
        {
            "exit_code": EXIT_OK,
            "stdout": stdout,
            "stderr": _render_report(planned).unwrap(),
            "json": {"data": planned},
        }
    )

def pi_model_map_command(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Dispatch pi-model-map subcommands."""
    subcommand = getattr(args, "pi_model_map_command", None)
    if subcommand == "draft":
        return _draft_command(args, as_json=as_json, facade=facade)
        
    return Failure(
        {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"Unsupported pi-model-map command: {subcommand}\n",
            "error": _critical_error("unsupported command", {"command": str(subcommand)}).unwrap(),
        }
    )
