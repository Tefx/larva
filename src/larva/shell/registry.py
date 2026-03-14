"""Contract surface for shell-side persona registry storage.

This module defines the shell boundary for canonical PersonaSpec persistence in
the documented global registry location: ``~/.larva/registry/``.

Scope of this contract module:
- define typed registry errors and storage protocols
- define contract-only filesystem adapter signatures

Out of scope for this contract step:
- filesystem I/O implementation
- JSON serialization/deserialization implementation
- override application, revalidation, or renormalization flows
- CLI/MCP/Python transport formatting

Boundary citations:
- ARCHITECTURE.md :: Module: ``larva.shell.registry``
- ARCHITECTURE.md :: 7. Cross-Module Interface Contracts
- ARCHITECTURE.md :: 8. Error Boundary Model
- INTERFACES.md :: D. Global Registry
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol, TypeAlias, TypedDict, cast

from returns.result import Failure, Result, Success

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec


DEFAULT_REGISTRY_ROOT = Path("~/.larva/registry").expanduser()
INDEX_FILENAME = "index.json"
SPEC_FILENAME_TEMPLATE = "{id}.json"
CLEAR_CONFIRMATION_TOKEN = "CLEAR REGISTRY"
_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


class MissingPersonaError(TypedDict):
    """Persona id exists in request but no matching stored record is found."""

    code: Literal["PERSONA_NOT_FOUND"]
    message: str
    persona_id: str


class InvalidPersonaIdError(TypedDict):
    """Persona id violates the flat kebab-case rule."""

    code: Literal["INVALID_PERSONA_ID"]
    message: str
    persona_id: str


class IndexReadError(TypedDict):
    """Failure reading or decoding ``index.json`` from registry root."""

    code: Literal["REGISTRY_INDEX_READ_FAILED"]
    message: str
    path: str


class SpecReadError(TypedDict):
    """Failure reading or decoding ``<id>.json`` PersonaSpec data."""

    code: Literal["REGISTRY_SPEC_READ_FAILED"]
    message: str
    persona_id: str
    path: str


class WriteFailureError(TypedDict):
    """Failure writing a persona spec file to registry storage."""

    code: Literal["REGISTRY_WRITE_FAILED"]
    message: str
    persona_id: str
    path: str


class UpdateFailureError(TypedDict):
    """Failure updating ``index.json`` mapping for persisted persona digest."""

    code: Literal["REGISTRY_UPDATE_FAILED"]
    message: str
    persona_id: str
    path: str


class DeleteFailureError(TypedDict):
    """Failure removing one or more persona spec files from registry storage."""

    code: Literal["REGISTRY_DELETE_FAILED"]
    message: str
    operation: Literal["delete", "clear"]
    persona_id: str | None
    path: str
    failed_spec_paths: list[str]


RegistryError: TypeAlias = (
    MissingPersonaError
    | InvalidPersonaIdError
    | IndexReadError
    | SpecReadError
    | WriteFailureError
    | UpdateFailureError
    | DeleteFailureError
)
"""Typed shell error surface for registry persistence operations."""


RegistryIndex: TypeAlias = dict[str, str]
"""Canonical ``index.json`` mapping from persona id to spec_digest."""


class RegistryStore(Protocol):
    """Authoritative shell-side contract for canonical PersonaSpec storage."""

    def save(self, spec: PersonaSpec) -> Result[None, RegistryError]:
        """Persist one canonical PersonaSpec and update digest index."""
        ...

    def get(self, persona_id: str) -> Result[PersonaSpec, RegistryError]:
        """Load one canonical PersonaSpec by flat kebab-case id."""
        ...

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        """Enumerate canonical PersonaSpec records from registry boundary."""
        ...

    def delete(self, persona_id: str) -> Result[None, RegistryError]:
        """Delete one persona using index-first safety ordering.

        Behavioral contract:
        - MUST update ``index.json`` first so the highest-risk invariant is
          ``no dangling index entry``.
        - If spec-file unlink fails after index update, implementation MUST
          perform best-effort rollback restoring the prior index entry.
        - Missing ids MUST surface ``PERSONA_NOT_FOUND``.
        """

        ...

    def clear(self, confirm: str = CLEAR_CONFIRMATION_TOKEN) -> Result[None, RegistryError]:
        """Delete all personas only when ``confirm`` exactly matches token.

        Behavioral contract:
        - ``confirm`` must exactly equal ``CLEAR_CONFIRMATION_TOKEN``.
        - Index removal is ordered before per-spec file deletions.
        - Partial spec-file deletion failures after index removal MUST be
          reported as ``REGISTRY_DELETE_FAILED`` with remaining failed paths.
        """

        ...


class FileSystemRegistryStore(RegistryStore):
    """Filesystem-backed registry adapter contract.

    Root location is ``~/.larva/registry/`` by default.
    - Persona records: ``<id>.json``
    - Digest index: ``index.json``

    This class is intentionally contract-only in this step.
    """

    def __init__(self, root: Path = DEFAULT_REGISTRY_ROOT) -> None:
        self._root = root.expanduser().resolve()

    @property
    def root(self) -> Path:
        """Configured registry root path for this adapter."""
        return self._root

    def save(self, spec: PersonaSpec) -> Result[None, RegistryError]:
        persona_id = str(spec.get("id", ""))
        invalid = self._invalid_id_error(persona_id)
        if invalid is not None:
            return Failure(invalid)

        spec_path = self._spec_path(persona_id)
        spec_digest = self._require_non_empty_digest(spec.get("spec_digest"))
        if spec_digest is None:
            return Failure(
                self._write_failed(
                    persona_id,
                    spec_path,
                    "spec_digest must be a non-empty string",
                )
            )

        root_create_error = self._ensure_root_exists(persona_id)
        if root_create_error is not None:
            return Failure(root_create_error)

        index_result = self._read_index()
        if isinstance(index_result, Failure):
            return index_result

        index_path = self._index_path()
        old_spec_bytes: bytes | None = None
        spec_existed = spec_path.exists()
        if spec_existed:
            try:
                old_spec_bytes = spec_path.read_bytes()
            except OSError as exc:
                return Failure(
                    self._write_failed(
                        persona_id, spec_path, f"failed to snapshot existing spec: {exc}"
                    )
                )

        spec_write_result = self._write_json_atomic(spec_path, spec, "spec", persona_id)
        if isinstance(spec_write_result, Failure):
            return spec_write_result

        updated_index = dict(index_result.unwrap())
        updated_index[persona_id] = spec_digest

        index_write_result = self._write_json_atomic(index_path, updated_index, "index", persona_id)
        if isinstance(index_write_result, Failure):
            rollback_error = self._rollback_spec_write(
                spec_path=spec_path,
                old_spec_bytes=old_spec_bytes,
                spec_existed=spec_existed,
                persona_id=persona_id,
            )
            if rollback_error is not None:
                rollback_message = index_write_result.failure()["message"]
                rollback_message = (
                    f"{rollback_message}; rollback failed: {rollback_error['message']}"
                )
                return Failure(
                    self._update_failed(
                        persona_id,
                        index_path,
                        rollback_message,
                    )
                )
            return index_write_result

        return Success(None)

    def get(self, persona_id: str) -> Result[PersonaSpec, RegistryError]:
        invalid = self._invalid_id_error(persona_id)
        if invalid is not None:
            return Failure(invalid)

        spec_path = self._spec_path(persona_id)
        if not spec_path.exists():
            return Failure(self._not_found(persona_id))

        return self._read_spec(persona_id, expected_digest=None)

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        index_result = self._read_index()
        if isinstance(index_result, Failure):
            return index_result

        index = index_result.unwrap()
        specs: list[PersonaSpec] = []
        for persona_id, expected_digest in sorted(index.items()):
            invalid = self._invalid_id_error(persona_id)
            if invalid is not None:
                return Failure(invalid)

            spec_result = self._read_spec(persona_id, expected_digest)
            if isinstance(spec_result, Failure):
                return spec_result
            specs.append(spec_result.unwrap())

        return Success(specs)

    def delete(self, persona_id: str) -> Result[None, RegistryError]:
        """Contract stub: delete behavior is acceptance-only in this step."""

        raise NotImplementedError("delete contract accepted; implementation is out of scope")

    def clear(self, confirm: str = CLEAR_CONFIRMATION_TOKEN) -> Result[None, RegistryError]:
        """Contract stub: clear behavior is acceptance-only in this step."""

        raise NotImplementedError("clear contract accepted; implementation is out of scope")

    def _index_path(self) -> Path:
        return self._root / INDEX_FILENAME

    def _spec_path(self, persona_id: str) -> Path:
        return self._root / SPEC_FILENAME_TEMPLATE.format(id=persona_id)

    def _invalid_id_error(self, persona_id: str) -> InvalidPersonaIdError | None:
        if _PERSONA_ID_PATTERN.fullmatch(persona_id) is not None:
            return None
        return {
            "code": "INVALID_PERSONA_ID",
            "message": f"invalid persona id '{persona_id}': expected flat kebab-case",
            "persona_id": persona_id,
        }

    def _not_found(self, persona_id: str) -> MissingPersonaError:
        return {
            "code": "PERSONA_NOT_FOUND",
            "message": f"persona '{persona_id}' not found in registry",
            "persona_id": persona_id,
        }

    def _ensure_root_exists(self, persona_id: str) -> WriteFailureError | None:
        try:
            self._root.mkdir(parents=True, exist_ok=True)
            return None
        except OSError as exc:
            return self._write_failed(
                persona_id, self._root, f"failed to create registry root: {exc}"
            )

    def _read_index(self) -> Result[RegistryIndex, RegistryError]:
        index_path = self._index_path()
        if not index_path.exists():
            return Success({})

        try:
            payload = json.loads(index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": f"failed to read registry index: {exc}",
                    "path": str(index_path),
                }
            )

        if not isinstance(payload, dict):
            return Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "registry index must be a JSON object",
                    "path": str(index_path),
                }
            )

        index: RegistryIndex = {}
        for key, value in payload.items():
            if not isinstance(key, str) or not isinstance(value, str):
                return Failure(
                    {
                        "code": "REGISTRY_INDEX_READ_FAILED",
                        "message": "registry index must map string ids to string digests",
                        "path": str(index_path),
                    }
                )
            if self._require_non_empty_digest(value) is None:
                return Failure(
                    {
                        "code": "REGISTRY_INDEX_READ_FAILED",
                        "message": "registry index digest values must be non-empty strings",
                        "path": str(index_path),
                    }
                )
            index[key] = value

        return Success(index)

    def _read_spec(
        self, persona_id: str, expected_digest: str | None
    ) -> Result[PersonaSpec, RegistryError]:
        spec_path = self._spec_path(persona_id)
        if not spec_path.exists():
            return Failure(
                self._spec_read_failed(
                    persona_id, spec_path, "spec file referenced by index is missing"
                )
            )

        try:
            payload = json.loads(spec_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return Failure(
                self._spec_read_failed(persona_id, spec_path, f"failed to read spec json: {exc}")
            )

        if not isinstance(payload, dict):
            return Failure(
                self._spec_read_failed(
                    persona_id, spec_path, "spec file must contain a JSON object"
                )
            )

        actual_digest = self._require_non_empty_digest(payload.get("spec_digest"))
        if actual_digest is None:
            return Failure(
                self._spec_read_failed(
                    persona_id,
                    spec_path,
                    "spec file must include a non-empty spec_digest",
                )
            )

        if expected_digest is not None:
            expected_digest_value = self._require_non_empty_digest(expected_digest)
            if expected_digest_value is None:
                return Failure(
                    self._spec_read_failed(
                        persona_id,
                        spec_path,
                        "index entry for persona must include a non-empty digest",
                    )
                )
            if actual_digest != expected_digest_value:
                return Failure(
                    self._spec_read_failed(
                        persona_id,
                        spec_path,
                        "digest mismatch between index.json and spec file",
                    )
                )

        return Success(cast("PersonaSpec", payload))

    def _require_non_empty_digest(self, digest: object) -> str | None:
        if isinstance(digest, str) and digest.strip():
            return digest
        return None

    def _write_json_atomic(
        self,
        path: Path,
        payload: object,
        kind: Literal["spec", "index"],
        persona_id: str,
    ) -> Result[None, RegistryError]:
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
            if kind == "spec":
                return Failure(self._write_failed(persona_id, path, f"failed to write spec: {exc}"))
            return Failure(self._update_failed(persona_id, path, f"failed to update index: {exc}"))

        return Success(None)

    def _rollback_spec_write(
        self,
        spec_path: Path,
        old_spec_bytes: bytes | None,
        spec_existed: bool,
        persona_id: str,
    ) -> WriteFailureError | None:
        if not spec_existed:
            try:
                if spec_path.exists():
                    spec_path.unlink()
                return None
            except OSError as exc:
                return self._write_failed(
                    persona_id, spec_path, f"failed to remove newly-written spec: {exc}"
                )

        if old_spec_bytes is None:
            return self._write_failed(
                persona_id, spec_path, "missing rollback snapshot for existing spec"
            )

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
            return self._write_failed(
                persona_id, spec_path, f"failed to rollback spec write: {exc}"
            )

        return None

    def _spec_read_failed(self, persona_id: str, path: Path, message: str) -> SpecReadError:
        return {
            "code": "REGISTRY_SPEC_READ_FAILED",
            "message": message,
            "persona_id": persona_id,
            "path": str(path),
        }

    def _write_failed(self, persona_id: str, path: Path, message: str) -> WriteFailureError:
        return {
            "code": "REGISTRY_WRITE_FAILED",
            "message": message,
            "persona_id": persona_id,
            "path": str(path),
        }

    def _update_failed(self, persona_id: str, path: Path, message: str) -> UpdateFailureError:
        return {
            "code": "REGISTRY_UPDATE_FAILED",
            "message": message,
            "persona_id": persona_id,
            "path": str(path),
        }


__all__ = [
    "CLEAR_CONFIRMATION_TOKEN",
    "DEFAULT_REGISTRY_ROOT",
    "DeleteFailureError",
    "INDEX_FILENAME",
    "SPEC_FILENAME_TEMPLATE",
    "FileSystemRegistryStore",
    "IndexReadError",
    "InvalidPersonaIdError",
    "MissingPersonaError",
    "RegistryError",
    "RegistryIndex",
    "RegistryStore",
    "SpecReadError",
    "UpdateFailureError",
    "WriteFailureError",
]
