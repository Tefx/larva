"""Contract-only normalize module for PersonaSpec normalization.

This module defines the canonical normalization contract for PersonaSpec
transformation. Normalization canonicalizes digest/default fields, but it does
not convert forbidden legacy fields into acceptable canonical input.

See:
- INTERFACES.md :: E. PersonaSpec Output Format :: Normalization
- ARCHITECTURE.md :: Module: larva.core.normalize
"""

import hashlib
import json
import re
from typing import Any, cast

from deal import post, pre, raises

from larva.core.spec import PersonaSpec


_SPEC_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_FORBIDDEN_NORMALIZE_FIELDS = frozenset({"tools", "side_effect_policy"})


class NormalizeError(Exception):
    """Normalization contract failure."""

    code: str
    message: str
    details: dict[str, Any]


@pre(
    lambda code, message, details=None: (
        isinstance(code, str)
        and len(code) > 0
        and isinstance(message, str)
        and len(message) > 0
        and (details is None or isinstance(details, dict))
    )
)
@post(
    lambda result: (
        isinstance(result, NormalizeError)
        and isinstance(result.code, str)
        and len(result.code) > 0
        and isinstance(result.message, str)
        and len(result.message) > 0
        and isinstance(result.details, dict)
    )
)
def _normalize_error(
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> NormalizeError:
    error = NormalizeError(f"{code}: {message}")
    error.code = code
    error.message = message
    error.details = {} if details is None else details
    return error


@pre(lambda spec: isinstance(spec, dict) and _is_json_serializable_spec(spec))
@post(lambda result: result is None)
@raises(NormalizeError)
def _reject_noncanonical_normalize_input(spec: dict[str, object]) -> None:
    """Reject hard-cut legacy inputs before digest computation.

    >>> _reject_noncanonical_normalize_input({"id": "p", "spec_version": "0.1.0"})
    >>> _reject_noncanonical_normalize_input({"id": "p"})
    Traceback (most recent call last):
    ...
    normalize.NormalizeError: MISSING_SPEC_VERSION: spec_version is required at canonical normalize boundary
    >>> _reject_noncanonical_normalize_input({"id": "p", "spec_version": "0.1.0", "tools": {"shell": "read_only"}})
    Traceback (most recent call last):
    ...
    normalize.NormalizeError: FORBIDDEN_FIELD: field 'tools' is not permitted at canonical normalize boundary
    """
    if "spec_version" not in spec:
        raise _normalize_error(
            code="MISSING_SPEC_VERSION",
            message="spec_version is required at canonical normalize boundary",
            details={"field": "spec_version"},
        )

    for field in _FORBIDDEN_NORMALIZE_FIELDS:
        if field in spec:
            raise _normalize_error(
                code="FORBIDDEN_FIELD",
                message=f"field '{field}' is not permitted at canonical normalize boundary",
                details={"field": field},
            )


@pre(lambda spec: "spec_digest" not in spec or isinstance(spec.get("spec_digest"), str))
@post(lambda result: isinstance(result, bool))
def _is_json_serializable_spec(spec: dict[str, object]) -> bool:
    """Return True when spec can be encoded as canonical JSON."""
    try:
        spec_copy = {k: v for k, v in spec.items() if k != "spec_digest"}
        json.dumps(spec_copy, sort_keys=True, separators=(",", ":"))
        return True
    except (TypeError, ValueError):
        return False


@pre(lambda spec: _is_json_serializable_spec(spec))
@post(lambda result: isinstance(result, str) and _SPEC_DIGEST_PATTERN.fullmatch(result) is not None)
def compute_spec_digest(spec: dict[str, object]) -> str:
    """Compute SHA-256 digest from canonical JSON representation.

    Canonical form: sorted keys, no whitespace, excluding spec_digest field.

    >>> digest = compute_spec_digest({"id": "test", "spec_version": "0.1.0"})
    >>> digest.startswith("sha256:")
    True
    >>> len(digest)
    71

    Args:
        spec: PersonaSpec to compute digest for.

    Returns:
        `sha256:<hex>` SHA-256 digest string.
    """
    spec_copy = {k: v for k, v in spec.items() if k != "spec_digest"}
    canonical_json = json.dumps(spec_copy, sort_keys=True, separators=(",", ":"))
    digest_hex = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    return f"sha256:{digest_hex}"


@pre(lambda spec: isinstance(spec, dict) and _is_json_serializable_spec(spec))
@post(lambda result: "spec_version" in result and "spec_digest" in result)
@post(lambda result: "capabilities" not in result or isinstance(result.get("capabilities"), dict))
@post(lambda result: "tools" not in result and "side_effect_policy" not in result)
@raises(NormalizeError)
def normalize_spec(spec: dict[str, object]) -> PersonaSpec:
    """Normalize a PersonaSpec candidate into canonical form.

    Acceptance Contract (from INTERFACES.md):
    - Require `spec_version`; missing values are rejected, not defaulted.
    - Compute `spec_digest` as SHA-256 of canonical JSON (sorted keys,
      no whitespace, excluding the spec_digest field itself).
    - Preserve flat self-contained output.

    Forbidden-Field Handling (hard-cut per ADR-002):
    - `tools` is forbidden at canonical admission and is NOT mapped to
      capabilities.
    - `side_effect_policy` is forbidden at canonical admission.
    - Normalization rejects forbidden fields immediately instead of preserving
      them for later rejection.

    spec_digest Behavior:
    - Digest is computed AFTER canonicalization.
    - Input `spec_digest` is always overwritten with fresh computation.
    - Digest excludes the `spec_digest` field itself from canonical JSON.
    - All remaining output fields (including forbidden fields when present)
      are included in digest computation.

    Args:
        spec: Input PersonaSpec candidate.

    Returns:
        PersonaSpec-shaped dict with existing spec_version preserved and
        spec_digest computed.

    Examples:
        >>> normalize_spec({"id": "test", "spec_version": "0.1.0"})["spec_version"]
        '0.1.0'
        >>> result = normalize_spec({"id": "test", "spec_version": "0.1.0"})
        >>> result["spec_digest"].startswith("sha256:")
        True
        >>> len(result["spec_digest"]) == 71
        True
        >>> normalize_spec({"id": "test", "spec_version": "0.1.0"}) == normalize_spec({"id": "test", "spec_version": "0.1.0"})
        True
        >>> normalize_spec({"spec_version": "0.1.0", "spec_digest": "stale_digest"})["spec_digest"] != "stale_digest"
        True
        >>> normalize_spec({"id": "test"})
        Traceback (most recent call last):
        ...
        normalize.NormalizeError: MISSING_SPEC_VERSION: spec_version is required at canonical normalize boundary
    """
    _reject_noncanonical_normalize_input(spec)
    canonical_spec = dict(spec)

    digest = compute_spec_digest(canonical_spec)
    return cast("PersonaSpec", {**canonical_spec, "spec_digest": digest})
