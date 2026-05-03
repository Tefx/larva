"""Shell-side PersonaSpec registry storage."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Literal, cast

from returns.result import Failure, Result, Success

from larva.core.validation_contract import CANONICAL_FORBIDDEN_FIELDS
from larva.shell.registry_extra_ops import RegistryExtraOps
from larva.shell.registry_fs import read_spec_payload, rollback_spec_write, write_json_atomic
from larva.shell.registry_types import (
    CLEAR_CONFIRMATION_TOKEN,
    DeleteFailureError,
    IndexReadError,
    InvalidConfirmError,
    InvalidPersonaIdError,
    InvalidVariantNameError,
    MissingPersonaError,
    RegistryCorruptError,
    RegistryError,
    RegistryIndex,
    RegistryStore,
    SpecReadError,
    UpdateFailureError,
    VariantNotFoundError,
    WriteFailureError,
)

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec


DEFAULT_REGISTRY_ROOT = Path("~/.larva/registry").expanduser()
INDEX_FILENAME = "index.json"
MANIFEST_FILENAME = "manifest.json"
VARIANTS_DIRNAME = "variants"
DEFAULT_VARIANT = "default"
SPEC_FILENAME_TEMPLATE = "{id}.json"
_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_VARIANT_NAME_PATTERN = _PERSONA_ID_PATTERN
_MAX_VARIANT_NAME_LENGTH = 64


class FileSystemRegistryStore(RegistryExtraOps, RegistryStore):
    """Filesystem-backed registry adapter rooted at ``~/.larva/registry/``."""

    def __init__(self, root: Path = DEFAULT_REGISTRY_ROOT) -> None:
        self._root = root.expanduser().resolve()

    @property
    def root(self) -> Path:
        """Configured registry root path for this adapter."""
        return self._root

    def save(self, spec: PersonaSpec, variant: str | None = None) -> Result[None, RegistryError]:
        persona_id = str(spec.get("id", ""))
        invalid = self._invalid_id_error(persona_id)
        if invalid is not None:
            return Failure(invalid)

        variant_name = DEFAULT_VARIANT if variant is None else variant
        variant_error = self._invalid_variant_error(variant_name)
        if variant_error is not None:
            return Failure(variant_error)

        spec_path = self._variant_path(persona_id, variant_name)
        if self._require_non_empty_digest(spec.get("spec_digest")) is None:
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
        persona_dir = self._persona_dir(persona_id)
        variants_dir = self._variants_dir(persona_id)
        try:
            variants_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return Failure(
                self._write_failed(
                    persona_id, variants_dir, f"failed to create variants dir: {exc}"
                )
            )

        manifest_path = self._manifest_path(persona_id)
        persona_is_new = not manifest_path.exists()
        active_before: str | None = None
        if not persona_is_new:
            manifest_result = self._read_manifest(persona_id)
            if isinstance(manifest_result, Failure):
                return manifest_result
            active_before = manifest_result.unwrap()
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

        if persona_is_new:
            manifest_write = self._write_json_atomic(
                manifest_path, {"active": variant_name}, "manifest", persona_id
            )
            if isinstance(manifest_write, Failure):
                rollback_error = self._rollback_spec_write(
                    spec_path, old_spec_bytes, spec_existed, persona_id
                )
                if rollback_error is not None:
                    return Failure(rollback_error)
                return manifest_write

        if active_before is None and not persona_is_new:
            return Failure(
                self._registry_corrupt(persona_id, persona_dir, "manifest active pointer missing")
            )

        return Success(None)

    def get(self, persona_id: str) -> Result[PersonaSpec, RegistryError]:
        invalid = self._invalid_id_error(persona_id)
        if invalid is not None:
            return Failure(invalid)

        persona_dir = self._persona_dir(persona_id)
        if persona_dir.exists():
            manifest_result = self._read_manifest(persona_id)
            if isinstance(manifest_result, Failure):
                return manifest_result
            return self.get_variant(persona_id, manifest_result.unwrap())

        spec_path = self._spec_path(persona_id)
        if not spec_path.exists():
            return Failure(self._not_found(persona_id))

        return self._read_spec(persona_id, expected_digest=None)

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        if self._root.exists():
            variant_specs: list[PersonaSpec] = []
            variant_persona_dirs = sorted(
                path
                for path in self._root.iterdir()
                if path.is_dir() and self._invalid_id_error(path.name) is None
            )
            if variant_persona_dirs:
                for persona_dir in variant_persona_dirs:
                    result = self.get(persona_dir.name)
                    if isinstance(result, Failure):
                        return result
                    variant_specs.append(result.unwrap())
                return Success(variant_specs)

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
        if (invalid := self._invalid_id_error(persona_id)) is not None:
            return Failure(invalid)
        persona_dir = self._persona_dir(persona_id)
        if persona_dir.exists():
            try:
                shutil.rmtree(persona_dir)
            except OSError as exc:
                return Failure(
                    {
                        "code": "REGISTRY_DELETE_FAILED",
                        "message": f"failed to remove persona directory: {exc}",
                        "operation": "delete",
                        "persona_id": persona_id,
                        "path": str(persona_dir),
                        "failed_spec_paths": [str(persona_dir)],
                    }
                )
            legacy_path = self._spec_path(persona_id)
            try:
                legacy_path.unlink(missing_ok=True)
                index_result = self._read_index()
                if isinstance(index_result, Success):
                    updated_index = dict(index_result.unwrap())
                    updated_index.pop(persona_id, None)
                    self._write_json_atomic(self._index_path(), updated_index, "index", persona_id)
            except OSError:
                return Success(None)
            return Success(None)
        spec_path = self._spec_path(persona_id)
        if not spec_path.exists():
            return Failure(self._not_found(persona_id))
        index_result = self._read_index()
        if isinstance(index_result, Failure):
            return index_result
        old_index = index_result.unwrap()
        updated_index = dict(old_index)
        updated_index.pop(persona_id, None)
        index_path = self._index_path()
        if isinstance(
            index_write_result := self._write_json_atomic(
                index_path, updated_index, "index", persona_id
            ),
            Failure,
        ):
            return index_write_result
        try:
            spec_path.unlink()
        except OSError as exc:
            message = f"failed to unlink spec file: {exc}"
            if isinstance(
                rollback_result := self._write_json_atomic(
                    index_path, old_index, "index", persona_id
                ),
                Failure,
            ):
                rollback_message = rollback_result.failure()["message"]
                message = f"{message}; rollback failed while restoring index: {rollback_message}"
            return Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": message,
                    "operation": "delete",
                    "persona_id": persona_id,
                    "path": str(spec_path),
                    "failed_spec_paths": [str(spec_path)],
                }
            )
        return Success(None)

    def _index_path(self) -> Path:
        return self._root / INDEX_FILENAME

    def _spec_path(self, persona_id: str) -> Path:
        return self._root / SPEC_FILENAME_TEMPLATE.format(id=persona_id)

    def _persona_dir(self, persona_id: str) -> Path:
        return self._root / persona_id

    def _manifest_path(self, persona_id: str) -> Path:
        return self._persona_dir(persona_id) / MANIFEST_FILENAME

    def _variants_dir(self, persona_id: str) -> Path:
        return self._persona_dir(persona_id) / VARIANTS_DIRNAME

    def _variant_path(self, persona_id: str, variant: str) -> Path:
        return self._variants_dir(persona_id) / f"{variant}.json"

    def _invalid_id_error(self, persona_id: str) -> InvalidPersonaIdError | None:
        if _PERSONA_ID_PATTERN.fullmatch(persona_id) is not None:
            return None
        return {
            "code": "INVALID_PERSONA_ID",
            "message": f"invalid persona id '{persona_id}': expected flat kebab-case",
            "persona_id": persona_id,
        }

    def _invalid_variant_error(self, variant: str) -> InvalidVariantNameError | None:
        if (
            len(variant) <= _MAX_VARIANT_NAME_LENGTH
            and _VARIANT_NAME_PATTERN.fullmatch(variant) is not None
        ):
            return None
        return {
            "code": "INVALID_VARIANT_NAME",
            "message": f"invalid variant name '{variant}': expected lower kebab-case <= 64 chars",
            "variant": variant,
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

    _CANONICAL_FORBIDDEN_FIELDS: ClassVar[frozenset[str]] = frozenset(CANONICAL_FORBIDDEN_FIELDS)

    def _read_spec(
        self, persona_id: str, expected_digest: str | None
    ) -> Result[PersonaSpec, RegistryError]:
        spec_path = self._spec_path(persona_id)
        return self._read_spec_at(persona_id, spec_path, expected_digest)

    def _read_spec_at(
        self, persona_id: str, spec_path: Path, expected_digest: str | None
    ) -> Result[PersonaSpec, RegistryError]:
        if not spec_path.exists():
            return Failure(
                self._spec_read_failed(
                    persona_id, spec_path, "spec file referenced by index is missing"
                )
            )

        payload_result = read_spec_payload(
            spec_path, expected_digest, self._require_non_empty_digest
        )
        if isinstance(payload_result, Failure):
            return Failure(self._spec_read_failed(persona_id, spec_path, payload_result.failure()))

        payload = payload_result.unwrap()

        # Hard-cut canonical boundary: reject stored records containing
        # forbidden legacy fields. No silent field dropping, no auto-rewrite.
        for field in self._CANONICAL_FORBIDDEN_FIELDS:
            if field in payload:
                return Failure(
                    self._spec_read_failed(
                        persona_id,
                        spec_path,
                        f"spec contains legacy field '{field}' which is not "
                        f"permitted at canonical boundary",
                    )
                )

        return Success(cast("PersonaSpec", payload))

    def _variant_not_found(self, persona_id: str, variant: str) -> VariantNotFoundError:
        return {
            "code": "VARIANT_NOT_FOUND",
            "message": f"variant '{variant}' not found for persona '{persona_id}'",
            "persona_id": persona_id,
            "variant": variant,
        }

    def _registry_corrupt(self, persona_id: str, path: Path, message: str) -> RegistryCorruptError:
        return {
            "code": "REGISTRY_CORRUPT",
            "message": message,
            "persona_id": persona_id,
            "path": str(path),
        }

    def _require_non_empty_digest(self, digest: object) -> str | None:
        if isinstance(digest, str) and digest.strip():
            return digest
        return None

    def _write_json_atomic(
        self,
        path: Path,
        payload: object,
        kind: Literal["spec", "index", "manifest"],
        persona_id: str,
    ) -> Result[None, RegistryError]:
        result = write_json_atomic(path, payload)
        if isinstance(result, Failure):
            exc = result.failure()
            if kind == "spec":
                return Failure(self._write_failed(persona_id, path, f"failed to write spec: {exc}"))
            return Failure(self._update_failed(persona_id, path, f"failed to update {kind}: {exc}"))
        return Success(None)

    def _rollback_spec_write(
        self,
        spec_path: Path,
        old_spec_bytes: bytes | None,
        spec_existed: bool,
        persona_id: str,
    ) -> WriteFailureError | None:
        result = rollback_spec_write(spec_path, old_spec_bytes, spec_existed)
        if isinstance(result, Failure):
            return self._write_failed(persona_id, spec_path, result.failure())
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
    "InvalidConfirmError",
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
    "shutil",
]
