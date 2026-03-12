"""Application facade contracts for larva use-case orchestration.

This module is contract-only for the app layer boundary. It defines:
- request/response typed surfaces exposed to transport adapters
- dependency-injection shapes for core and shell collaborators
- stub-only facade signatures with no business logic

Acceptance note (ARCHITECTURE.md, registry-read-override-revalidation):
- override application belongs in this facade layer
- any override path must re-enter validation and normalization
"""

from __future__ import annotations

from typing import Any, Protocol, TypedDict, cast

from returns.result import Failure, Result, Success

from larva.core.assemble import AssemblyError
from larva.core.spec import AssemblyInput, PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStore
from larva.shell.registry import RegistryStore


ERROR_NUMERIC_CODES: dict[str, int] = {
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
}


class AssembleRequest(TypedDict, total=False):
    """App-layer request shape for assembling a PersonaSpec."""

    id: str
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
    """List response shape for registered persona summaries."""

    id: str
    spec_digest: str
    model: str


class LarvaError(TypedDict):
    """Transport-neutral app-level error shape.

    Codes align with INTERFACES.md error-code definitions.
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

    def assemble_candidate(self, data: AssemblyInput) -> PersonaSpec: ...


class ValidateModule(Protocol):
    """DI shape for the ``larva.core.validate`` module boundary."""

    def validate_spec(self, spec: PersonaSpec) -> ValidationReport: ...


class NormalizeModule(Protocol):
    """DI shape for the ``larva.core.normalize`` module boundary."""

    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec: ...


class LarvaFacade(Protocol):
    """App-layer contract consumed by CLI, MCP, and Python adapters."""

    def validate(self, spec: PersonaSpec) -> ValidationReport: ...

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]: ...

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]: ...

    def resolve(
        self,
        id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]: ...

    def list(self) -> Result[list[PersonaSummary], LarvaError]: ...


class DefaultLarvaFacade(LarvaFacade):
    """Constructor-level DI contract for the concrete facade.

    Acceptance note:
    - overrides are applied in facade flow (not in shell adapters)
    - every override path must run revalidation and renormalization
    """

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

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]:
        assemble_input: AssemblyInput = {
            "id": cast("str", request.get("id", "")),
            "prompts": [],
            "toolsets": [],
            "constraints": [],
            "variables": request.get("variables", {}),
            "overrides": request.get("overrides", {}),
        }

        prompt_names = request.get("prompts", [])
        for prompt_name in prompt_names:
            prompt_result = self._components.load_prompt(prompt_name)
            if isinstance(prompt_result, Failure):
                return Failure(
                    self._component_error(prompt_result.failure(), prompt_name, "prompt")
                )
            cast("list[dict[str, str]]", assemble_input["prompts"]).append(prompt_result.unwrap())

        toolset_names = request.get("toolsets", [])
        for toolset_name in toolset_names:
            toolset_result = self._components.load_toolset(toolset_name)
            if isinstance(toolset_result, Failure):
                return Failure(
                    self._component_error(toolset_result.failure(), toolset_name, "toolset")
                )
            cast("list[dict[str, dict[str, str]]]", assemble_input["toolsets"]).append(
                toolset_result.unwrap()
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
                constraint_result.unwrap()
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

        report = self.validate(candidate)
        if not report["valid"]:
            return Failure(self._validation_error(report))

        normalized = self._normalize.normalize_spec(candidate)
        return Success(normalized)

    def _component_error(
        self, error: Exception, component_name: str, component_type: str
    ) -> LarvaError:
        message = str(error)
        details: dict[str, object] = {
            "component_type": getattr(error, "component_type", component_type),
            "component_name": getattr(error, "component_name", component_name),
        }
        return self._error(
            code="COMPONENT_NOT_FOUND",
            message=message,
            details=details,
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
        return {
            "code": code,
            "numeric_code": ERROR_NUMERIC_CODES.get(code, 10),
            "message": message,
            "details": details,
        }

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]:
        report = self.validate(spec)
        if not report["valid"]:
            return Failure(self._validation_error(report))

        normalized = self._normalize.normalize_spec(spec)
        save_result = self._registry.save(normalized)
        if isinstance(save_result, Failure):
            error = save_result.failure()
            details = {k: v for k, v in error.items() if k not in {"code", "message"}}
            return Failure(
                self._error(
                    code=error["code"],
                    message=error["message"],
                    details=cast("dict[str, object]", details),
                )
            )

        persona_id = cast("str", normalized.get("id", ""))
        return Success({"id": persona_id, "registered": True})

    def resolve(
        self,
        id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]:
        get_result = self._registry.get(id)
        if isinstance(get_result, Failure):
            error = get_result.failure()
            details = {k: v for k, v in error.items() if k not in {"code", "message"}}
            return Failure(
                self._error(
                    code=error["code"],
                    message=error["message"],
                    details=cast("dict[str, object]", details),
                )
            )

        resolved = dict(get_result.unwrap())
        if overrides is not None:
            resolved.update(overrides)

        report = self.validate(cast("PersonaSpec", resolved))
        if not report["valid"]:
            return Failure(self._validation_error(report))

        normalized = self._normalize.normalize_spec(cast("PersonaSpec", resolved))
        return Success(normalized)

    def list(self) -> Result[list[PersonaSummary], LarvaError]:
        list_result = self._registry.list()
        if isinstance(list_result, Failure):
            error = list_result.failure()
            details = {k: v for k, v in error.items() if k not in {"code", "message"}}
            return Failure(
                self._error(
                    code=error["code"],
                    message=error["message"],
                    details=cast("dict[str, object]", details),
                )
            )

        summaries: list[PersonaSummary] = []
        for spec in list_result.unwrap():
            summaries.append(
                {
                    "id": spec["id"],
                    "spec_digest": spec["spec_digest"],
                    "model": spec["model"],
                }
            )
        return Success(summaries)
