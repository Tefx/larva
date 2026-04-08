"""
larva web UI server.

Authoritative runtime boundary for the packaged web surface used by
``larva serve``. This module wraps larva's Python API as REST endpoints and
serves the single-file HTML UI from ``src/larva/shell/web_ui.html``.

Normative REST contract for ``larva serve``:
    GET    /                       -> packaged HTML UI
    GET    /api/personas           -> list personas
    GET    /api/personas/{id}      -> resolve persona
    POST   /api/personas           -> validate + register persona
    PATCH  /api/personas/{id}      -> patch + revalidate + register persona
    DELETE /api/personas/{id}      -> delete persona
    POST   /api/personas/clear     -> clear registry with confirmation
    POST   /api/personas/validate  -> validate candidate spec
    POST   /api/personas/assemble  -> assemble candidate spec
    GET    /api/components         -> list component names
    GET    /api/components/{t}/{n} -> load one component

Convenience-only UI behavior such as browser auto-open and clipboard copy lives
above the REST contract and should not be treated as a separate API guarantee.

Usage:
    larva serve [--port 7400] [--no-open]
    pip install larva[web]  # required for web dependencies
"""

from __future__ import annotations

import webbrowser
from pathlib import Path
from typing import Any

from larva.shell.python_api import (
    LarvaApiError,
    assemble,
    clear,
    component_list,
    component_show,
    delete,
    list as list_personas,
    register,
    resolve,
    validate,
)
from larva.core.validate import ValidationReport

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

app = FastAPI(title="larva", docs_url=None, redoc_url=None)

STATIC_DIR = Path(__file__).parent


# ---------------------------------------------------------------------------
# Error projection (domain -> HTTP envelope)
# ---------------------------------------------------------------------------


# @invar:allow shell_result: FastAPI HTTP boundary must return JSONResponse, not Result
def _api_error_response(e: LarvaApiError) -> Any:
    """Project LarvaApiError to HTTP 400 with error envelope."""
    return JSONResponse(
        status_code=400,
        content={"error": e.error},
    )


def _component_api_error_response(e: LarvaApiError) -> Any:
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
def _validation_error_response(report: ValidationReport) -> Any:
    """Project validation failure to HTTP 400 with PERSONA_INVALID envelope."""
    return JSONResponse(
        status_code=400,
        content={"error": {"code": "PERSONA_INVALID", "errors": report["errors"]}},
    )


# ---------------------------------------------------------------------------
# Persona endpoints (shared implementation pattern)
# ---------------------------------------------------------------------------


@app.get("/api/personas")
def api_list_personas() -> Any:
    """List all registered personas."""
    try:
        return {"data": list_personas()}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.get("/api/personas/{persona_id}")
async def api_get_persona(persona_id: str) -> Any:
    """Resolve a persona by ID."""
    try:
        return {"data": resolve(persona_id, None)}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas")
async def api_register_persona(request: Request) -> Any:
    """Validate and register a new persona."""
    body = await request.json()
    spec = body.get("spec", body)
    try:
        # Validate first
        report = validate(spec)
        if not report["valid"]:
            return _validation_error_response(report)
        result = register(spec)
        return {"data": result}
    except LarvaApiError as e:
        return _api_error_response(e)


# @invar:allow entry_point_too_thick: web endpoint, shared implementation calls router helpers
@app.patch("/api/personas/{persona_id}")
async def api_update_persona(persona_id: str, request: Request) -> Any:
    """Patch a persona (protected fields ignored, revalidates)."""
    patches = await request.json()
    try:
        # Get current spec
        spec = resolve(persona_id, None)
        # Apply patches
        # Protected fields (id, spec_digest, spec_version) are stripped
        # Deep-merge fields (model_params, capabilities) get merged correctly
        for key, value in patches.items():
            if key in ("spec_digest", "spec_version"):
                continue  # protected fields
            if key == "model_params" and isinstance(value, dict):
                spec["model_params"] = value  # type: ignore[typeddict-item]
            elif key == "capabilities" and isinstance(value, dict):
                spec["capabilities"] = value  # type: ignore[typeddict-item]
            else:
                spec[key] = value  # type: ignore[misc]

        # Revalidate
        report = validate(spec)
        if not report["valid"]:
            return _validation_error_response(report)

        # Re-register (normalize will recompute digest)
        register(spec)

        # Return updated spec
        return {"data": resolve(persona_id, None)}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.delete("/api/personas/{persona_id}")
def api_delete_persona(persona_id: str) -> Any:
    """Delete a persona by ID."""
    try:
        result = delete(persona_id)
        return {"data": result}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas/clear")
async def api_clear_personas(request: Request) -> Any:
    """Clear the registry with confirmation."""
    body = await request.json()
    confirm = body.get("confirm", "")
    try:
        count = clear(confirm=confirm)
        return {"data": {"cleared": True, "count": count}}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas/validate")
async def api_validate_persona(request: Request) -> Any:
    """Validate a candidate persona spec."""
    spec = await request.json()
    try:
        report = validate(spec)
        return {"data": report}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas/assemble")
# @invar:allow entry_point_too_thick: web endpoint, mirrors contrib implementation parity
async def api_assemble_persona(request: Request) -> Any:
    """Assemble a persona spec from components."""
    body = await request.json()
    try:
        spec = assemble(
            body["id"],
            None,
            body.get("prompts"),
            body.get("toolsets"),
            body.get("constraints"),
            body.get("model"),
            body.get("overrides"),
            body.get("variables"),
        )
        return {"data": spec}
    except LarvaApiError as e:
        return _api_error_response(e)


# ---------------------------------------------------------------------------
# Component endpoints
# ---------------------------------------------------------------------------


@app.get("/api/components")
def api_list_components() -> Any:
    """List all available components."""
    try:
        return {"data": component_list()}
    except LarvaApiError as e:
        return _component_api_error_response(e)


@app.get("/api/components/{component_type}/{name}")
def api_get_component(component_type: str, name: str) -> Any:
    """Load a specific component."""
    try:
        return {"data": component_show(component_type, name)}
    except LarvaApiError as e:
        return _component_api_error_response(e)


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "web_ui.html", media_type="text/html")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(port: int = 7400, no_open: bool = False) -> None:
    """Start the web UI server.

    Can be called from CLI (larva serve) or directly.
    """
    if not no_open:
        import threading

        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    import argparse as _ap

    _parser = _ap.ArgumentParser(description="larva web UI")
    _parser.add_argument("--port", type=int, default=7400)
    _parser.add_argument("--no-open", action="store_true")
    _args = _parser.parse_args()
    main(port=_args.port, no_open=_args.no_open)
