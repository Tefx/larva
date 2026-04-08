"""
larva web UI server.

Direct-script web runtime for repository contributors. It mirrors the packaged
``larva serve`` surface and serves ``contrib/web/index.html`` for local review.

Contract note:
- The shared endpoint inventory from ``src/larva/shell/web.py`` remains the
  authoritative packaged contract.
- ``POST /api/personas/batch-update`` is a contrib-only convenience surface for
  local review of bulk edits and is not part of the authoritative ``larva
  serve`` contract.
- Clipboard copy feedback in the HTML UI is convenience behavior, not a REST
  contract guarantee.

Usage:
    uv run python contrib/web/server.py [--port 7400] [--no-open]
"""

from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path
from typing import Any

from larva.shell.python_api import (
    LarvaApiError,
    assemble,
    clear,
    delete,
    list as list_personas,
    register,
    resolve,
    update_batch,
    validate,
)
from larva.shell.components import FilesystemComponentStore
from larva.core.validate import ValidationReport

_WEB_IMPORT_ERROR: ImportError | None = None


class _MissingFastApiApp:
    def _decorator(self, *_args: object, **_kwargs: object) -> Any:
        return lambda func: func

    get = post = patch = delete = _decorator


try:
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, JSONResponse
    import uvicorn
except ImportError as exc:
    _WEB_IMPORT_ERROR = exc

    class FastAPI(_MissingFastApiApp):  # type: ignore[no-redef]
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    class HTTPException(Exception):  # type: ignore[no-redef]
        def __init__(self, status_code: int, detail: str) -> None:
            self.status_code = status_code
            self.detail = detail

    Request = Request  # type: ignore[misc]

    class FileResponse:  # type: ignore[no-redef]
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    class JSONResponse:  # type: ignore[no-redef]
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

    uvicorn = None  # type: ignore[assignment]

app = (
    FastAPI(title="larva", docs_url=None, redoc_url=None)
    if _WEB_IMPORT_ERROR is None
    else _MissingFastApiApp()
)

STATIC_DIR = Path(__file__).parent
_component_store = FilesystemComponentStore()


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
        return {"data": resolve(persona_id)}
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


# @invar:allow entry_point_too_thick: contrib web endpoint, inline patch logic is clearer
@app.patch("/api/personas/{persona_id}")
async def api_update_persona(persona_id: str, request: Request) -> Any:
    """Patch a persona (protected fields ignored, revalidates)."""
    patches = await request.json()
    try:
        # Get current spec
        spec = resolve(persona_id)
        # Apply patches
        # Protected fields (id, spec_digest, spec_version) are stripped
        # Deep-merge fields (model_params, capabilities) get merged correctly
        # NOTE: contrib does NOT allow deprecated 'tools' field reintroduction
        # - canonical 'capabilities' field is the only valid tool capability surface
        # - validate() will reject 'tools' if present in the patched spec
        for key, value in patches.items():
            if key in ("spec_digest", "spec_version"):
                continue  # protected fields
            if key == "model_params" and isinstance(value, dict):
                spec["model_params"] = value  # type: ignore[typeddict-item]
            elif key == "capabilities" and isinstance(value, dict):
                spec["capabilities"] = value  # canonical field
            else:
                spec[key] = value  # type: ignore[misc]

        # Revalidate
        report = validate(spec)
        if not report["valid"]:
            return _validation_error_response(report)

        # Re-register (normalize will recompute digest)
        register(spec)

        # Return updated spec
        return {"data": resolve(persona_id)}
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
# @invar:allow entry_point_too_thick: contrib web endpoint, mirrors packaged implementation parity
async def api_assemble_persona(request: Request) -> Any:
    """Assemble a persona spec from components."""
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
# Contrib-only endpoint: batch-update
# ---------------------------------------------------------------------------


@app.post("/api/personas/batch-update")
async def api_batch_update_personas(request: Request) -> Any:
    """Batch-update endpoint (contrib-only convenience surface).

    Source: INTERFACES.md line 147
    """
    body = await request.json()
    where = body.get("where", {})
    patches = body.get("patches", {})
    dry_run = body.get("dry_run", False)
    try:
        result = update_batch(where=where, patches=patches, dry_run=dry_run)
        return {"data": result}
    except LarvaApiError as e:
        return JSONResponse(status_code=400, content={"error": e.error})


# ---------------------------------------------------------------------------
# Component endpoints
# ---------------------------------------------------------------------------


@app.get("/api/components")
def api_list_components() -> Any:
    """List all available components."""
    result = _component_store.list_components()
    if hasattr(result, "unwrap"):
        return {"data": result.unwrap()}
    return {"data": {"prompts": [], "toolsets": [], "constraints": [], "models": []}}


@app.get("/api/components/{component_type}/{name}")
def api_get_component(component_type: str, name: str) -> Any:
    """Load a specific component."""
    loaders = {
        "prompts": _component_store.load_prompt,
        "toolsets": _component_store.load_toolset,
        "constraints": _component_store.load_constraint,
        "models": _component_store.load_model,
    }
    loader = loaders.get(component_type)
    if not loader:
        raise HTTPException(status_code=400, detail=f"Invalid component type: {component_type}")  # type: ignore[misc]
    result = loader(name)
    if hasattr(result, "unwrap"):
        return {"data": result.unwrap()}
    raise HTTPException(status_code=404, detail=f"Component not found: {component_type}/{name}")  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    if _WEB_IMPORT_ERROR is not None:
        raise SystemExit(
            "FastAPI and uvicorn are required.\nInstall with: uv pip install fastapi uvicorn"
        )

    parser = argparse.ArgumentParser(description="larva web UI")
    parser.add_argument("--port", type=int, default=7400)
    parser.add_argument("--no-open", action="store_true", help="Don't open browser")
    args = parser.parse_args()

    if not args.no_open:
        import threading

        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{args.port}")).start()

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")  # type: ignore[misc]


if __name__ == "__main__":
    main()
