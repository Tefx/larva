"""Pure functions and types for drafting Pi model maps."""

from __future__ import annotations

from typing import Any, TypedDict

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


@pre(lambda registry_usage, inventory, existing_map=None: isinstance(registry_usage, list) and isinstance(inventory, list))
@post(lambda result: isinstance(result, Result))
def draft_model_map(
    registry_usage: list[RegistryModelUse],
    inventory: list[PiModelInventoryItem],
    existing_map: PiModelMapDraft | None = None,
) -> Result[PiModelMapDraftResult, str]:
    """
    Draft a stable model map from registry models and Pi inventory.
    
    This function is purely deterministic and performs no I/O.
    It does not guess vendor preferences, nor does it read dotfiles like
    /Users/tefx/dotfiles/agent/models.yaml.

    >>> draft_model_map([], [])
    <Success: {'draft': {'models': {}, 'prefix_rules': []}, 'covered_models': [], 'stale_models': [], 'invalid_existing_models': [], 'stale_prefix_rules': [], 'invalid_prefix_rules': [], 'conflicting_prefix_rules': [], 'unresolved': [], 'output_path': None, 'wrote_file': False}>
    """
    # Contract stub only
    # @invar:allow dead_param: Stubs do not use parameters yet
    return Success({
        "draft": {"models": {}, "prefix_rules": []},
        "covered_models": [],
        "stale_models": [],
        "invalid_existing_models": [],
        "stale_prefix_rules": [],
        "invalid_prefix_rules": [],
        "conflicting_prefix_rules": [],
        "unresolved": [],
        "output_path": None,
        "wrote_file": False,
    })
