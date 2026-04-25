"""Non-blocking canonical warning collection for PersonaSpec validation."""

from __future__ import annotations

import re

from deal import post, pre

_DESCRIPTION_WARN_MIN_CHARS = 20
_DESCRIPTION_WARN_MAX_CHARS = 500
_CANONICAL_PERSONA_ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
_MUTATING_POSTURES: frozenset[str] = frozenset({"read_write", "destructive"})
_READ_FOCUSED_PERSONA_MARKERS: frozenset[str] = frozenset(
    {
        "audit",
        "auditor",
        "read-only",
        "readonly",
        "review",
        "reviewer",
        "validate",
        "validator",
    }
)
_PROMPT_LIKE_DESCRIPTION_PREFIXES: tuple[str, ...] = (
    "you are ",
    "act as ",
    "follow these ",
    "always ",
    "never ",
    "respond with ",
)
_PROMPT_LIKE_DESCRIPTION_MARKERS: tuple[str, ...] = (
    "you are ",
    "respond with ",
    "step-by-step",
    "do not ",
    "must ",
)

_KNOWN_MODEL_SNAPSHOT: frozenset[str] = frozenset(
    {
        "gpt-4",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-5",
        "gpt-5.4",
        "openai/gpt-5.4",
        "openai/gpt-5.4-pro",
        "claude-opus-4",
        "claude-opus-4-20250514",
        "claude-sonnet-4",
        "claude-sonnet-4-5-20250514",
    }
)

_KNOWN_CAPABILITY_FAMILY_SNAPSHOT: frozenset[str] = frozenset(
    {
        "shell",
        "filesystem",
        "git",
        "email",
        "http",
        "network",
        "database",
        "browser",
        "python",
        "mcp",
    }
)


@pre(lambda description: isinstance(description, str) and len(description) <= 100_000)
@post(lambda result: isinstance(result, bool))
def _description_looks_like_prompt(description: str) -> bool:
    """Detect descriptions that read like executable prompt text.

    >>> _description_looks_like_prompt("Reviews code changes with explicit capability limits.")
    False
    >>> _description_looks_like_prompt("You are a meticulous reviewer.\\nAlways cite exact lines.")
    True
    """
    normalized = description.strip().lower()
    if normalized == "":
        return False

    if any(normalized.startswith(prefix) for prefix in _PROMPT_LIKE_DESCRIPTION_PREFIXES):
        return True

    return "\n" in description and any(
        marker in normalized for marker in _PROMPT_LIKE_DESCRIPTION_MARKERS
    )


@pre(lambda model: model is None or not isinstance(model, (tuple, set)))
@post(lambda result: result is None or isinstance(result, str))
def _model_snapshot_warning(model: object) -> str | None:
    """Warn when the model id is outside the known snapshot.

    >>> _model_snapshot_warning("custom-model")
    "unknown model identifier 'custom-model' is outside the known-model snapshot"
    >>> _model_snapshot_warning("gpt-4o-mini") is None
    True
    """
    if isinstance(model, str) and model.strip() and model not in _KNOWN_MODEL_SNAPSHOT:
        return f"unknown model identifier '{model}' is outside the known-model snapshot"
    return None


@pre(lambda capabilities: capabilities is None or not isinstance(capabilities, (tuple, set)))
@post(lambda result: isinstance(result, list) and all(isinstance(item, str) for item in result))
def _capability_snapshot_warnings(capabilities: object) -> list[str]:
    """Warn on non-blocking capability posture and vocabulary conditions.

    >>> _capability_snapshot_warnings({})[0]
    'capabilities is empty; this is valid but likely under-specified'
    >>> _capability_snapshot_warnings({"shell": "none"})[-1]
    "all declared capabilities are 'none'; this is valid but operationally inert"
    >>> class AttrDict(dict):
    ...     def items(self):
    ...         raise KeyError("__ch_pytype__")
    >>> _capability_snapshot_warnings(AttrDict())
    []
    """
    if not isinstance(capabilities, dict):
        return []

    try:
        capability_items = list(capabilities.items())
    except (KeyError, RuntimeError, TypeError):
        return []

    warnings: list[str] = []
    if len(capability_items) == 0:
        warnings.append("capabilities is empty; this is valid but likely under-specified")
        return warnings

    unknown_families = sorted(
        family
        for family, _posture in capability_items
        if isinstance(family, str) and family not in _KNOWN_CAPABILITY_FAMILY_SNAPSHOT
    )
    if unknown_families:
        warnings.append(
            "capabilities include unknown tool families outside the snapshot: "
            + ", ".join(unknown_families)
        )

    if all(
        isinstance(posture, str) and posture == "none"
        for _family, posture in capability_items
    ):
        warnings.append(
            "all declared capabilities are 'none'; this is valid but operationally inert"
        )

    return warnings


