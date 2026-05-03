"""Thin Python API exports for larva."""

from __future__ import annotations

from functools import partial
from typing import TYPE_CHECKING, Any, cast

from returns.result import Failure, Result

from larva.app.facade_types import (
    ActivatedVariant,
    BatchUpdateResult,
    ClearedRegistry,
    DeletedPersona,
    DeletedVariant,
    LarvaError,
    LarvaFacade,
    PersonaSummary,
    RegisteredPersona,
    VariantMetadata,
)
from larva.core.spec import PersonaSpec
from larva.core.validation_contract import ValidationReport
from larva.shell.shared import facade_factory

if TYPE_CHECKING:
    import builtins
    from collections.abc import Callable


class LarvaApiError(Exception):
    """Exception raised when facade operations fail."""

    def __init__(self, error: LarvaError) -> None:
        self.error = error
        super().__init__(error["message"])


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
# @shell_complexity: single dispatch function keeps operation-to-facade mapping and shared
# Failure-to-exception translation in one shell boundary.
def _invoke(op: str, *args: object, **kwargs: object) -> object:
    facade = _get_facade()
    if op == "validate":
        return facade.validate(cast("PersonaSpec", args[0]))
    if op == "register":
        result = cast(
            "Result[object, LarvaError]",
            facade.register(
                cast("PersonaSpec", args[0]),
                variant=cast("str | None", kwargs.get("variant")),
            ),
        )
    elif op == "resolve":
        result = cast(
            "Result[object, LarvaError]",
            facade.resolve(
                cast("str", args[0]),
                cast("dict[str, Any] | None", kwargs.get("overrides")),
                variant=cast("str | None", kwargs.get("variant")),
            ),
        )
    elif op == "update":
        result = cast(
            "Result[object, LarvaError]",
            facade.update(
                cast("str", args[0]),
                cast("dict[str, Any]", kwargs["patches"]),
                variant=cast("str | None", kwargs.get("variant")),
            ),
        )
    elif op == "variant_list":
        result = cast("Result[object, LarvaError]", facade.variant_list(cast("str", args[0])))
    elif op == "variant_activate":
        result = cast(
            "Result[object, LarvaError]",
            facade.variant_activate(cast("str", args[0]), cast("str", args[1])),
        )
    elif op == "variant_delete":
        result = cast(
            "Result[object, LarvaError]",
            facade.variant_delete(cast("str", args[0]), cast("str", args[1])),
        )
    elif op == "update_batch":
        result = cast(
            "Result[object, LarvaError]",
            facade.update_batch(
                cast("dict[str, Any]", kwargs["where"]),
                cast("dict[str, Any]", kwargs["patches"]),
                cast("bool", kwargs.get("dry_run", False)),
            ),
        )
    elif op == "list":
        result = cast("Result[object, LarvaError]", facade.list())
    elif op == "delete":
        result = cast("Result[object, LarvaError]", facade.delete(cast("str", args[0])))
    elif op == "clear":
        if args:
            raise TypeError("clear() takes 0 positional arguments but 1 was given")
        if "confirm" not in kwargs:
            raise TypeError("clear() missing required keyword-only argument: 'confirm'")
        result = cast(
            "Result[object, LarvaError]", facade.clear(confirm=cast("str", kwargs["confirm"]))
        )
    elif op == "clone":
        result = cast(
            "Result[object, LarvaError]", facade.clone(cast("str", args[0]), cast("str", args[1]))
        )
    elif op == "export_all":
        result = cast("Result[object, LarvaError]", facade.export_all())
    elif op == "export_ids":
        result = cast(
            "Result[object, LarvaError]", facade.export_ids(cast("builtins.list[str]", args[0]))
        )
    else:
        raise LarvaApiError(
            {
                "code": "UNKNOWN_OPERATION",
                "numeric_code": 999,
                "message": f"Unknown python_api operation: {op}",
                "details": {},
            }
        )

    if isinstance(result, Failure):
        raise LarvaApiError(result.failure())

    unwrapped = result.unwrap()
    if op == "clear":
        return cast("ClearedRegistry", unwrapped)["count"]
    return unwrapped


validate = cast("Callable[[PersonaSpec], ValidationReport]", partial(_invoke, "validate"))

register = cast(
    "Callable[..., RegisteredPersona]",
    lambda spec, variant=None: _invoke("register", spec, variant=variant),
)

resolve = cast(
    "Callable[..., PersonaSpec]",
    lambda id, overrides=None, variant=None: _invoke("resolve", id, overrides=overrides, variant=variant),  # noqa: A006,E501
)
update = cast(
    "Callable[..., PersonaSpec]",
    lambda persona_id, patches, variant=None: _invoke(
        "update",
        persona_id,
        patches=patches,
        variant=variant,
    ),
)
variant_list = cast("Callable[[str], VariantMetadata]", partial(_invoke, "variant_list"))
variant_activate = cast(
    "Callable[[str, str], ActivatedVariant]", partial(_invoke, "variant_activate")
)
variant_delete = cast("Callable[[str, str], DeletedVariant]", partial(_invoke, "variant_delete"))
update_batch = cast(
    "Callable[[dict[str, Any], dict[str, Any], bool], BatchUpdateResult]",
    lambda where, patches, dry_run=False: _invoke(
        "update_batch",
        where=where,
        patches=patches,
        dry_run=dry_run,
    ),
)
list = cast("Callable[[], builtins.list[PersonaSummary]]", partial(_invoke, "list"))  # noqa: A001
delete = cast("Callable[[str], DeletedPersona]", partial(_invoke, "delete"))
clear = cast("Callable[..., int]", partial(_invoke, "clear"))


clone = cast("Callable[[str, str], PersonaSpec]", partial(_invoke, "clone"))
export_all = cast("Callable[[], builtins.list[PersonaSpec]]", partial(_invoke, "export_all"))
export_ids = cast(
    "Callable[[builtins.list[str]], builtins.list[PersonaSpec]]", partial(_invoke, "export_ids")
)
__all__ = [
    "validate",
    "register",
    "resolve",
    "update",
    "variant_list",
    "variant_activate",
    "variant_delete",
    "update_batch",
    "list",
    "delete",
    "clear",
    "clone",
    "export_all",
    "export_ids",
    "PersonaSpec",
    "ValidationReport",
    "RegisteredPersona",
    "PersonaSummary",
    "VariantMetadata",
    "ActivatedVariant",
    "DeletedVariant",
    "LarvaError",
    "DeletedPersona",
    "ClearedRegistry",
    "BatchUpdateResult",
    "LarvaApiError",
]
