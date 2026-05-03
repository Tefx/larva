"""Shell-side PersonaSpec registry storage."""

# @invar:allow file_size: registry variant rollout preserves existing public exports while filling contract stubs; planned split requires a separate compatibility-safe refactor.

from __future__ import annotations

import json
import shutil
import re
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Literal, Protocol, TypeAlias, TypedDict, cast

from returns.result import Failure, Result, Success

from larva.core.validation_contract import CANONICAL_FORBIDDEN_FIELDS
from larva.shell.registry_fs import read_spec_payload, rollback_spec_write, write_json_atomic

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec


DEFAULT_REGISTRY_ROOT = Path("~/.larva/registry").expanduser()
INDEX_FILENAME = "index.json"
MANIFEST_FILENAME = "manifest.json"
VARIANTS_DIRNAME = "variants"
DEFAULT_VARIANT = "default"
SPEC_FILENAME_TEMPLATE = "{id}.json"
CLEAR_CONFIRMATION_TOKEN = "CLEAR REGISTRY"
_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_VARIANT_NAME_PATTERN = _PERSONA_ID_PATTERN
_MAX_VARIANT_NAME_LENGTH = 64


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


class InvalidConfirmError(TypedDict):
    """Confirmation token does not match required value for destructive operation."""

    code: Literal["INVALID_CONFIRMATION_TOKEN"]
    message: str


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


class RegistryCorruptError(TypedDict):
    """Registry-local variant metadata is missing or internally inconsistent."""

    code: Literal["REGISTRY_CORRUPT"]
    message: str
    persona_id: str
    path: str


class InvalidVariantNameError(TypedDict):
    """Variant name violates the local lower-kebab slug rule."""

    code: Literal["INVALID_VARIANT_NAME"]
    message: str
    variant: str


class VariantNotFoundError(TypedDict):
    """Requested variant does not exist for an existing persona."""

    code: Literal["VARIANT_NOT_FOUND"]
    message: str
    persona_id: str
    variant: str


class ActiveVariantDeleteForbiddenError(TypedDict):
    """Caller attempted to delete the active variant."""

    code: Literal["ACTIVE_VARIANT_DELETE_FORBIDDEN"]
    message: str
    persona_id: str
    variant: str


class LastVariantDeleteForbiddenError(TypedDict):
    """Caller attempted to delete the only remaining variant."""

    code: Literal["LAST_VARIANT_DELETE_FORBIDDEN"]
    message: str
    persona_id: str
    variant: str


class VariantList(TypedDict):
    """Registry-local variant metadata for a base persona id."""

    id: str
    active: str
    variants: list[str]


RegistryError: TypeAlias = (
    MissingPersonaError
    | InvalidPersonaIdError
    | InvalidConfirmError
    | IndexReadError
    | SpecReadError
    | WriteFailureError
    | UpdateFailureError
    | DeleteFailureError
    | RegistryCorruptError
    | InvalidVariantNameError
    | VariantNotFoundError
    | ActiveVariantDeleteForbiddenError
    | LastVariantDeleteForbiddenError
)
"""Typed shell error surface for registry persistence operations."""


RegistryIndex: TypeAlias = dict[str, str]
"""Canonical ``index.json`` mapping from persona id to spec_digest."""


class RegistryStore(Protocol):
    """Authoritative shell-side contract for canonical PersonaSpec storage."""

    def save(self, spec: PersonaSpec, variant: str | None = None) -> Result[None, RegistryError]:
        """Persist one canonical PersonaSpec and update digest index."""
        ...

    def get_variant(self, persona_id: str, variant: str) -> Result[PersonaSpec, RegistryError]:
        """Load one named registry-local variant for a base persona id."""
        ...

    def variant_list(self, persona_id: str) -> Result[VariantList, RegistryError]:
        """Return registry-local variant metadata for a base persona id."""
        ...

    def variant_activate(self, persona_id: str, variant: str) -> Result[VariantList, RegistryError]:
        """Set the active variant pointer for a base persona id."""
        ...

    def variant_delete(self, persona_id: str, variant: str) -> Result[None, RegistryError]:
        """Delete an inactive, non-last registry-local variant."""
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

    def clear(self, confirm: str = CLEAR_CONFIRMATION_TOKEN) -> Result[int, RegistryError]:
        """Delete all personas only when ``confirm`` exactly matches token.

        Returns the count of personas that were cleared on success.

        Behavioral contract:
        - ``confirm`` must exactly equal ``CLEAR_CONFIRMATION_TOKEN``.
        - Wrong confirmation token returns ``INVALID_CONFIRMATION_TOKEN`` error
          without any filesystem mutation.
        - Index removal is ordered before per-spec file deletions.
        - Partial spec-file deletion failures after index removal MUST be
          reported as ``REGISTRY_DELETE_FAILED`` with remaining failed paths.
        """

        ...


