"""Contract-only normalize module for PersonaSpec normalization.

This module defines the canonical normalization contract for PersonaSpec
transformation. All behavior is acceptance-only - expressing what normalization
does without implementing business logic.

See:
- INTERFACES.md :: E. PersonaSpec Output Format :: Normalization
- ARCHITECTURE.md :: Module: larva.core.normalize
"""

from invar import post
from invar import pre

from larva.core.spec import PersonaSpec


@pre(lambda spec: isinstance(spec, dict))
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
        This is a contract stub. Implementation handles:
        - spec_version defaulting to "0.1.0" if missing
        - spec_digest computation from canonical JSON representation
        - Deterministic, pure transformation (no I/O side effects)

    Examples:
        >>> normalize_spec({"id": "test"})  # pragma: no cover
        Traceback (most recent call last):
            ...
        NotImplementedError: normalize_spec implementation pending core_normalize.core-normalize-implement
    """
    raise NotImplementedError(
        "normalize_spec implementation pending core_normalize.core-normalize-implement"
    )
