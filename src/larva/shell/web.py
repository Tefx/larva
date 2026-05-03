"""
larva web UI server.

Authoritative runtime boundary for the packaged web surface used by
``larva serve``. This module wraps larva's Python API as REST endpoints and
serves the single-file HTML UI from ``src/larva/shell/web_ui.html``.

Normative REST contract for ``larva serve``:
    GET    /                            -> packaged HTML UI
    GET    /api/personas                -> list personas
    GET    /api/personas/{id}           -> resolve persona
    POST   /api/personas                -> validate + register persona
    PATCH  /api/personas/{id}           -> patch + revalidate + register persona
    DELETE /api/personas/{id}           -> delete persona
    POST   /api/personas/clear          -> clear registry with confirmation
    POST   /api/personas/validate      -> validate candidate spec
    POST   /api/personas/export        -> export all or selected personas
    POST   /api/personas/update_batch  -> batch update by selector + patch

Convenience-only UI behavior such as browser auto-open and clipboard copy lives
above the REST contract and should not be treated as a separate API guarantee.

Usage:
    larva serve [--port 7400] [--no-open]
    pip install larva[web]  # required for web dependencies
"""

from __future__ import annotations

import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from larva.shell import python_api as _python_api
from larva.shell.web_routes import register_routes

clear = _python_api.clear
delete = _python_api.delete
export_all = _python_api.export_all
export_ids = _python_api.export_ids
list_personas = _python_api.list
register = _python_api.register
resolve = _python_api.resolve
update = _python_api.update
update_batch = _python_api.update_batch
variant_list = _python_api.variant_list
variant_activate = _python_api.variant_activate
variant_delete = _python_api.variant_delete
variant_list = _python_api.variant_list
variant_activate = _python_api.variant_activate
variant_delete = _python_api.variant_delete
variant_list = _python_api.variant_list
variant_activate = _python_api.variant_activate
variant_delete = _python_api.variant_delete
variant_list = _python_api.variant_list
variant_activate = _python_api.variant_activate
variant_delete = _python_api.variant_delete
validate = _python_api.validate

__all__ = [
    "app",
    "clear",
    "create_app",
    "delete",
    "export_all",
    "export_ids",
    "list_personas",
    "main",
    "register",
    "resolve",
    "run_web_app",
    "update",
    "variant_list",
    "variant_activate",
    "variant_delete",
    "update_batch",
    "validate",
]

STATIC_DIR = Path(__file__).parent

# -----------------------------------------------------------------------------
# Web-Facing Component Projection
# -----------------------------------------------------------------------------
# Canonical inputs remain: prompts | toolsets | constraints | models
# Web-facing UI layer uses: Prompts | Capability Presets | Constraints | Models
#





# ---------------------------------------------------------------------------
# Persona endpoints (shared implementation pattern)
# ---------------------------------------------------------------------------


def create_app(*, static_dir: Path | None = None, index_file: str = "web_ui.html") -> FastAPI:
    """Create a FastAPI app for the canonical web REST surface."""
    resolved_static_dir = STATIC_DIR if static_dir is None else Path(static_dir)
    app = FastAPI(title="larva", docs_url=None, redoc_url=None)
    register_routes(app, static_dir=resolved_static_dir, index_file=index_file)
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
