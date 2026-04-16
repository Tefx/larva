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
from typing import Any, TypedDict

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
    update,
    validate,
)
from larva.core.validate import ValidationReport

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

STATIC_DIR = Path(__file__).parent

# -----------------------------------------------------------------------------
# Web-Facing Component Projection
# -----------------------------------------------------------------------------
# Canonical inputs remain: prompts | toolsets | constraints | models
# Web-facing UI layer uses: Prompts | Capability Presets | Constraints | Models
#


class ComponentTypeProjection(TypedDict):
    """Web-facing projection for one canonical component kind.

    Canonical inputs (prompts, toolsets, constraints, models) are preserved
    as authoritative internal categories. This projection provides UI-only
    display metadata so the web UI can render preset-library and compose-persona
    wording without inventing new backend semantics.

    Fields:
        canonical_kind: Internal canonical name (e.g. 'toolsets'). MUST NOT be
            changed by UI — this is the authoritative key for assemble requests.
        display_label: User-facing singular name (e.g. 'Capability Preset').
        plural_display_label: User-facing plural name (e.g. 'Capability Presets').
        description: Human-readable description for UI tooltips and placeholders.
        singular_alias: Accepted singular alias at ingress (e.g. 'toolset').
        assemble_field: The field name used in /api/personas/assemble requests.
        ui_hint: UI-specific routing hint (e.g. 'preset' for toolsets).
    """

    canonical_kind: str
    display_label: str
    plural_display_label: str
    description: str
    singular_alias: str
    assemble_field: str
    ui_hint: str


# Canonical kind -> web projection (order matters for /api/components/projection)
_CANONICAL_KIND_PROJECTIONS: dict[str, ComponentTypeProjection] = {
    "prompts": {
        "canonical_kind": "prompts",
        "display_label": "Prompt",
        "plural_display_label": "Prompts",
        "description": "System prompt fragments that define persona behavior",
        "singular_alias": "prompt",
        "assemble_field": "prompts",
        "ui_hint": "prompt",
    },
    "toolsets": {
        "canonical_kind": "toolsets",
        "display_label": "Capability Preset",
        "plural_display_label": "Capability Presets",
        "description": "Bundles of tool capability declarations (read, write, destructive)",
        "singular_alias": "toolset",
        "assemble_field": "toolsets",
        "ui_hint": "preset",
    },
    "constraints": {
        "canonical_kind": "constraints",
        "display_label": "Constraint",
        "plural_display_label": "Constraints",
        "description": "Persona constraints (spawn policy, compaction prompts)",
        "singular_alias": "constraint",
        "assemble_field": "constraints",
        "ui_hint": "constraint",
    },
    "models": {
        "canonical_kind": "models",
        "display_label": "Model",
        "plural_display_label": "Models",
        "description": "Model configuration and parameters",
        "singular_alias": "model",
        "assemble_field": "model",
        "ui_hint": "model",
    },
}


def get_component_projections() -> list[ComponentTypeProjection]:
    """Return web-facing projections for all canonical component kinds.

    This projection is UI-only metadata — it does not change canonical inputs.
    The web UI uses display_label and plural_display_label for preset-library
    and compose-persona wording. assemble_field is the authoritative key for
    assemble requests.
    """
    return list(_CANONICAL_KIND_PROJECTIONS.values())


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


def create_app(*, static_dir: Path | None = None, index_file: str = "web_ui.html") -> FastAPI:
    """Create a FastAPI app for the canonical web REST surface."""
    resolved_static_dir = STATIC_DIR if static_dir is None else Path(static_dir)
    app = FastAPI(title="larva", docs_url=None, redoc_url=None)

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
        """Patch a persona through the shared facade seam."""
        patches = await request.json()
        try:
            return {"data": update(persona_id, patches)}
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

        # Validate: reject unknown fields at canonical boundary
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
                        "message": f"assemble request field '{unknown_fields[0]}' is not permitted at canonical boundary",
                        "details": {"field": unknown_fields[0], "unknown_fields": unknown_fields},
                    }
                },
            )

        try:
            spec = assemble(
                body["id"],
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

    @app.get("/api/components/projection")
    def api_components_projection() -> Any:
        """Return web-facing projection metadata for component kinds.

        This endpoint provides UI-only display metadata (labels, descriptions)
        for rendering the preset-library and compose-persona UI without
        inventing new backend semantics.

        Canonical component kind vocabulary (prompts, toolsets, constraints,
        models) is preserved as the authoritative internal category. This
        projection does NOT change any canonical input fields.

        Contract: this endpoint is additive — existing /api/components behavior
        is unchanged.
        """
        return {"data": get_component_projections()}

    @app.get("/")
    def serve_index() -> FileResponse:
        return FileResponse(resolved_static_dir / index_file, media_type="text/html")

    return app


app = create_app()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def run_web_app(runtime_app: FastAPI, *, port: int = 7400, no_open: bool = False) -> None:
    """Run a web app with the packaged launch contract."""
    if not no_open:
        import threading

        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()

    uvicorn.run(runtime_app, host="127.0.0.1", port=port, log_level="info")


def main(port: int = 7400, no_open: bool = False) -> None:
    """Start the web UI server.

    Can be called from CLI (larva serve) or directly.
    """
    run_web_app(app, port=port, no_open=no_open)


if __name__ == "__main__":
    import argparse as _ap

    _parser = _ap.ArgumentParser(description="larva web UI")
    _parser.add_argument("--port", type=int, default=7400)
    _parser.add_argument("--no-open", action="store_true")
    _args = _parser.parse_args()
    main(port=_args.port, no_open=_args.no_open)
