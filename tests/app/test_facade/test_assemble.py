"""Tests for facade assemble operation.

Sources:
- ARCHITECTURE.md section 7 (Assembly -> Validation -> Normalization)
- INTERFACES.md section A/G (use-cases + app-level error codes)
"""

from __future__ import annotations

from typing import Any, cast

from returns.result import Failure, Result, Success

from larva.app.facade import DefaultLarvaFacade, LarvaError
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import validate as validate_module
from larva.core import spec as spec_module

from .conftest import (
    InMemoryComponentStore,
    InMemoryRegistryStore,
    RaisingAssembleModule,
    RaisingUnknownCodeAssembleModule,
    SpyValidateModule,
    SpyNormalizeModule,
    _canonical_spec,
    _facade,
    _failure,
    _invalid_report,
    _valid_report,
)


class TestFacadeAssemble:
    def test_assemble_runs_assemble_then_validate_then_normalize(self) -> None:
        calls: list[str] = []
        facade, assemble_module, validate_module, normalize_module = _facade(calls=calls)

        result = facade.assemble(
            {
                "id": "persona-a",
                "prompts": ["base"],
                "toolsets": ["default-tools"],
                "constraints": ["strict"],
                "model": "default-model",
                "overrides": {"description": "runtime description"},
            }
        )

        assert isinstance(result, Success)
        assert calls == ["assemble", "normalize", "validate"]
        assemble_input = assemble_module.inputs[0]
        assert assemble_input["id"] == "persona-a"
        assert assemble_input["prompts"] == [{"text": "Prompt body"}]
        assert assemble_input["toolsets"] == [{"capabilities": {"shell": "read_only"}}]
        assert assemble_input["constraints"] == [{"can_spawn": False}]
        assert assemble_input["model"] == {"model": "gpt-4o-mini"}
        assert "variables" not in assemble_input
        assert assemble_input["overrides"] == {"description": "runtime description"}
        # validate receives normalized spec, not the original candidate
        assert validate_module.inputs[0] == normalize_module.inputs[0]
        assert normalize_module.inputs[0]["id"] == "assembled"

    def test_assemble_rejects_unresolved_placeholder_without_variables_escape_hatch(self) -> None:
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=cast("Any", assemble_module),
            validate=cast("Any", validate_module),
            normalize=cast("Any", normalize_module),
            components=cast(
                "Any", InMemoryComponentStore(prompts_by_name={"templated": "You are {role}."})
            ),
            registry=InMemoryRegistryStore(),
        )

        result = facade.assemble({"id": "persona-a", "prompts": ["templated"]})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "UNRESOLVED_PROMPT_TEXT"
        assert cast("dict[str, object]", error["details"])["placeholders"] == ["role"]

    def test_assemble_rejects_variables_at_facade_request_boundary(self) -> None:
        facade, _, _, _ = _facade()

        result = facade.assemble({"id": "persona-a", "variables": {"role": "analyst"}})  # type: ignore[typeddict-unknown-key] # runtime boundary rejection coverage

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "INVALID_INPUT"
        assert cast("dict[str, object]", error["details"])["field"] == "variables"

    def test_assemble_component_miss_maps_to_app_error(self) -> None:
        components = InMemoryComponentStore(fail_prompt=True)
        facade, assemble_module, validate_module, normalize_module = _facade(components=components)

        result = facade.assemble({"id": "persona-a", "prompts": ["missing-prompt"]})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "COMPONENT_NOT_FOUND"
        assert error["numeric_code"] == 105
        assert "missing-prompt" in error["message"]
        assert error["details"]["component_type"] == "prompt"
        assert error["details"]["component_name"] == "missing-prompt"
        assert assemble_module.inputs == []
        assert validate_module.inputs == []
        assert normalize_module.inputs == []

    def test_assemble_component_conflict_maps_to_app_error(self) -> None:
        calls: list[str] = []
        assemble_module = RaisingAssembleModule(calls)
        validate_module = SpyValidateModule(_valid_report(), calls)
        normalize_module = SpyNormalizeModule(calls)
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(),
        )

        result = facade.assemble(
            {
                "id": "persona-a",
                "constraints": ["strict", "autonomous"],
            }
        )

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "COMPONENT_CONFLICT"
        assert error["numeric_code"] == 106
        assert error["details"]["field"] == "can_spawn"
        assert validate_module.inputs == []
        assert normalize_module.inputs == []

    def test_assemble_unknown_error_code_falls_back_to_internal_numeric_code(self) -> None:
        calls: list[str] = []
        assemble_module = RaisingUnknownCodeAssembleModule(calls)
        validate_module = SpyValidateModule(_valid_report(), calls)
        normalize_module = SpyNormalizeModule(calls)
        facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=InMemoryComponentStore(),
            registry=InMemoryRegistryStore(),
        )

        result = facade.assemble({"id": "persona-a"})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "UNMAPPED_ASSEMBLY_ERROR"
        assert error["numeric_code"] == 10
        assert error["message"] == "unmapped assembly failure"
        assert calls == ["assemble"]

    def test_assemble_validation_failure_returns_persona_invalid(self) -> None:
        calls: list[str] = []
        facade, _, _, normalize_module = _facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            calls=calls,
        )

        result = facade.assemble({"id": "persona-a", "prompts": ["base"]})

        error = _failure(cast("Result[object, LarvaError]", result))
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101
        assert error["details"]["report"]["errors"][0]["code"] == "INVALID_SPEC_VERSION"
        # normalize is called before validation in _normalize_and_validate
        # normalize receives the assembled candidate (default "assembled" id from SpyAssembleModule)
        assert normalize_module.inputs[0]["id"] == "assembled"
        assert calls == ["assemble", "normalize", "validate"]
