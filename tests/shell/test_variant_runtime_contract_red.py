import json
from pathlib import Path
from typing import cast
import pytest
from returns.result import Failure, Success

from larva.shell.registry import FileSystemRegistryStore

def _make_spec(persona_id: str, model: str = "gpt-4o-mini") -> dict:
    import hashlib
    spec = {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": f"You are {persona_id}",
        "model": model,
        "capabilities": {"shell": "read_only"},
        "spec_version": "0.1.0",
    }
    payload = {k: v for k, v in spec.items() if k != "spec_digest"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    spec["spec_digest"] = f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"
    return spec

@pytest.fixture
def variant_root(tmp_path: Path) -> Path:
    root = tmp_path / ".larva" / "registry"
    root.mkdir(parents=True)
    return root

def test_register_splits_contract_and_implementation(variant_root: Path) -> None:
    """register splits canonical PersonaSpec input into contract-owned and variant implementation state."""
    store = FileSystemRegistryStore(root=variant_root)
    spec = _make_spec("split-tester")
    
    result = store.save(spec, variant="tacit")
    assert isinstance(result, Success)
    
    contract_path = variant_root / "split-tester" / "contract.json"
    variant_path = variant_root / "split-tester" / "variants" / "tacit.json"
    
    assert contract_path.exists(), "contract.json must be created"
    assert variant_path.exists(), "variant implementation file must be created"
    
    contract_data = json.loads(contract_path.read_text(encoding="utf-8"))
    variant_data = json.loads(variant_path.read_text(encoding="utf-8"))
    
    assert "prompt" not in contract_data, "contract.json must not contain implementation fields"
    assert "model" not in contract_data, "contract.json must not contain implementation fields"
    assert "id" in contract_data, "contract.json must contain contract fields"
    
    assert "id" not in variant_data, "variant.json must not contain contract fields"
    assert "capabilities" not in variant_data, "variant.json must not contain contract fields"
    assert "prompt" in variant_data, "variant.json must contain implementation fields"

def test_resolve_materializes_and_recomputes_digest(variant_root: Path) -> None:
    """resolve materializes contract + selected variant with recomputed spec_digest."""
    persona_dir = variant_root / "materialize-tester"
    persona_dir.mkdir(parents=True)
    (persona_dir / "variants").mkdir()
    
    contract_data = {
        "id": "materialize-tester",
        "description": "Desc",
        "capabilities": {"shell": "read_only"},
        "spec_version": "0.1.0"
    }
    variant_data = {
        "prompt": "You are tacit.",
        "model": "gpt-4o"
    }
    
    (persona_dir / "manifest.json").write_text(json.dumps({"active": "tacit"}), encoding="utf-8")
    (persona_dir / "contract.json").write_text(json.dumps(contract_data), encoding="utf-8")
    (persona_dir / "variants" / "tacit.json").write_text(json.dumps(variant_data), encoding="utf-8")
    
    store = FileSystemRegistryStore(root=variant_root)
    result = store.get("materialize-tester")
    
    assert isinstance(result, Success)
    spec = result.unwrap()
    assert spec["id"] == "materialize-tester"
    assert spec["prompt"] == "You are tacit."
    assert "spec_digest" in spec, "spec_digest must be recomputed"

def test_ownership_violating_files_fail_closed(variant_root: Path) -> None:
    """corrupt/missing/ownership-violating files fail closed with REGISTRY_CORRUPT."""
    persona_dir = variant_root / "corrupt-tester"
    persona_dir.mkdir(parents=True)
    (persona_dir / "variants").mkdir()
    
    # Write a contract.json that contains implementation fields
    contract_data = {
        "id": "corrupt-tester",
        "description": "Desc",
        "capabilities": {},
        "spec_version": "0.1.0",
        "prompt": "ILLEGAL FIELD IN CONTRACT"
    }
    variant_data = {
        "model": "gpt-4o"
    }
    
    (persona_dir / "manifest.json").write_text(json.dumps({"active": "default"}), encoding="utf-8")
    (persona_dir / "contract.json").write_text(json.dumps(contract_data), encoding="utf-8")
    (persona_dir / "variants" / "default.json").write_text(json.dumps(variant_data), encoding="utf-8")
    
    store = FileSystemRegistryStore(root=variant_root)
    result = store.get("corrupt-tester")
    
    assert isinstance(result, Failure)
    assert result.failure()["code"] == "REGISTRY_CORRUPT"

