"""Packaged FastAPI route registration for the larva web REST surface.

This module owns the endpoint wiring used by :mod:`larva.shell.web` while the
public ``larva serve`` entrypoint remains in ``web.py``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeAlias, TypeVar, cast

from fastapi import Request  # noqa: TC002 # FastAPI inspects Request annotations at runtime.
from fastapi.responses import FileResponse, JSONResponse
from returns.result import Failure, Result, Success

from larva.core.patch import PatchError, apply_patches
from larva.shell.python_api import LarvaApiError
from larva.shell.shared.request_validation import (
    reject_unknown_params,
    require_list_of_strings,
    require_param,
    require_params_object,
    require_type,
)

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from pathlib import Path

    from fastapi import FastAPI

    from larva.core.spec import PersonaSpec
    from larva.core.validation_contract import ValidationReport


T = TypeVar("T")
WebResult: TypeAlias = Result[T, JSONResponse]


def _web_api() -> WebResult[Any]:
    """Return the web module exposing monkeypatchable REST facade call sites."""
    from larva.shell import web

    return Success(web)


def _api_error_response(e: LarvaApiError) -> WebResult[JSONResponse]:
    """Project LarvaApiError to HTTP 400 with error envelope."""
    return Success(JSONResponse(status_code=400, content={"error": e.error}))


def _component_api_error_response(e: LarvaApiError) -> WebResult[JSONResponse]:
    """Project component LarvaApiError to transport-specific HTTP statuses."""
    code = e.error.get("code")
    if code == "INVALID_INPUT":
        status_code = 400
    elif code == "COMPONENT_NOT_FOUND":
        status_code = 404
    elif code == "INTERNAL":
        status_code = 503
    else:
        status_code = 400
    return Success(JSONResponse(status_code=status_code, content={"error": e.error}))


# @shell_orchestration: HTTP error-envelope projection is transport boundary glue.
def _validation_error_response(report: ValidationReport) -> WebResult[JSONResponse]:
    """Project validation failure to HTTP 400 with PERSONA_INVALID envelope."""
    return Success(
        JSONResponse(
            status_code=400,
            content={"error": {"code": "PERSONA_INVALID", "errors": report["errors"]}},
        )
    )


def _invalid_input_response(message: str, details: dict[str, object]) -> WebResult[JSONResponse]:
    """Project malformed request input to a structured HTTP 400 envelope."""
    return Success(
        JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "INVALID_INPUT",
                    "numeric_code": 1,
                    "message": message,
                    "details": details,
                }
            },
        )
    )


async def _read_request_object(request: Request) -> WebResult[dict[str, Any]]:
    """Read request JSON and require a top-level object payload."""
    try:
        payload = await request.json()
    except ValueError:
        return Failure(
            _invalid_input_response(
                "request body must be valid JSON object",
                {"field": "params", "received_type": "invalid_json"},
            ).unwrap()
        )

    params_result = require_params_object(payload)
    if isinstance(params_result, Failure):
        issue = params_result.failure()
        return Failure(_invalid_input_response(issue.reason, issue.details).unwrap())
    return Success(params_result.unwrap())


def _validation_issue_response(result: Failure[Any]) -> WebResult[JSONResponse]:
    """Project a shared request-validation failure to the web error envelope."""
    issue = result.failure()
    return _invalid_input_response(issue.reason, issue.details)


def _patch_error_response(error: PatchError) -> WebResult[JSONResponse]:
    """Project patch validation failures before any batch mutation is attempted."""
    return Success(
        JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": error.code,
                    "numeric_code": 114,
                    "message": error.message,
                    "details": error.details,
                }
            },
        )
    )


# @shell_complexity: Selector validation stays at REST boundary to preserve exact HTTP errors.
def _validate_export_request(body: dict[str, Any]) -> WebResult[tuple[bool, list[str]]]:
    """Validate the web export selector using the packaged REST fail-closed contract."""
    unknown_result = reject_unknown_params(body, {"all", "ids"})
    if isinstance(unknown_result, Failure):
        return Failure(_validation_issue_response(unknown_result).unwrap())

    if "all" in body:
        all_result = require_type(body, "all", bool, "boolean")
        if isinstance(all_result, Failure):
            return Failure(_validation_issue_response(all_result).unwrap())
    ids_result = require_list_of_strings(body, "ids")
    if isinstance(ids_result, Failure):
        return Failure(_validation_issue_response(ids_result).unwrap())

    has_all = "all" in body
    has_ids = "ids" in body
    if has_all and has_ids:
        return Failure(
            _invalid_input_response(
                "cannot specify both 'all' and 'ids'",
                {"field": "params", "conflict": ["all", "ids"]},
            ).unwrap()
        )
    if not has_all and not has_ids:
        return Failure(
            _invalid_input_response(
                "must specify either 'all' or 'ids'",
                {"field": "params", "missing": ["all", "ids"]},
            ).unwrap()
        )
    if has_all:
        if body["all"] is False:
            return Failure(
                _invalid_input_response(
                    "must specify either 'all' or 'ids'",
                    {"field": "all", "missing": ["ids"]},
                ).unwrap()
            )
        return Success((True, []))
    return Success((False, cast("list[str]", body["ids"])))


# @shell_complexity: Batch update validation stays at REST boundary for fail-closed errors.
def _validate_update_batch_request(
    body: dict[str, Any],
) -> WebResult[tuple[dict[str, Any], dict[str, Any], bool]]:
    """Validate packaged REST update_batch request shape before facade delegation."""
    unknown_result = reject_unknown_params(body, {"where", "patches", "dry_run"})
    if isinstance(unknown_result, Failure):
        return Failure(_validation_issue_response(unknown_result).unwrap())

    for key in ("where", "patches"):
        required_result = require_param(body, key)
        if isinstance(required_result, Failure):
            return Failure(_validation_issue_response(required_result).unwrap())
        typed_result = require_type(body, key, dict, "object")
        if isinstance(typed_result, Failure):
            return Failure(_validation_issue_response(typed_result).unwrap())

    if "dry_run" in body:
        dry_run_result = require_type(body, "dry_run", bool, "boolean")
        if isinstance(dry_run_result, Failure):
            return Failure(_validation_issue_response(dry_run_result).unwrap())

    try:
        apply_patches({}, cast("dict[str, object]", body["patches"]))
    except PatchError as error:
        return Failure(_patch_error_response(error).unwrap())

    return Success((body["where"], body["patches"], body.get("dry_run", False)))


async def _api_list_personas() -> WebResult[dict[str, Any]]:
    """Return all registered personas through the packaged REST envelope."""
    try:
        return Success({"data": _web_api().unwrap().list_personas()})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


async def _api_get_persona(persona_id: str) -> WebResult[dict[str, Any]]:
    """Resolve one persona by id through the packaged REST envelope."""
    try:
        return Success({"data": _web_api().unwrap().resolve(persona_id, None)})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


# @shell_complexity: Registration endpoint orchestrates request validation and facade calls.
async def _api_register_persona(request: Request) -> WebResult[dict[str, Any]]:
    """Validate and register a persona from the packaged REST request body."""
    body = await _read_request_object(request)
    if isinstance(body, Failure):
        return Failure(body.failure())
    request_body = body.unwrap()
    spec = request_body.get("spec", request_body)
    if "spec" in request_body:
        spec_result = require_type(request_body, "spec", dict, "object")
        if isinstance(spec_result, Failure):
            issue = spec_result.failure()
            return Failure(_invalid_input_response(issue.reason, issue.details).unwrap())
    try:
        api = _web_api().unwrap()
        report = api.validate(cast("PersonaSpec", spec))
        if not report["valid"]:
            return Failure(_validation_error_response(report).unwrap())
        result = api.register(spec)
        return Success({"data": result})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


# @shell_complexity: Export endpoint branches on the documented all-vs-ids selector.
async def _api_export_personas(request: Request) -> WebResult[dict[str, Any]]:
    """Export all or selected personas through the packaged REST surface."""
    body = await _read_request_object(request)
    if isinstance(body, Failure):
        return Failure(body.failure())
    target = _validate_export_request(body.unwrap())
    if isinstance(target, Failure):
        return Failure(target.failure())
    use_all, ids = target.unwrap()
    try:
        api = _web_api().unwrap()
        result = api.export_all() if use_all else api.export_ids(ids)
        return Success({"data": result})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


async def _api_update_batch_personas(request: Request) -> WebResult[dict[str, Any]]:
    """Batch update personas after fail-closed packaged REST validation."""
    body = await _read_request_object(request)
    if isinstance(body, Failure):
        return Failure(body.failure())
    update_request = _validate_update_batch_request(body.unwrap())
    if isinstance(update_request, Failure):
        return Failure(update_request.failure())
    where, patches, dry_run = update_request.unwrap()
    try:
        return Success({"data": _web_api().unwrap().update_batch(where, patches, dry_run)})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


async def _api_update_persona(persona_id: str, request: Request) -> WebResult[dict[str, Any]]:
    """Patch one persona by id through the packaged REST envelope."""
    patches = await _read_request_object(request)
    if isinstance(patches, Failure):
        return Failure(patches.failure())
    try:
        return Success({"data": _web_api().unwrap().update(persona_id, patches.unwrap())})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


async def _api_delete_persona(persona_id: str) -> WebResult[dict[str, Any]]:
    """Delete one persona by id through the packaged REST envelope."""
    try:
        result = _web_api().unwrap().delete(persona_id)
        return Success({"data": result})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


async def _api_clear_personas(request: Request) -> WebResult[dict[str, Any]]:
    """Clear the registry after packaged REST confirmation validation."""
    body = await _read_request_object(request)
    if isinstance(body, Failure):
        return Failure(body.failure())
    confirm = body.unwrap().get("confirm", "")
    try:
        count = _web_api().unwrap().clear(confirm=confirm)
        return Success({"data": {"cleared": True, "count": count}})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


async def _api_validate_persona(request: Request) -> WebResult[dict[str, Any]]:
    """Validate a candidate PersonaSpec through the packaged REST envelope."""
    spec = await _read_request_object(request)
    if isinstance(spec, Failure):
        return Failure(spec.failure())
    try:
        report = _web_api().unwrap().validate(cast("PersonaSpec", spec.unwrap()))
        return Success({"data": report})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


def _assemble_unknown_field_response(unknown_fields: list[str]) -> WebResult[JSONResponse]:
    """Build the canonical-boundary unknown-field response for assemble."""
    return Success(
        JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "INVALID_INPUT",
                    "numeric_code": 1,
                    "message": (
                        f"assemble request field '{unknown_fields[0]}' is not permitted "
                        "at canonical boundary"
                    ),
                    "details": {"field": unknown_fields[0], "unknown_fields": unknown_fields},
                }
            },
        )
    )


def _assemble_missing_id_response() -> WebResult[JSONResponse]:
    """Build the canonical-boundary missing-id response for assemble."""
    return Success(
        JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "INVALID_INPUT",
                    "numeric_code": 1,
                    "message": "assemble request missing required field 'id'",
                    "details": {"field": "id", "reason": "missing_required_field"},
                }
            },
        )
    )


# @shell_complexity: Assemble endpoint enforces canonical boundary before delegation.
async def _api_assemble_persona(request: Request) -> WebResult[dict[str, Any]]:
    """Assemble a persona from canonical packaged REST component selectors."""
    body = await _read_request_object(request)
    if isinstance(body, Failure):
        return Failure(body.failure())
    request_body = body.unwrap()
    allowed_fields = frozenset(
        {"id", "description", "prompts", "toolsets", "constraints", "model", "overrides"}
    )
    unknown_fields = sorted(set(request_body.keys()) - allowed_fields)
    if unknown_fields:
        return Failure(_assemble_unknown_field_response(unknown_fields).unwrap())
    if "id" not in request_body:
        return Failure(_assemble_missing_id_response().unwrap())
    try:
        spec = (
            _web_api()
            .unwrap()
            .assemble(
                cast("str", request_body["id"]),
                request_body.get("description"),
                request_body.get("prompts"),
                request_body.get("toolsets"),
                request_body.get("constraints"),
                request_body.get("model"),
                request_body.get("overrides"),
            )
        )
        return Success({"data": spec})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())


async def _api_list_components() -> WebResult[dict[str, Any]]:
    """Return all component names through the packaged REST envelope."""
    try:
        return Success({"data": _web_api().unwrap().component_list()})
    except LarvaApiError as e:
        return Failure(_component_api_error_response(e).unwrap())


async def _api_get_component(component_type: str, name: str) -> WebResult[dict[str, Any]]:
    """Return one component through the packaged REST envelope."""
    try:
        return Success({"data": _web_api().unwrap().component_show(component_type, name)})
    except LarvaApiError as e:
        return Failure(_component_api_error_response(e).unwrap())


async def _api_components_projection() -> WebResult[dict[str, Any]]:
    """Return web-facing component projection metadata."""
    from larva.shell.web import get_component_projections

    return Success({"data": get_component_projections()})


def _make_serve_index(
    static_dir: Path, index_file: str
) -> WebResult[Callable[[], Awaitable[FileResponse]]]:
    """Create the route handler that serves the packaged HTML UI artifact."""

    async def _serve_index() -> FileResponse:
        return FileResponse(static_dir / index_file, media_type="text/html")

    return Success(_serve_index)


# @shell_orchestration: FastAPI route registration mutates the app routing table.
def _register_persona_routes(app: FastAPI) -> WebResult[None]:
    """Register packaged PersonaSpec REST routes on ``app``.

    Args:
        app: FastAPI application receiving the persona REST routes.
    """

    def _send(result: WebResult[Any]) -> Any:
        if isinstance(result, Failure):
            return result.failure()
        return result.unwrap()

    async def list_personas() -> Any:
        return _send(await _api_list_personas())

    async def get_persona(persona_id: str) -> Any:
        return _send(await _api_get_persona(persona_id))

    async def register_persona(request: Request) -> Any:
        return _send(await _api_register_persona(request))

    async def export_personas(request: Request) -> Any:
        return _send(await _api_export_personas(request))

    async def update_batch_personas(request: Request) -> Any:
        return _send(await _api_update_batch_personas(request))

    async def update_persona(persona_id: str, request: Request) -> Any:
        return _send(await _api_update_persona(persona_id, request))

    async def delete_persona(persona_id: str) -> Any:
        return _send(await _api_delete_persona(persona_id))

    async def clear_personas(request: Request) -> Any:
        return _send(await _api_clear_personas(request))

    async def validate_persona(request: Request) -> Any:
        return _send(await _api_validate_persona(request))

    async def assemble_persona(request: Request) -> Any:
        return _send(await _api_assemble_persona(request))

    app.add_api_route("/api/personas", list_personas, methods=["GET"])
    app.add_api_route("/api/personas/{persona_id}", get_persona, methods=["GET"])
    app.add_api_route("/api/personas", register_persona, methods=["POST"])
    app.add_api_route("/api/personas/export", export_personas, methods=["POST"])
    app.add_api_route("/api/personas/update_batch", update_batch_personas, methods=["POST"])
    app.add_api_route("/api/personas/{persona_id}", update_persona, methods=["PATCH"])
    app.add_api_route("/api/personas/{persona_id}", delete_persona, methods=["DELETE"])
    app.add_api_route("/api/personas/clear", clear_personas, methods=["POST"])
    app.add_api_route("/api/personas/validate", validate_persona, methods=["POST"])
    app.add_api_route("/api/personas/assemble", assemble_persona, methods=["POST"])
    return Success(None)


# @shell_orchestration: FastAPI route registration mutates the app routing table.
def _register_component_routes(app: FastAPI) -> WebResult[None]:
    """Register packaged component REST routes on ``app``.

    Args:
        app: FastAPI application receiving component routes.
    """

    def _send(result: WebResult[Any]) -> Any:
        if isinstance(result, Failure):
            return result.failure()
        return result.unwrap()

    async def list_components() -> Any:
        return _send(await _api_list_components())

    async def get_component(component_type: str, name: str) -> Any:
        return _send(await _api_get_component(component_type, name))

    async def components_projection() -> Any:
        return _send(await _api_components_projection())

    app.add_api_route("/api/components", list_components, methods=["GET"])
    app.add_api_route("/api/components/{component_type}/{name}", get_component, methods=["GET"])
    app.add_api_route("/api/components/projection", components_projection, methods=["GET"])
    return Success(None)


# @shell_orchestration: FastAPI route registration mutates the app routing table.
def _register_static_routes(app: FastAPI, *, static_dir: Path, index_file: str) -> WebResult[None]:
    """Register packaged static UI routes on ``app``.

    Args:
        app: FastAPI application receiving static UI routes.
        static_dir: Directory containing the packaged HTML UI artifact.
        index_file: HTML filename served at ``/``.
    """
    app.add_api_route("/", _make_serve_index(static_dir, index_file).unwrap(), methods=["GET"])
    return Success(None)


# @shell_orchestration: FastAPI route registration mutates the app routing table.
def _register_routes(app: FastAPI, *, static_dir: Path, index_file: str) -> WebResult[None]:
    """Register the packaged web REST routes on ``app``.

    Args:
        app: FastAPI application receiving the canonical packaged routes.
        static_dir: Directory containing the packaged HTML UI artifact.
        index_file: HTML filename served at ``/``.
    """
    _register_persona_routes(app).unwrap()
    _register_component_routes(app).unwrap()
    _register_static_routes(app, static_dir=static_dir, index_file=index_file).unwrap()
    return Success(None)


register_routes = _register_routes
