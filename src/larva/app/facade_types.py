"""Shared facade types and protocols."""

from __future__ import annotations

from typing import Protocol, TypedDict

from returns.result import Result

from larva.core.spec import AssemblyInput, PersonaSpec
from larva.core.validate import ValidationReport


class AssembleRequest(TypedDict, total=False):
    id: str
    description: str
    prompts: list[str]
    toolsets: list[str]
    constraints: list[str]
    model: str
    overrides: dict[str, object]


class RegisteredPersona(TypedDict):
    id: str
    registered: bool


class PersonaSummary(TypedDict):
    id: str
    description: str
    spec_digest: str
    model: str


class DeletedPersona(TypedDict):
    id: str
    deleted: bool


class ClearedRegistry(TypedDict):
    cleared: bool
    count: int


class BatchUpdateItemResult(TypedDict):
    id: str
    updated: bool


class BatchUpdateResult(TypedDict):
    items: list[BatchUpdateItemResult]
    matched: int
    updated: int


class LarvaError(TypedDict):
    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


class SpecModule(Protocol):
    PersonaSpec: type[PersonaSpec]
    AssemblyInput: type[AssemblyInput]


class AssembleModule(Protocol):
    def assemble_candidate(self, data: AssemblyInput) -> PersonaSpec: ...


class ValidateModule(Protocol):
    def validate_spec(
        self,
        spec: PersonaSpec,
        registry_persona_ids: frozenset[str] | None = None,
    ) -> ValidationReport: ...


class NormalizeModule(Protocol):
    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec: ...


class LarvaFacade(Protocol):
    def validate(self, spec: PersonaSpec) -> ValidationReport: ...

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]: ...

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]: ...

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
