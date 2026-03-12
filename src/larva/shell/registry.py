"""Contract surface for shell-side persona registry storage.

This module defines the shell boundary for canonical PersonaSpec persistence in
the documented global registry location: ``~/.larva/registry/``.

Scope of this contract module:
- define typed registry errors and storage protocols
- define contract-only filesystem adapter signatures

Out of scope for this contract step:
- filesystem I/O implementation
- JSON serialization/deserialization implementation
- override application, revalidation, or renormalization flows
- CLI/MCP/Python transport formatting

Boundary citations:
- ARCHITECTURE.md :: Module: ``larva.shell.registry``
- ARCHITECTURE.md :: 7. Cross-Module Interface Contracts
- ARCHITECTURE.md :: 8. Error Boundary Model
- INTERFACES.md :: D. Global Registry
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal, Protocol, TypeAlias, TypedDict

from returns.result import Result

from larva.core.spec import PersonaSpec


DEFAULT_REGISTRY_ROOT = Path("~/.larva/registry").expanduser()
INDEX_FILENAME = "index.json"
SPEC_FILENAME_TEMPLATE = "{id}.json"


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


class IndexReadError(TypedDict):
    """Failure reading or decoding ``index.json`` from registry root."""

    code: Literal["REGISTRY_INDEX_READ_FAILED"]
    message: str
    path: str


class SpecReadError(TypedDict):
    """Failure reading or decoding ``<id>.json`` PersonaSpec data."""

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
    """Failure updating ``index.json`` mapping for persisted persona digest."""

    code: Literal["REGISTRY_UPDATE_FAILED"]
    message: str
    persona_id: str
    path: str


RegistryError: TypeAlias = (
    MissingPersonaError
    | InvalidPersonaIdError
    | IndexReadError
    | SpecReadError
    | WriteFailureError
    | UpdateFailureError
)
"""Typed shell error surface for registry persistence operations."""


RegistryIndex: TypeAlias = dict[str, str]
"""Canonical ``index.json`` mapping from persona id to spec_digest."""


class RegistryStore(Protocol):
    """Authoritative shell-side contract for canonical PersonaSpec storage."""

    def save(self, spec: PersonaSpec) -> Result[None, RegistryError]:
        """Persist one canonical PersonaSpec and update digest index."""
        ...

    def get(self, id: str) -> Result[PersonaSpec, RegistryError]:
        """Load one canonical PersonaSpec by flat kebab-case id."""
        ...

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        """Enumerate canonical PersonaSpec records from registry boundary."""
        ...


class FileSystemRegistryStore(RegistryStore):
    """Filesystem-backed registry adapter contract.

    Root location is ``~/.larva/registry/`` by default.
    - Persona records: ``<id>.json``
    - Digest index: ``index.json``

    This class is intentionally contract-only in this step.
    """

    def __init__(self, root: Path = DEFAULT_REGISTRY_ROOT) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        """Configured registry root path for this adapter."""
        return self._root

    def save(self, spec: PersonaSpec) -> Result[None, RegistryError]:
        raise NotImplementedError("Contract-only stub: persistence belongs to implement step")

    def get(self, id: str) -> Result[PersonaSpec, RegistryError]:
        raise NotImplementedError("Contract-only stub: read path belongs to implement step")

    def list(self) -> Result[list[PersonaSpec], RegistryError]:
        raise NotImplementedError("Contract-only stub: enumeration belongs to implement step")


__all__ = [
    "DEFAULT_REGISTRY_ROOT",
    "INDEX_FILENAME",
    "SPEC_FILENAME_TEMPLATE",
    "FileSystemRegistryStore",
    "IndexReadError",
    "InvalidPersonaIdError",
    "MissingPersonaError",
    "RegistryError",
    "RegistryIndex",
    "RegistryStore",
    "SpecReadError",
    "UpdateFailureError",
    "WriteFailureError",
]
