"""Registry-facing facade operations extracted from the main facade."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, TypeAlias, cast

from returns.result import Failure, Success

from larva.app.update_batch_where import validate_update_batch_where

if TYPE_CHECKING:
    from returns.result import Result

    from larva.app.facade_types import (
        BatchUpdateItemResult,
        BatchUpdateResult,
        ClearedRegistry,
        DeletedPersona,
        LarvaError,
        PersonaSummary,
        SpecModule,
    )
    from larva.core.spec import PersonaSpec
    from larva.shell.registry import RegistryError, RegistryStore

_LOOKUP_NOT_FOUND = object()
PersonaSpecList: TypeAlias = list["PersonaSpec"]
StrList: TypeAlias = list[str]


class _RegistryOpsHost(Protocol):
    _spec: SpecModule
    _registry: RegistryStore

    def _error(self, *, code: str, message: str, details: dict[str, object]) -> LarvaError: ...

    def _registry_failure_error(
        self,
        error: RegistryError,
        extra_details: dict[str, object] | None = None,
    ) -> LarvaError: ...

    def _validate_registry_read_spec(self, spec: PersonaSpec) -> Result[None, LarvaError]: ...

    def _normalize_validated_spec(self, spec: PersonaSpec) -> Result[PersonaSpec, LarvaError]: ...

    def update(
        self,
        persona_id: str,
        patches: dict[str, object],
        variant: str | None = None,
    ) -> Result[PersonaSpec, LarvaError]: ...

    def _normalize_and_validate(self, spec: PersonaSpec) -> Result[PersonaSpec, LarvaError]: ...


class RegistryFacadeOps(_RegistryOpsHost):
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

    def update_batch(
        self,
        where: dict[str, object],
        patches: dict[str, object],
        dry_run: bool = False,
    ) -> Result[BatchUpdateResult, LarvaError]:
        where_issue = validate_update_batch_where(
            persona_fields=self._spec.PersonaSpec.__annotations__,
            where=where,
        )
        if where_issue is not None:
            return Failure(
                self._error(
                    code="INVALID_INPUT",
                    message=where_issue["message"],
                    details=where_issue["details"],
                )
            )

        list_result = self._registry.list()
        if isinstance(list_result, Failure):
            return Failure(self._registry_failure_error(list_result.failure()))

        matched_specs: list[PersonaSpec] = []
        for raw_spec in list_result.unwrap():
            stored_validation = self._validate_registry_read_spec(raw_spec)
            if isinstance(stored_validation, Failure):
                return stored_validation
            normalized_result = self._normalize_validated_spec(raw_spec)
            if isinstance(normalized_result, Failure):
                return normalized_result
            canonical_spec = normalized_result.unwrap()
            where_matches = True
            for dotted_key, expected_value in where.items():
                actual_value = self._dotted_lookup_or_not_found(
                    cast("dict[str, object]", canonical_spec),
                    dotted_key,
                )
                if actual_value is _LOOKUP_NOT_FOUND or actual_value != expected_value:
                    where_matches = False
                    break
            if where_matches:
                matched_specs.append(canonical_spec)

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
        for raw_spec in list_result.unwrap():
            stored_validation = self._validate_registry_read_spec(raw_spec)
            if isinstance(stored_validation, Failure):
                return stored_validation
            normalized_result = self._normalize_validated_spec(raw_spec)
            if isinstance(normalized_result, Failure):
                return normalized_result
            summary_result = self._summary_from_spec(normalized_result.unwrap())
            if isinstance(summary_result, Failure):
                return summary_result
            summaries.append(summary_result.unwrap())
        return Success(summaries)

    def clone(self, source_id: str, new_id: str) -> Result[PersonaSpec, LarvaError]:
        get_result = self._registry.get(source_id)
        if isinstance(get_result, Failure):
            return Failure(self._registry_failure_error(get_result.failure()))

        cloned = dict(get_result.unwrap())
        stored_validation = self._validate_registry_read_spec(cast("PersonaSpec", cloned))
        if isinstance(stored_validation, Failure):
            return stored_validation
        cloned["id"] = new_id
        if "spec_digest" in cloned:
            del cloned["spec_digest"]

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

    def export_all(self) -> Result[PersonaSpecList, LarvaError]:
        list_result = self._registry.list()
        if isinstance(list_result, Failure):
            return Failure(self._registry_failure_error(list_result.failure()))

        specs: list[PersonaSpec] = []
        for raw_spec in list_result.unwrap():
            stored_validation = self._validate_registry_read_spec(raw_spec)
            if isinstance(stored_validation, Failure):
                return stored_validation
            normalized_result = self._normalize_validated_spec(raw_spec)
            if isinstance(normalized_result, Failure):
                return normalized_result
            specs.append(normalized_result.unwrap())
        return Success(specs)

    def export_ids(self, ids: StrList) -> Result[PersonaSpecList, LarvaError]:
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
            stored_spec = get_result.unwrap()
            stored_validation = self._validate_registry_read_spec(stored_spec)
            if isinstance(stored_validation, Failure):
                return stored_validation
            normalized_result = self._normalize_validated_spec(stored_spec)
            if isinstance(normalized_result, Failure):
                return normalized_result
            specs.append(normalized_result.unwrap())
        return Success(specs)
