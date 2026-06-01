"""Expected-red contract tests for pi-model-map draft helper."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from returns.result import Success, Failure

from larva.shell.cli import run_cli
from larva.app.facade_types import PersonaSummary


def _make_facade(summaries: list[dict]) -> MagicMock:
    facade = MagicMock()
    # Ensure it looks like LarvaFacade.list returning Success
    facade.list.return_value = Success(summaries)
    return facade


@pytest.fixture
def fake_pi_bin(tmp_path, monkeypatch):
    pi_bin = tmp_path / "fake_pi"
    pi_bin.write_text("#!/bin/sh\nexit 0\n")
    pi_bin.chmod(0o755)
    
    import shutil
    def fake_which(cmd, *args, **kwargs):
        if cmd == "pi":
            return str(pi_bin)
        return None
    monkeypatch.setattr(shutil, "which", fake_which)
    return pi_bin


@pytest.fixture
def mock_subprocess_run(monkeypatch):
    mock_run = MagicMock()
    mock_run.return_value.returncode = 0
    mock_run.return_value.stdout = b"PROVIDER\tMODEL_ID\n"
    mock_run.return_value.stderr = b""
    monkeypatch.setattr(subprocess, "run", mock_run)
    return mock_run


def test_duplicate_registry_model_grouping_and_stable_sorted_exact_output(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Deduplication and merge policy:
    - duplicate registry model grouping
    - stable sorted exact output
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\ngoogle\tgemini-1.5-pro\n"
    
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openai/gpt-4o"},
        {"id": "b", "description": "", "spec_digest": "", "model": "google/gemini-1.5-pro"},
        {"id": "c", "description": "", "spec_digest": "", "model": "openai/gpt-4o"},
    ])
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive"], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0, f"Expected 0, got {code}. Stderr: {stderr.getvalue()}"
    
    output = json.loads(stdout.getvalue())
    assert "models" in output
    models = output["models"]
    
    # Must group duplicates and sort by exact model strings
    assert list(models.keys()) == ["google/gemini-1.5-pro", "openai/gpt-4o"]
    assert models["openai/gpt-4o"] == {"provider": "openai", "model_id": "gpt-4o"}


def test_valid_existing_exact_mapping_preservation(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Existing model-map / Candidate discovery policy:
    - valid existing exact mapping preservation only when target exists in Pi inventory
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "my/custom"}
    ])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text(json.dumps({
        "models": {
            "my/custom": {"provider": "openai", "model_id": "gpt-4o"}
        },
        "prefix_rules": []
    }))
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    output = json.loads(stdout.getvalue())
    assert output["models"]["my/custom"] == {"provider": "openai", "model_id": "gpt-4o"}


def test_stale_exact_mapping_removal_reporting(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Existing model-map:
    - stale exact mapping removal/reporting
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\n"
    facade = _make_facade([])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text(json.dumps({
        "models": {
            "old/model": {"provider": "openai", "model_id": "gpt-3"}
        },
        "prefix_rules": []
    }))
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    output = json.loads(stdout.getvalue())
    assert "old/model" not in output["models"]
    assert "stale exact mapping" in stderr.getvalue().lower()


def test_invalid_existing_exact_target_reporting(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Existing model-map:
    - invalid existing exact target reporting and re-choice/unresolved handling
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "my/custom"}
    ])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text(json.dumps({
        "models": {
            "my/custom": {"provider": "openai", "model_id": "missing-model"}
        },
        "prefix_rules": []
    }))
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    # Should fail in non-interactive mode because target is invalid and no single obvious target exists,
    # or because it's invalid and we need interactive re-choice.
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code != 0
    assert "LARVA_PI_MODEL_MAP_UNRESOLVED" in stderr.getvalue()
    assert "invalid target" in stderr.getvalue().lower()


def test_valid_existing_prefix_rule_preservation(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Existing model-map:
    - valid existing prefix rule preservation
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenrouter\tanthropic/claude\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openrouter/anthropic/claude"}
    ])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text(json.dumps({
        "models": {},
        "prefix_rules": [
            {"from_prefix": "openrouter/", "to_provider": "openrouter", "to_model_id_prefix": ""}
        ]
    }))
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    output = json.loads(stdout.getvalue())
    assert output["prefix_rules"][0]["from_prefix"] == "openrouter/"
    assert "openrouter/anthropic/claude" not in output["models"], "Should be covered by prefix rule, no exact entry needed"


def test_stale_prefix_rule_reporting_removal(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Existing model-map:
    - stale prefix rule reporting/removal
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\n"
    facade = _make_facade([])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text(json.dumps({
        "models": {},
        "prefix_rules": [
            {"from_prefix": "stale/", "to_provider": "stale", "to_model_id_prefix": ""}
        ]
    }))
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    output = json.loads(stdout.getvalue())
    assert len(output["prefix_rules"]) == 0
    assert "stale prefix rule" in stderr.getvalue().lower()


def test_invalid_prefix_target_reporting(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Existing model-map:
    - invalid prefix target reporting
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "missing/model"}
    ])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text(json.dumps({
        "models": {},
        "prefix_rules": [
            {"from_prefix": "missing/", "to_provider": "missing", "to_model_id_prefix": ""}
        ]
    }))
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code != 0
    assert "LARVA_PI_MODEL_MAP_UNRESOLVED" in stderr.getvalue()
    assert "invalid prefix" in stderr.getvalue().lower()


def test_same_length_prefix_conflict_rejection(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Existing model-map:
    - same-length prefix conflict rejection
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "conflict/model"}
    ])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text(json.dumps({
        "models": {},
        "prefix_rules": [
            {"from_prefix": "conflict/", "to_provider": "prov1", "to_model_id_prefix": ""},
            {"from_prefix": "conflict/", "to_provider": "prov2", "to_model_id_prefix": ""}
        ]
    }))
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code != 0
    assert "conflict" in stderr.getvalue().lower()


def test_ambiguous_candidates_without_hard_coded_preferences(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Candidate discovery policy:
    - ambiguous OpenAI-like, Google-like, OpenRouter-like, other-provider, and unknown-provider
      candidates without hard-coded preferences.
    """
    # Provide multiple valid matches for openai/gpt-4o: exact, wrapped, suffix
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\nopenai-codex\tgpt-4o\nopenrouter\topenai/gpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openai/gpt-4o"}
    ])
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive"], facade=facade, stdout=stdout, stderr=stderr)
    assert code != 0
    assert "LARVA_PI_MODEL_MAP_UNRESOLVED" in stderr.getvalue()
    # It shouldn't just guess openai over openrouter implicitly if multiple evidence rules match.


