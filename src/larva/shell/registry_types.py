"""Shared registry storage types.

This module keeps the shell registry adapter focused on filesystem behavior while
preserving the public error and protocol names re-exported by
``larva.shell.registry``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, Protocol, TypeAlias, TypedDict

if TYPE_CHECKING:
    from returns.result import Result

    from larva.core.spec import PersonaSpec


CLEAR_CONFIRMATION_TOKEN = "CLEAR REGISTRY"


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
    """Confirmation token does not match required value."""

    code: Literal["INVALID_CONFIRMATION_TOKEN"]
    message: str


class SpecReadError(TypedDict):
    """Failure reading or decoding stored PersonaSpec data."""

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
    """Failure updating registry-local metadata for a persisted persona."""

    code: Literal["REGISTRY_UPDATE_FAILED"]
    message: str
    persona_id: str
    path: str


class DeleteFailureError(TypedDict):
    """Failure removing one or more persona spec files."""

    code: Literal["REGISTRY_DELETE_FAILED"]
    message: str
    operation: Literal["delete", "clear"]
    persona_id: str | None
    path: str
    failed_spec_paths: list[str]


class RegistryCorruptError(TypedDict):
    """Registry-local variant metadata is internally inconsistent."""

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


class BaseContractMismatchError(TypedDict):
    """Existing base persona contract differs from a registered variant spec."""

    code: Literal["BASE_CONTRACT_MISMATCH"]
    message: str
    persona_id: str
    mismatched_fields: list[str]


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
    | SpecReadError
    | WriteFailureError
    | UpdateFailureError
    | DeleteFailureError
    | RegistryCorruptError
    | InvalidVariantNameError
    | VariantNotFoundError
    | BaseContractMismatchError
    | ActiveVariantDeleteForbiddenError
    | LastVariantDeleteForbiddenError
)
"""Typed shell error surface for registry persistence operations."""

class RegistryStore(Protocol):
    """Authoritative shell-side contract for canonical PersonaSpec storage."""

    def save(self, spec: PersonaSpec, variant: str | None = None) -> Result[None, RegistryError]:
        """Persist one canonical PersonaSpec variant and manifest metadata."""
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
        """Delete one persona directory, including all registry-local variants.

        Behavioral contract:
        - New registry-local storage removes the whole ``<id>/`` directory.
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
        - Registry-local persona directories are deleted as whole records.
        - Partial deletion failures MUST be reported as
          ``REGISTRY_DELETE_FAILED`` with remaining failed paths.
        """
        ...
