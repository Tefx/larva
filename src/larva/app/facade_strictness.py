"""Focused strictness helpers for facade admission paths."""

from __future__ import annotations

from larva.core.validation_contract import ValidationIssue
from larva.core.validation_field_shapes import validate_field_shapes


def spec_digest_issues(spec: dict[str, object]) -> list[ValidationIssue]:
    """Return only canonical spec_digest issues for a raw PersonaSpec-like mapping."""
    if "spec_digest" not in spec:
        return []
    return [
        issue
        for issue in validate_field_shapes({"spec_digest": spec.get("spec_digest")})
        if issue["details"].get("field") == "spec_digest"
    ]