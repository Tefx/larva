"""Application facade contracts and implementation.

This module is the larva admission consolidation seam for PersonaSpec-bearing
production paths. It does not own PersonaSpec semantics; it applies and maps
the canonical opifex-aligned contract enforced by ``larva.core.validate``.

Acceptance notes:
- success on larva production paths must imply conformance to the opifex
  canonical PersonaSpec contract
- this facade must not widen admission by treating ``tools``,
  ``side_effect_policy``, or unknown top-level fields as acceptable canonical
  PersonaSpec input
- ``contracts/persona_spec.schema.json`` is reference-only while present and
  must never act as an independent contract owner
"""

from __future__ import annotations

from typing import Any, Protocol, TypedDict, cast

from returns.result import Failure, Result, Success

from larva.core.component_error_projection import project_component_store_error
from larva.core.assemble import AssemblyError
from larva.core.patch import apply_patches
from larva.core.spec import AssemblyInput, PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStore
from larva.shell.registry import RegistryError, RegistryStore


ERROR_NUMERIC_CODES: dict[str, int] = {
    "INVALID_INPUT": 1,
    "INTERNAL": 10,
    "PERSONA_NOT_FOUND": 100,
    "PERSONA_INVALID": 101,
    "PERSONA_CYCLE": 102,
    "VARIABLE_UNRESOLVED": 103,
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
}


_LOOKUP_NOT_FOUND = object()


class AssembleRequest(TypedDict, total=False):
    """App-layer request shape for assembling a PersonaSpec."""

    id: str
    description: str
    prompts: list[str]
    toolsets: list[str]
    constraints: list[str]
    model: str
    overrides: dict[str, object]
    variables: dict[str, str]


class RegisteredPersona(TypedDict):
    """Result shape for a successful registration operation."""

    id: str
    registered: bool


class PersonaSummary(TypedDict):
    """List response shape for registered persona summaries.

    Fields:
        id: Persona identifier.
        description: Human-readable persona description.
        spec_digest: Canonical digest of the persona spec.
        model: Model identifier used by the persona.
    """

    id: str
    description: str
    spec_digest: str
    model: str


class DeletedPersona(TypedDict):
    """Result shape for a successful delete operation."""

    id: str
    deleted: bool


class ClearedRegistry(TypedDict):
    """Result shape for a successful clear operation."""

    cleared: bool
    count: int


class BatchUpdateItemResult(TypedDict):
    """Per-persona batch-update item (`id`, `updated`)."""

    id: str
    updated: bool


class BatchUpdateResult(TypedDict):
    """Aggregate batch-update result (`items`, `matched`, `updated`)."""

    items: list[BatchUpdateItemResult]
    matched: int
    updated: int


class LarvaError(TypedDict):
    """Transport-neutral app-level error shape.

    Codes align with INTERFACES.md error-code definitions.

    Error-shape expectation:
        - validation failures map to ``PERSONA_INVALID`` at facade level
        - detailed validator output is preserved under ``details[\"report\"]``
        - assembly failures preserve their specific code when aligned with the
          shared taxonomy
    """

    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


class SpecModule(Protocol):
    """DI shape for the ``larva.core.spec`` module boundary."""

    PersonaSpec: type[PersonaSpec]
    AssemblyInput: type[AssemblyInput]


class AssembleModule(Protocol):
    """DI shape for the ``larva.core.assemble`` module boundary."""

    def assemble_candidate(self, data: AssemblyInput) -> PersonaSpec:
        """Assemble a candidate without redefining canonical admission."""
        ...


class ValidateModule(Protocol):
    """DI shape for the ``larva.core.validate`` module boundary."""

    def validate_spec(self, spec: PersonaSpec) -> ValidationReport:
        """Return the canonical admission verdict for a PersonaSpec candidate."""
        ...


class NormalizeModule(Protocol):
    """DI shape for the ``larva.core.normalize`` module boundary."""

    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec: ...


class LarvaFacade(Protocol):
    """App-layer contract consumed by CLI, MCP, and Python adapters."""

    def validate(self, spec: PersonaSpec) -> ValidationReport:
        """Validate against the opifex-aligned canonical admission contract."""
        ...

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]:
        """Assemble then validate so success implies canonical conformance."""
        ...

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]:
        """Register only canonically admissible PersonaSpec inputs."""
        ...

    def resolve(
        self,
        id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]: ...

    def update(
        self,
        persona_id: str,
        patches: dict[str, object],
    ) -> Result[PersonaSpec, LarvaError]: ...

    def update_batch(
        self,
        where: dict[str, object],
        patches: dict[str, object],
        dry_run: bool = False,
    ) -> Result[BatchUpdateResult, LarvaError]: ...

    def list(self) -> Result[list[PersonaSummary], LarvaError]: ...

    def clone(self, source_id: str, new_id: str) -> Result[PersonaSpec, LarvaError]: ...

    def delete(self, persona_id: str) -> Result[DeletedPersona, LarvaError]: ...

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[ClearedRegistry, LarvaError]: ...

    def export_all(self) -> Result[list[PersonaSpec], LarvaError]: ...

    def export_ids(self, ids: list[str]) -> Result[list[PersonaSpec], LarvaError]: ...


