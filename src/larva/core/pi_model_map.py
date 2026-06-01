"""Pure functions and types for drafting Pi model maps."""

from __future__ import annotations

from typing import TypedDict

from deal import post, pre
from returns.result import Result, Success

class ModelMapEntry(TypedDict):
    provider: str
    model_id: str

class PrefixRule(TypedDict):
    from_prefix: str
    to_provider: str
    to_model_id_prefix: str

class PiModelMapDraft(TypedDict):
    models: dict[str, ModelMapEntry]
    prefix_rules: list[PrefixRule]

class UnresolvedModel(TypedDict):
    source_model: str
    used_by: list[str]
    reason: str
    candidates: list[ModelMapEntry]

class PrefixRuleFinding(TypedDict):
    rule: PrefixRule
    reason: str
    affected_models: list[str]

class PiModelMapDraftResult(TypedDict):
    draft: PiModelMapDraft
    covered_models: list[str]
    stale_models: list[str]
    invalid_existing_models: list[str]
    stale_prefix_rules: list[PrefixRuleFinding]
    invalid_prefix_rules: list[PrefixRuleFinding]
    conflicting_prefix_rules: list[PrefixRuleFinding]
    unresolved: list[UnresolvedModel]
    output_path: str | None
    wrote_file: bool

class RegistryModelUse(TypedDict):
    model: str
    used_by: list[str]

class PiModelInventoryItem(TypedDict):
    provider: str
    model_id: str


@pre(lambda registry_usage, inventory, existing_map=None: all(item.get("model", "") != "" for item in registry_usage) and all(item.get("provider", "") != "" and item.get("model_id", "") != "" for item in inventory) and (existing_map is None or "models" in existing_map))
@post(lambda result: isinstance(result, Result))
def draft_model_map(
    registry_usage: list[RegistryModelUse],
    inventory: list[PiModelInventoryItem],
    existing_map: PiModelMapDraft | None = None,
) -> Result[PiModelMapDraftResult, str]:
    """
    Draft a stable model map from registry models and Pi inventory.
    
    This function is purely deterministic and performs no I/O.
    It does not guess vendor preferences or read any external files.

    >>> draft_model_map([], [])
    <Success: {'draft': {'models': {}, 'prefix_rules': []}, 'covered_models': [], 'stale_models': [], 'invalid_existing_models': [], 'stale_prefix_rules': [], 'invalid_prefix_rules': [], 'conflicting_prefix_rules': [], 'unresolved': [], 'output_path': None, 'wrote_file': False}>
    >>> draft_model_map([{'model': 'openai/gpt-4o', 'used_by': ['a']}], [{'provider': 'openai', 'model_id': 'gpt-4o'}]).unwrap()['draft']['models']
    {'openai/gpt-4o': {'provider': 'openai', 'model_id': 'gpt-4o'}}
    """
    inventory_keys = {(item["provider"], item["model_id"]) for item in inventory}
    inventory_entries = [
        {"provider": provider, "model_id": model_id}
        for provider, model_id in sorted(inventory_keys)
    ]
    usage_by_model = _group_registry_usage(registry_usage)
    source_models = set(usage_by_model)
    existing = existing_map or {"models": {}, "prefix_rules": []}

    draft_models: dict[str, ModelMapEntry] = {}
    stale_models: list[str] = []
    invalid_existing_models: list[str] = []
    unresolved: list[UnresolvedModel] = []

    for source_model, mapping in sorted(existing["models"].items()):
        if source_model not in source_models:
            stale_models.append(source_model)
            continue
        if (mapping["provider"], mapping["model_id"]) in inventory_keys:
            draft_models[source_model] = dict(mapping)
        else:
            invalid_existing_models.append(source_model)
            unresolved.append(
                {
                    "source_model": source_model,
                    "used_by": usage_by_model[source_model],
                    "reason": "invalid target",
                    "candidates": [],
                }
            )

    prefix_plan = _plan_prefix_rules(existing["prefix_rules"], sorted(source_models), inventory_keys)
    draft_prefix_rules = prefix_plan["rules"]

    covered_models = set(draft_models)
    for source_model in sorted(source_models):
        if source_model in covered_models:
            continue
        if _prefix_rule_target(source_model, draft_prefix_rules) in inventory_keys:
            covered_models.add(source_model)

    for source_model in sorted(source_models):
        if source_model in covered_models or source_model in invalid_existing_models:
            continue
        candidates_result = _candidates_for_source(source_model, inventory_entries)
        if candidates_result[0] != "ok":
            unresolved.append(
                {
                    "source_model": source_model,
                    "used_by": usage_by_model[source_model],
                    "reason": candidates_result[0],
                    "candidates": candidates_result[1],
                }
            )
            continue
        candidates = candidates_result[1]
        if len(candidates) == 1:
            draft_models[source_model] = candidates[0]
            covered_models.add(source_model)
        else:
            unresolved.append(
                {
                    "source_model": source_model,
                    "used_by": usage_by_model[source_model],
                    "reason": "ambiguous candidates" if candidates else "no candidates",
                    "candidates": candidates,
                }
            )

    result: PiModelMapDraftResult = {
        "draft": {"models": {}, "prefix_rules": []},
        "covered_models": sorted(covered_models),
        "stale_models": stale_models,
        "invalid_existing_models": invalid_existing_models,
        "stale_prefix_rules": prefix_plan["stale"],
        "invalid_prefix_rules": prefix_plan["invalid"],
        "conflicting_prefix_rules": prefix_plan["conflicting"],
        "unresolved": unresolved,
        "output_path": None,
        "wrote_file": False,
    }
    result["draft"] = {
        "models": {key: draft_models[key] for key in sorted(draft_models)},
        "prefix_rules": sorted(
            draft_prefix_rules,
            key=lambda rule: (
                rule["from_prefix"],
                rule["to_provider"],
                rule["to_model_id_prefix"],
            ),
        ),
    }
    return Success(result)


