"""``associate bench`` after the in-house suite was dropped (t9, claim c6).

No case or check remains. The verb stays contract-compliant: with no public
suite configured it reports that on stderr and exits 2 (setup incomplete) —
never a vacuous pass. The kept plumbing (runner types, table, config stamp)
is exercised directly.
"""

import json
from pathlib import Path

from associate.bench import Row, SuiteResult
from associate.bench import config as bench_config
from associate.bench import render, run_task
from associate.cli import main
from associate.harness import get_harness

_REPO_ROOT = Path(__file__).resolve().parent.parent


def test_no_in_house_corpus_remains():
    assert not (_REPO_ROOT / "tests" / "behavioral").exists()
    for gone in ("corpus", "checks", "replay"):
        assert not (_REPO_ROOT / "associate" / "bench" / f"{gone}.py").exists()


def test_bench_text_mode_reports_no_suites_and_exits_two(capsys):
    rc = main(["bench"])
    captured = capsys.readouterr()
    assert rc == 2
    assert captured.out == ""
    assert "no public benchmark suites" in captured.err


def test_bench_json_mode_error_shape(capsys):
    rc = main(["bench", "--json"])
    captured = capsys.readouterr()
    assert rc == 2
    assert captured.out == ""
    err = json.loads(captured.err)
    assert set(err) >= {"code", "message", "remediation"}
    assert err["code"] == 2


def test_explain_and_learn_describe_the_new_bench(capsys):
    assert main(["explain", "bench"]) == 0
    out = capsys.readouterr().out
    assert "public" in out and "No suite is configured" in out
    main(["learn", "--json"])
    payload = json.loads(capsys.readouterr().out)
    entry = next(e for e in payload["commands"] if e["path"] == ["bench"])
    assert "behavioral" not in entry["summary"]


def test_table_renders_rows_and_verdict():
    row = Row(case_id="x", category="demo", duration_ms=3, failures=[])
    suite = SuiteResult(configuration={}, rows=[row])
    assert "PASS" in render(suite)
    bad = Row(case_id="y", category="demo", duration_ms=1, failures=["boom"])
    assert "FAIL (1 of 1)" in render(SuiteResult(configuration={}, rows=[bad]))


def test_run_task_drives_the_stub_adapter(tmp_path):
    checkout = tmp_path / "co"
    checkout.mkdir()
    task = {
        "id": "t",
        "prompt": "hi",
        "checkout": str(checkout),
        "session_id": "bench-t-1",
        "export_dir": str(tmp_path / "export"),
    }
    harness, result, duration_ms, error = run_task(get_harness("stub"), task, tmp_path)
    assert error is None and result and duration_ms >= 0
    config = bench_config.describe("stub", harness, result)
    assert config["harness"] == "stub"
    assert config["plumbing_only"] is True


def test_configuration_never_carries_a_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("ASSOCIATE_API_KEY", "sk-thisisaverysecretkey0123456789")
    config = bench_config.describe("stub", None, {})
    blob = json.dumps(config)
    assert "sk-thisisaverysecretkey0123456789" not in blob
    assert "api_key" not in blob.lower()
