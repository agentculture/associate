"""``associate bench`` — public suites as data (t18); in-house corpus gone (t9).

No case or check remains. The verb stays contract-compliant: with no public
suite configured it reports that on stderr and exits 2 (setup incomplete) —
never a vacuous pass. The kept plumbing (runner types, table, config stamp)
is exercised directly.
"""

import json
import os
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


def _fake_suites(tmp_path, monkeypatch, extra=()):
    """A fake upstream runner on PATH that writes a result file; suites by data."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake = bindir / "fake-upstream"
    fake.write_text(
        "#!/usr/bin/env python3\nimport sys, json, os\n"
        "out, model = sys.argv[1], sys.argv[2]\n"
        "print('upstream progress: 1/1 done', flush=True)\n"
        "print('upstream warning', file=sys.stderr, flush=True)\n"
        "os.makedirs(out, exist_ok=True)\n"
        "json.dump({'acc': 42.5, 'seen': [model, os.environ.get('FAKE_BASE')]},"
        " open(os.path.join(out, 'res.json'), 'w'))\n"
    )
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")

    def suite(name, models):
        return {
            "name": name,
            "version": f"{name}-1.2",
            "homepage": "https://example.invalid",
            "runner": {
                "argv": ["fake-upstream", "{output_dir}", "{model}"],
                "env": {"FAKE_BASE": "{base_url}", "FAKE_KEY": "{api_key}"},
            },
            "scorer": {
                "name": "fake-scorer",
                "result": {"file": "{output_dir}/res.json", "format": "json", "path": ["acc"]},
            },
            "models": models,
        }

    entries = [suite("bfcl", ["worker", "senses"]), suite("mmmu", ["worker"])]
    entries += [suite(n, ["worker"]) for n in extra]
    path = tmp_path / "suites.json"
    path.write_text(json.dumps({"version": 1, "suites": entries}))
    monkeypatch.setenv("ASSOCIATE_BENCH_SUITES", str(path))
    return path


def test_shipped_suites_list_the_three_public_ones(capsys):
    assert main(["bench", "--suite", "--json"]) == 0
    names = [s["name"] for s in json.loads(capsys.readouterr().out)["suites"]]
    assert {"bfcl", "mmmu", "livecodebench"} <= set(names)
    assert main(["bench", "--suite"]) == 0
    assert "livecodebench" in capsys.readouterr().out


def test_livecodebench_excludes_senses(capsys):
    rc = main(["bench", "--suite", "livecodebench", "--model", "senses"])
    assert rc == 1
    assert "worker, cortex" in capsys.readouterr().err


def test_fourth_suite_by_data_alone(tmp_path, monkeypatch, capsys):
    _fake_suites(tmp_path, monkeypatch, extra=("fourth",))
    main(["bench", "--suite", "--json"])
    names = [s["name"] for s in json.loads(capsys.readouterr().out)["suites"]]
    assert "fourth" in names
    assert main(["bench", "--suite", "fourth", "--model", "worker", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["suite"] == "fourth"


def test_row_carries_suite_version_scorer_and_config_stamp(tmp_path, monkeypatch, capsys):
    _fake_suites(tmp_path, monkeypatch)
    monkeypatch.setenv("ASSOCIATE_BASE_URL", "http://gw.invalid:8001/v1")
    monkeypatch.setenv("ASSOCIATE_API_KEY", "sk-thisisaverysecretkey0123456789")
    rc = main(
        [
            "bench",
            "--suite",
            "bfcl",
            "--model",
            "senses",
            "--json",
            "--output-dir",
            str(tmp_path / "out"),
        ]
    )
    captured = capsys.readouterr()
    assert rc == 0
    row = json.loads(captured.out)
    assert (row["suite"], row["suite_version"], row["scorer"]) == (
        "bfcl",
        "bfcl-1.2",
        "fake-scorer",
    )
    assert row["score"] == 42.5 and row["model"] == "senses" and row["lobes_role"] == "senses"
    assert row["configuration"]["provider"] == "http://gw.invalid:8001/v1"
    assert "pi_version" in row["configuration"]
    assert "sk-thisisaverysecretkey" not in captured.out + captured.err
    assert main(["bench", "--suite", "bfcl", "--model", "worker"]) == 0
    assert "bfcl-1.2" in capsys.readouterr().out


def test_upstream_stdout_goes_to_stderr_and_json_stdout_parses(tmp_path, monkeypatch, capfd):
    """CLI invariant 1: the child's progress is a diagnostic, never a result."""
    _fake_suites(tmp_path, monkeypatch)
    rc = main(["bench", "--suite", "bfcl", "--model", "worker", "--json"])
    captured = capfd.readouterr()
    assert rc == 0
    assert captured.out.count("\n") == 1
    assert json.loads(captured.out)["suite"] == "bfcl"
    assert "upstream progress: 1/1 done" in captured.err
    assert "upstream warning" in captured.err


