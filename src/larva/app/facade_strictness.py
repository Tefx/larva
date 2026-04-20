"""Focused strictness helpers for facade admission paths."""

from __future__ import annotations

from larva.core.normalize import compute_spec_digest
from larva.core.validation_contract import ValidationIssue
from larva.core.validation_field_shapes import validate_field_shapes


def spec_digest_issues(spec: dict[str, object]) -> list[ValidationIssue]:
    """Return canonical stored-spec digest issues for read-path strictness.

    Stored larva output must always carry a canonical ``spec_digest`` matching
    the content digest. Read paths must fail closed instead of laundering stale
    or malformed digests through re-normalization.
    """
    if "spec_digest" not in spec:
        return [
            {
                "code": "MISSING_REQUIRED_FIELD",
                "message": "stored canonical spec is missing required field 'spec_digest'",
                "details": {"field": "spec_digest"},
            }
        ]

    type_issues = [
        issue
        for issue in validate_field_shapes({"spec_digest": spec.get("spec_digest")})
        if issue["details"].get("field") == "spec_digest"
    ]
    if type_issues:
        return type_issues

    actual_digest = spec.get("spec_digest")
    if not isinstance(actual_digest, str):
        return []

    expected_digest = compute_spec_digest(spec)
    if actual_digest == expected_digest:
        return []

    return [
        {
            "code": "INVALID_SPEC_DIGEST",
            "message": "stored spec_digest does not match canonical content digest",
            "details": {
                "field": "spec_digest",
                "expected": expected_digest,
                "actual": actual_digest,
            },
        }
    ]
