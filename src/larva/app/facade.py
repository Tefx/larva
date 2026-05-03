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
    AssembleModule,
    AssembleRequest,
    LarvaError,
    LarvaFacade,
    NormalizeModule,
    RegisteredPersona,
    SpecModule,
    ValidateModule,
)
from larva.core.assembly_error import AssemblyError
from larva.core.component_error_projection import project_component_store_error
from larva.core.normalize import NormalizeError
from larva.core.patch import PatchError, apply_patches

if TYPE_CHECKING:
    from larva.app.facade_types import DeletedVariant, VariantMetadata
    from larva.core.spec import AssemblyInput, PersonaSpec
    from larva.core.validation_contract import ValidationReport
    from larva.shell.components import ComponentStore
    from larva.shell.registry import RegistryError, RegistryStore

ERROR_NUMERIC_CODES: dict[str, int] = {
    "INVALID_INPUT": 1,
    "INTERNAL": 10,
    "PERSONA_NOT_FOUND": 100,
    "PERSONA_INVALID": 101,
    "PERSONA_CYCLE": 102,
    "INVALID_PERSONA_ID": 104,
    "COMPONENT_NOT_FOUND": 105,
    "COMPONENT_CONFLICT": 106,
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
}


_ASSEMBLE_REQUEST_ALLOWED_FIELDS = frozenset(
    {"id", "description", "prompts", "toolsets", "constraints", "model", "overrides"}
)
_RESOLVE_FORBIDDEN_OVERRIDE_FIELDS = frozenset({"id", "tools", "side_effect_policy", "variables"})


class DefaultLarvaFacade(RegistryFacadeOps, LarvaFacade):
    """Concrete facade implementation."""

    def __init__(
        self,
        *,
        spec: SpecModule,
        assemble: AssembleModule,
        validate: ValidateModule,
        normalize: NormalizeModule,
        components: ComponentStore,
        registry: RegistryStore,
    ) -> None:
        self._spec = spec
        self._assemble = assemble
        self._validate = validate
        self._normalize = normalize
        self._components = components
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
        forbidden_fields = sorted(set(overrides) & _RESOLVE_FORBIDDEN_OVERRIDE_FIELDS)
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

    def _validate_assemble_request(self, request: AssembleRequest) -> Result[None, LarvaError]:
        unknown_fields = sorted(set(request) - _ASSEMBLE_REQUEST_ALLOWED_FIELDS)
        if unknown_fields:
            field = unknown_fields[0]
            return Failure(
                self._error(
                    code="INVALID_INPUT",
                    message=(
                        f"assemble request field '{field}' is not permitted at canonical boundary"
                    ),
                    details={"field": field, "unknown_fields": unknown_fields},
                )
            )
        return Success(None)

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]:
        request_validation = self._validate_assemble_request(request)
        if isinstance(request_validation, Failure):
            return request_validation
        assemble_input: AssemblyInput = {
            "id": request.get("id", ""),
            "prompts": [],
            "toolsets": [],
            "constraints": [],
            "overrides": request.get("overrides", {}),
        }
        description = request.get("description")
        if isinstance(description, str):
            assemble_input["description"] = description

        prompt_names = request.get("prompts", [])
        for prompt_name in prompt_names:
            prompt_result = self._components.load_prompt(prompt_name)
            if isinstance(prompt_result, Failure):
                return Failure(
                    self._component_error(prompt_result.failure(), prompt_name, "prompt")
                )
            cast("list[dict[str, str]]", assemble_input["prompts"]).append(
                cast("dict[str, str]", prompt_result.unwrap())
            )

        toolset_names = request.get("toolsets", [])
        for toolset_name in toolset_names:
            toolset_result = self._components.load_toolset(toolset_name)
            if isinstance(toolset_result, Failure):
                return Failure(
                    self._component_error(toolset_result.failure(), toolset_name, "toolset")
                )
            cast("list[dict[str, dict[str, str]]]", assemble_input["toolsets"]).append(
                cast("dict[str, dict[str, str]]", toolset_result.unwrap())
            )

        constraint_names = request.get("constraints", [])
        for constraint_name in constraint_names:
            constraint_result = self._components.load_constraint(constraint_name)
            if isinstance(constraint_result, Failure):
                return Failure(
                    self._component_error(
                        constraint_result.failure(), constraint_name, "constraint"
                    )
                )
            cast("list[dict[str, object]]", assemble_input["constraints"]).append(
                cast("dict[str, object]", constraint_result.unwrap())
            )

        model_name = request.get("model")
        if model_name:
            model_result = self._components.load_model(model_name)
            if isinstance(model_result, Failure):
                return Failure(self._component_error(model_result.failure(), model_name, "model"))
            assemble_input["model"] = model_result.unwrap()

        try:
            candidate = self._assemble.assemble_candidate(assemble_input)
        except AssemblyError as error:
            return Failure(self._assembly_error(error))

        normalized_result = self._normalize_and_validate(candidate)
        if isinstance(normalized_result, Failure):
            return normalized_result
        return Success(normalized_result.unwrap())

    def _component_error(
        self, error: Exception, component_name: str, component_type: str
    ) -> LarvaError:
        return project_component_store_error(
            operation="assemble",
            error=error,
            default_component_type=component_type,
            default_component_name=component_name,
        )

    def _assembly_error(self, error: AssemblyError) -> LarvaError:
        return self._error(
            code=error.code,
            message=error.message,
            details=dict(error.details),
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
        if variant is None:
            save_result = self._registry.save(normalized)
        else:
            save_result = self._registry.save(normalized, variant=variant)
        if isinstance(save_result, Failure):
            return Failure(self._registry_failure_error(save_result.failure()))

        persona_id = normalized.get("id", "")
        return Success({"id": persona_id, "registered": True})

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
        if variant is None:
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
