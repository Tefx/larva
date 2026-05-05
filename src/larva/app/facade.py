"""Application facade contracts and implementation.

This is larva's admission seam for canonical PersonaSpec production paths.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.app.facade_registry_ops import RegistryFacadeOps
from larva.app.facade_strictness import spec_digest_issues
from larva.app.facade_types import (
    ActivatedVariant,
    LarvaError,
    LarvaFacade,
    NormalizeModule,
    RegisteredPersona,
    SpecModule,
    ValidateModule,
)
from larva.core.normalize import NormalizeError
from larva.core.patch import PatchError, apply_patches

if TYPE_CHECKING:
    from larva.app.facade_types import DeletedVariant, VariantMetadata
    from larva.core.spec import PersonaSpec
    from larva.core.validation_contract import ValidationReport
    from larva.shell.registry import RegistryError, RegistryStore

ERROR_NUMERIC_CODES: dict[str, int] = {
    "INVALID_INPUT": 1,
    "INTERNAL": 10,
    "PERSONA_NOT_FOUND": 100,
    "PERSONA_INVALID": 101,
    "PERSONA_CYCLE": 102,
    "INVALID_PERSONA_ID": 104,
    "REGISTRY_INDEX_READ_FAILED": 107,
    "REGISTRY_SPEC_READ_FAILED": 108,
    "REGISTRY_WRITE_FAILED": 109,
    "REGISTRY_UPDATE_FAILED": 110,
    "REGISTRY_DELETE_FAILED": 111,
    "INVALID_CONFIRMATION_TOKEN": 112,
    "FORBIDDEN_OVERRIDE_FIELD": 113,
    "FORBIDDEN_PATCH_FIELD": 114,
    "FORBIDDEN_FIELD": 115,
    "MISSING_SPEC_VERSION": 116,
    "REGISTRY_CORRUPT": 117,
    "INVALID_VARIANT_NAME": 118,
    "VARIANT_NOT_FOUND": 119,
    "ACTIVE_VARIANT_DELETE_FORBIDDEN": 120,
    "LAST_VARIANT_DELETE_FORBIDDEN": 121,
    "PERSONA_ID_MISMATCH": 122,
    "BASE_CONTRACT_MISMATCH": 123,
    "MIXED_SCOPE_PATCH": 124,
    "FIELD_SCOPE_VIOLATION": 125,
}


_RESOLVE_ALLOWED_OVERRIDE_FIELDS = frozenset(
    {"prompt", "model", "model_params", "compaction_prompt"}
)
_CONTRACT_PATCH_FIELDS = frozenset({"description", "capabilities", "can_spawn"})
_IMPLEMENTATION_PATCH_FIELDS = frozenset({"prompt", "model", "model_params", "compaction_prompt"})
_CONTRACT_COMPARE_FIELDS = frozenset(
    {"id", "description", "capabilities", "can_spawn", "spec_version"}
)


class DefaultLarvaFacade(RegistryFacadeOps, LarvaFacade):
    """Concrete facade implementation."""

    def __init__(
        self,
        *,
        spec: SpecModule,
        validate: ValidateModule,
        normalize: NormalizeModule,
        registry: RegistryStore,
    ) -> None:
        self._spec = spec
        self._validate = validate
        self._normalize = normalize
        self._registry = registry

    def _registry_persona_ids_for_warnings(self) -> frozenset[str] | None:
        registry_result = self._registry.list()
        if isinstance(registry_result, Failure):
            return None
        return frozenset(
            persona_id
            for persona in registry_result.unwrap()
            for persona_id in [persona.get("id")]
            if isinstance(persona_id, str) and persona_id != ""
        )

    def validate(self, spec: PersonaSpec) -> ValidationReport:
        return self._validate.validate_spec(spec, self._registry_persona_ids_for_warnings())

    def _validate_raw_spec(self, spec: PersonaSpec) -> Result[None, LarvaError]:
        report = self.validate(spec)
        if not report["valid"]:
            return Failure(self._validation_error(report))
        return Success(None)

    def _validate_stored_spec_digest(self, spec: PersonaSpec) -> Result[None, LarvaError]:
        issues = spec_digest_issues(cast("dict[str, object]", spec))
        if not issues:
            return Success(None)
        return Failure(self._validation_error({"valid": False, "errors": issues, "warnings": []}))

    def _validate_registry_read_spec(self, spec: PersonaSpec) -> Result[None, LarvaError]:
        raw_validation = self._validate_raw_spec(spec)
        if isinstance(raw_validation, Failure):
            return raw_validation
        return self._validate_stored_spec_digest(spec)

    def _normalize_validated_spec(self, spec: PersonaSpec) -> Result[PersonaSpec, LarvaError]:
        try:
            normalized = self._normalize.normalize_spec(spec)
        except NormalizeError as error:
            return Failure(self._normalize_error(error))
        report = self.validate(normalized)
        if not report["valid"]:
            return Failure(self._validation_error(report))
        return Success(normalized)

    def _validate_resolve_overrides(
        self, overrides: dict[str, object] | None
    ) -> Result[None, LarvaError]:
        if overrides is None:
            return Success(None)
        forbidden_fields = sorted(set(overrides) - _RESOLVE_ALLOWED_OVERRIDE_FIELDS)
        if not forbidden_fields:
            return Success(None)
        field = forbidden_fields[0]
        return Failure(
            self._error(
                code="FORBIDDEN_OVERRIDE_FIELD",
                message=f"Override field '{field}' is not permitted at canonical resolve boundary",
                details={"field": field},
            )
        )

    def _normalize_and_validate(
        self,
        spec: PersonaSpec,
    ) -> Result[PersonaSpec, LarvaError]:
        """Validate raw input, normalize it, then re-validate canonical output."""
        raw_validation = self._validate_raw_spec(spec)
        if isinstance(raw_validation, Failure):
            return raw_validation
        try:
            normalized = self._normalize.normalize_spec(spec)
        except NormalizeError as error:
            return Failure(self._normalize_error(error))
        report = self.validate(normalized)
        if not report["valid"]:
            return Failure(self._validation_error(report))
        return Success(normalized)

    def _normalize_error(self, error: NormalizeError) -> LarvaError:
        return self._error(
            code=error.code,
            message=error.message,
            details=cast("dict[str, object]", dict(error.details)),
        )

    def _patch_error(self, error: PatchError) -> LarvaError:
        return self._error(
            code=error.code,
            message=error.message,
            details=cast("dict[str, object]", dict(error.details)),
        )

    def _validation_error(self, report: ValidationReport) -> LarvaError:
        errors = report.get("errors", [])
        first_message = "PersonaSpec validation failed"
        if errors:
            first_message = errors[0].get("message", first_message)
        return self._error(
            code="PERSONA_INVALID",
            message=first_message,
            details={"report": report},
        )

    def _error(self, *, code: str, message: str, details: dict[str, object]) -> LarvaError:
        fallback_numeric_code = ERROR_NUMERIC_CODES["INTERNAL"]
        return {
            "code": code,
            "numeric_code": ERROR_NUMERIC_CODES.get(code, fallback_numeric_code),
            "message": message,
            "details": details,
        }

    def _registry_failure_error(
        self,
        error: RegistryError,
        extra_details: dict[str, object] | None = None,
    ) -> LarvaError:
        details = {k: v for k, v in error.items() if k not in {"code", "message"}}
        if extra_details:
            details.update(extra_details)
        return self._error(
            code=error["code"],
            message=error["message"],
            details=details,
        )

    def register(
        self, spec: PersonaSpec, variant: str | None = None
    ) -> Result[RegisteredPersona, LarvaError]:
        normalized_result = self._normalize_and_validate(spec)
        if isinstance(normalized_result, Failure):
            return normalized_result
        normalized = normalized_result.unwrap()

        persona_id = cast("str", normalized.get("id", ""))
        metadata_result = self._registry.variant_list(persona_id)
        if isinstance(metadata_result, Failure):
            metadata_error = metadata_result.failure()
            if metadata_error["code"] != "PERSONA_NOT_FOUND":
                return Failure(self._registry_failure_error(metadata_error))
        else:
            existing_result = self._registry.get(persona_id)
            if isinstance(existing_result, Failure):
                return Failure(self._registry_failure_error(existing_result.failure()))
            existing = existing_result.unwrap()
            mismatched_fields = sorted(
                field
                for field in _CONTRACT_COMPARE_FIELDS
                if existing.get(field) != normalized.get(field)
            )
            if mismatched_fields:
                return Failure(
                    self._error(
                        code="BASE_CONTRACT_MISMATCH",
                        message="registered variant contract fields differ from existing base persona contract",
                        details={"id": persona_id, "mismatched_fields": mismatched_fields},
                    )
                )

        if variant is None:
            save_result = self._registry.save(normalized)
        else:
            save_result = self._registry.save(normalized, variant=variant)
        if isinstance(save_result, Failure):
            return Failure(self._registry_failure_error(save_result.failure()))

        return Success({"id": persona_id, "registered": True})

    def _validate_update_patch_scope(
        self, patches: dict[str, object], variant: str | None
    ) -> Result[None, LarvaError]:
        roots = {key.split(".", 1)[0] for key in patches}
        contract_roots = roots & _CONTRACT_PATCH_FIELDS
        implementation_roots = roots & _IMPLEMENTATION_PATCH_FIELDS
        if contract_roots and implementation_roots:
            return Failure(
                self._error(
                    code="MIXED_SCOPE_PATCH",
                    message="update patch must not mix contract-owned and implementation-owned fields",
                    details={
                        "contract_fields": sorted(contract_roots),
                        "implementation_fields": sorted(implementation_roots),
                    },
                )
            )
        if variant is not None and contract_roots:
            return Failure(
                self._error(
                    code="FIELD_SCOPE_VIOLATION",
                    message="contract-owned fields cannot be patched with an explicit variant",
                    details={"fields": sorted(contract_roots), "variant": variant},
                )
            )
        return Success(None)

    def resolve(
        self,
        id: str,  # noqa: A002 - public API field name is canonical.
        overrides: dict[str, object] | None = None,
        variant: str | None = None,
    ) -> Result[PersonaSpec, LarvaError]:
        get_result = (
            self._registry.get(id) if variant is None else self._registry.get_variant(id, variant)
        )
        if isinstance(get_result, Failure):
            return Failure(self._registry_failure_error(get_result.failure()))

        resolved = dict(get_result.unwrap())
        stored_validation = self._validate_registry_read_spec(cast("PersonaSpec", resolved))
        if isinstance(stored_validation, Failure):
            return stored_validation
        override_validation = self._validate_resolve_overrides(overrides)
        if isinstance(override_validation, Failure):
            return override_validation
        if overrides is not None:
            resolved.update(overrides)

        normalized_result = self._normalize_validated_spec(cast("PersonaSpec", resolved))
        if isinstance(normalized_result, Failure):
            return normalized_result
        return Success(normalized_result.unwrap())

    def update(
        self,
        persona_id: str,
        patches: dict[str, object],
        variant: str | None = None,
    ) -> Result[PersonaSpec, LarvaError]:
        scope_validation = self._validate_update_patch_scope(patches, variant)
        if isinstance(scope_validation, Failure):
            return scope_validation
        get_result = (
            self._registry.get(persona_id)
            if variant is None
            else self._registry.get_variant(persona_id, variant)
        )
        if isinstance(get_result, Failure):
            return Failure(self._registry_failure_error(get_result.failure()))

        existing = cast("dict[str, object]", dict(get_result.unwrap()))
        stored_validation = self._validate_registry_read_spec(cast("PersonaSpec", existing))
        if isinstance(stored_validation, Failure):
            return stored_validation
        try:
            patched = apply_patches(existing, patches)
        except PatchError as error:
            return Failure(self._patch_error(error))

        normalized_result = self._normalize_and_validate(cast("PersonaSpec", patched))
        if isinstance(normalized_result, Failure):
            return normalized_result
        normalized = normalized_result.unwrap()
        update_materialized = getattr(self._registry, "update_materialized", None)
        if callable(update_materialized):
            save_result = update_materialized(normalized, variant=variant)
        elif variant is None:
            save_result = self._registry.save(normalized)
        else:
            save_result = self._registry.save(normalized, variant=variant)
        if isinstance(save_result, Failure):
            return Failure(self._registry_failure_error(save_result.failure()))

        return Success(normalized)

    def variant_list(self, persona_id: str) -> Result[VariantMetadata, LarvaError]:
        metadata_result = self._registry.variant_list(persona_id)
        if isinstance(metadata_result, Failure):
            return Failure(self._registry_failure_error(metadata_result.failure()))
        metadata = metadata_result.unwrap()
        return Success(
            {"id": metadata["id"], "active": metadata["active"], "variants": metadata["variants"]}
        )

    def variant_activate(
        self, persona_id: str, variant: str
    ) -> Result[ActivatedVariant, LarvaError]:
        activate_result = self._registry.variant_activate(persona_id, variant)
        if isinstance(activate_result, Failure):
            return Failure(self._registry_failure_error(activate_result.failure()))
        metadata = activate_result.unwrap()
        return Success({"id": metadata["id"], "active": metadata["active"]})

    def variant_delete(self, persona_id: str, variant: str) -> Result[DeletedVariant, LarvaError]:
        delete_result = self._registry.variant_delete(persona_id, variant)
        if isinstance(delete_result, Failure):
            return Failure(self._registry_failure_error(delete_result.failure()))
        return Success({"id": persona_id, "variant": variant, "deleted": True})