@pre(lambda registry_usage: isinstance(registry_usage, list))
@post(lambda result: all(model for model in result))
def _group_registry_usage(registry_usage: list[RegistryModelUse]) -> dict[str, list[str]]:
    """
    Group registry summaries by exact model string with stable persona ids.

    >>> _group_registry_usage([{'model': 'm/a', 'used_by': ['b']}, {'model': 'm/a', 'used_by': ['a']}])
    {'m/a': ['a', 'b']}
    """
    grouped: dict[str, set[str]] = {}
    for item in registry_usage:
        model = item["model"]
        if not model:
            continue
        grouped.setdefault(model, set()).update(item["used_by"])
    return {model: sorted(ids) for model, ids in sorted(grouped.items())}


@pre(lambda source_model, inventory: isinstance(source_model, str) and isinstance(inventory, list))
@post(lambda result: isinstance(result[0], str))
def _candidates_for_source(
    source_model: str, inventory: list[PiModelInventoryItem]
) -> tuple[str, list[ModelMapEntry]]:
    """
    Find Pi target candidates from direct, wrapped, and basename evidence only.

    >>> _candidates_for_source('openai/gpt-4o', [{'provider': 'openai', 'model_id': 'gpt-4o'}])
    ('ok', [{'provider': 'openai', 'model_id': 'gpt-4o'}])
    >>> _candidates_for_source('malformed', [{'provider': 'openai', 'model_id': 'gpt-4o'}])[0]
    'malformed source model'
    """
    if "/" not in source_model:
        return ("malformed source model", [])
    source_provider, source_model_id = source_model.split("/", 1)
    if not source_provider or not source_model_id:
        return ("malformed source model", [])
    basename = source_model_id.rsplit("/", 1)[-1]
    candidates: dict[tuple[str, str], ModelMapEntry] = {}
    for item in inventory:
        key = (item["provider"], item["model_id"])
        direct = item["provider"] == source_provider and item["model_id"] == source_model_id
        wrapped = item["model_id"] == source_model
        suffix = item["model_id"].rsplit("/", 1)[-1] == basename
        if direct or wrapped or suffix:
            candidates[key] = {"provider": item["provider"], "model_id": item["model_id"]}
    return ("ok", [candidates[key] for key in sorted(candidates)])


@pre(lambda source_model, rules: isinstance(source_model, str) and isinstance(rules, list))
@post(lambda result: result is None or isinstance(result[0], str))
def _prefix_rule_target(
    source_model: str, rules: list[PrefixRule]
) -> tuple[str, str] | None:
    """
    Resolve the longest preserved literal prefix rule target for a source model.

    >>> _prefix_rule_target('openrouter/a/b', [{'from_prefix': 'openrouter/', 'to_provider': 'openrouter', 'to_model_id_prefix': ''}])
    ('openrouter', 'a/b')
    """
    matches = [rule for rule in rules if source_model.startswith(rule["from_prefix"])]
    if not matches:
        return None
    max_len = max(len(rule["from_prefix"]) for rule in matches)
    longest = [rule for rule in matches if len(rule["from_prefix"]) == max_len]
    if len(longest) != 1:
        return None
    rule = longest[0]
    suffix = source_model[len(rule["from_prefix"]) :]
    return (rule["to_provider"], rule["to_model_id_prefix"] + suffix)


class _PrefixPlan(TypedDict):
    rules: list[PrefixRule]
    stale: list[PrefixRuleFinding]
    invalid: list[PrefixRuleFinding]
    conflicting: list[PrefixRuleFinding]


@pre(lambda rules, source_models, inventory_keys: isinstance(rules, list) and isinstance(source_models, list) and isinstance(inventory_keys, set))
@post(lambda result: set(result) == {"rules", "stale", "invalid", "conflicting"})
def _plan_prefix_rules(
    rules: list[PrefixRule],
    source_models: list[str],
    inventory_keys: set[tuple[str, str]],
) -> _PrefixPlan:
    """
    Preserve non-conflicting prefix rules only when they cover current models.

    >>> _plan_prefix_rules([], [], set())['rules']
    []
    """
    unique: dict[tuple[str, str, str], PrefixRule] = {}
    for rule in rules:
        key = (rule["from_prefix"], rule["to_provider"], rule["to_model_id_prefix"])
        unique.setdefault(key, rule)
    grouped: dict[str, list[PrefixRule]] = {}
    for rule in unique.values():
        grouped.setdefault(rule["from_prefix"], []).append(rule)

    kept: list[PrefixRule] = []
    stale: list[PrefixRuleFinding] = []
    invalid: list[PrefixRuleFinding] = []
    conflicting: list[PrefixRuleFinding] = []
    for from_prefix, group in sorted(grouped.items()):
        affected = [model for model in source_models if model.startswith(from_prefix)]
        if len(group) > 1:
            for rule in group:
                conflicting.append(
                    {"rule": rule, "reason": "same-length prefix conflict", "affected_models": affected}
                )
            continue
        rule = group[0]
        if not affected:
            stale.append({"rule": rule, "reason": "stale prefix rule", "affected_models": []})
            continue
        invalid_models = [
            model
            for model in affected
            if (
                rule["to_provider"],
                rule["to_model_id_prefix"] + model[len(rule["from_prefix"]) :],
            )
            not in inventory_keys
        ]
        if invalid_models:
            invalid.append(
                {"rule": rule, "reason": "invalid prefix target", "affected_models": invalid_models}
            )
            continue
        kept.append(rule)
    return {"rules": kept, "stale": stale, "invalid": invalid, "conflicting": conflicting}
