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
@post(lambda result: "tools" not in result or isinstance(result.get("tools"), dict))
@post(lambda result: result.get("capabilities") is not None or result.get("tools") is None)
def normalize_spec(spec: dict[str, object]) -> PersonaSpec:
    """Normalize a PersonaSpec candidate into canonical form.

    Acceptance Contract (from INTERFACES.md):
    - Default `spec_version` to `"0.1.0"` when absent.
    - Compute `spec_digest` as SHA-256 of canonical JSON (sorted keys,
      no whitespace, excluding the spec_digest field itself).
    - Preserve flat self-contained output.

    ADR-002 Transition (tools -> capabilities):
    - If `tools` present and `capabilities` absent: copy tools to capabilities.
    - If both present: `capabilities` wins (tools ignored).
    - Output always contains `capabilities` (canonical field).
    - During transition: output mirrors `capabilities` to `tools` for compatibility.

    spec_digest Behavior:
    - Digest is computed AFTER `tools` -> `capabilities` normalization.
    - Input `spec_digest` is always overwritten with fresh computation.
    - Digest excludes the `spec_digest` field itself from canonical JSON.
    - Both `capabilities` and `tools` (if present after normalization) are
      included in digest computation.

    Args:
        spec: Input PersonaSpec candidate (possibly incomplete).

    Returns:
        Canonical PersonaSpec with spec_version defaulted, tools normalized
        to capabilities (transition), and spec_digest computed.

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
        >>> # ADR-002: tools-only spec normalizes to capabilities
        >>> result = normalize_spec({"id": "test", "tools": {"filesystem": "read_only"}})
        >>> result.get("capabilities") == {"filesystem": "read_only"}
        True
        >>> result.get("tools") == {"filesystem": "read_only"}  # mirrored during transition
        True
        >>> # ADR-002: capabilities-only spec passes through
        >>> result = normalize_spec({"id": "test", "capabilities": {"git": "read_write"}})
        >>> result.get("capabilities") == {"git": "read_write"}
        True
        >>> result.get("tools") == {"git": "read_write"}  # mirrored during transition
        True
        >>> # ADR-002: both present - capabilities wins
        >>> result = normalize_spec({"id": "test", "tools": {"filesystem": "read_only"}, "capabilities": {"git": "read_write"}})
        >>> result.get("capabilities") == {"git": "read_write"}
        True
        >>> result.get("tools") == {"git": "read_write"}  # mirrors capabilities
        True
    """
    # Apply defaults
    if "spec_version" not in spec:
        spec = {**spec, "spec_version": "0.1.0"}

    # ADR-002: Normalize tools -> capabilities
    tools = spec.get("tools")
    capabilities = spec.get("capabilities")

    if capabilities is not None:
        # Capabilities present (canonical wins) - mirror to tools during transition
        spec = {**spec, "tools": capabilities}
    elif tools is not None:
        # Only tools present - copy to capabilities
        spec = {**spec, "capabilities": tools}

    digest = _compute_spec_digest(spec)
    return cast("PersonaSpec", {**spec, "spec_digest": digest})
