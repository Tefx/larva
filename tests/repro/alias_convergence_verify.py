"""Independent verification: canonical component-kind rejection and error alignment.

Intent: prove only canonical plural component kinds are accepted on shared helper
and Python API paths, while singular aliases fail closed with aligned
``invalid_kind`` semantics.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from returns.result import Failure, Success

from larva.core.component_kind import (
    CANONICAL_COMPONENT_KINDS,
    invalid_component_kind_message,
    normalize_component_kind,
)
from larva.shell.python_api_components import _component_show_result
from larva.shell.shared import component_queries as shared_component_queries

SINGULAR_ALIAS_PAIRS = [
    ("prompt", "prompts"),
    ("toolset", "toolsets"),
    ("constraint", "constraints"),
    ("model", "models"),
]


class TestCanonicalVocabulary:
    """Verify canonical component-kind vocabulary stays plural-only."""

    @pytest.mark.parametrize("singular,plural", SINGULAR_ALIAS_PAIRS)
    def test_singular_aliases_are_not_canonical(self, singular: str, plural: str) -> None:
        """Singular aliases must be rejected instead of normalized."""
        result = normalize_component_kind(singular)
        assert result is None, (
            f"Singular alias '{singular}' must fail closed instead of normalizing to '{plural}'"
        )

    def test_canonical_kinds_match_spec(self) -> None:
        """Canonical component kinds are exactly the four plural shared names."""
        expected = ("prompts", "toolsets", "constraints", "models")
        assert CANONICAL_COMPONENT_KINDS == expected, (
            f"Canonical kinds must match spec. Expected {expected}, got {CANONICAL_COMPONENT_KINDS}"
        )

    @pytest.mark.parametrize("plural", CANONICAL_COMPONENT_KINDS)
    def test_canonical_plural_kinds_normalize_to_themselves(self, plural: str) -> None:
        """Canonical plural kinds remain stable under normalization."""
        result = normalize_component_kind(plural)
        assert result == plural, f"Expected canonical kind '{plural}' to stay canonical"

    def test_invalid_kind_returns_none(self) -> None:
        """Invalid kinds must return None (not a silent alias)."""
        invalid_inputs = ["invalid", "promptz", "toolsetz", "unknown", "", "Prompts", "MODELS"]
        for kind in invalid_inputs:
            result = normalize_component_kind(kind)
            assert result is None, f"Invalid kind '{kind}' should return None, got '{result}'"


class TestCanonicalRoutingBehavior:
    """Verify canonical kinds load, and singular aliases fail before loader routing."""

    def test_shared_service_routes_canonical_plural_kind_to_loader(self) -> None:
        """Canonical plural kind must reach the expected loader."""
        call_record: list[str] = []

        class _Store:
            def load_prompt(self, name: str):
                call_record.append(f"load_prompt:{name}")
                return Success({"text": f"prompt {name}"})

            def load_toolset(self, name: str):
                call_record.append(f"load_toolset:{name}")
                return Success({"capabilities": {}})

            def load_constraint(self, name: str):
                call_record.append(f"load_constraint:{name}")
                return Success({})

            def load_model(self, name: str):
                call_record.append(f"load_model:{name}")
                return Success({"model": "test"})

        result = shared_component_queries.query_component(
            _Store(),
            component_type="prompts",
            component_name="test-item",
            operation="python_api.component_show",
        )

        assert isinstance(result, Success)
        assert result.unwrap() == {"text": "prompt test-item"}
        assert call_record == ["load_prompt:test-item"]

    @pytest.mark.parametrize("singular,_plural", SINGULAR_ALIAS_PAIRS)
    def test_python_api_result_rejects_singular_alias_before_loader(
        self,
        singular: str,
        _plural: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Python API helper must reject singular aliases before any loader call."""
        call_record: list[str] = []

        class _Store:
            def load_prompt(self, name: str):
                call_record.append(f"load_prompt:{name}")
                return Success({"text": f"prompt {name}"})

            def load_toolset(self, name: str):
                call_record.append(f"load_toolset:{name}")
                return Success({"capabilities": {}})

            def load_constraint(self, name: str):
                call_record.append(f"load_constraint:{name}")
                return Success({})

            def load_model(self, name: str):
                call_record.append(f"load_model:{name}")
                return Success({"model": "test"})

        monkeypatch.setattr("larva.shell.python_api_components._component_store", _Store())

        result = _component_show_result(singular, "test-item")

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "INVALID_INPUT"
        assert error["details"]["reason"] == "invalid_kind"
        assert call_record == []

    @pytest.mark.parametrize("singular,_plural", SINGULAR_ALIAS_PAIRS)
    def test_shared_service_rejects_singular_alias_before_loader(
        self,
        singular: str,
        _plural: str,
    ) -> None:
        """Shared service must fail closed for singular aliases before any loader call."""
        call_record: list[str] = []

        class _Store:
            def load_prompt(self, name: str):
                call_record.append(f"load_prompt:{name}")
                return Success({"text": f"prompt {name}"})

            def load_toolset(self, name: str):
                call_record.append(f"load_toolset:{name}")
                return Success({"capabilities": {}})

            def load_constraint(self, name: str):
                call_record.append(f"load_constraint:{name}")
                return Success({})

            def load_model(self, name: str):
                call_record.append(f"load_model:{name}")
                return Success({"model": "test"})

        result = shared_component_queries.query_component(
            _Store(),
            component_type=singular,
            component_name="test-item",
            operation="python_api.component_show",
        )

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "INVALID_INPUT"
        assert error["details"]["reason"] == "invalid_kind"
        assert call_record == []


