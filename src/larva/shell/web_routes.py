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
    return Success(JSONResponse(status_code=400, content={"error": e.error}))

# @shell_orchestration: HTTP error-envelope projection is transport boundary glue.
def _validation_error_response(report: ValidationReport) -> WebResult[JSONResponse]:
    return Success(
        JSONResponse(
            status_code=400,
            content={"error": {"code": "PERSONA_INVALID", "errors": report["errors"]}},
        )
    )

def _invalid_input_response(message: str, details: dict[str, object]) -> WebResult[JSONResponse]:
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
    issue = result.failure()
    return _invalid_input_response(issue.reason, issue.details)

def _patch_error_response(error: PatchError) -> WebResult[JSONResponse]:
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
    try:
        return Success({"data": _web_api().unwrap().list_personas()})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_get_persona(persona_id: str) -> WebResult[dict[str, Any]]:
    try:
        return Success({"data": _web_api().unwrap().resolve(persona_id, None)})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

# @shell_complexity: Registration endpoint orchestrates request validation and facade calls.
async def _api_register_persona(request: Request) -> WebResult[dict[str, Any]]:
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
    patches = await _read_request_object(request)
    if isinstance(patches, Failure):
        return Failure(patches.failure())
    try:
        return Success({"data": _web_api().unwrap().update(persona_id, patches.unwrap())})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_delete_persona(persona_id: str) -> WebResult[dict[str, Any]]:
    try:
        result = _web_api().unwrap().delete(persona_id)
        return Success({"data": result})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_clear_personas(request: Request) -> WebResult[dict[str, Any]]:
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
    spec = await _read_request_object(request)
    if isinstance(spec, Failure):
        return Failure(spec.failure())
    try:
        report = _web_api().unwrap().validate(cast("PersonaSpec", spec.unwrap()))
        return Success({"data": report})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_registry_personas() -> WebResult[dict[str, Any]]:
    try:
        api = _web_api().unwrap()
        personas = api.list_personas()
        summaries = []
        for p in personas:
            meta = api.variant_list(p["id"])
            summaries.append({
                "id": p["id"],
                "description": p.get("description", ""),
                "model": p.get("model", ""),
                "active_variant": meta["active"],
                "variants": meta["variants"],
            })
        return Success({"data": summaries})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_variant_list(persona_id: str) -> WebResult[dict[str, Any]]:
    try:
        return Success({"data": _web_api().unwrap().variant_list(persona_id)})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_variant_detail(persona_id: str, variant: str) -> WebResult[dict[str, Any]]:
    try:
        api = _web_api().unwrap()
        v_list = api.variant_list(persona_id)
        is_active = (v_list.get("active") == variant)
        spec = api.resolve(persona_id, None, variant=variant)
        envelope = {
            "_registry": {"variant": variant, "is_active": is_active},
            "spec": spec
        }
        return Success({"data": envelope})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_variant_put(
    persona_id: str, variant: str, request: Request
) -> WebResult[dict[str, Any]]:
    body = await _read_request_object(request)
    if isinstance(body, Failure):
        return Failure(body.failure())

    spec = body.unwrap()
    if spec.get("id") != persona_id:
        return Failure(
            JSONResponse(
                status_code=400,
                content={
                    "error": {
                        "code": "PERSONA_ID_MISMATCH",
                        "numeric_code": 113,
                        "message": "PUT variant spec id must match route id",
                        "details": {"field": "id", "expected": persona_id, "got": spec.get("id")},
                    }
                },
            )
        )

    try:
        api = _web_api().unwrap()
        result = api.register(spec, variant=variant)
        return Success({"data": result})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_variant_activate(persona_id: str, variant: str) -> WebResult[dict[str, Any]]:
    try:
        result = _web_api().unwrap().variant_activate(persona_id, variant)
        return Success({"data": result})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

async def _api_variant_delete(persona_id: str, variant: str) -> WebResult[dict[str, Any]]:
    try:
        result = _web_api().unwrap().variant_delete(persona_id, variant)
        return Success({"data": result})
    except LarvaApiError as e:
        return Failure(_api_error_response(e).unwrap())

def _make_serve_index(
    static_dir: Path, index_file: str
) -> WebResult[Callable[[], Awaitable[FileResponse]]]:
    """Create the route handler that serves the packaged HTML UI artifact."""

    async def _serve_index() -> FileResponse:
        return FileResponse(static_dir / index_file, media_type="text/html")

    return Success(_serve_index)



# @shell_orchestration: FastAPI route registration mutates the app routing table.
def _register_persona_routes(app: FastAPI) -> WebResult[None]:
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

    async def registry_personas() -> Any:
        return _send(await _api_registry_personas())
    async def variant_list(persona_id: str) -> Any:
        return _send(await _api_variant_list(persona_id))
    async def variant_detail(persona_id: str, variant: str) -> Any:
        return _send(await _api_variant_detail(persona_id, variant))
    async def variant_put(persona_id: str, variant: str, request: Request) -> Any:
        return _send(await _api_variant_put(persona_id, variant, request))
    async def variant_activate(persona_id: str, variant: str) -> Any:
        return _send(await _api_variant_activate(persona_id, variant))
    async def variant_delete_route(persona_id: str, variant: str) -> Any:
        return _send(await _api_variant_delete(persona_id, variant))

    app.add_api_route("/api/personas", list_personas, methods=["GET"])
    app.add_api_route("/api/personas/{persona_id}", get_persona, methods=["GET"])
    app.add_api_route("/api/personas", register_persona, methods=["POST"])
    app.add_api_route("/api/personas/export", export_personas, methods=["POST"])
    app.add_api_route("/api/personas/update_batch", update_batch_personas, methods=["POST"])
    app.add_api_route("/api/personas/{persona_id}", update_persona, methods=["PATCH"])
    app.add_api_route("/api/personas/{persona_id}", delete_persona, methods=["DELETE"])
    app.add_api_route("/api/personas/clear", clear_personas, methods=["POST"])
    app.add_api_route("/api/personas/validate", validate_persona, methods=["POST"])

    app.add_api_route("/api/registry/personas", registry_personas, methods=["GET"])
    app.add_api_route("/api/registry/personas/{persona_id}/variants", variant_list, methods=["GET"])
    app.add_api_route(
        "/api/registry/personas/{persona_id}/variants/{variant}",
        variant_detail,
        methods=["GET"],
    )
    app.add_api_route(
        "/api/registry/personas/{persona_id}/variants/{variant}",
        variant_put,
        methods=["PUT"],
    )
    app.add_api_route(
        "/api/registry/personas/{persona_id}/variants/{variant}/activate",
        variant_activate,
        methods=["POST"],
    )
    app.add_api_route(
        "/api/registry/personas/{persona_id}/variants/{variant}",
        variant_delete_route,
        methods=["DELETE"],
    )

    return Success(None)

# @shell_orchestration: FastAPI route registration mutates the app routing table.
def _register_static_routes(app: FastAPI, *, static_dir: Path, index_file: str) -> WebResult[None]:
    app.add_api_route("/", _make_serve_index(static_dir, index_file).unwrap(), methods=["GET"])
    return Success(None)

# @shell_orchestration: FastAPI route registration mutates the app routing table.
def _register_routes(app: FastAPI, *, static_dir: Path, index_file: str) -> WebResult[None]:
    _register_persona_routes(app).unwrap()
    _register_static_routes(app, static_dir=static_dir, index_file=index_file).unwrap()
    return Success(None)

register_routes = _register_routes
