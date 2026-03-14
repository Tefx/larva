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


class DeletedPersona(TypedDict):
    """Result shape for a successful delete operation.

    Success payload contract:
    - `id`: the persona id that was deleted
    - `deleted`: always `True` on success

    Error envelope contract for delete failures:
    - Registry `DeleteFailureError` preserves `code`/`message` at app layer
    - Remaining registry fields (`operation`, `persona_id`, `path`, `failed_spec_paths`)
      move into `details` envelope
    - Wrong-confirm for clear operation returns `INVALID_CONFIRMATION_TOKEN` error

    Note: This is a contract-only type. Implementation lives in `shell/registry`.
    """

    id: str
    deleted: bool


class ClearedRegistry(TypedDict):
    """Result shape for a successful clear operation.

    Success payload contract:
    - `cleared`: always `True` on success
    - `count`: number of personas that were removed from registry

    Error envelope contract for clear failures:
    - Wrong `confirm` token returns `LarvaError` with code `INVALID_CONFIRMATION_TOKEN`
      (from shell/registry) mapped through to app layer
    - Partial delete failures after index removal surface `REGISTRY_DELETE_FAILED`
      with `details.failed_spec_paths` containing remaining paths

    Note: This is a contract-only type. Implementation lives in `shell/registry`.
    """

    cleared: bool
    count: int


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

    def clone(self, source_id: str, new_id: str) -> Result[PersonaSpec, LarvaError]:
        """Clone a registered persona to a new id.

        Success contract:
        - Returns `PersonaSpec` with `id` set to `new_id`
        - All non-id fields preserved from source persona
        - `spec_digest` recalculated for the new persona

        Error mapping contract (facade-layer):
        - Registry get failure -> pass-through (PERSONA_NOT_FOUND / INVALID_PERSONA_ID)
        - Validation failure -> PERSONA_INVALID via `_validation_error(report)`
        - Registry save failure -> pass-through (REGISTRY_WRITE_FAILED)

        Overwrite semantics:
        - If `new_id` already exists in registry, overwrite (consistent with `register`)
        - No existence check before save

        Note: This is a contract-only signature. Implementation lives in
        `DefaultLarvaFacade` but this step does not implement the body.
        """
        ...

    def delete(self, persona_id: str) -> Result[DeletedPersona, LarvaError]:
        """Delete one persona by id from the registry.

        Success contract:
        - Returns `DeletedPersona` with `{id, deleted: True}`

        Error mapping contract (facade-layer):
        - Registry `PERSONA_NOT_FOUND` -> facade `PERSONA_NOT_FOUND` (pass-through)
        - Registry `INVALID_PERSONA_ID` -> facade `INVALID_PERSONA_ID` (pass-through)
        - Registry `DeleteFailureError` -> facade `REGISTRY_DELETE_FAILED`
          with `details` containing `operation`, `path`, and `failed_spec_paths`

        Note: This is a contract-only signature. Implementation lives in
        `DefaultLarvaFacade` but this step does not implement the body.
        """
        ...

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[ClearedRegistry, LarvaError]:
        """Clear all personas from the registry.

        Success contract:
        - Returns `ClearedRegistry` with `{cleared: True, count: <int>}`
          where `count` is the number of personas removed

        Error mapping contract (facade-layer):
        - Wrong `confirm` token -> facade `INVALID_CONFIRMATION_TOKEN`
          (shell-level error code preserved via mapping)
        - Registry `DeleteFailureError` during clear -> facade `REGISTRY_DELETE_FAILED`
          with `details` containing `operation`, `path`, and `failed_spec_paths`

        Note: This is a contract-only signature. Implementation lives in
        `DefaultLarvaFacade` but this step does not implement the body.
        """
        ...

    def export_all(self) -> Result[list[PersonaSpec], LarvaError]:
        """Export all persona specs from the registry.

        Success contract:
        - Returns `Result[list[PersonaSpec], LarvaError]` containing all
          persona specs stored in the registry
        - Each spec in the list is canonical registry data (already normalized
          and validated at write time)
        - The returned specs MUST NOT be re-validated or re-normalized downstream;
          they are already in canonical form

        Error mapping contract (facade-layer):
        - Registry `list` failure -> facade `REGISTRY_INDEX_READ_FAILED`
          with `details` containing `operation` and `error` context
        - Registry `get` call failure during iteration -> facade `REGISTRY_SPEC_READ_FAILED`
          with `details` containing `persona_id` and `error` context

        Note: This is a contract-only signature. Implementation lives in
        `DefaultLarvaFacade` but this step does not implement the body.
        """
        ...

    def export_ids(self, ids: list[str]) -> Result[list[PersonaSpec], LarvaError]:
        """Export specific persona specs by id from the registry.

        Success contract:
        - Returns `Result[list[PersonaSpec], LarvaError]` containing the
          requested persona specs in the same order as input `ids`
        - Empty `ids` input returns `Success([])` immediately (no registry calls)
        - Each spec in the list is canonical registry data (already normalized
          and validated at write time)
        - The returned specs MUST NOT be re-validated or re-normalized downstream;
          they are already in canonical form

        Error mapping contract (facade-layer):
        - Any `PERSONA_NOT_FOUND` error -> fail-fast on first error, return
          `Failure(LarvaError)` with code `PERSONA_NOT_FOUND` and `details.id`
          containing the missing persona id
        - Registry `get` call failure -> facade `REGISTRY_SPEC_READ_FAILED`
          with `details` containing `persona_id` and `error` context

        Note: This is a contract-only signature. Implementation lives in
        `DefaultLarvaFacade` but this step does not implement the body.
        """
        ...


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
        fallback_numeric_code = ERROR_NUMERIC_CODES["INTERNAL"]
        return {
            "code": code,
            "numeric_code": ERROR_NUMERIC_CODES.get(code, fallback_numeric_code),
            "message": message,
            "details": details,
        }

    def _summary_from_spec(self, spec: PersonaSpec) -> Result[PersonaSummary, LarvaError]:
        persona_id = spec.get("id")
        spec_digest = spec.get("spec_digest")
        model = spec.get("model")
        if (
            not isinstance(persona_id, str)
            or not isinstance(spec_digest, str)
            or not isinstance(model, str)
        ):
            return Failure(
                self._error(
                    code="PERSONA_INVALID",
                    message="registry record is malformed: expected string id/spec_digest/model",
                    details={
                        "record": dict(spec),
                    },
                )
            )
        return Success(
            {
                "id": persona_id,
                "spec_digest": spec_digest,
                "model": model,
            }
        )

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
            summary_result = self._summary_from_spec(spec)
            if isinstance(summary_result, Failure):
                return summary_result
            summaries.append(summary_result.unwrap())
        return Success(summaries)

    def clone(self, source_id: str, new_id: str) -> Result[PersonaSpec, LarvaError]:
        """Clone a registered persona to a new id.

        Implementation flow (contract-only stub):
        1. `self._registry.get(source_id)` -> get source persona
           - On failure: pass-through PERSONA_NOT_FOUND / INVALID_PERSONA_ID
        2. Copy dict, set `id = new_id`, delete `spec_digest`
        3. `self.validate()` -> validate the cloned spec
           - On failure: return PERSONA_INVALID via `self._validation_error(report)`
        4. `self._normalize.normalize_spec()` -> recalculate spec_digest
        5. `self._registry.save()` -> persist cloned persona
           - On failure: pass-through REGISTRY_WRITE_FAILED
           - Note: Overwrites if `new_id` already exists (no existence check)
        6. Return normalized PersonaSpec

        Note: This is a contract-only stub. Implementation lands in facade-clone step.
        """
        raise NotImplementedError("contract-only stub: implementation in facade-clone step")

    def delete(self, persona_id: str) -> Result[DeletedPersona, LarvaError]:
        delete_result = self._registry.delete(persona_id)
        if isinstance(delete_result, Failure):
            error = delete_result.failure()
            details = {k: v for k, v in error.items() if k not in {"code", "message"}}
            return Failure(
                self._error(
                    code=error["code"],
                    message=error["message"],
                    details=cast("dict[str, object]", details),
                )
            )

        return Success({"id": persona_id, "deleted": True})

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[ClearedRegistry, LarvaError]:
        clear_result = self._registry.clear(confirm)
        if isinstance(clear_result, Failure):
            error = clear_result.failure()
            details = {k: v for k, v in error.items() if k not in {"code", "message"}}
            return Failure(
                self._error(
                    code=error["code"],
                    message=error["message"],
                    details=cast("dict[str, object]", details),
                )
            )

        return Success({"cleared": True, "count": clear_result.unwrap()})

    def export_all(self) -> Result[list[PersonaSpec], LarvaError]:
        """Export all persona specs from the registry.

        Contract acceptance stub:
        - Returns canonical registry data without renormalize/revalidate
        - Registry traversal delegated to `self._registry.list()` + `get(id)`
        - Fail-fast on first registry error

        Note: Implementation pending in downstream step.
        """
        # CONTRACT: This is an acceptance-only stub.
        # Implementation must:
        # 1. Call self._registry.list() to get all persona ids
        # 2. For each id, call self._registry.get(id)
        # 3. Return list of canonical PersonaSpec (no revalidation/renormalization)
        # 4. Fail-fast on first registry error
        raise NotImplementedError(
            "export_all contract is defined; implementation pending in downstream step"
        )

    def export_ids(self, ids: list[str]) -> Result[list[PersonaSpec], LarvaError]:
        """Export specific persona specs by id from the registry.

        Contract acceptance stub:
        - Empty `ids` -> return Success([]) immediately (no registry calls)
        - Non-empty `ids` -> fail-fast on first PERSONA_NOT_FOUND or registry error
        - Returns canonical registry data without renormalize/revalidate

        Note: Implementation pending in downstream step.
        """
        # CONTRACT: This is an acceptance-only stub.
        # Implementation must:
        # 1. If ids is empty, return Success([]) immediately
        # 2. For each id in ids, call self._registry.get(id)
        # 3. Fail-fast on first error (PERSONA_NOT_FOUND or registry failure)
        # 4. Return list of canonical PersonaSpec in same order as input ids
        # 5. No revalidation/renormalization on returned specs
        raise NotImplementedError(
            "export_ids contract is defined; implementation pending in downstream step"
        )
