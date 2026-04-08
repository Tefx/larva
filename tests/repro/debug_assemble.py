"""Debug assemble endpoint requirements."""

from starlette.testclient import TestClient
from larva.shell.web import app

client = TestClient(app)

# Test 1: assemble with minimal fields
print("=" * 60)
print("TEST 1: Assemble with minimal fields")
print("=" * 60)
assemble_req1 = {
    "id": "test-assemble",
    "description": "Assembled persona",
    "prompt": "You are a test.",
    "model": "test-model",
    "capabilities": {},
}
resp1 = client.post("/api/personas/assemble", json=assemble_req1)
print(f"Status: {resp1.status_code}")
print(f"Response: {resp1.json()}")
print()

# Test 2: assemble with prompts list
print("=" * 60)
print("TEST 2: Assemble with prompts list")
print("=" * 60)
assemble_req2 = {
    "id": "test-assemble-2",
    "prompts": ["You are helpful.", "Be concise."],
    "model": "test-model",
    "capabilities": {},
    "description": "Assembled from prompts",
}
resp2 = client.post("/api/personas/assemble", json=assemble_req2)
print(f"Status: {resp2.status_code}")
print(f"Response: {resp2.json()}")
print()

# Test 3: assemble with full spec
print("=" * 60)
print("TEST 3: Assemble from components")
print("=" * 60)
assemble_req3 = {
    "id": "test-assemble-3",
    "description": "Assembled from components",
    "prompts": [],
    "model": "test-model",
}
resp3 = client.post("/api/personas/assemble", json=assemble_req3)
print(f"Status: {resp3.status_code}")
print(f"Response: {resp3.json()}")