class DefaultLarvaFacade(LarvaFacade):
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

    def validate(self, spec: PersonaSpec) -> ValidationReport:
        return self._validate.validate_spec(spec)

    def _normalize_and_validate(
        self,
        spec: PersonaSpec,
    ) -> Result[PersonaSpec, LarvaError]:
        """Normalize then verify canonical admission contract conformance."""
        normalized = self._normalize.normalize_spec(spec)
        report = self.validate(normalized)
        if not report["valid"]:
            return Failure(self._validation_error(report))
        return Success(normalized)

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]:
        assemble_input: AssemblyInput = {
            "id": cast("str", request.get("id", "")),
            "prompts": [],
            "toolsets": [],
            "constraints": [],
            "variables": request.get("variables", {}),
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
            first_message = cast("str", errors[0].get("message", first_message))
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
            code=cast("str", error["code"]),
            message=cast("str", error["message"]),
            details=cast("dict[str, object]", details),
        )

    def _summary_from_spec(self, spec: PersonaSpec) -> Result[PersonaSummary, LarvaError]:
        persona_id = spec.get("id")
        description = spec.get("description")
        spec_digest = spec.get("spec_digest")
        model = spec.get("model")
        if (
            not isinstance(persona_id, str)
            or not isinstance(description, str)
            or not isinstance(spec_digest, str)
            or not isinstance(model, str)
        ):
            return Failure(
                self._error(
                    code="PERSONA_INVALID",
                    message=(
                        "registry record is malformed: expected string "
                        "id/description/spec_digest/model"
                    ),
                    details={
                        "record": dict(spec),
                    },
                )
            )
        return Success(
            {
                "id": persona_id,
                "description": description,
                "spec_digest": spec_digest,
                "model": model,
            }
        )

    def _dotted_lookup_or_not_found(self, source: dict[str, object], dotted_key: str) -> object:
        current: object = source
        for part in dotted_key.split("."):
            if not isinstance(current, dict):
                return _LOOKUP_NOT_FOUND
            next_value = current.get(part, _LOOKUP_NOT_FOUND)
            if next_value is _LOOKUP_NOT_FOUND:
                return _LOOKUP_NOT_FOUND
            current = next_value
        return current

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]:
        report = self.validate(spec)
        if not report["valid"]:
            return Failure(self._validation_error(report))

        normalized_result = self._normalize_and_validate(spec)
        if isinstance(normalized_result, Failure):
            return normalized_result
        normalized = normalized_result.unwrap()
        save_result = self._registry.save(normalized)
        if isinstance(save_result, Failure):
            return Failure(self._registry_failure_error(save_result.failure()))

        persona_id = cast("str", normalized.get("id", ""))
        return Success({"id": persona_id, "registered": True})

    def resolve(
        self,
        id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]:
        get_result = self._registry.get(id)
        if isinstance(get_result, Failure):
            return Failure(self._registry_failure_error(get_result.failure()))

        resolved = dict(get_result.unwrap())
        if overrides is not None:
            resolved.update(overrides)

        report = self.validate(cast("PersonaSpec", resolved))
        if not report["valid"]:
            return Failure(self._validation_error(report))

        normalized_result = self._normalize_and_validate(cast("PersonaSpec", resolved))
        if isinstance(normalized_result, Failure):
            return normalized_result
        return Success(normalized_result.unwrap())

    def update(
        self,
        persona_id: str,
        patches: dict[str, object],
    ) -> Result[PersonaSpec, LarvaError]:
        get_result = self._registry.get(persona_id)
        if isinstance(get_result, Failure):
            return Failure(self._registry_failure_error(get_result.failure()))

        existing = cast("dict[str, object]", dict(get_result.unwrap()))
        patched = apply_patches(existing, patches)

        report = self.validate(cast("PersonaSpec", patched))
        if not report["valid"]:
            return Failure(self._validation_error(report))

        normalized_result = self._normalize_and_validate(cast("PersonaSpec", patched))
        if isinstance(normalized_result, Failure):
            return normalized_result
        normalized = normalized_result.unwrap()
        save_result = self._registry.save(normalized)
        if isinstance(save_result, Failure):
            return Failure(self._registry_failure_error(save_result.failure()))

        return Success(normalized)

    def update_batch(
        self,
        where: dict[str, object],
        patches: dict[str, object],
        dry_run: bool = False,
    ) -> Result[BatchUpdateResult, LarvaError]:
        list_result = self._registry.list()
        if isinstance(list_result, Failure):
            return Failure(self._registry_failure_error(list_result.failure()))

        matched_specs: list[PersonaSpec] = []
        for spec in list_result.unwrap():
            where_matches = True
            for dotted_key, expected_value in where.items():
                actual_value = self._dotted_lookup_or_not_found(
                    cast("dict[str, object]", spec),
                    dotted_key,
                )
                if actual_value is _LOOKUP_NOT_FOUND or actual_value != expected_value:
                    where_matches = False
                    break
            if where_matches:
                matched_specs.append(spec)

        if dry_run:
            dry_run_items: list[BatchUpdateItemResult] = []
            for spec in matched_specs:
                persona_id = spec.get("id")
                if not isinstance(persona_id, str):
                    return Failure(
                        self._error(
                            code="PERSONA_INVALID",
                            message="registry record is malformed: expected string id",
                            details={"record": dict(spec)},
                        )
                    )
                dry_run_items.append(
                    {
                        "id": persona_id,
                        "updated": False,
                    }
                )
            return Success(
                {
                    "items": dry_run_items,
                    "matched": len(matched_specs),
                    "updated": 0,
                }
            )

        updated_items: list[BatchUpdateItemResult] = []
        for spec in matched_specs:
            persona_id = spec.get("id")
            if not isinstance(persona_id, str):
                return Failure(
                    self._error(
                        code="PERSONA_INVALID",
                        message="registry record is malformed: expected string id",
                        details={"record": dict(spec)},
                    )
                )
            update_result = self.update(persona_id, patches)
            if isinstance(update_result, Failure):
                return Failure(update_result.failure())
            updated_items.append({"id": persona_id, "updated": True})

        return Success(
            {
                "items": updated_items,
                "matched": len(matched_specs),
                "updated": len(updated_items),
            }
        )

    def list(self) -> Result[list[PersonaSummary], LarvaError]:
        list_result = self._registry.list()
        if isinstance(list_result, Failure):
            return Failure(self._registry_failure_error(list_result.failure()))

        summaries: list[PersonaSummary] = []
        for spec in list_result.unwrap():
            summary_result = self._summary_from_spec(spec)
            if isinstance(summary_result, Failure):
                return summary_result
            summaries.append(summary_result.unwrap())
        return Success(summaries)

    def clone(self, source_id: str, new_id: str) -> Result[PersonaSpec, LarvaError]:
        get_result = self._registry.get(source_id)
        if isinstance(get_result, Failure):
            return Failure(self._registry_failure_error(get_result.failure()))

        cloned = dict(get_result.unwrap())
        cloned["id"] = new_id
        if "spec_digest" in cloned:
            del cloned["spec_digest"]

        report = self.validate(cast("PersonaSpec", cloned))
        if not report["valid"]:
            return Failure(self._validation_error(report))

        normalized_result = self._normalize_and_validate(cast("PersonaSpec", cloned))
        if isinstance(normalized_result, Failure):
            return normalized_result
        normalized = normalized_result.unwrap()
        save_result = self._registry.save(normalized)
        if isinstance(save_result, Failure):
            return Failure(self._registry_failure_error(save_result.failure()))

        return Success(normalized)

    def delete(self, persona_id: str) -> Result[DeletedPersona, LarvaError]:
        delete_result = self._registry.delete(persona_id)
        if isinstance(delete_result, Failure):
            return Failure(self._registry_failure_error(delete_result.failure()))

        return Success({"id": persona_id, "deleted": True})

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[ClearedRegistry, LarvaError]:
        clear_result = self._registry.clear(confirm)
        if isinstance(clear_result, Failure):
            return Failure(self._registry_failure_error(clear_result.failure()))

        return Success({"cleared": True, "count": clear_result.unwrap()})

    def export_all(self) -> Result[list[PersonaSpec], LarvaError]:
        list_result = self._registry.list()
        if isinstance(list_result, Failure):
            return Failure(self._registry_failure_error(list_result.failure()))
        return Success(list_result.unwrap())

    def export_ids(self, ids: list[str]) -> Result[list[PersonaSpec], LarvaError]:
        if not ids:
            return Success([])

        specs: list[PersonaSpec] = []
        for persona_id in ids:
            get_result = self._registry.get(persona_id)
            if isinstance(get_result, Failure):
                return Failure(
                    self._registry_failure_error(
                        get_result.failure(),
                        extra_details={"id": persona_id},
                    )
                )
            specs.append(get_result.unwrap())
        return Success(specs)
