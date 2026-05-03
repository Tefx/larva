"""Filesystem helper operations for shell registry storage."""

from __future__ import annotations

import json
import os
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Callable

from returns.result import Failure, Result, Success


def write_json_atomic(path: Path, payload: object) -> Result[None, str]:
    """Write JSON to ``path`` atomically using a temporary sibling file."""
    try:
        fd, tmp_path_text = tempfile.mkstemp(
            dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path_text, path)
        except Exception:
            with suppress(OSError):
                os.unlink(tmp_path_text)
            raise
    except (OSError, TypeError, ValueError) as exc:
        return Failure(str(exc))
    return Success(None)


# @shell_complexity: branch structure preserves atomic rollback semantics across file states.
def rollback_spec_write(
    spec_path: Path,
    old_spec_bytes: bytes | None,
    spec_existed: bool,
) -> Result[None, str]:
    """Restore pre-save spec state after metadata update failure."""
    if not spec_existed:
        try:
            if spec_path.exists():
                spec_path.unlink()
            return Success(None)
        except OSError as exc:
            return Failure(f"failed to remove newly-written spec: {exc}")

    if old_spec_bytes is None:
        return Failure("missing rollback snapshot for existing spec")

    try:
        fd, tmp_path_text = tempfile.mkstemp(
            dir=str(spec_path.parent),
            prefix=f".{spec_path.name}.",
            suffix=".rollback.tmp",
        )
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(old_spec_bytes)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path_text, spec_path)
        except Exception:
            with suppress(OSError):
                os.unlink(tmp_path_text)
            raise
    except OSError as exc:
        return Failure(f"failed to rollback spec write: {exc}")

    return Success(None)


# @shell_complexity: validates file shape and digest parity at shell boundary in one pass.
def read_spec_payload(
    spec_path: Path,
    expected_digest: str | None,
    require_non_empty_digest: Callable[[object], str | None],
) -> Result[dict[str, object], str]:
    """Load and validate one registry spec payload from disk."""
    try:
        payload = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return Failure(f"failed to read spec json: {exc}")

    if not isinstance(payload, dict):
        return Failure("spec file must contain a JSON object")

    actual_digest = require_non_empty_digest(payload.get("spec_digest"))
    if actual_digest is None:
        return Failure("spec file must include a non-empty spec_digest")

    if expected_digest is not None:
        expected_digest_value = require_non_empty_digest(expected_digest)
        if expected_digest_value is None:
            return Failure("expected persona digest must be non-empty")
        if actual_digest != expected_digest_value:
            return Failure("digest mismatch between expected digest and spec file")

    return Success(payload)


__all__ = ["read_spec_payload", "rollback_spec_write", "write_json_atomic"]
