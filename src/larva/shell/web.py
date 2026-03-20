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

from larva.shell.python_api import (
    LarvaApiError,
    assemble,
    clear,
    delete,
    list as list_personas,
    register,
    resolve,
    validate,
)
from larva.shell.components import FilesystemComponentStore

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

app = FastAPI(title="larva", docs_url=None, redoc_url=None)

STATIC_DIR = Path(__file__).parent
_component_store = FilesystemComponentStore()


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


# @invar:allow shell_result: FastAPI helper returns JSONResponse, not Result
def _api_error_response(e: LarvaApiError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": e.error},
    )


# ---------------------------------------------------------------------------
# Persona endpoints
# ---------------------------------------------------------------------------


@app.get("/api/personas")
def api_list_personas():
    try:
        return {"data": list_personas()}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.get("/api/personas/{persona_id}")
def api_get_persona(persona_id: str):
    try:
        return {"data": resolve(persona_id)}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas")
async def api_register_persona(request: Request):
    body = await request.json()
    spec = body.get("spec", body)
    try:
        # Validate first
        report = validate(spec)
        if not report["valid"]:
            return JSONResponse(
                status_code=400,
                content={"error": {"code": "PERSONA_INVALID", "errors": report["errors"]}},
            )
        result = register(spec)
        return {"data": result}
    except LarvaApiError as e:
        return _api_error_response(e)


# @invar:allow entry_point_too_thick: contrib web endpoint, inline patch logic is clearer
@app.patch("/api/personas/{persona_id}")
async def api_update_persona(persona_id: str, request: Request):
    patches = await request.json()
    try:
        # Get current spec
        spec = resolve(persona_id)
        # Apply patches
        for key, value in patches.items():
            if key in ("spec_digest", "spec_version"):
                continue  # protected fields
            if key == "model_params" and isinstance(value, dict):
                spec["model_params"] = value  # type: ignore[typeddict-item]
            elif key == "tools" and isinstance(value, dict):
                spec["tools"] = value
            else:
                spec[key] = value
        # Revalidate
        report = validate(spec)
        if not report["valid"]:
            return JSONResponse(
                status_code=400,
                content={"error": {"code": "PERSONA_INVALID", "errors": report["errors"]}},
            )
        # Re-register (normalize will recompute digest)
        register(spec)
        # Return updated spec
        return {"data": resolve(persona_id)}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.delete("/api/personas/{persona_id}")
def api_delete_persona(persona_id: str):
    try:
        result = delete(persona_id)
        return {"data": result}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas/clear")
async def api_clear_personas(request: Request):
    body = await request.json()
    confirm = body.get("confirm", "")
    try:
        count = clear(confirm=confirm)
        return {"data": {"cleared": True, "count": count}}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas/validate")
async def api_validate_persona(request: Request):
    spec = await request.json()
    try:
        report = validate(spec)
        return {"data": report}
    except LarvaApiError as e:
        return _api_error_response(e)


@app.post("/api/personas/assemble")
async def api_assemble_persona(request: Request):
    body = await request.json()
    try:
        spec = assemble(
            id=body["id"],
            prompts=body.get("prompts"),
            toolsets=body.get("toolsets"),
            constraints=body.get("constraints"),
            model=body.get("model"),
            overrides=body.get("overrides"),
            variables=body.get("variables"),
        )
        return {"data": spec}
    except LarvaApiError as e:
        return _api_error_response(e)


# ---------------------------------------------------------------------------
# Component endpoints
# ---------------------------------------------------------------------------


@app.get("/api/components")
def api_list_components():
    result = _component_store.list_components()
    if hasattr(result, "unwrap"):
        return {"data": result.unwrap()}
    return {"data": {"prompts": [], "toolsets": [], "constraints": [], "models": []}}


@app.get("/api/components/{component_type}/{name}")
def api_get_component(component_type: str, name: str):
    loaders = {
        "prompts": _component_store.load_prompt,
        "toolsets": _component_store.load_toolset,
        "constraints": _component_store.load_constraint,
        "models": _component_store.load_model,
    }
    loader = loaders.get(component_type)
    if not loader:
        raise HTTPException(status_code=400, detail=f"Invalid component type: {component_type}")
    result = loader(name)
    if hasattr(result, "unwrap"):
        return {"data": result.unwrap()}
    raise HTTPException(status_code=404, detail=f"Component not found: {component_type}/{name}")


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------


@app.get("/")
def serve_index():
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
