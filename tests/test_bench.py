"""Acceptance tests for the behavioral suite and ``associate bench`` (t17).

Covers c48 and its honesty condition h40: one corpus case per category, the
*same* seven cases for every adapter (no adapter-specific case), a table whose
rows record the complete configuration, and a stub run that is labelled
plumbing-only and runs in CI with no pi and no lane.
"""

import json
import re
from pathlib import Path

import pytest

from associate.bench import corpus, runner
from associate.cli import main

_REPO_ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# The corpus
# ---------------------------------------------------------------------------


def test_corpus_has_one_case_per_category():
    cases = corpus.load_cases()
    assert len(cases) == len(corpus.CATEGORIES)
    assert sorted(case.category for case in cases) == sorted(corpus.CATEGORIES)


def test_corpus_lives_under_tests_behavioral():
    assert corpus.default_cases_dir() == _REPO_ROOT / "tests" / "behavioral" / "cases"


def test_no_case_is_adapter_specific():
    """h40: two configurations may differ only in adapter and model-role columns."""
    for path in sorted(corpus.default_cases_dir().glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        assert set(raw) <= corpus.CASE_KEYS, f"{path.name} carries unknown keys"
        assert set(raw["expect"]) <= corpus.EXPECT_KEYS, f"{path.name} expect keys"
        blob = path.read_text(encoding="utf-8").lower()
        adapter_words = re.compile(r"\b(stub|harness|adapter|pi|nemotron|plumbing)\b")
        found = adapter_words.search(blob)
        assert found is None, f"{path.name} mentions {found.group(0)!r}"


def test_every_case_names_a_fixture_and_a_prompt():
    for case in corpus.load_cases():
        assert case.fixture_files, case.id
        assert case.prompt.strip(), case.id


def test_load_cases_rejects_an_unknown_key(tmp_path):
    (tmp_path / "bad.json").write_text(
        json.dumps(
            {
                "id": "bad",
                "category": "local read/find",
                "title": "t",
                "prompt": "p",
                "fixture": {"files": {"a.txt": "a"}},
                "expect": {},
                "harness": "stub",
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(corpus.CorpusError) as excinfo:
        corpus.load_cases(tmp_path)
    assert "harness" in str(excinfo.value)


def test_missing_cases_dir_is_an_error(tmp_path):
    with pytest.raises(corpus.CorpusError):
        corpus.load_cases(tmp_path / "nope")


# ---------------------------------------------------------------------------
# The runner against the stub adapter
# ---------------------------------------------------------------------------


def test_seven_cases_pass_against_the_stub(tmp_path):
    suite = runner.run_suite("stub", workdir=tmp_path)
    assert suite.passed, [(r.case_id, r.failures) for r in suite.rows if not r.passed]
    assert len(suite.rows) == len(corpus.CATEGORIES)
    for row in suite.rows:
        assert row.duration_ms >= 0
        assert row.category in corpus.CATEGORIES


def test_stub_suite_is_labelled_plumbing_only(tmp_path):
    suite = runner.run_suite("stub", workdir=tmp_path)
    assert suite.configuration["plumbing_only"] is True
    assert suite.configuration["harness"] == "stub"
    assert suite.configuration["served_model_id"] == "stub"
    assert suite.configuration["model_role"]


def test_configuration_never_carries_a_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("ASSOCIATE_API_KEY", "sk-thisisaverysecretkey0123456789")
    monkeypatch.setenv("ASSOCIATE_BASE_URL", "http://localhost:8001/v1")
    suite = runner.run_suite("stub", workdir=tmp_path)
    blob = json.dumps(suite.as_dict())
    assert "sk-thisisaverysecretkey0123456789" not in blob
    assert "api_key" not in blob.lower()


def test_a_failing_case_is_reported_not_raised(tmp_path):
    """An unmet expectation is a failed row, never a traceback."""
    # max_tool_calls is a check the replay script cannot satisfy by construction.
    broken = corpus.load_cases()[0]
    broken.expect["max_tool_calls"] = 0
    suite = runner.run_suite("stub", cases=[broken], workdir=tmp_path)
    assert not suite.passed
    assert suite.rows[0].failures
    assert suite.rows[0].result == "fail"


def test_unknown_harness_raises_with_the_adapter_list(tmp_path):
    with pytest.raises(KeyError) as excinfo:
        runner.run_suite("bogus", workdir=tmp_path)
    assert "stub" in str(excinfo.value)


# ---------------------------------------------------------------------------
# The CLI verb
# ---------------------------------------------------------------------------


def test_cli_stub_run_exits_zero_and_names_harness_and_role(capsys, tmp_path):
    rc = main(["bench", "--harness", "stub", "--workdir", str(tmp_path)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "harness" in out and "model role" in out
    assert "plumbing-only" in out
    # every row names the harness and the model role
    role = runner.run_suite("stub", workdir=tmp_path).configuration["model_role"]
    rows = [
        line
        for line in out.splitlines()
        if any(category in line for category in corpus.CATEGORIES)
        and "stub" in line
        and role in line
    ]
    assert len(rows) == len(corpus.CATEGORIES)


def test_cli_json_payload_carries_the_full_configuration(capsys, tmp_path):
    rc = main(["bench", "--harness", "stub", "--workdir", str(tmp_path), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    config = payload["configuration"]
    for key in (
        "harness",
        "model_role",
        "served_model_id",
        "pi_version",
        "extension_version",
        "provider",
        "reasoning",
        "plumbing_only",
    ):
        assert key in config, key
    assert payload["passed"] is True
    assert len(payload["rows"]) == len(corpus.CATEGORIES)
    for row in payload["rows"]:
        assert row["harness"] == "stub"
        assert row["model_role"] == config["model_role"]
        assert row["pi_version"] == config["pi_version"]
        assert row["extension_version"] == config["extension_version"]
        assert row["reasoning"] == config["reasoning"]
        assert row["served_model_id"] == "stub"
        assert row["note"] == "plumbing-only"
        assert row["result"] == "pass"


def test_cli_bogus_harness_exits_one_listing_adapters(capsys, tmp_path):
    rc = main(["bench", "--harness", "bogus", "--workdir", str(tmp_path)])
    err = capsys.readouterr().err
    assert rc == 1
    assert "bogus" in err
    assert "stub" in err


def test_cli_bogus_harness_json_error_shape(capsys, tmp_path):
    rc = main(["bench", "--harness", "bogus", "--workdir", str(tmp_path), "--json"])
    captured = capsys.readouterr()
    assert rc == 1
    payload = json.loads(captured.err)
    assert payload["code"] == 1
    assert "stub" in payload["message"] or "stub" in payload["remediation"]
    assert captured.out == ""


def test_cli_missing_cases_dir_is_an_env_error(capsys, tmp_path):
    rc = main(["bench", "--harness", "stub", "--cases", str(tmp_path / "absent")])
    assert rc == 2
    assert "error:" in capsys.readouterr().err


def test_cli_exits_non_zero_when_a_case_fails(capsys, tmp_path, monkeypatch):
    real = runner.run_suite

    def failing(*args, **kwargs):
        suite = real(*args, **kwargs)
        suite.rows[0].failures.append("synthetic failure")
        return suite

    monkeypatch.setattr(runner, "run_suite", failing)
    from associate.cli._commands import bench as bench_cmd

    monkeypatch.setattr(bench_cmd, "run_suite", failing)
    rc = main(["bench", "--harness", "stub", "--workdir", str(tmp_path)])
    assert rc == 1


# ---------------------------------------------------------------------------
# The four CLI sync points
# ---------------------------------------------------------------------------


def test_explain_documents_bench(capsys):
    rc = main(["explain", "bench"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "associate bench" in out
    assert "--harness" in out


def test_learn_mentions_bench(capsys):
    main(["learn"])
    assert "bench" in capsys.readouterr().out
    main(["learn", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert any(entry["path"] == ["bench"] for entry in payload["commands"])
