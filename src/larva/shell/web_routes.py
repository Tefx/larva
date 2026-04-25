"""Packaged FastAPI route registration for the larva web REST surface.

This module owns the endpoint wiring used by :mod:`larva.shell.web` while the
public ``larva serve`` entrypoint remains in ``web.py``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from fastapi import Request  # noqa: TC002 # FastAPI inspects Request annotations at runtime.
from fastapi.responses import FileResponse, JSONResponse
from returns.result import Failure

from larva.core.patch import PatchError, apply_patches
from larva.shell.python_api import (
    LarvaApiError,
    assemble,
    clear,
    component_list,
    component_show,
    delete,
    export_all,
    export_ids,
    register,
    resolve,
    update,
    update_batch,
    validate,
)
from larva.shell.python_api import (
    list as list_personas,
)
from larva.shell.shared.request_validation import (
    reject_unknown_params,
    require_list_of_strings,
    require_param,
    require_params_object,
    require_type,
)

if TYPE_CHECKING:
    from pathlib import Path

    from fastapi import FastAPI

    from larva.core.spec import PersonaSpec
    from larva.core.validation_contract import ValidationReport


# @invar:allow shell_result: FastAPI HTTP boundary must return JSONResponse, not Result
def _api_error_response(e: LarvaApiError) -> JSONResponse:
    """Project LarvaApiError to HTTP 400 with error envelope."""
    return JSONResponse(status_code=400, content={"error": e.error})


def _component_api_error_response(e: LarvaApiError) -> JSONResponse:
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
    return JSONResponse(status_code=status_code, content={"error": e.error})


# @invar:allow shell_result: FastAPI HTTP boundary must return JSONResponse, not Result
def _validation_error_response(report: ValidationReport) -> JSONResponse:
    """Project validation failure to HTTP 400 with PERSONA_INVALID envelope."""
    return JSONResponse(
        status_code=400,
        content={"error": {"code": "PERSONA_INVALID", "errors": report["errors"]}},
    )


def _invalid_input_response(message: str, details: dict[str, object]) -> JSONResponse:
    """Project malformed request input to a structured HTTP 400 envelope."""
    return JSONResponse(
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


async def _read_request_object(request: Request) -> dict[str, Any] | JSONResponse:
    """Read request JSON and require a top-level object payload."""
    try:
        payload = await request.json()
    except Exception:
        return _invalid_input_response(
            "request body must be valid JSON object",
            {"field": "params", "received_type": "invalid_json"},
        )

    params_result = require_params_object(payload)
    if isinstance(params_result, Failure):
        issue = params_result.failure()
        return _invalid_input_response(issue.reason, issue.details)
    return params_result.unwrap()


def _validation_issue_response(result: Failure[Any]) -> JSONResponse:
    """Project a shared request-validation failure to the web error envelope."""
    issue = result.failure()
    return _invalid_input_response(issue.reason, issue.details)


def _patch_error_response(error: PatchError) -> JSONResponse:
    """Project patch validation failures before any batch mutation is attempted."""
    return JSONResponse(
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


def _validate_export_request(body: dict[str, Any]) -> tuple[bool, list[str]] | JSONResponse:
    """Validate the web export selector using the packaged REST fail-closed contract."""
    unknown_result = reject_unknown_params(body, {"all", "ids"})
    if isinstance(unknown_result, Failure):
        return _validation_issue_response(unknown_result)

    if "all" in body:
        all_result = require_type(body, "all", bool, "boolean")
        if isinstance(all_result, Failure):
            return _validation_issue_response(all_result)
    ids_result = require_list_of_strings(body, "ids")
    if isinstance(ids_result, Failure):
        return _validation_issue_response(ids_result)

    has_all = "all" in body
    has_ids = "ids" in body
    if has_all and has_ids:
        return _invalid_input_response(
            "cannot specify both 'all' and 'ids'",
            {"field": "params", "conflict": ["all", "ids"]},
        )
    if not has_all and not has_ids:
        return _invalid_input_response(
            "must specify either 'all' or 'ids'",
            {"field": "params", "missing": ["all", "ids"]},
        )
    if has_all:
        if body["all"] is False:
            return _invalid_input_response(
                "must specify either 'all' or 'ids'",
                {"field": "all", "missing": ["ids"]},
            )
        return True, []
    return False, cast("list[str]", body["ids"])


def _validate_update_batch_request(
    body: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], bool] | JSONResponse:
    """Validate packaged REST update_batch request shape before facade delegation."""
    unknown_result = reject_unknown_params(body, {"where", "patches", "dry_run"})
    if isinstance(unknown_result, Failure):
        return _validation_issue_response(unknown_result)

    for key in ("where", "patches"):
        required_result = require_param(body, key)
        if isinstance(required_result, Failure):
            return _validation_issue_response(required_result)
        typed_result = require_type(body, key, dict, "object")
        if isinstance(typed_result, Failure):
            return _validation_issue_response(typed_result)

    if "dry_run" in body:
        dry_run_result = require_type(body, "dry_run", bool, "boolean")
        if isinstance(dry_run_result, Failure):
            return _validation_issue_response(dry_run_result)

    try:
        apply_patches({}, cast("dict[str, object]", body["patches"]))
    except PatchError as error:
        return _patch_error_response(error)

    return body["where"], body["patches"], body.get("dry_run", False)


def register_routes(app: FastAPI, *, static_dir: Path, index_file: str) -> None:
    """Register the packaged web REST routes on ``app``.

    Args:
        app: FastAPI application receiving the canonical packaged routes.
        static_dir: Directory containing the packaged HTML UI artifact.
        index_file: HTML filename served at ``/``.
    """

    async def api_list_personas() -> Any:
        try:
            return {"data": list_personas()}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_get_persona(persona_id: str) -> Any:
        try:
            return {"data": resolve(persona_id, None)}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_register_persona(request: Request) -> Any:
        body = await _read_request_object(request)
        if isinstance(body, JSONResponse):
            return body
        spec = body.get("spec", body)
        if "spec" in body:
            spec_result = require_type(body, "spec", dict, "object")
            if isinstance(spec_result, Failure):
                issue = spec_result.failure()
                return _invalid_input_response(issue.reason, issue.details)
        try:
            report = validate(cast("PersonaSpec", spec))
            if not report["valid"]:
                return _validation_error_response(report)
            result = register(spec)
            return {"data": result}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_export_personas(request: Request) -> Any:
        body = await _read_request_object(request)
        if isinstance(body, JSONResponse):
            return body
        target = _validate_export_request(body)
        if isinstance(target, JSONResponse):
            return target
        use_all, ids = target
        try:
            result = export_all() if use_all else export_ids(ids)
            return {"data": result}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_update_batch_personas(request: Request) -> Any:
        body = await _read_request_object(request)
        if isinstance(body, JSONResponse):
            return body
        update_request = _validate_update_batch_request(body)
        if isinstance(update_request, JSONResponse):
            return update_request
        where, patches, dry_run = update_request
        try:
            return {"data": update_batch(where, patches, dry_run)}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_update_persona(persona_id: str, request: Request) -> Any:
        patches = await _read_request_object(request)
        if isinstance(patches, JSONResponse):
            return patches
        try:
            return {"data": update(persona_id, patches)}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_delete_persona(persona_id: str) -> Any:
        try:
            result = delete(persona_id)
            return {"data": result}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_clear_personas(request: Request) -> Any:
        body = await _read_request_object(request)
        if isinstance(body, JSONResponse):
            return body
        confirm = body.get("confirm", "")
        try:
            count = clear(confirm=confirm)
            return {"data": {"cleared": True, "count": count}}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_validate_persona(request: Request) -> Any:
        spec = await _read_request_object(request)
        if isinstance(spec, JSONResponse):
            return spec
        try:
            report = validate(cast("PersonaSpec", spec))
            return {"data": report}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_assemble_persona(request: Request) -> Any:
        body = await _read_request_object(request)
        if isinstance(body, JSONResponse):
            return body
        allowed_fields = frozenset(
            {"id", "description", "prompts", "toolsets", "constraints", "model", "overrides"}
        )
        unknown_fields = sorted(set(body.keys()) - allowed_fields)
        if unknown_fields:
            return JSONResponse(
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
        if "id" not in body:
            return JSONResponse(
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
        try:
            spec = assemble(
                cast("str", body["id"]),
                body.get("description"),
                body.get("prompts"),
                body.get("toolsets"),
                body.get("constraints"),
                body.get("model"),
                body.get("overrides"),
            )
            return {"data": spec}
        except LarvaApiError as e:
            return _api_error_response(e)

    async def api_list_components() -> Any:
        try:
            return {"data": component_list()}
        except LarvaApiError as e:
            return _component_api_error_response(e)

    async def api_get_component(component_type: str, name: str) -> Any:
        try:
            return {"data": component_show(component_type, name)}
        except LarvaApiError as e:
            return _component_api_error_response(e)

    async def api_components_projection() -> Any:
        from larva.shell.web import get_component_projections

        return {"data": get_component_projections()}

    async def serve_index() -> FileResponse:
        return FileResponse(static_dir / index_file, media_type="text/html")

    app.add_api_route("/api/personas", api_list_personas, methods=["GET"])
    app.add_api_route("/api/personas/{persona_id}", api_get_persona, methods=["GET"])
    app.add_api_route("/api/personas", api_register_persona, methods=["POST"])
    app.add_api_route("/api/personas/export", api_export_personas, methods=["POST"])
    app.add_api_route("/api/personas/update_batch", api_update_batch_personas, methods=["POST"])
    app.add_api_route("/api/personas/{persona_id}", api_update_persona, methods=["PATCH"])
    app.add_api_route("/api/personas/{persona_id}", api_delete_persona, methods=["DELETE"])
    app.add_api_route("/api/personas/clear", api_clear_personas, methods=["POST"])
    app.add_api_route("/api/personas/validate", api_validate_persona, methods=["POST"])
    app.add_api_route("/api/personas/assemble", api_assemble_persona, methods=["POST"])
    app.add_api_route("/api/components", api_list_components, methods=["GET"])
    app.add_api_route("/api/components/{component_type}/{name}", api_get_component, methods=["GET"])
    app.add_api_route("/api/components/projection", api_components_projection, methods=["GET"])
    app.add_api_route("/", serve_index, methods=["GET"])
