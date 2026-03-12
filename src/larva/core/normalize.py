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

from deal import post, pre

from larva.core.spec import PersonaSpec


@pre(lambda spec: isinstance(spec, dict))
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
@post(lambda result: isinstance(result, str) and len(result) == 64)
def _compute_spec_digest(spec: PersonaSpec) -> str:
    """Compute SHA-256 digest from canonical JSON representation.

    Canonical form: sorted keys, no whitespace, excluding spec_digest field.

    Args:
        spec: PersonaSpec to compute digest for.

    Returns:
        Hex-encoded SHA-256 digest string.
    """
    spec_copy = {k: v for k, v in spec.items() if k != "spec_digest"}
    canonical_json = json.dumps(spec_copy, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


@pre(lambda spec: isinstance(spec, dict) and _is_json_serializable_spec(spec))
@post(lambda result: "spec_version" in result and "spec_digest" in result)
def normalize_spec(spec: PersonaSpec) -> PersonaSpec:
    """Normalize a PersonaSpec candidate into canonical form.

    Acceptance Contract (from INTERFACES.md):
    - Default `spec_version` to `"0.1.0"` when absent.
    - Compute `spec_digest` as SHA-256 of canonical JSON (sorted keys,
      no whitespace, excluding the spec_digest field itself).
    - Preserve flat self-contained output.

    Args:
        spec: Input PersonaSpec candidate (possibly incomplete).

    Returns:
        Canonical PersonaSpec with spec_version defaulted and spec_digest computed.

    Note:
        This implementation handles:
        - spec_version defaulting to "0.1.0" if missing
        - spec_digest computation from canonical JSON representation
        - Deterministic, pure transformation (no I/O side effects)

    Examples:
        >>> normalize_spec({"id": "test"})["spec_version"]
        '0.1.0'
        >>> result = normalize_spec({"id": "test"})
        >>> len(result["spec_digest"]) == 64
        True
        >>> normalize_spec({"id": "test"}) == normalize_spec({"id": "test"})
        True
        >>> normalize_spec({"spec_digest": "stale_digest"})["spec_digest"] != "stale_digest"
        True
    """
    if "spec_version" not in spec:
        spec = {**spec, "spec_version": "0.1.0"}

    digest = _compute_spec_digest(spec)
    return {**spec, "spec_digest": digest}