def test_malformed_source_model(fake_pi_bin, mock_subprocess_run, tmp_path, monkeypatch):
    """
    Candidate discovery policy:
    - malformed source model: interactive manual/skip path; non-interactive unresolved failure
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "malformed_no_slash"}
    ])
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    # Non-interactive
    code = run_cli(["pi-model-map", "draft", "--non-interactive"], facade=facade, stdout=stdout, stderr=stderr)
    assert code != 0
    assert "LARVA_PI_MODEL_MAP_UNRESOLVED" in stderr.getvalue()
    assert "malformed" in stderr.getvalue().lower()
    
    # Interactive skip (mocking sys.stdin)
    stdout_interactive = io.StringIO()
    stderr_interactive = io.StringIO()
    monkeypatch.setattr("sys.stdin", io.StringIO("skip\n"))
    
    code = run_cli(["pi-model-map", "draft"], facade=facade, stdout=stdout_interactive, stderr=stderr_interactive)
    assert code == 0
    # Expected output should be JSON that is empty because we skipped
    output = json.loads(stdout_interactive.getvalue())
    assert output["models"] == {}


def test_no_candidate_manual_skip_path(fake_pi_bin, mock_subprocess_run, tmp_path, monkeypatch):
    """
    Candidate discovery policy:
    - no-candidate manual/skip path
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "missing/model"}
    ])
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    monkeypatch.setattr("sys.stdin", io.StringIO("skip\n"))
    
    code = run_cli(["pi-model-map", "draft"], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    output = json.loads(stdout.getvalue())
    assert output["models"] == {}


def test_redirect_safe_stdout_raw_json_only(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Draft output contract:
    - redirect-safe stdout: raw JSON only in default dry-run mode; reports/warnings on stderr
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openai/gpt-4o"}
    ])
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive"], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    
    # Stdout must be strictly JSON, no human text
    raw_out = stdout.getvalue()
    json.loads(raw_out)
    
    # Human text must go to stderr
    assert "report" in stderr.getvalue().lower() or "draft" in stderr.getvalue().lower()


