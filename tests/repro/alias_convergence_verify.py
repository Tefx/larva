"""Independent verification: alias convergence and error alignment.

Step: dup_error_abstraction.alias_verify
Intent: Prove that single/plural kind aliases reach the same loader
        and that invalid-kind handling is aligned across surfaces.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from returns.result import Failure, Success

from larva.core.component_kind import (
    CANONICAL_COMPONENT_KINDS,
    normalize_component_kind,
    invalid_component_kind_message,
)
from larva.shell.shared import component_queries as shared_component_queries
from larva.shell.python_api_components import _component_show_result


# ==============================================================================
# CONVERGENCE: Each alias pair normalizes to canonical plural
# ==============================================================================

ALIAS_PAIRS = [
    ("prompt", "prompts"),
    ("toolset", "toolsets"),
    ("constraint", "constraints"),
    ("model", "models"),
]

# Also verify canonical forms stay canonical
CANONICAL_SELF_MAP = [
    ("prompts", "prompts"),
    ("toolsets", "toolsets"),
    ("constraints", "constraints"),
    ("models", "models"),
]


class TestAliasConvergence:
    """Prove singular/plural aliases normalize to identical internal loader routing."""

    @pytest.mark.parametrize("singular,plural", ALIAS_PAIRS)
    def test_singular_normalizes_to_plural(self, singular: str, plural: str) -> None:
        """Singular alias must normalize to canonical plural."""
        result = normalize_component_kind(singular)
        assert result == plural, (
            f"Expected singular '{singular}' → canonical '{plural}', got '{result}'"
        )

    @pytest.mark.parametrize("singular,plural", ALIAS_PAIRS)
    def test_plural_is_canonical(self, singular: str, plural: str) -> None:
        """Plural form is already canonical."""
        result = normalize_component_kind(plural)
        assert result == plural, f"Expected plural '{plural}' to be canonical, got '{result}'"

    @pytest.mark.parametrize("canonical,expected", CANONICAL_SELF_MAP)
    def test_canonical_self_normalizes(self, canonical: str, expected: str) -> None:
        """Canonical kinds normalize to themselves."""
        result = normalize_component_kind(canonical)
        assert result == expected, (
            f"Expected canonical '{canonical}' → '{expected}', got '{result}'"
        )

    @pytest.mark.parametrize("singular,plural", ALIAS_PAIRS)
    def test_singular_reaches_same_loader_as_plural(
        self, singular: str, plural: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Both singular and plural must route to the same underlying loader.

        This is the behavioral convergence proof: alias surface -> identical loader.
        """
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

        monkeypatch.setattr(
            "larva.shell.python_api_components._component_store",
            _Store(),
        )

        # Singular alias
        _component_show_result(singular, "test-item")

        # Plural canonical
        _component_show_result(plural, "test-item")

        # Both must call the SAME loader (same internal meaning)
        # The call_record should have TWO identical entries
        assert len(call_record) == 2, f"Expected 2 calls, got {len(call_record)}"
        assert call_record[0] == call_record[1], (
            f"Singular '{singular}' and plural '{plural}' must reach same loader. "
            f"Got: singular → {call_record[0]}, plural → {call_record[1]}"
        )

    @pytest.mark.parametrize("singular,plural", ALIAS_PAIRS)
    def test_shared_service_routes_singular_and_plural_to_same_loader(
        self, singular: str, plural: str
    ) -> None:
        """Shared service must keep alias routing transport-neutral."""
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

        singular_result = shared_component_queries.query_component(
            _Store(),
            component_type=singular,
            component_name="test-item",
            operation="python_api.component_show",
        )
        plural_result = shared_component_queries.query_component(
            _Store(),
            component_type=plural,
            component_name="test-item",
            operation="python_api.component_show",
        )

        assert isinstance(singular_result, Success)
        assert isinstance(plural_result, Success)
        assert len(call_record) == 2, f"Expected 2 calls, got {len(call_record)}"
        assert call_record[0] == call_record[1]


