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

from typing import Protocol, TypedDict

from returns.result import Result

from larva.core.spec import AssemblyInput, PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStore
from larva.shell.registry import RegistryStore


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
    ) -> None: ...

    def validate(self, spec: PersonaSpec) -> ValidationReport:
        raise NotImplementedError("Contract-only: facade validate flow is not implemented")

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]:
        raise NotImplementedError("Contract-only: facade assemble flow is not implemented")

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]:
        raise NotImplementedError("Contract-only: facade register flow is not implemented")

    def resolve(
        self,
        id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]:
        raise NotImplementedError("Contract-only: facade resolve flow is not implemented")

    def list(self) -> Result[list[PersonaSummary], LarvaError]:
        raise NotImplementedError("Contract-only: facade list flow is not implemented")
