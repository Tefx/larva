import json
from typing import cast
import pytest
from returns.result import Failure, Success

from larva.app.facade import DefaultLarvaFacade
from .conftest import _facade, InMemoryRegistryStore, _canonical_spec

def test_new_base_registration_writes_contract_and_activates() -> None:
    """new base registration writes contract + default/named variant and activates it."""
    registry = InMemoryRegistryStore()
    facade, _, _, _ = _facade(registry=registry)
    
    spec = _canonical_spec("new-base")
    result = facade.register(spec, variant="tacit")
    
    assert isinstance(result, Success)
    # The active variant must be the one registered
    assert registry.active_variants["new-base"] == "tacit"

def test_existing_base_registration_with_contract_field_mismatch() -> None:
    """existing base registration with contract-field mismatch returns BASE_CONTRACT_MISMATCH."""
    registry = InMemoryRegistryStore()
    facade, _, _, _ = _facade(registry=registry)
    
    spec = _canonical_spec("existing-base")
    facade.register(spec, variant="default")
    
    mismatch_spec = dict(spec)
    mismatch_spec["capabilities"] = {"shell": "read_write"} # contract field mismatch
    mismatch_spec["spec_digest"] = "sha256:fake"
    
    result = facade.register(cast(dict, mismatch_spec), variant="tacit")
    
    assert isinstance(result, Failure)
    assert result.failure()["code"] == "BASE_CONTRACT_MISMATCH"

def test_replacing_non_active_variant_does_not_change_active_pointer() -> None:
    """replacing a non-active variant does not change active pointer."""
    registry = InMemoryRegistryStore()
    facade, _, _, _ = _facade(registry=registry)
    
    spec = _canonical_spec("pointer-tester")
    facade.register(spec, variant="default")
    facade.register(spec, variant="tacit")
    
    registry.active_variants["pointer-tester"] = "default"
    
    # Replace tacit variant
    result = facade.register(spec, variant="tacit")
    assert isinstance(result, Success)
    
    # Active pointer must still be default
    assert registry.active_variants["pointer-tester"] == "default"

def test_update_enforces_mixed_scope_patch() -> None:
    """update enforces MIXED_SCOPE_PATCH rule."""
    registry = InMemoryRegistryStore()
    spec = _canonical_spec("mixed-patch")
    registry.save(spec, variant="default")
    facade, _, _, _ = _facade(registry=registry)
    
    # Patch contains both contract-owned (description) and implementation-owned (prompt)
    result = facade.update("mixed-patch", {"description": "New", "prompt": "New"})
    
    assert isinstance(result, Failure)
    assert result.failure()["code"] == "MIXED_SCOPE_PATCH"

def test_update_enforces_field_scope_violation() -> None:
    """update enforces FIELD_SCOPE_VIOLATION for contract patches with explicit variant."""
    registry = InMemoryRegistryStore()
    spec = _canonical_spec("scope-violation")
    registry.save(spec, variant="tacit")
    facade, _, _, _ = _facade(registry=registry)
    
    # Contract-owned patches with an explicit variant are rejected
    result = facade.update("scope-violation", {"description": "New"}, variant="tacit")
    
    assert isinstance(result, Failure)
    assert result.failure()["code"] == "FIELD_SCOPE_VIOLATION"

def test_update_enforces_never_patch_fields() -> None:
    """update enforces never-patch id/spec_version/spec_digest rules."""
    registry = InMemoryRegistryStore()
    spec = _canonical_spec("never-patch")
    registry.save(spec, variant="default")
    facade, _, _, _ = _facade(registry=registry)
    
    result = facade.update("never-patch", {"id": "new-id"})
    assert isinstance(result, Failure)
    assert result.failure()["code"] == "FORBIDDEN_PATCH_FIELD"
    
    result2 = facade.update("never-patch", {"spec_version": "0.2.0"})
    assert isinstance(result2, Failure)
    assert result2.failure()["code"] == "FORBIDDEN_PATCH_FIELD"
    
    result3 = facade.update("never-patch", {"spec_digest": "sha256:fake"})
    assert isinstance(result3, Failure)
    assert result3.failure()["code"] == "FORBIDDEN_PATCH_FIELD"