def test_bench_base_url_default_comes_from_the_contract(tmp_path, monkeypatch, capsys):
    from associate import contract

    _fake_suites(tmp_path, monkeypatch)
    monkeypatch.delenv("ASSOCIATE_BASE_URL", raising=False)
    registry = json.loads(json.dumps(contract.load_models()))
    registry["endpoint"]["default_base_url"] = "http://moved.invalid:9/v1"
    monkeypatch.setattr(contract, "load_models", lambda: registry)
    out = tmp_path / "out"
    assert (
        main(["bench", "--suite", "bfcl", "--model", "worker", "--json", "--output-dir", str(out)])
        == 0
    )
    capsys.readouterr()
    seen = json.loads((out / "res.json").read_text())["seen"]
    assert seen[1] == "http://moved.invalid:9/v1"


def test_user_errors_name_valid_choices(tmp_path, monkeypatch, capsys):
    _fake_suites(tmp_path, monkeypatch)
    assert main(["bench", "--suite", "nope", "--model", "worker"]) == 1
    assert "bfcl" in capsys.readouterr().err
    assert main(["bench", "--suite", "bfcl", "--model", "super-vl"]) == 1
    assert "worker" in capsys.readouterr().err
    assert main(["bench", "--suite", "mmmu", "--model", "senses"]) == 1
    assert main(["bench", "--suite", "bfcl"]) == 1


def test_missing_upstream_binary_is_exit_two_without_traceback(tmp_path, monkeypatch, capsys):
    path = _fake_suites(tmp_path, monkeypatch)
    data = json.loads(path.read_text())
    data["suites"][0]["runner"]["argv"][0] = "no-such-upstream-binary"
    data["suites"][0]["install_hint"] = "pip install the-thing"
    path.write_text(json.dumps(data))
    assert main(["bench", "--suite", "bfcl", "--model", "worker"]) == 2
    err = capsys.readouterr().err
    assert "pip install the-thing" in err and "Traceback" not in err


def test_malformed_suites_file_is_exit_two(tmp_path, monkeypatch, capsys):
    bad = tmp_path / "s.json"
    bad.write_text(json.dumps({"suites": [{"name": "x"}]}))
    monkeypatch.setenv("ASSOCIATE_BENCH_SUITES", str(bad))
    assert main(["bench", "--suite"]) == 2


def test_csv_score_parsing(tmp_path):
    from associate.bench.public import _parse_score

    f = tmp_path / "o.csv"
    f.write_text("Model,Overall Acc\nm,85.3%\n")
    spec = {"format": "csv", "column": "Overall Acc", "row": 0}
    assert _parse_score(spec, f) == 85.3


def test_explain_and_learn_describe_the_new_bench(capsys):
    assert main(["explain", "bench"]) == 0
    out = capsys.readouterr().out
    assert "--suite" in out and "BFCL" in out
    main(["learn", "--json"])
    payload = json.loads(capsys.readouterr().out)
    entry = next(e for e in payload["commands"] if e["path"] == ["bench"])
    assert "--suite" in entry["summary"]


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