class TestErrorAlignment:
    """Prove invalid-kind error messages are consistent across helper surfaces."""

    def test_shared_service_invalid_kind_projects_canonical_error(self) -> None:
        """Shared service must preserve invalid-kind error category."""

        class _Store:
            def load_prompt(self, name: str):
                return Success({})

            def load_toolset(self, name: str):
                return Success({})

            def load_constraint(self, name: str):
                return Success({})

            def load_model(self, name: str):
                return Success({})

        result = shared_component_queries.query_component(
            _Store(),
            component_type="invalid",
            component_name="test-item",
            operation="python_api.component_show",
        )

        assert isinstance(result, Failure)
        error = result.failure()
        assert error["code"] == "INVALID_INPUT"
        assert error["details"]["reason"] == "invalid_kind"
        assert error["message"] == invalid_component_kind_message("invalid")

    def test_error_message_format(self) -> None:
        """Invalid kind message must include canonical vocabulary list."""
        msg = invalid_component_kind_message("invalid")
        assert "Invalid component type: invalid" in msg
        assert "prompts | toolsets | constraints | models" in msg

    def test_all_invalid_kinds_produce_aligned_message(self) -> None:
        """All invalid inputs must produce messages with the same structure."""
        for case in ["invalid", "typo", "unknown_model", "promptz"]:
            msg = invalid_component_kind_message(case)
            assert msg.startswith("Invalid component type: ")
            assert "Supported values: prompts | toolsets | constraints | models" in msg


class TestTransportBoundaryAlignment:
    """Prove shared helper stays transport-neutral and Python API preserves canonical errors."""

    def test_shared_module_has_no_framework_imports(self) -> None:
        """Extracted shared service must stay transport-neutral."""
        source = shared_component_queries.__file__
        assert source is not None
        module_text = Path(source).read_text(encoding="utf-8")

        forbidden_markers = (
            "fastapi",
            "starlette",
            "click",
            "typer",
            "argparse",
            "mcp",
            "http",
        )
        for marker in forbidden_markers:
            assert marker not in module_text, (
                f"Shared component query module must stay transport-neutral; found '{marker}'"
            )

    def test_python_api_invalid_kind_error_includes_canonical(self) -> None:
        """Python API must include canonical vocabulary in invalid-kind error."""

        class _Store:
            def load_prompt(self, name: str):
                return Failure(Exception("not used"))

            def load_toolset(self, name: str):
                return Failure(Exception("not used"))

            def load_constraint(self, name: str):
                return Failure(Exception("not used"))

            def load_model(self, name: str):
                return Failure(Exception("not used"))

        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr("larva.shell.python_api_components._component_store", _Store())
        try:
            result = _component_show_result("invalid_type", "test")
        finally:
            monkeypatch.undo()

        assert isinstance(result, Failure), "Invalid kind must return Failure"
        error = result.failure()
        assert error["code"] == "INVALID_INPUT"
        assert "Invalid component type" in error["message"]
        assert "prompts | toolsets | constraints | models" in error["message"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