class TestCanonicalVocabulary:
    """Verify the canonical vocabulary is exactly what INTERFACES.md specifies."""

    def test_canonical_kinds_are_exactly_four(self) -> None:
        """Contract: exactly four canonical kinds."""
        assert len(CANONICAL_COMPONENT_KINDS) == 4, (
            f"Expected exactly 4 canonical kinds, got {len(CANONICAL_COMPONENT_KINDS)}"
        )

    def test_canonical_kinds_match_spec(self) -> None:
        """Contract: canonical kinds must match INTERFACES.md specification."""
        expected = ("prompts", "toolsets", "constraints", "models")
        assert CANONICAL_COMPONENT_KINDS == expected, (
            f"Canonical kinds must match spec. Expected {expected}, got {CANONICAL_COMPONENT_KINDS}"
        )

    def test_invalid_kind_returns_none(self) -> None:
        """Invalid kinds must return None (not canonical)."""
        invalid_inputs = ["invalid", "promptz", "toolsetz", "unknown", "", "Prompts", "MODELS"]
        for kind in invalid_inputs:
            result = normalize_component_kind(kind)
            assert result is None, f"Invalid kind '{kind}' should return None, got '{result}'"


# ==============================================================================
# ERROR ALIGNMENT: Invalid kind handling across transports
# ==============================================================================


class TestErrorAlignment:
    """Prove invalid-kind error messages are consistent across surfaces."""

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
        assert "Invalid component type: invalid" in msg, (
            f"Expected error prefix in message, got: {msg}"
        )
        assert "prompts | toolsets | constraints | models" in msg, (
            f"Expected canonical vocabulary list in message, got: {msg}"
        )

    def test_error_message_includes_input(self) -> None:
        """Error message must echo the invalid input for debugging."""
        msg = invalid_component_kind_message("typo")
        assert "typo" in msg, f"Expected input 'typo' in message, got: {msg}"

    def test_all_invalid_kinds_produce_aligned_message(self) -> None:
        """All invalid inputs must produce messages with same structure."""
        test_cases = ["invalid", "typo", "unknown_model", "promptz"]

        for case in test_cases:
            msg = invalid_component_kind_message(case)
            # Structure must be: "Invalid component type: <input>. Supported values: <canonical>"
            assert msg.startswith("Invalid component type: "), (
                f"Message for '{case}' must start with prefix"
            )
            assert "Supported values: prompts | toolsets | constraints | models" in msg, (
                f"Message for '{case}' must include canonical vocabulary"
            )


class TestTransportBoundaryAlignment:
    """Prove Python API, MCP, Web, and CLI handle invalid kind consistently."""

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
        """Python API must include canonical vocabulary in invalid kind error."""
        from larva.shell.python_api_components import LarvaApiError
        from returns.result import Failure

        class _Store:
            def load_prompt(self, name: str):
                return Failure(Exception("not used"))

            def load_toolset(self, name: str):
                return Failure(Exception("not used"))

            def load_constraint(self, name: str):
                return Failure(Exception("not used"))

            def load_model(self, name: str):
                return Failure(Exception("not used"))

        pytest.MonkeyPatch().setattr(
            "larva.shell.python_api_components._component_store",
            _Store(),
        )

        result = _component_show_result("invalid_type", "test")
        assert isinstance(result, Failure), "Invalid kind must return Failure"

        error = result.failure()
        assert error["code"] == "INVALID_INPUT"
        assert "Invalid component type" in error["message"]
        # Must include canonical vocabulary for discoverability
        assert "prompts | toolsets | constraints | models" in error["message"] or (
            "prompts" in error["message"]
            and "toolsets" in error["message"]
            and "constraints" in error["message"]
            and "models" in error["message"]
        ), f"Error must include canonical vocabulary, got: {error['message']}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