class FileSystemRegistryStore(RegistryStore):
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
        persona_dir = self._persona_dir(persona_id)
        variants_dir = self._variants_dir(persona_id)
        try:
            variants_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return Failure(self._write_failed(persona_id, variants_dir, f"failed to create variants dir: {exc}"))

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
                rollback_error = self._rollback_spec_write(spec_path, old_spec_bytes, spec_existed, persona_id)
                if rollback_error is not None:
                    return Failure(rollback_error)
                return manifest_write

        legacy_result = self._write_legacy_projection(persona_id, spec, spec_digest)
        if isinstance(legacy_result, Failure):
            if persona_is_new:
                with suppress(OSError):
                    manifest_path.unlink()
            rollback_error = self._rollback_spec_write(spec_path, old_spec_bytes, spec_existed, persona_id)
            if rollback_error is not None:
                return Failure(rollback_error)
            return legacy_result

        if active_before is None and not persona_is_new:
            return Failure(self._registry_corrupt(persona_id, persona_dir, "manifest active pointer missing"))

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
                path for path in self._root.iterdir() if path.is_dir() and self._invalid_id_error(path.name) is None
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

    def clear(self, confirm: str = CLEAR_CONFIRMATION_TOKEN) -> Result[int, RegistryError]:
        if confirm != CLEAR_CONFIRMATION_TOKEN:
            return Failure(
                {
                    "code": "INVALID_CONFIRMATION_TOKEN",
                    "message": "clear requires exact confirmation token 'CLEAR REGISTRY'",
                }
            )

        index_result = self._read_index()
        if isinstance(index_result, Failure):
            return index_result

        index = index_result.unwrap()
        clear_count = len(index)
        index_path = self._index_path()

        if index_path.exists():
            try:
                index_path.unlink()
            except OSError as exc:
                return Failure(
                    {
                        "code": "REGISTRY_DELETE_FAILED",
                        "message": f"failed to remove registry index during clear: {exc}",
                        "operation": "clear",
                        "persona_id": None,
                        "path": str(index_path),
                        "failed_spec_paths": [],
                    }
                )

        failed_spec_paths: list[str] = []
        if self._root.exists():
            for persona_dir in sorted(path for path in self._root.iterdir() if path.is_dir()):
                try:
                    shutil.rmtree(persona_dir)
                except OSError as exc:
                    failed_spec_paths.append(f"{persona_dir}: {exc}")
        for persona_id in sorted(index):
            spec_path = self._spec_path(persona_id)
            try:
                spec_path.unlink(missing_ok=True)
            except OSError as exc:
                failed_spec_paths.append(f"{spec_path}: {exc}")

        if failed_spec_paths:
            return Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to remove one or more persona specs during clear",
                    "operation": "clear",
                    "persona_id": None,
                    "path": str(index_path),
                    "failed_spec_paths": failed_spec_paths,
                }
            )

        return Success(clear_count)

    def get_variant(self, persona_id: str, variant: str) -> Result[PersonaSpec, RegistryError]:
        if (invalid := self._invalid_id_error(persona_id)) is not None:
            return Failure(invalid)
        if (variant_error := self._invalid_variant_error(variant)) is not None:
            return Failure(variant_error)
        persona_dir = self._persona_dir(persona_id)
        if not persona_dir.exists():
            return Failure(self._not_found(persona_id))
        variant_path = self._variant_path(persona_id, variant)
        if not variant_path.exists():
            return Failure(self._variant_not_found(persona_id, variant))
        spec_result = self._read_spec_at(persona_id, variant_path, expected_digest=None)
        if isinstance(spec_result, Failure):
            return spec_result
        spec = spec_result.unwrap()
        if spec.get("id") != persona_id:
            return Failure(self._registry_corrupt(persona_id, variant_path, "variant spec id must match persona directory name"))
        return Success(spec)

    def variant_list(self, persona_id: str) -> Result[VariantList, RegistryError]:
        if (invalid := self._invalid_id_error(persona_id)) is not None:
            return Failure(invalid)
        if not self._persona_dir(persona_id).exists():
            return Failure(self._not_found(persona_id))
        active_result = self._read_manifest(persona_id)
        if isinstance(active_result, Failure):
            return active_result
        variants = self._scan_variants(persona_id)
        if isinstance(variants, Failure):
            return variants
        active = active_result.unwrap()
        if active not in variants.unwrap():
            return Failure(self._registry_corrupt(persona_id, self._manifest_path(persona_id), "manifest active variant is missing"))
        return Success({"id": persona_id, "active": active, "variants": variants.unwrap()})

    def variant_activate(self, persona_id: str, variant: str) -> Result[VariantList, RegistryError]:
        if (invalid := self._invalid_id_error(persona_id)) is not None:
            return Failure(invalid)
        if (variant_error := self._invalid_variant_error(variant)) is not None:
            return Failure(variant_error)
        if not self._persona_dir(persona_id).exists():
            return Failure(self._not_found(persona_id))
        if not self._variant_path(persona_id, variant).exists():
            return Failure(self._variant_not_found(persona_id, variant))
        write_result = self._write_json_atomic(self._manifest_path(persona_id), {"active": variant}, "manifest", persona_id)
        if isinstance(write_result, Failure):
            return write_result
        return self.variant_list(persona_id)

    def variant_delete(self, persona_id: str, variant: str) -> Result[None, RegistryError]:
        metadata = self.variant_list(persona_id)
        if isinstance(metadata, Failure):
            return metadata
        payload = metadata.unwrap()
        if variant not in payload["variants"]:
            return Failure(self._variant_not_found(persona_id, variant))
        if len(payload["variants"]) == 1:
            return Failure({"code": "LAST_VARIANT_DELETE_FORBIDDEN", "message": "cannot delete last variant", "persona_id": persona_id, "variant": variant})
        if payload["active"] == variant:
            return Failure({"code": "ACTIVE_VARIANT_DELETE_FORBIDDEN", "message": "cannot delete active variant", "persona_id": persona_id, "variant": variant})
        try:
            self._variant_path(persona_id, variant).unlink()
        except OSError as exc:
            return Failure({"code": "REGISTRY_DELETE_FAILED", "message": f"failed to unlink variant: {exc}", "operation": "delete", "persona_id": persona_id, "path": str(self._variant_path(persona_id, variant)), "failed_spec_paths": [str(self._variant_path(persona_id, variant))]})
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
        if len(variant) <= _MAX_VARIANT_NAME_LENGTH and _VARIANT_NAME_PATTERN.fullmatch(variant) is not None:
            return None
        return {"code": "INVALID_VARIANT_NAME", "message": f"invalid variant name '{variant}': expected lower kebab-case <= 64 chars", "variant": variant}

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

    _CANONICAL_FORBIDDEN_FIELDS: ClassVar[frozenset[str]] = frozenset(
        CANONICAL_FORBIDDEN_FIELDS
    )

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

    def _read_manifest(self, persona_id: str) -> Result[str, RegistryError]:
        manifest_path = self._manifest_path(persona_id)
        if not manifest_path.exists():
            return Failure(self._registry_corrupt(persona_id, manifest_path, "manifest.json is missing"))
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return Failure(self._registry_corrupt(persona_id, manifest_path, f"failed to read manifest: {exc}"))
        if not isinstance(payload, dict) or set(payload) != {"active"} or not isinstance(payload.get("active"), str):
            return Failure(self._registry_corrupt(persona_id, manifest_path, "manifest must contain exactly an active string pointer"))
        active = payload["active"]
        if self._invalid_variant_error(active) is not None:
            return Failure(self._registry_corrupt(persona_id, manifest_path, "manifest active variant name is invalid"))
        if not self._variant_path(persona_id, active).exists():
            return Failure(self._registry_corrupt(persona_id, manifest_path, "manifest active variant is missing"))
        return Success(active)

    def _scan_variants(self, persona_id: str) -> Result[list[str], RegistryError]:
        variants_dir = self._variants_dir(persona_id)
        if not variants_dir.exists() or not variants_dir.is_dir():
            return Failure(self._registry_corrupt(persona_id, variants_dir, "variants directory is missing"))
        variants: list[str] = []
        for path in sorted(variants_dir.glob("*.json")):
            variant_name = path.stem
            if self._invalid_variant_error(variant_name) is not None:
                return Failure(self._registry_corrupt(persona_id, path, "variant filename is invalid"))
            variants.append(variant_name)
        if not variants:
            return Failure(self._registry_corrupt(persona_id, variants_dir, "persona has no variants"))
        return Success(variants)

    def _write_legacy_projection(self, persona_id: str, spec: PersonaSpec, spec_digest: str) -> Result[None, RegistryError]:
        legacy_spec = self._spec_path(persona_id)
        old_spec_bytes: bytes | None = None
        spec_existed = legacy_spec.exists()
        if spec_existed:
            try:
                old_spec_bytes = legacy_spec.read_bytes()
            except OSError as exc:
                return Failure(self._write_failed(persona_id, legacy_spec, f"failed to snapshot legacy spec: {exc}"))
        spec_result = self._write_json_atomic(legacy_spec, spec, "spec", persona_id)
        if isinstance(spec_result, Failure):
            return spec_result
        index_result = self._read_index()
        if isinstance(index_result, Failure):
            rollback_error = self._rollback_spec_write(legacy_spec, old_spec_bytes, spec_existed, persona_id)
            if rollback_error is not None:
                return Failure(rollback_error)
            return index_result
        index = dict(index_result.unwrap())
        index[persona_id] = spec_digest
        index_write = self._write_json_atomic(self._index_path(), index, "index", persona_id)
        if isinstance(index_write, Failure):
            rollback_error = self._rollback_spec_write(legacy_spec, old_spec_bytes, spec_existed, persona_id)
            if rollback_error is not None:
                return Failure(rollback_error)
        return index_write

    def _variant_not_found(self, persona_id: str, variant: str) -> VariantNotFoundError:
        return {"code": "VARIANT_NOT_FOUND", "message": f"variant '{variant}' not found for persona '{persona_id}'", "persona_id": persona_id, "variant": variant}

    def _registry_corrupt(self, persona_id: str, path: Path, message: str) -> RegistryCorruptError:
        return {"code": "REGISTRY_CORRUPT", "message": message, "persona_id": persona_id, "path": str(path)}

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
]
