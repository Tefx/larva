"""Shared validation contract types and constants."""

from __future__ import annotations

from types import MappingProxyType
from typing import TypedDict

from deal import post, pre


CANONICAL_REQUIRED_FIELDS: tuple[str, ...] = (
    "id",
    "description",
    "prompt",
    "model",
    "capabilities",
    "spec_version",
)
CANONICAL_OPTIONAL_FIELDS: tuple[str, ...] = (
    "model_params",
    "can_spawn",
    "compaction_prompt",
    "spec_digest",
)
CANONICAL_FORBIDDEN_FIELDS: tuple[str, ...] = (
    "tools",
    "side_effect_policy",
    "variant",
    "_registry",
    "active",
    "manifest",
)

VALIDATION_ISSUE_KEYS: tuple[str, ...] = ("code", "message", "details")
VALIDATION_REPORT_KEYS: tuple[str, ...] = ("valid", "errors", "warnings")

CANONICAL_REQUIRED_FIELD_MESSAGE = (
    "required field '{field}' is missing at canonical admission boundary"
)
CANONICAL_FORBIDDEN_FIELD_MESSAGE = "'{field}' is not permitted at canonical admission boundary"
CANONICAL_UNKNOWN_FIELD_MESSAGE = (
    "unknown top-level field '{field}' is not permitted at canonical admission boundary"
)

CANONICAL_CAPABILITIES_REQUIRED_CLAUSE = "canonical admission requires capabilities"
CANONICAL_TOOLS_REJECTED_CLAUSE = "tools is rejected at canonical admission"
CANONICAL_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE = (
    "tools is rejected and side_effect_policy is rejected at canonical admission"
)

CANONICAL_CONTRACT_METADATA = MappingProxyType(
    {
        "required_fields": CANONICAL_REQUIRED_FIELDS,
        "optional_fields": CANONICAL_OPTIONAL_FIELDS,
        "forbidden_fields": CANONICAL_FORBIDDEN_FIELDS,
        "validation_issue_keys": VALIDATION_ISSUE_KEYS,
        "validation_report_keys": VALIDATION_REPORT_KEYS,
        "required_field_message": CANONICAL_REQUIRED_FIELD_MESSAGE,
        "forbidden_field_message": CANONICAL_FORBIDDEN_FIELD_MESSAGE,
        "unknown_field_message": CANONICAL_UNKNOWN_FIELD_MESSAGE,
        "capabilities_required_clause": CANONICAL_CAPABILITIES_REQUIRED_CLAUSE,
        "tools_rejected_clause": CANONICAL_TOOLS_REJECTED_CLAUSE,
        "forbidden_legacy_vocabulary_clause": CANONICAL_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE,
    }
)


class ValidationIssue(TypedDict):
    code: str
    message: str
    details: dict[str, object]


@pre(
    lambda code, message, details: isinstance(code, str)
    and code != ""
    and isinstance(message, str)
    and message != ""
    and isinstance(details, dict)
)
@post(
    lambda result: isinstance(result, dict)
    and "code" in result
    and "message" in result
    and "details" in result
)
def validation_issue(code: str, message: str, details: dict[str, object]) -> ValidationIssue:
    """Build a canonical ValidationIssue with typed fields.

    >>> issue = validation_issue("MISSING_REQUIRED_FIELD", "id is required", {"field": "id"})
    >>> issue["code"]
    'MISSING_REQUIRED_FIELD'
    >>> issue["message"]
    'id is required'
    >>> issue["details"]["field"]
    'id'
    >>> validation_issue("", "msg", {})  # doctest: +ELLIPSIS
    Traceback (most recent call last):
    ...
    deal.PreContractError: ...
    """
    return {"code": code, "message": message, "details": details}


class ValidationReport(TypedDict):
    valid: bool
    errors: list[ValidationIssue]
    warnings: list[str]