def test_successful_pi_inventory_rows_on_stderr_are_consumed(fake_pi_bin, mock_subprocess_run):
    """
    Pi data source authority:
    - successful `pi --list-models --offline` inventory rows may arrive on stderr;
      those rows are evidence, not a fatal diagnostic channel.
    - helper stdout remains raw draft JSON only on success.
    """
    mock_subprocess_run.return_value.stdout = b""
    mock_subprocess_run.return_value.stderr = b"PROVIDER\tMODEL_ID\nopenai-codex\tgpt-5.5\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openai/gpt-5.5"}
    ])

    import io
    stdout = io.StringIO()
    stderr = io.StringIO()

    code = run_cli(["pi-model-map", "draft", "--non-interactive"], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0, f"Expected 0, got {code}. Stderr: {stderr.getvalue()}"
    output = json.loads(stdout.getvalue())

    assert output == {
        "models": {"openai/gpt-5.5": {"provider": "openai-codex", "model_id": "gpt-5.5"}},
        "prefix_rules": [],
    }
    assert "PROVIDER" not in stdout.getvalue()
    assert "pi-model-map draft report:" in stderr.getvalue()


def test_optional_json_envelope_behavior(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Draft output contract:
    - optional --json envelope behavior if the CLI pattern includes it
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openai/gpt-4o"}
    ])
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--json"], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    output = json.loads(stdout.getvalue())
    
    assert "data" in output
    assert "draft" in output["data"]
    assert "models" in output["data"]["draft"]


def test_write_filesystem_behavior(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Draft output contract:
    - --write filesystem behavior without embedding report metadata
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openai/gpt-4o"}
    ])
    
    out_file = tmp_path / "custom-map.json"
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--write", "--output", str(out_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code == 0
    
    assert out_file.exists()
    content = json.loads(out_file.read_text())
    assert "models" in content
    assert content["models"]["openai/gpt-4o"]["provider"] == "openai"
    assert "stale_models" not in content  # Report metadata must not be written to file


def test_invalid_existing_model_map_fail_closed(fake_pi_bin, mock_subprocess_run, tmp_path):
    """
    Error model:
    - invalid existing model-map fail-closed behavior
    """
    mock_subprocess_run.return_value.stdout = b"PROVIDER\tMODEL_ID\nopenai\tgpt-4o\n"
    facade = _make_facade([
        {"id": "a", "description": "", "spec_digest": "", "model": "openai/gpt-4o"}
    ])
    
    map_file = tmp_path / "model-map.json"
    map_file.write_text("{ INVALID JSON ")
    
    import io
    stdout = io.StringIO()
    stderr = io.StringIO()
    
    code = run_cli(["pi-model-map", "draft", "--non-interactive", "--model-map", str(map_file)], facade=facade, stdout=stdout, stderr=stderr)
    assert code != 0
    assert "LARVA_PI_MODEL_MAP_INVALID" in stderr.getvalue()
