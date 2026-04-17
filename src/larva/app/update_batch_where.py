"""Canonical validation for update_batch where clauses."""

from __future__ import annotations

from collections.abc import Collection
from typing import TypedDict


_UPDATE_BATCH_DOTTED_WHERE_FIELDS = frozenset({"capabilities", "model_params"})


class UpdateBatchWhereIssue(TypedDict):
    """Structured update_batch where validation failure."""

    message: str
    details: dict[str, object]


def validate_update_batch_where(
    *,
    persona_fields: Collection[str],
    where: dict[str, object],
) -> UpdateBatchWhereIssue | None:
    """Return the first canonical where-clause violation, if any."""
    canonical_fields = frozenset(persona_fields)

    for raw_key in where.keys():
        if not isinstance(raw_key, str) or raw_key == "":
            return {
                "message": "where clause keys must be non-empty strings",
                "details": {
                    "field": "where",
                    "received_key": raw_key,
                    "received_key_type": type(raw_key).__name__,
                },
            }

        path_parts = raw_key.split(".")
        if any(part == "" for part in path_parts):
            return {
                "message": f"where clause '{raw_key}' is not a valid canonical selector",
                "details": {"field": raw_key, "where_key": raw_key},
            }

        root = path_parts[0]
        if root not in canonical_fields:
            return {
                "message": f"where clause field '{root}' is not permitted at canonical update boundary",
                "details": {"field": root, "where_key": raw_key},
            }

        if len(path_parts) > 1 and root not in _UPDATE_BATCH_DOTTED_WHERE_FIELDS:
            return {
                "message": f"where clause '{raw_key}' is not a valid canonical dotted selector",
                "details": {"field": raw_key, "root_field": root, "where_key": raw_key},
            }

    return None
