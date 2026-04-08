"""Debug script to understand validation behavior."""

from starlette.testclient import TestClient
from larva.shell.web import app

client = TestClient(app)

# Test 1: tools field
print("=" * 60)
print("TEST 1: 'tools' field (INTERFACES.md line 176: rejected)")
print("=" * 60)
invalid_spec = {
    "id": "test-persona",
    "description": "Test",
    "prompt": "You are a test assistant.",
    "model": "test-model",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
    "tools": {"shell": "read_only"},
}
resp = client.post("/api/personas/validate", json=invalid_spec)
print(f"Status: {resp.status_code}")
print(f"Response: {resp.json()}")
print()

# Test 2: side_effect_policy field
print("=" * 60)
print("TEST 2: 'side_effect_policy' field (INTERFACES.md line 176-177: rejected)")
print("=" * 60)
invalid_spec2 = {
    "id": "test-persona",
    "description": "Test",
    "prompt": "You are a test assistant.",
    "model": "test-model",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
    "side_effect_policy": "strict",
}
resp2 = client.post("/api/personas/validate", json=invalid_spec2)
print(f"Status: {resp2.status_code}")
print(f"Response: {resp2.json()}")
print()

# Test 3: Unknown field
print("=" * 60)
print("TEST 3: unknown field (INTERFACES.md line 178: rejected)")
print("=" * 60)
invalid_spec3 = {
    "id": "test-persona",
    "description": "Test",
    "prompt": "You are a test assistant.",
    "model": "test-model",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
    "unknown_field": "some_value",
}
resp3 = client.post("/api/personas/validate", json=invalid_spec3)
print(f"Status: {resp3.status_code}")
print(f"Response: {resp3.json()}")
print()

# Test 4: Minimal valid spec
print("=" * 60)
print("TEST 4: Minimal valid spec (should pass)")
print("=" * 60)
valid_spec = {
    "id": "test-persona",
    "description": "Test",
    "prompt": "You are a test assistant.",
    "model": "test-model",
    "capabilities": {"shell": "read_only"},
    "spec_version": "0.1.0",
}
resp4 = client.post("/api/personas/validate", json=valid_spec)
print(f"Status: {resp4.status_code}")
print(f"Response: {resp4.json()}")
print()

# Test 5: Assemble endpoint
print("=" * 60)
print("TEST 5: Assemble endpoint (minimal request)")
print("=" * 60)
assemble_req = {"id": "test-assemble", "prompts": []}
resp5 = client.post("/api/personas/assemble", json=assemble_req)
print(f"Status: {resp5.status_code}")
print(f"Response: {resp5.json()}")
