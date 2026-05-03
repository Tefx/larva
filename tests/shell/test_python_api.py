from __future__ import annotations

from pathlib import Path

import pytest

from larva.app.facade import DefaultLarvaFacade
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.shell import python_api
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


def test_python_api_exports_cutover() -> None:
    assert {"variant_list", "variant_activate", "variant_delete"} <= set(python_api.__all__)
    assert {"assemble", "component_list", "component_show"}.isdisjoint(python_api.__all__)
    assert not hasattr(python_api, "assemble")
    assert not hasattr(python_api, "component_list")
    assert not hasattr(python_api, "component_show")


def test_python_api_variant_args_pass_through(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    facade = _facade(tmp_path)
    monkeypatch.setattr(python_api, "_get_facade", lambda: facade)

    assert python_api.register(_spec("api-persona")) == {"id": "api-persona", "registered": True}
    assert python_api.register(_spec("api-persona", description="tacit"), variant="tacit") == {
        "id": "api-persona",
        "registered": True,
    }
    assert python_api.variant_list("api-persona") == {
        "id": "api-persona",
        "active": "default",
        "variants": ["default", "tacit"],
    }
    assert python_api.resolve("api-persona", variant="tacit")["description"] == "tacit"
    assert python_api.update("api-persona", {"model": "openai/gpt-5.5-mini"}, variant="tacit")["model"] == "openai/gpt-5.5-mini"
    assert python_api.variant_activate("api-persona", "tacit") == {"id": "api-persona", "active": "tacit"}


def test_python_api_rejects_variant_inside_personaspec(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(python_api, "_get_facade", lambda: _facade(tmp_path))
    with pytest.raises(python_api.LarvaApiError) as exc_info:
        python_api.register({**_spec("bad-api"), "variant": "tacit"})
    assert exc_info.value.error["code"] == "PERSONA_INVALID"
