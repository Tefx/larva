"""Shared facade types and protocols."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, TypeAlias, TypedDict

if TYPE_CHECKING:
    from returns.result import Result

    from larva.core.spec import PersonaSpec
    from larva.core.validation_contract import ValidationReport

PersonaSpecList: TypeAlias = list["PersonaSpec"]
StrList: TypeAlias = list[str]


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


class VariantMetadata(TypedDict):
    id: str
    active: str
    variants: list[str]


class ActivatedVariant(TypedDict):
    id: str
    active: str


class DeletedVariant(TypedDict):
    id: str
    variant: str
    deleted: bool


class LarvaError(TypedDict):
    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


class SpecModule(Protocol):
    PersonaSpec: type[PersonaSpec]


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

    def register(
        self, spec: PersonaSpec, variant: str | None = None
    ) -> Result[RegisteredPersona, LarvaError]: ...

    def resolve(
        self,
        id: str,  # noqa: A002 - public API field name is canonical.
        overrides: dict[str, object] | None = None,
        variant: str | None = None,
    ) -> Result[PersonaSpec, LarvaError]: ...

    def update(
        self,
        persona_id: str,
        patches: dict[str, object],
        variant: str | None = None,
    ) -> Result[PersonaSpec, LarvaError]: ...

    def variant_list(self, persona_id: str) -> Result[VariantMetadata, LarvaError]: ...

    def variant_activate(
        self, persona_id: str, variant: str
    ) -> Result[ActivatedVariant, LarvaError]: ...

    def variant_delete(
        self, persona_id: str, variant: str
    ) -> Result[DeletedVariant, LarvaError]: ...

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

    def export_all(self) -> Result[PersonaSpecList, LarvaError]: ...

    def export_ids(self, ids: StrList) -> Result[PersonaSpecList, LarvaError]: ...
