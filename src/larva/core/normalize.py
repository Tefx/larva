"""Contract-only normalize module for PersonaSpec normalization.

This module defines the canonical normalization contract for PersonaSpec
transformation. All behavior is acceptance-only - expressing what normalization
does without implementing business logic.

See:
- INTERFACES.md :: E. PersonaSpec Output Format :: Normalization
- ARCHITECTURE.md :: Module: larva.core.normalize
"""

import hashlib
import json
import re
from typing import cast

from deal import post, pre

from larva.core.spec import PersonaSpec


_SPEC_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


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
def _compute_spec_digest(spec: dict[str, object]) -> str:
    """Compute SHA-256 digest from canonical JSON representation.

    Canonical form: sorted keys, no whitespace, excluding spec_digest field.

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
@post(lambda result: "tools" not in result)
@post(lambda result: "side_effect_policy" not in result)
def normalize_spec(spec: dict[str, object]) -> PersonaSpec:
    """Normalize a PersonaSpec candidate into canonical form.

    Acceptance Contract (from INTERFACES.md):
    - Default `spec_version` to `"0.1.0"` when absent.
    - Compute `spec_digest` as SHA-256 of canonical JSON (sorted keys,
      no whitespace, excluding the spec_digest field itself).
    - Preserve flat self-contained output.

    Forbidden-Field Handling (hard-cut per ADR-002):
    - `tools` is forbidden at canonical admission and must not survive
      normalization. It is NOT mapped to capabilities.
    - `side_effect_policy` is forbidden at canonical admission and must
      not survive normalization.

    spec_digest Behavior:
    - Digest is computed AFTER canonicalization and forbidden-field stripping.
    - Input `spec_digest` is always overwritten with fresh computation.
    - Digest excludes the `spec_digest` field itself from canonical JSON.
    - Canonical output fields (including `capabilities` when present) are
      included in digest computation.

    Args:
        spec: Input PersonaSpec candidate (possibly incomplete).

    Returns:
        Canonical PersonaSpec with spec_version defaulted, forbidden fields
        stripped, and spec_digest computed.

    Examples:
        >>> normalize_spec({"id": "test"})["spec_version"]
        '0.1.0'
        >>> result = normalize_spec({"id": "test"})
        >>> result["spec_digest"].startswith("sha256:")
        True
        >>> len(result["spec_digest"]) == 71
        True
        >>> normalize_spec({"id": "test"}) == normalize_spec({"id": "test"})
        True
        >>> normalize_spec({"spec_digest": "stale_digest"})["spec_digest"] != "stale_digest"
        True
        >>> result = normalize_spec({"id": "test", "side_effect_policy": "read_only"})
        >>> "side_effect_policy" in result
        False
    """
    canonical_spec = dict(spec)

    # Apply defaults
    if "spec_version" not in canonical_spec:
        canonical_spec["spec_version"] = "0.1.0"

    # Forbidden fields stripped — tools is NOT mapped to capabilities (hard-cut).
    canonical_spec.pop("tools", None)
    canonical_spec.pop("side_effect_policy", None)

    digest = _compute_spec_digest(canonical_spec)
    return cast("PersonaSpec", {**canonical_spec, "spec_digest": digest})
