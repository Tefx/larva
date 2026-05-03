"""Extracted filesystem registry administrative and variant operations."""

from __future__ import annotations

import json
import shutil
from typing import TYPE_CHECKING, Literal, Protocol

from returns.result import Failure, Result, Success

from larva.shell.registry_types import (
    CLEAR_CONFIRMATION_TOKEN,
    InvalidPersonaIdError,
    InvalidVariantNameError,
    MissingPersonaError,
    RegistryCorruptError,
    RegistryError,
    VariantList,
    VariantNotFoundError,
    WriteFailureError,
)

if TYPE_CHECKING:
    from pathlib import Path

    from larva.core.spec import PersonaSpec


class _RegistryOpsHost(Protocol):
    _root: Path

    def _persona_dir(self, persona_id: str) -> Path: ...
    def _manifest_path(self, persona_id: str) -> Path: ...
    def _variants_dir(self, persona_id: str) -> Path: ...
    def _variant_path(self, persona_id: str, variant: str) -> Path: ...
    def _invalid_id_error(self, persona_id: str) -> InvalidPersonaIdError | None: ...
    def _invalid_variant_error(self, variant: str) -> InvalidVariantNameError | None: ...
    def _not_found(self, persona_id: str) -> MissingPersonaError: ...
    def _read_spec_at(
        self, persona_id: str, spec_path: Path, expected_digest: str | None
    ) -> Result[PersonaSpec, RegistryError]: ...
    def _write_json_atomic(
        self,
        path: Path,
        payload: object,
        kind: Literal["spec", "manifest"],
        persona_id: str,
    ) -> Result[None, RegistryError]: ...
    def _write_failed(self, persona_id: str, path: Path, message: str) -> WriteFailureError: ...
    def _registry_corrupt(
        self, persona_id: str, path: Path, message: str
    ) -> RegistryCorruptError: ...

    def _variant_not_found(self, persona_id: str, variant: str) -> VariantNotFoundError: ...


class RegistryExtraOps(_RegistryOpsHost):
    def clear(self, confirm: str = CLEAR_CONFIRMATION_TOKEN) -> Result[int, RegistryError]:
        if confirm != CLEAR_CONFIRMATION_TOKEN:
            return Failure(
                {
                    "code": "INVALID_CONFIRMATION_TOKEN",
                    "message": "clear requires exact confirmation token 'CLEAR REGISTRY'",
                }
            )

        persona_dirs: list[Path] = []
        if self._root.exists():
            persona_dirs = sorted(path for path in self._root.iterdir() if path.is_dir())
        clear_count = len(persona_dirs)

        failed_spec_paths: list[str] = []
        for persona_dir in persona_dirs:
            try:
                shutil.rmtree(persona_dir)
            except OSError as exc:
                failed_spec_paths.append(f"{persona_dir}: {exc}")

        if failed_spec_paths:
            return Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to remove one or more persona specs during clear",
                    "operation": "clear",
                    "persona_id": None,
                    "path": str(self._root),
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
            return Failure(
                self._registry_corrupt(
                    persona_id, variant_path, "variant spec id must match persona directory name"
                )
            )
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
            return Failure(
                self._registry_corrupt(
                    persona_id,
                    self._manifest_path(persona_id),
                    "manifest active variant is missing",
                )
            )
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
        write_result = self._write_json_atomic(
            self._manifest_path(persona_id), {"active": variant}, "manifest", persona_id
        )
        if isinstance(write_result, Failure):
            return write_result
        return self.variant_list(persona_id)

    def variant_delete(self, persona_id: str, variant: str) -> Result[None, RegistryError]:
        if (invalid := self._invalid_id_error(persona_id)) is not None:
            return Failure(invalid)
        if (variant_error := self._invalid_variant_error(variant)) is not None:
            return Failure(variant_error)
        metadata = self.variant_list(persona_id)
        if isinstance(metadata, Failure):
            return metadata
        payload = metadata.unwrap()
        if variant not in payload["variants"]:
            return Failure(self._variant_not_found(persona_id, variant))
        if len(payload["variants"]) == 1:
            return Failure(
                {
                    "code": "LAST_VARIANT_DELETE_FORBIDDEN",
                    "message": "cannot delete last variant",
                    "persona_id": persona_id,
                    "variant": variant,
                }
            )
        if payload["active"] == variant:
            return Failure(
                {
                    "code": "ACTIVE_VARIANT_DELETE_FORBIDDEN",
                    "message": "cannot delete active variant",
                    "persona_id": persona_id,
                    "variant": variant,
                }
            )
        try:
            self._variant_path(persona_id, variant).unlink()
        except OSError as exc:
            return Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": f"failed to unlink variant: {exc}",
                    "operation": "delete",
                    "persona_id": persona_id,
                    "path": str(self._variant_path(persona_id, variant)),
                    "failed_spec_paths": [str(self._variant_path(persona_id, variant))],
                }
            )
        return Success(None)

    def _read_manifest(self, persona_id: str) -> Result[str, RegistryError]:
        manifest_path = self._manifest_path(persona_id)
        if not manifest_path.exists():
            return Failure(
                self._registry_corrupt(persona_id, manifest_path, "manifest.json is missing")
            )
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return Failure(
                self._registry_corrupt(persona_id, manifest_path, f"failed to read manifest: {exc}")
            )
        if (
            not isinstance(payload, dict)
            or set(payload) != {"active"}
            or not isinstance(payload.get("active"), str)
        ):
            return Failure(
                self._registry_corrupt(
                    persona_id,
                    manifest_path,
                    "manifest must contain exactly an active string pointer",
                )
            )
        active = payload["active"]
        if self._invalid_variant_error(active) is not None:
            return Failure(
                self._registry_corrupt(
                    persona_id, manifest_path, "manifest active variant name is invalid"
                )
            )
        if not self._variant_path(persona_id, active).exists():
            return Failure(
                self._registry_corrupt(
                    persona_id, manifest_path, "manifest active variant is missing"
                )
            )
        return Success(active)

    def _scan_variants(self, persona_id: str) -> Result[list[str], RegistryError]:
        variants_dir = self._variants_dir(persona_id)
        if not variants_dir.exists() or not variants_dir.is_dir():
            return Failure(
                self._registry_corrupt(persona_id, variants_dir, "variants directory is missing")
            )
        variants: list[str] = []
        for path in sorted(variants_dir.glob("*.json")):
            variant_name = path.stem
            if self._invalid_variant_error(variant_name) is not None:
                return Failure(
                    self._registry_corrupt(persona_id, path, "variant filename is invalid")
                )
            variants.append(variant_name)
        if not variants:
            return Failure(
                self._registry_corrupt(persona_id, variants_dir, "persona has no variants")
            )
        return Success(variants)
