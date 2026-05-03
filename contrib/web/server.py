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
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

from larva.shell.python_api import (
    LarvaApiError,
    update_batch,
)

_WEB_IMPORT_ERROR: ImportError | None = None


class _MissingFastApiApp:
    def _decorator(self, *_args: object, **_kwargs: object) -> Any:
        return lambda func: func

    get = post = patch = delete = _decorator


JSONResponse: Any = Any

try:
    from fastapi.responses import JSONResponse
except ImportError as exc:
    _WEB_IMPORT_ERROR = exc


STATIC_DIR = Path(__file__).parent
run_web_app: Callable[..., None] | None = None
if _WEB_IMPORT_ERROR is None:
    from larva.shell.web import create_app as create_canonical_app
    from larva.shell.web import run_web_app

    app = create_canonical_app(static_dir=STATIC_DIR, index_file="index.html")
else:
    app = _MissingFastApiApp()


# ---------------------------------------------------------------------------
# Contrib-only endpoint: batch-update
# ---------------------------------------------------------------------------


@app.post("/api/personas/batch-update")
async def api_batch_update_personas(body: dict[str, Any]) -> Any:
    """Batch-update endpoint (contrib-only convenience surface).

    Source: INTERFACES.md line 147
    """
    where = body.get("where", {})
    patches = body.get("patches", {})
    dry_run = body.get("dry_run", False)
    try:
        result = update_batch(where=where, patches=patches, dry_run=dry_run)
        return {"data": result}
    except LarvaApiError as e:
        return JSONResponse(status_code=400, content={"error": e.error})


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(port: int = 7400, no_open: bool = False) -> None:
    if _WEB_IMPORT_ERROR is not None:
        raise SystemExit(
            "FastAPI and uvicorn are required.\nInstall with: uv pip install fastapi uvicorn"
        )
    assert run_web_app is not None

    run_web_app(app, port=port, no_open=no_open)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="larva web UI")
    parser.add_argument("--port", type=int, default=7400)
    parser.add_argument("--no-open", action="store_true", help="Don't open browser")
    args = parser.parse_args()
    main(port=args.port, no_open=args.no_open)
