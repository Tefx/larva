from __future__ import annotations

import io
import json
from pathlib import Path

from larva.app.facade import DefaultLarvaFacade
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.shell.cli import run_cli
from larva.shell.cli_parser import build_cli_parser
from larva.shell.components import FilesystemComponentStore
from larva.shell.registry import FileSystemRegistryStore


def _spec(persona_id: str, *, description: str = "base") -> dict[str, object]:
    return {
        "id": persona_id,
        "description": description,
        "prompt": f"Prompt for {persona_id}",
        "model": "openai/gpt-5.5",
        "capabilities": {},
        "spec_version": "0.1.0",
    }


def _facade(root: Path) -> DefaultLarvaFacade:
    return DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module,
        validate=validate_module,
        normalize=normalize_module,
        components=FilesystemComponentStore(root / "components"),
        registry=FileSystemRegistryStore(root / "registry"),
    )


def _run(argv: list[str], facade: DefaultLarvaFacade) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = run_cli(argv, facade=facade, stdout=stdout, stderr=stderr)
    return int(code), stdout.getvalue(), stderr.getvalue()


def test_cli_help_cutover_removes_assemble_and_component() -> None:
    parser = build_cli_parser().unwrap()
    help_text = parser.format_help()
    assert "variant" in help_text
    assert "assemble" not in help_text
    assert "component" not in help_text


def test_cli_variant_path_exercises_facade_and_registry(tmp_path: Path) -> None:
    facade = _facade(tmp_path)
    base_path = tmp_path / "base.json"
    tacit_path = tmp_path / "tacit.json"
    base_path.write_text(json.dumps(_spec("cli-persona", description="base")), encoding="utf-8")
    tacit_path.write_text(json.dumps(_spec("cli-persona", description="tacit")), encoding="utf-8")

    assert _run(["register", str(base_path), "--json"], facade)[0] == 0
    assert _run(["register", str(tacit_path), "--variant", "tacit", "--json"], facade)[0] == 0

    code, out, _ = _run(["variant", "list", "cli-persona", "--json"], facade)
    assert code == 0
    listed = json.loads(out)["data"]
    assert listed == {"id": "cli-persona", "active": "default", "variants": ["default", "tacit"]}

    assert _run(["variant", "activate", "cli-persona", "tacit", "--json"], facade)[0] == 0
    code, out, _ = _run(["resolve", "cli-persona", "--json"], facade)
    assert code == 0
    resolved = json.loads(out)["data"]
    assert resolved["description"] == "tacit"
    assert "variant" not in resolved

    assert _run(["update", "cli-persona", "--variant", "tacit", "--set", "model=openai/gpt-5.5-mini", "--json"], facade)[0] == 0
    code, out, _ = _run(["resolve", "cli-persona", "--variant", "tacit", "--json"], facade)
    assert code == 0
    assert json.loads(out)["data"]["model"] == "openai/gpt-5.5-mini"


def test_cli_rejects_variant_inside_spec(tmp_path: Path) -> None:
    facade = _facade(tmp_path)
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({**_spec("bad-cli"), "variant": "tacit"}), encoding="utf-8")
    code, out, _ = _run(["register", str(path), "--json"], facade)
    assert code == 1
    assert json.loads(out)["error"]["code"] == "PERSONA_INVALID"
