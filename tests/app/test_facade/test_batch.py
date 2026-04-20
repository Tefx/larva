"""Tests for facade update_batch operation.

Sources:
- ARCHITECTURE.md section 7 (Batch update use-case contract)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import cast

from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError

from .conftest import (
    InMemoryRegistryStore,
    _canonical_spec,
    _digest_for,
    _facade,
    _failure,
    _valid_report,
)


class TestFacadeUpdateBatch:
    """Acceptance tests for facade update_batch operation."""

    def test_update_batch_success_returns_counts_and_items_in_registry_order(self) -> None:
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        calls: list[str] = []
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"model_params.temperature": 0.5},
        )

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload["matched"] == 2
        assert payload["updated"] == 2
        assert payload["items"] == [
            {"id": "alpha", "updated": True},
            {"id": "beta", "updated": True},
        ]
        # Each matched spec goes through validate + normalize + validate while
        # scanning list results, then validate + validate + normalize + validate
        # during delegated update (stored-read strictness plus patched admission).
        assert calls == [
            "validate",
            "normalize",
            "validate",
            "validate",
            "normalize",
            "validate",
            "validate",
            "validate",
            "normalize",
            "validate",
            "validate",
            "validate",
            "normalize",
            "validate",
        ]
        assert len(validate_module.inputs) == 10
        assert len(normalize_module.inputs) == 4
        assert len(registry.save_inputs) == 2

    def test_update_batch_where_uses_and_across_clauses(self) -> None:
        spec_match = _canonical_spec("match-me")
        spec_match["model"] = "gpt-4o"
        spec_match["model_params"] = {"temperature": 0.7, "max_tokens": 1000}
        spec_match["spec_digest"] = _digest_for(spec_match)

        spec_wrong_model = _canonical_spec("wrong-model")
        spec_wrong_temp = _canonical_spec("wrong-temp")
        spec_wrong_temp["model"] = "gpt-4o"
        spec_wrong_temp["model_params"] = {"temperature": 0.3, "max_tokens": 1000}
        spec_wrong_temp["spec_digest"] = _digest_for(spec_wrong_temp)

        registry = InMemoryRegistryStore(
            list_result=Success([spec_match, spec_wrong_model, spec_wrong_temp])
        )
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.update_batch(
            where={"model": "gpt-4o", "model_params.temperature": 0.7},
            patches={"description": "Updated"},
        )

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload["matched"] == 1
        assert payload["updated"] == 1
        assert payload["items"] == [{"id": "match-me", "updated": True}]
        assert len(registry.save_inputs) == 1
        assert registry.save_inputs[0]["description"] == "Updated"

    def test_update_batch_missing_dotted_key_is_non_match(self) -> None:
        spec_nested = _canonical_spec("nested-match")
        spec_nested["model_params"] = {"temperature": 0.7, "nested": {"deep": "value"}}
        spec_nested["spec_digest"] = _digest_for(spec_nested)

        spec_missing = _canonical_spec("missing-path")
        spec_missing["model_params"] = {"temperature": 0.7}
        spec_missing["spec_digest"] = _digest_for(spec_missing)

        registry = InMemoryRegistryStore(list_result=Success([spec_nested, spec_missing]))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        result = facade.update_batch(
            where={"model_params.nested.deep": "value"},
            patches={"description": "Nested updated"},
        )

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload["matched"] == 1
        assert payload["updated"] == 1
        assert payload["items"] == [{"id": "nested-match", "updated": True}]

    def test_update_batch_dry_run_returns_matched_ids_without_writes(self) -> None:
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        calls: list[str] = []
        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta]))
        facade, _, validate_module, normalize_module = _facade(
            report=_valid_report(),
            registry=registry,
            calls=calls,
        )

        result = facade.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"description": "Should not persist"},
            dry_run=True,
        )

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert payload["matched"] == 2
        assert payload["updated"] == 0
        assert payload["items"] == [
            {"id": "alpha", "updated": False},
            {"id": "beta", "updated": False},
        ]
        assert registry.save_inputs == []
        assert len(validate_module.inputs) == 4
        assert len(normalize_module.inputs) == 2
        assert calls == [
            "validate",
            "normalize",
            "validate",
            "validate",
            "normalize",
            "validate",
        ]

    def test_update_batch_registry_list_failure_maps_to_facade_error(self) -> None:
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "cannot read registry index",
                    "path": "/tmp/registry/index.json",
                }
            )
        )
        facade, _, validate_module, normalize_module = _facade(registry=registry)

        result = facade.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"description": "Should not matter"},
        )

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert error["numeric_code"] == 107
        assert error["message"] == "cannot read registry index"
        assert error["details"]["path"] == "/tmp/registry/index.json"
        assert validate_module.inputs == []
        assert normalize_module.inputs == []

    def test_update_batch_delegates_update_in_order(self) -> None:
        spec_alpha = _canonical_spec("alpha")
        spec_beta = _canonical_spec("beta")
        spec_skip = _canonical_spec("skip")
        spec_skip["model"] = "gpt-4o"
        spec_skip["spec_digest"] = _digest_for(spec_skip)

        registry = InMemoryRegistryStore(list_result=Success([spec_alpha, spec_beta, spec_skip]))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        called_ids: list[str] = []

        def fake_update(
            persona_id: str,
            patches: dict[str, object],
        ) -> Result[dict, LarvaError]:
            called_ids.append(persona_id)
            return Success(_canonical_spec(persona_id))

        setattr(facade, "update", fake_update)

        result = facade.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"description": "delegated"},
        )

        assert isinstance(result, Success)
        payload = result.unwrap()
        assert called_ids == ["alpha", "beta"]
        assert payload["matched"] == 2
        assert payload["updated"] == 2
        assert payload["items"] == [
            {"id": "alpha", "updated": True},
            {"id": "beta", "updated": True},
        ]

    def test_update_batch_fails_fast_on_first_delegated_error_no_rollback(self) -> None:
        spec_first = _canonical_spec("first")
        spec_second = _canonical_spec("second")
        spec_third = _canonical_spec("third")
        registry = InMemoryRegistryStore(list_result=Success([spec_first, spec_second, spec_third]))
        facade, _, _, _ = _facade(report=_valid_report(), registry=registry)

        called_ids: list[str] = []

        def fake_update(
            persona_id: str,
            patches: dict[str, object],
        ) -> Result[dict, LarvaError]:
            called_ids.append(persona_id)
            if persona_id == "second":
                return Failure(
                    {
                        "code": "REGISTRY_WRITE_FAILED",
                        "numeric_code": 109,
                        "message": "disk full on second write",
                        "details": {
                            "persona_id": "second",
                            "path": "/tmp/second.json",
                        },
                    }
                )
            return Success(_canonical_spec(persona_id))

        setattr(facade, "update", fake_update)

        result = facade.update_batch(
            where={"model": "gpt-4o-mini"},
            patches={"description": "delegated"},
        )

        assert isinstance(result, Failure)
        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "REGISTRY_WRITE_FAILED"
        assert error["numeric_code"] == 109
        assert error["details"]["persona_id"] == "second"
        assert called_ids == ["first", "second"]