@pre(lambda description: description is None or not isinstance(description, (tuple, set)))
@post(lambda result: isinstance(result, list) and all(isinstance(item, str) for item in result))
def _description_warnings(description: object) -> list[str]:
    """Warn on description guidance violations.

    >>> _description_warnings("Too short")[0]
    'description length is outside guidance range 20-500 chars'
    >>> _description_warnings("You are a reviewer.\\nAlways cite lines.")[-1]
    'description looks like prompt text instead of a short operational summary'
    """
    if not isinstance(description, str):
        return []

    warnings: list[str] = []
    description_len = len(description.strip())
    if description_len > 0 and (
        description_len < _DESCRIPTION_WARN_MIN_CHARS
        or description_len > _DESCRIPTION_WARN_MAX_CHARS
    ):
        warnings.append(
            "description length is outside guidance range "
            f"{_DESCRIPTION_WARN_MIN_CHARS}-{_DESCRIPTION_WARN_MAX_CHARS} chars"
        )
    if _description_looks_like_prompt(description):
        warnings.append("description looks like prompt text instead of a short operational summary")
    return warnings


@pre(
    lambda can_spawn, registry_persona_ids=None: (
        can_spawn is None or isinstance(can_spawn, (bool, list, str, int, float, dict))
    )
    and (registry_persona_ids is None or isinstance(registry_persona_ids, frozenset))
)
@post(lambda result: isinstance(result, list) and all(isinstance(item, str) for item in result))
def _unknown_spawn_targets(
    can_spawn: object,
    registry_persona_ids: frozenset[str] | None = None,
) -> list[str]:
    """Return canonical spawn targets that are absent from the current snapshot.

    >>> _unknown_spawn_targets(["child-a", "child-b"], frozenset({"child-a"}))
    ['child-b']
    >>> _unknown_spawn_targets(True, frozenset({"child-a"}))
    []
    """
    if registry_persona_ids is None or not isinstance(can_spawn, list):
        return []

    return sorted(
        target
        for target in can_spawn
        if isinstance(target, str)
        and target.strip() != ""
        and _CANONICAL_PERSONA_ID_PATTERN.fullmatch(target)
        and target not in registry_persona_ids
    )


@pre(lambda spec: isinstance(spec, dict) and all(isinstance(key, str) for key in spec))
@post(lambda result: result is None or isinstance(result, str))
def _mutating_capability_warning(spec: dict[str, object]) -> str | None:
    """Warn when a read-focused persona declares mutating capability postures.

    >>> _mutating_capability_warning({
    ...     "id": "code-reviewer",
    ...     "description": "Reviews code changes with read-only expectations.",
    ...     "capabilities": {"filesystem": "read_write"},
    ... }) == (
    ...     "read-focused persona identity conflicts with mutating/destructive "
    ...     "capabilities: filesystem=read_write"
    ... )
    True
    >>> _mutating_capability_warning({
    ...     "id": "builder",
    ...     "description": "Builds tools.",
    ...     "capabilities": {"filesystem": "read_write"},
    ... }) is None
    True
    """
    capabilities = spec.get("capabilities")
    if not isinstance(capabilities, dict):
        return None

    try:
        capability_items = list(capabilities.items())
    except Exception:
        return None

    risky_postures = sorted(
        f"{family}={posture}"
        for family, posture in capability_items
        if isinstance(family, str)
        and isinstance(posture, str)
        and posture in _MUTATING_POSTURES
    )
    if not risky_postures:
        return None

    persona_text = " ".join(
        str(spec.get(field, "")) for field in ("id", "description")
    ).lower()
    if not any(marker in persona_text for marker in _READ_FOCUSED_PERSONA_MARKERS):
        return None

    return (
        "read-focused persona identity conflicts with mutating/destructive capabilities: "
        + ", ".join(risky_postures)
    )


@pre(
    lambda spec, registry_persona_ids=None: isinstance(spec, dict)
    and (registry_persona_ids is None or isinstance(registry_persona_ids, frozenset))
)
@post(lambda result: isinstance(result, list) and all(isinstance(item, str) for item in result))
def collect_non_blocking_warnings(
    spec: dict[str, object],
    registry_persona_ids: frozenset[str] | None = None,
) -> list[str]:
    """Collect canonical non-blocking warning signals.

    >>> collect_non_blocking_warnings({"model": "custom-model"})[0]
    "unknown model identifier 'custom-model' is outside the known-model snapshot"
    >>> collect_non_blocking_warnings({"capabilities": {"shell": "none"}})[0]
    "all declared capabilities are 'none'; this is valid but operationally inert"
    >>> collect_non_blocking_warnings(
    ...     {"can_spawn": ["child-a", "child-b"]},
    ...     frozenset({"child-a"}),
    ... )[-1]
    'can_spawn references ids outside the current registry snapshot: child-b'
    """
    warnings: list[str] = []

    model_warning = _model_snapshot_warning(spec.get("model"))
    if model_warning is not None:
        warnings.append(model_warning)

    warnings.extend(_capability_snapshot_warnings(spec.get("capabilities")))
    warnings.extend(_description_warnings(spec.get("description")))

    mutating_warning = _mutating_capability_warning(spec)
    if mutating_warning is not None:
        warnings.append(mutating_warning)

    unknown_spawn_targets = _unknown_spawn_targets(
        spec.get("can_spawn"),
        registry_persona_ids,
    )
    if unknown_spawn_targets:
        warnings.append(
            "can_spawn references ids outside the current registry snapshot: "
            + ", ".join(unknown_spawn_targets)
        )

    return warnings
