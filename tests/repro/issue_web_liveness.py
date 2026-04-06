"""Reproduction: Issue XXX - Web Entrypoint Liveness Probe.

Expected: The packaged web entrypoint ('larva serve') starts, binds to a port, and
accepts HTTP requests to canonical REST endpoints, returning valid responses.

Actual: TBD - running this probe to verify liveness.

This is a Mode D Liveness Probe test following the blind-tester protocol.
"""

import subprocess
import time
import json
import sys
import signal
import os
import urllib.request
import urllib.error


def test_web_liveness():
    """Test that larva serve is alive and handles canonical admission operations."""

    # Use a non-default port to avoid conflicts
    PORT = 17499
    BASE_URL = f"http://127.0.0.1:{PORT}"

    # Create a minimal valid PersonaSpec for testing
    test_persona = {
        "id": "liveness-test-persona",
        "description": "Test persona for liveness verification",
        "prompt": "You are a test persona.",
        "model": "test-model",
        "capabilities": {"shell": "read_only"},
        "spec_version": "0.1.0",
    }

    server_process = None

    try:
        print(f"## Launch command")
        print(f"```\nuv run larva serve --port {PORT} --no-open\n```")

        # Launch the server
        server_process = subprocess.Popen(
            ["uv", "run", "larva", "serve", "--port", str(PORT), "--no-open"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=os.getcwd(),
            preexec_fn=os.setsid,
        )

        # Give server time to start and bind
        time.sleep(3)

        # Check if process is still alive
        poll_result = server_process.poll()
        if poll_result is not None:
            stdout, stderr = server_process.communicate()
            print(f"## Observed runtime behavior")
            print(f"- started: FALSE (process exited immediately with code {poll_result})")
            print(f"- stdout: {stdout.decode('utf-8', errors='replace')}")
            print(f"- stderr: {stderr.decode('utf-8', errors='replace')}")
            print(f"- stayed_alive: FALSE")
            print(f"- canonical_operation_result: NONE")
            sys.exit(1)

        print(f"## Observed runtime behavior")
        print(f"- started: TRUE (process running with PID {server_process.pid})")

        # Use lsof to verify port is bound (network-level verification)
        port_check = subprocess.run(
            ["lsof", "-i", f":{PORT}"], capture_output=True, text=True, timeout=5
        )

        if port_check.returncode == 0 and f":{PORT}" in port_check.stdout:
            print(f"- port_bound: TRUE (lsof confirms port {PORT} is bound)")
        else:
            print(f"- port_bound: FALSE (lsof output: {port_check.stdout})")
            print(f"- stayed_alive: FALSE")
            print(f"- canonical_operation_result: NONE")
            sys.exit(1)

        # Verify the UI endpoint serves HTML
        print(f"\n## Operation executed")
        print(f"### GET /")
        try:
            req = urllib.request.Request(f"{BASE_URL}/")
            with urllib.request.urlopen(req, timeout=5) as response:
                status_code = response.status
                content_type = response.headers.get("content-type", "none")
                body = response.read().decode("utf-8")

            print(f"```")
            print(f"GET {BASE_URL}/")
            print(f"status={status_code}")
            print(f"content-type={content_type}")

            if status_code == 200:
                print(f"body-preview={body[:100]!r}...")
                print(f"```")
                print(f"✓ UI endpoint returns HTML")
            else:
                print(f"body={body!r}")
                print(f"```")
                print(f"✗ UI endpoint failed to return content")
                sys.exit(1)
        except Exception as e:
            print(f"✗ Failed to reach UI endpoint: {e}")
            sys.exit(1)

        # Verify canonical admission operation: validate endpoint
        print(f"\n### POST /api/personas/validate (canonical admission)")
        try:
            req_data = json.dumps(test_persona).encode("utf-8")
            req = urllib.request.Request(
                f"{BASE_URL}/api/personas/validate",
                data=req_data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                status_code = response.status
                content_type = response.headers.get("content-type", "none")
                body = response.read().decode("utf-8")

            print(f"```")
            print(f"POST {BASE_URL}/api/personas/validate")
            print(f"Content-Type: application/json")
            print(f"Request body: {json.dumps(test_persona, indent=2)}")
            print(f"")
            print(f"status={status_code}")
            print(f"content-type={content_type}")
            print(f"body={body}")
            print(f"```")

            if status_code != 200:
                print(f"✗ Validation endpoint returned non-200 status")
                sys.exit(1)

            data = json.loads(body)
            if "data" not in data or "valid" not in data["data"]:
                print(f"✗ Validation response missing 'valid' field")
                sys.exit(1)

            print(f"✓ Validation endpoint returns valid response structure")
        except Exception as e:
            print(f"✗ Failed to call validation endpoint: {e}")
            sys.exit(1)

        # Verify canonical admission operation: register endpoint
        print(f"\n### POST /api/personas (canonical admission)")
        try:
            req_data = json.dumps(test_persona).encode("utf-8")
            req = urllib.request.Request(
                f"{BASE_URL}/api/personas",
                data=req_data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                status_code = response.status
                content_type = response.headers.get("content-type", "none")
                body = response.read().decode("utf-8")

            print(f"```")
            print(f"POST {BASE_URL}/api/personas")
            print(f"Content-Type: application/json")
            print(f"Request body: {json.dumps(test_persona, indent=2)}")
            print(f"")
            print(f"status={status_code}")
            print(f"content-type={content_type}")
            print(f"body={body}")
            print(f"```")

            if status_code != 200:
                print(f"✗ Register endpoint returned non-200 status")
                sys.exit(1)

            data = json.loads(body)
            if "data" not in data or "id" not in data["data"]:
                print(f"✗ Register response missing required fields")
                sys.exit(1)

            print(f"✓ Register endpoint returns valid response structure")
        except Exception as e:
            print(f"✗ Failed to call register endpoint: {e}")
            sys.exit(1)

        # Verify canonical admission operation: list endpoint
        print(f"\n### GET /api/personas (canonical admission verification)")
        try:
            req = urllib.request.Request(f"{BASE_URL}/api/personas")
            with urllib.request.urlopen(req, timeout=5) as response:
                status_code = response.status
                content_type = response.headers.get("content-type", "none")
                body = response.read().decode("utf-8")

            print(f"```")
            print(f"GET {BASE_URL}/api/personas")
            print(f"status={status_code}")
            print(f"content-type={content_type}")
            print(f"body={body}")
            print(f"```")

            if status_code != 200:
                print(f"✗ List endpoint returned non-200 status")
                sys.exit(1)

            data = json.loads(body)
            if "data" not in data or not isinstance(data["data"], list):
                print(f"✗ List response missing 'data' list field")
                sys.exit(1)

            # Verify our registered persona appears in the list
            persona_found = any(p.get("id") == "liveness-test-persona" for p in data["data"])
            if not persona_found:
                print(f"✗ Registered persona not found in list")
                sys.exit(1)

            print(f"✓ List endpoint returns valid response with registered persona")
        except Exception as e:
            print(f"✗ Failed to call list endpoint: {e}")
            sys.exit(1)

        print(f"\n- stayed_alive: TRUE (all operations completed while server running)")
        print(
            f"- canonical_operation_result: SUCCESS (validation, registration, and list all succeeded)"
        )

        # Clean up: delete the test persona
        try:
            req = urllib.request.Request(
                f"{BASE_URL}/api/personas/liveness-test-persona", method="DELETE"
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass  # Best effort cleanup

        print(f"\n## VERDICT: ALIVE")
        print(f"The packaged web entrypoint successfully:")
        print(f"  1. Started and bound to port {PORT}")
        print(f"  2. Served HTML UI at /")
        print(f"  3. Accepted canonical admission operations (validate, register, list)")
        print(f"  4. Returned valid response structures from all tested endpoints")
        sys.exit(0)

    finally:
        # Clean up the server process
        if server_process and server_process.poll() is None:
            try:
                os.killpg(os.getpgid(server_process.pid), signal.SIGTERM)
                server_process.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(os.getpgid(server_process.pid), signal.SIGKILL)
                except Exception:
                    pass


if __name__ == "__main__":
    test_web_liveness()
