"""Thin Python API exports for larva."""

from __future__ import annotations

from functools import partial
from typing import Any, Callable, cast

from returns.result import Failure, Result

from larva.app.facade import (
    AssembleRequest,
    BatchUpdateResult,
    ClearedRegistry,
    DeletedPersona,
    LarvaError,
    LarvaFacade,
    PersonaSummary,
    RegisteredPersona,
)
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell import python_api_components
from larva.shell.python_api_components import LarvaApiError
from larva.shell.shared import facade_factory


class _FacadeAccessor:
    def __init__(self, facade: LarvaFacade, factory: Callable[[], LarvaFacade]) -> None:
        self._facade = facade
        self._factory = factory

    def __call__(self) -> LarvaFacade:
        current_factory = facade_factory.build_default_facade
        if current_factory is not self._factory:
            self._facade = current_factory()
            self._factory = current_factory
        return self._facade


_get_facade = _FacadeAccessor(
    facade_factory.build_default_facade(),
    facade_factory.build_default_facade,
)


# @invar:allow shell_result: shared Python API dispatch unwraps facade Results to exceptions
# @shell_orchestration: preserves Python API behavior while centralizing non-Result surface
# @shell_complexity: single dispatch function keeps operation-to-facade mapping and shared Failure-to-exception translation in one shell boundary.
def _invoke(op: str, *args: object, **kwargs: object) -> object:
    facade = _get_facade()
    if op == "validate":
        return facade.validate(cast("PersonaSpec", args[0]))
    if op == "assemble":
        request_dict: dict[str, object] = {"id": cast("str", kwargs["id"])}
        optional_fields: tuple[tuple[str, object | None], ...] = (
            ("description", cast("str | None", kwargs.get("description"))),
            ("prompts", cast("list[str] | None", kwargs.get("prompts"))),
            ("toolsets", cast("list[str] | None", kwargs.get("toolsets"))),
            ("constraints", cast("list[str] | None", kwargs.get("constraints"))),
            ("model", cast("str | None", kwargs.get("model"))),
            ("overrides", cast("dict[str, Any] | None", kwargs.get("overrides"))),
            ("variables", cast("dict[str, str] | None", kwargs.get("variables"))),
        )
        for key, value in optional_fields:
            if value is not None:
                request_dict[key] = value
        request = cast("AssembleRequest", request_dict)
        result = facade.assemble(request)
    elif op == "register":
        result = facade.register(cast("PersonaSpec", args[0]))
    elif op == "resolve":
        result = facade.resolve(
            cast("str", args[0]), cast("dict[str, Any] | None", kwargs.get("overrides"))
        )
    elif op == "update":
        result = facade.update(cast("str", args[0]), cast("dict[str, Any]", kwargs["patches"]))
    elif op == "update_batch":
        result = facade.update_batch(
            cast("dict[str, Any]", kwargs["where"]),
            cast("dict[str, Any]", kwargs["patches"]),
            cast("bool", kwargs.get("dry_run", False)),
        )
    elif op == "list":
        result = facade.list()
    elif op == "delete":
        result = facade.delete(cast("str", args[0]))
    elif op == "clear":
        if args:
            raise TypeError("clear() takes 0 positional arguments but 1 was given")
        if "confirm" not in kwargs:
            raise TypeError("clear() missing required keyword-only argument: 'confirm'")
        result = facade.clear(confirm=cast("str", kwargs["confirm"]))
    elif op == "clone":
        result = facade.clone(cast("str", args[0]), cast("str", args[1]))
    elif op == "export_all":
        result = facade.export_all()
    elif op == "export_ids":
        result = facade.export_ids(cast("list[str]", args[0]))
    elif op == "component_list":
        result = python_api_components._component_list_result()
    elif op == "component_show":
        result = python_api_components._component_show_result(
            cast("str", args[0]), cast("str", args[1])
        )
    else:
        raise LarvaApiError(
            {
                "code": "UNKNOWN_OPERATION",
                "numeric_code": 999,
                "message": f"Unknown python_api operation: {op}",
            }
        )

    if isinstance(result, Failure):
        raise LarvaApiError(result.failure())

    unwrapped = cast("Result[object, LarvaError]", result).unwrap()
    if op == "clear":
        return cast("ClearedRegistry", unwrapped)["count"]
    return unwrapped


validate = cast("Callable[[PersonaSpec], ValidationReport]", partial(_invoke, "validate"))
assemble = cast(
    "Callable[[str, str | None, list[str] | None, list[str] | None, list[str] | None, str | None, dict[str, Any] | None, dict[str, str] | None], PersonaSpec]",
    lambda id, description=None, prompts=None, toolsets=None, constraints=None, model=None, overrides=None, variables=None: (
        _invoke(
            "assemble",
            id=id,
            description=description,
            prompts=prompts,
            toolsets=toolsets,
            constraints=constraints,
            model=model,
            overrides=overrides,
            variables=variables,
        )
    ),
)
register = cast("Callable[[PersonaSpec], RegisteredPersona]", partial(_invoke, "register"))
resolve = cast(
    "Callable[[str, dict[str, Any] | None], PersonaSpec]",
    lambda id, overrides=None: _invoke("resolve", id, overrides=overrides),
)
update = cast(
    "Callable[[str, dict[str, Any]], PersonaSpec]",
    lambda persona_id, patches: _invoke("update", persona_id, patches=patches),
)
update_batch = cast(
    "Callable[[dict[str, Any], dict[str, Any], bool], BatchUpdateResult]",
    lambda where, patches, dry_run=False: _invoke(
        "update_batch",
        where=where,
        patches=patches,
        dry_run=dry_run,
    ),
)
list = cast("Callable[[], list[PersonaSummary]]", partial(_invoke, "list"))
delete = cast("Callable[[str], DeletedPersona]", partial(_invoke, "delete"))
clear = cast("Callable[..., int]", partial(_invoke, "clear"))


clone = cast("Callable[[str, str], PersonaSpec]", partial(_invoke, "clone"))
export_all = cast("Callable[[], list[PersonaSpec]]", partial(_invoke, "export_all"))
export_ids = cast("Callable[[list[str]], list[PersonaSpec]]", partial(_invoke, "export_ids"))
component_list = cast("Callable[[], dict[str, list[str]]]", partial(_invoke, "component_list"))
component_show = cast(
    "Callable[[str, str], dict[str, object]]",
    partial(_invoke, "component_show"),
)


__all__ = [
    "validate",
    "assemble",
    "register",
    "resolve",
    "update",
    "update_batch",
    "list",
    "component_list",
    "component_show",
    "delete",
    "clear",
    "clone",
    "export_all",
    "export_ids",
    "PersonaSpec",
    "ValidationReport",
    "AssembleRequest",
    "RegisteredPersona",
    "PersonaSummary",
    "LarvaError",
    "DeletedPersona",
    "ClearedRegistry",
    "BatchUpdateResult",
    "LarvaApiError",
]
