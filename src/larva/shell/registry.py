"""Shell-side PersonaSpec registry storage."""

from __future__ import annotations

import re
import shutil
import json
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Literal, cast

from returns.result import Failure, Result, Success

from larva.core.normalize import compute_spec_digest
from larva.core.validation_contract import CANONICAL_FORBIDDEN_FIELDS
from larva.shell.registry_extra_ops import RegistryExtraOps
from larva.shell.registry_fs import read_spec_payload, rollback_spec_write, write_json_atomic
from larva.shell.registry_types import (
    CLEAR_CONFIRMATION_TOKEN,
    DeleteFailureError,
    InvalidConfirmError,
    InvalidPersonaIdError,
    InvalidVariantNameError,
    MissingPersonaError,
    RegistryCorruptError,
    RegistryError,
    RegistryStore,
    SpecReadError,
    UpdateFailureError,
    VariantNotFoundError,
    WriteFailureError,
)

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec


DEFAULT_REGISTRY_ROOT = Path("~/.larva/registry").expanduser()
MANIFEST_FILENAME = "manifest.json"
CONTRACT_FILENAME = "contract.json"
VARIANTS_DIRNAME = "variants"
DEFAULT_VARIANT = "default"
_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_VARIANT_NAME_PATTERN = _PERSONA_ID_PATTERN
_MAX_VARIANT_NAME_LENGTH = 64
_CONTRACT_FIELDS = frozenset({"id", "description", "capabilities", "can_spawn", "spec_version"})
_CONTRACT_REQUIRED_FIELDS = frozenset({"id", "description", "capabilities", "spec_version"})
_VARIANT_FIELDS = frozenset({"prompt", "model", "model_params", "compaction_prompt"})
_VARIANT_REQUIRED_FIELDS = frozenset({"prompt", "model"})


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

        contract = {field: spec[field] for field in _CONTRACT_FIELDS if field in spec}
        implementation = {field: spec[field] for field in _VARIANT_FIELDS if field in spec}
        contract_path = self._contract_path(persona_id)
        variant_path = self._variant_path(persona_id, variant_name)

        contract_validation = self._validate_contract_payload(persona_id, contract_path, contract)
        if isinstance(contract_validation, Failure):
            return contract_validation
        implementation_validation = self._validate_variant_payload(persona_id, variant_path, implementation)
        if isinstance(implementation_validation, Failure):
            return implementation_validation

        if self._require_non_empty_digest(spec.get("spec_digest")) is None:
            return Failure(
                self._write_failed(
                    persona_id,
                    variant_path,
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
            contract_match = self._require_matching_contract(persona_id, contract)
            if isinstance(contract_match, Failure):
                return contract_match
        old_variant_bytes: bytes | None = None
        variant_existed = variant_path.exists()
        if variant_existed:
            try:
                old_variant_bytes = variant_path.read_bytes()
            except OSError as exc:
                return Failure(
                    self._write_failed(
                        persona_id, variant_path, f"failed to snapshot existing variant: {exc}"
                    )
                )

        if persona_is_new:
            contract_write_result = self._write_json_atomic(contract_path, contract, "spec", persona_id)
            if isinstance(contract_write_result, Failure):
                return contract_write_result

        variant_write_result = self._write_json_atomic(variant_path, implementation, "spec", persona_id)
        if isinstance(variant_write_result, Failure):
            return variant_write_result

        if persona_is_new:
            manifest_write = self._write_json_atomic(
                manifest_path, {"active": variant_name}, "manifest", persona_id
            )
            if isinstance(manifest_write, Failure):
                rollback_error = self._rollback_spec_write(
                    variant_path, old_variant_bytes, variant_existed, persona_id
                )
                if rollback_error is not None:
                    return Failure(rollback_error)
                return manifest_write

        if active_before is None and not persona_is_new:
            return Failure(
                self._registry_corrupt(persona_id, persona_dir, "manifest active pointer missing")
            )

        return Success(None)

    def _require_matching_contract(
        self, persona_id: str, contract: dict[str, object]
    ) -> Result[None, RegistryError]:
        existing_contract = self._read_contract(persona_id)
        if isinstance(existing_contract, Failure):
            return existing_contract
        mismatched_fields = sorted(
            field for field in _CONTRACT_FIELDS if existing_contract.unwrap().get(field) != contract.get(field)
        )
        if mismatched_fields:
            return Failure(
                {
                    "code": "BASE_CONTRACT_MISMATCH",
                    "message": "registered variant contract fields differ from existing base persona contract",
                    "persona_id": persona_id,
                    "mismatched_fields": mismatched_fields,
                }
            )
        return Success(None)

    def update_materialized(
        self, spec: PersonaSpec, variant: str | None = None
    ) -> Result[None, RegistryError]:
        persona_id = str(spec.get("id", ""))
        if (invalid := self._invalid_id_error(persona_id)) is not None:
            return Failure(invalid)
        if not self._persona_dir(persona_id).exists():
            return Failure(self._not_found(persona_id))
        if variant is None:
            active_result = self._read_manifest(persona_id)
            if isinstance(active_result, Failure):
                return active_result
            variant_name = active_result.unwrap()
        else:
            variant_name = variant
        if (variant_error := self._invalid_variant_error(variant_name)) is not None:
            return Failure(variant_error)
        if not self._variant_path(persona_id, variant_name).exists():
            return Failure(self._variant_not_found(persona_id, variant_name))

        contract = {field: spec[field] for field in _CONTRACT_FIELDS if field in spec}
        implementation = {field: spec[field] for field in _VARIANT_FIELDS if field in spec}
        contract_path = self._contract_path(persona_id)
        variant_path = self._variant_path(persona_id, variant_name)
        contract_validation = self._validate_contract_payload(persona_id, contract_path, contract)
        if isinstance(contract_validation, Failure):
            return contract_validation
        implementation_validation = self._validate_variant_payload(persona_id, variant_path, implementation)
        if isinstance(implementation_validation, Failure):
            return implementation_validation

        existing_contract = self._read_contract(persona_id)
        if isinstance(existing_contract, Failure):
            return existing_contract
        existing_variant = self._read_variant_impl(persona_id, variant_name)
        if isinstance(existing_variant, Failure):
            return existing_variant

        if existing_contract.unwrap() != contract:
            contract_write = self._write_json_atomic(contract_path, contract, "spec", persona_id)
            if isinstance(contract_write, Failure):
                return contract_write
        if existing_variant.unwrap() != implementation:
            variant_write = self._write_json_atomic(variant_path, implementation, "spec", persona_id)
            if isinstance(variant_write, Failure):
                return variant_write
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

        return Failure(self._not_found(persona_id))

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        if not self._root.exists():
            return Success([])
        variant_specs: list[PersonaSpec] = []
        variant_persona_dirs = sorted(
            path
            for path in self._root.iterdir()
            if path.is_dir() and self._invalid_id_error(path.name) is None
        )
        for persona_dir in variant_persona_dirs:
            result = self.get(persona_dir.name)
            if isinstance(result, Failure):
                return result
            variant_specs.append(result.unwrap())
        return Success(variant_specs)

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
            return Success(None)
        return Failure(self._not_found(persona_id))

    def _persona_dir(self, persona_id: str) -> Path:
        return self._root / persona_id

    def _manifest_path(self, persona_id: str) -> Path:
        return self._persona_dir(persona_id) / MANIFEST_FILENAME

    def _contract_path(self, persona_id: str) -> Path:
        return self._persona_dir(persona_id) / CONTRACT_FILENAME

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

    _CANONICAL_FORBIDDEN_FIELDS: ClassVar[frozenset[str]] = frozenset(CANONICAL_FORBIDDEN_FIELDS)

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

    def _read_json_object(
        self, persona_id: str, path: Path, label: str
    ) -> Result[dict[str, object], RegistryError]:
        if not path.exists():
            return Failure(self._registry_corrupt(persona_id, path, f"{label} is missing"))
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return Failure(self._registry_corrupt(persona_id, path, f"failed to read {label}: {exc}"))
        if not isinstance(payload, dict) or not all(isinstance(key, str) for key in payload):
            return Failure(self._registry_corrupt(persona_id, path, f"{label} must contain a JSON object"))
        return Success(cast("dict[str, object]", payload))

    def _validate_owned_payload(
        self,
        persona_id: str,
        path: Path,
        payload: dict[str, object],
        *,
        label: str,
        allowed: frozenset[str],
        required: frozenset[str],
    ) -> Result[None, RegistryError]:
        extra_fields = sorted(set(payload) - allowed)
        if extra_fields:
            return Failure(
                self._registry_corrupt(
                    persona_id,
                    path,
                    f"{label} contains fields outside its ownership: {', '.join(extra_fields)}",
                )
            )
        missing_fields = sorted(required - set(payload))
        if missing_fields:
            return Failure(
                self._registry_corrupt(
                    persona_id,
                    path,
                    f"{label} is missing required fields: {', '.join(missing_fields)}",
                )
            )
        return Success(None)

    def _validate_contract_payload(
        self, persona_id: str, path: Path, payload: dict[str, object]
    ) -> Result[None, RegistryError]:
        field_result = self._validate_owned_payload(
            persona_id,
            path,
            payload,
            label="contract.json",
            allowed=_CONTRACT_FIELDS,
            required=_CONTRACT_REQUIRED_FIELDS,
        )
        if isinstance(field_result, Failure):
            return field_result
        if payload.get("id") != persona_id:
            return Failure(
                self._registry_corrupt(persona_id, path, "contract id must match persona directory name")
            )
        return Success(None)

    def _validate_variant_payload(
        self, persona_id: str, path: Path, payload: dict[str, object]
    ) -> Result[None, RegistryError]:
        return self._validate_owned_payload(
            persona_id,
            path,
            payload,
            label="variant file",
            allowed=_VARIANT_FIELDS,
            required=_VARIANT_REQUIRED_FIELDS,
        )

    def _read_contract(self, persona_id: str) -> Result[dict[str, object], RegistryError]:
        path = self._contract_path(persona_id)
        payload_result = self._read_json_object(persona_id, path, "contract.json")
        if isinstance(payload_result, Failure):
            return payload_result
        payload = payload_result.unwrap()
        validation = self._validate_contract_payload(persona_id, path, payload)
        if isinstance(validation, Failure):
            return validation
        return Success(payload)

    def _read_variant_impl(
        self, persona_id: str, variant: str
    ) -> Result[dict[str, object], RegistryError]:
        path = self._variant_path(persona_id, variant)
        if not path.exists():
            return Failure(self._variant_not_found(persona_id, variant))
        payload_result = self._read_json_object(persona_id, path, "variant file")
        if isinstance(payload_result, Failure):
            return payload_result
        payload = payload_result.unwrap()
        validation = self._validate_variant_payload(persona_id, path, payload)
        if isinstance(validation, Failure):
            return validation
        return Success(payload)

    def _materialize_spec(self, persona_id: str, variant: str) -> Result[PersonaSpec, RegistryError]:
        contract_result = self._read_contract(persona_id)
        if isinstance(contract_result, Failure):
            return contract_result
        variant_result = self._read_variant_impl(persona_id, variant)
        if isinstance(variant_result, Failure):
            return variant_result
        materialized: dict[str, object] = {**contract_result.unwrap(), **variant_result.unwrap()}
        materialized["spec_digest"] = compute_spec_digest(materialized)
        return Success(cast("PersonaSpec", materialized))

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
        kind: Literal["spec", "manifest"],
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
    "InvalidConfirmError",
    "FileSystemRegistryStore",
    "InvalidPersonaIdError",
    "MissingPersonaError",
    "RegistryError",
    "RegistryStore",
    "SpecReadError",
    "UpdateFailureError",
    "WriteFailureError",
    "shutil",
]
