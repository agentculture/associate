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


def test_finish_without_a_final_message_fails_delivery():
    """Deviation d9: a hand-back that never became a final message reaches nobody."""
    from associate.bench import checks

    entries = [
        {"id": "w1", "tool": "read", "args": {"path": "a.py"}},
        {"id": "w2", "tool": "finish", "args": {"summary": "x"}},
    ]
    silent = checks.Artifacts(entries, {"outcome": "ok"}, {"statements": [], "citations": []})
    assert checks._check_delivery(silent)
    spoken = checks.Artifacts(
        entries,
        {"outcome": "ok"},
        {
            "statements": [{"text": "x", "evidence": ["w1"], "status": "referenced"}],
            "citations": [],
        },
    )
    assert checks._check_delivery(spoken) == []
    no_finish = checks.Artifacts(
        entries[:1], {"outcome": "ok"}, {"statements": [], "citations": []}
    )
    assert checks._check_delivery(no_finish) == []


def test_the_argv_shell_named_bash_is_not_a_forbidden_tool():
    """The extension's safe shell overrides Pi's ``bash`` by name (c35); walks may use it."""
    from associate.bench import checks

    assert "bash" not in checks.FORBIDDEN_TOOLS
    assert {"write", "edit", "apply_patch"} <= checks.FORBIDDEN_TOOLS
    walk = checks.Artifacts(
        [{"id": "w1", "tool": "bash", "args": {"argv": ["git", "log"]}}],
        {"outcome": "ok"},
        {"statements": [], "citations": []},
    )
    assert checks._check_forbidden_tools(walk) == []


# ---------------------------------------------------------------------------
# A search expectation is met only by an actual, successful search
# ---------------------------------------------------------------------------


def _artifacts(entries):
    from associate.bench import checks

    return checks.Artifacts(entries, {"outcome": "ok"}, {"statements": [], "citations": []})


def test_a_finish_summary_mentioning_the_term_is_not_a_search():
    """The term comes from the prompt, so it reappears in whatever the model says."""
    from associate.bench import checks

    walk = _artifacts(
        [
            {"id": "w1", "tool": "finish", "args": {"summary": "TIMEOUT_SECONDS is 47"}},
            {"id": "w2", "tool": "bash", "args": {"argv": ["rg", "TIMEOUT_SECONDS", "."]}},
        ]
    )
    assert checks._check_searches({"searches": ["TIMEOUT_SECONDS"]}, walk)


def test_a_failed_grep_does_not_satisfy_a_search_expectation():
    """`tools/search.ts` returns `{"ok": false}` for a refused or failed search."""
    from associate.bench import checks

    structured = _artifacts(
        [
            {
                "id": "w1",
                "tool": "grep",
                "args": {"pattern": "TIMEOUT_SECONDS"},
                "result": {
                    "content": json.dumps({"ok": False, "error": {"code": "search_failed"}})
                },
            }
        ]
    )
    assert checks._check_searches({"searches": ["TIMEOUT_SECONDS"]}, structured)

    flagged = _artifacts(
        [
            {
                "id": "w1",
                "tool": "grep",
                "args": {"pattern": "TIMEOUT_SECONDS"},
                "result": {},
                "error": "rg exited with code 2",
            }
        ]
    )
    assert checks._check_searches({"searches": ["TIMEOUT_SECONDS"]}, flagged)


def test_a_successful_grep_satisfies_a_search_expectation():
    from associate.bench import checks

    walk = _artifacts(
        [
            {
                "id": "w1",
                "tool": "grep",
                "args": {"pattern": "TIMEOUT_SECONDS", "path": "."},
                "result": {"content": json.dumps({"ok": True, "matches": ["src/c.py:3:x"]})},
            }
        ]
    )
    assert checks._check_searches({"searches": ["TIMEOUT_SECONDS"]}, walk) == []


def test_a_successful_find_satisfies_a_search_expectation():
    from associate.bench import checks

    walk = _artifacts([{"id": "w1", "tool": "find", "args": {"pattern": "constants", "path": "."}}])
    assert checks._check_searches({"searches": ["constants"]}, walk) == []


# ---------------------------------------------------------------------------
# Citation coverage: a read's recorded range, honestly read
# ---------------------------------------------------------------------------


def _read(args, content=None):
    entry = {"id": "w1", "tool": "read", "args": args}
    if content is not None:
        entry["result"] = {"content": content}
    return entry


def test_a_bounded_pi_read_does_not_cover_a_line_outside_its_window():
    """`start_line`/`end_line` are inclusive, and they bound what was seen."""
    from associate.bench import checks

    walk = _artifacts([_read({"path": "a.py", "start_line": 100, "end_line": 150})])
    assert checks._covered(walk, "a.py", 200) is False
    assert checks._covered(walk, "a.py", 120) is True
    assert checks._covered(walk, "a.py", 100) is True
    assert checks._covered(walk, "a.py", 150) is True, "end_line is inclusive"
    assert checks._covered(walk, "a.py", 151) is False


def test_an_unbounded_pi_read_covers_only_the_read_budget():
    """A read with no `end_line` is bounded by `policy.budgets.read.max_lines`."""
    from associate import contract
    from associate.bench import checks

    max_lines = contract.load_policy()["budgets"]["read"]["max_lines"]
    walk = _artifacts([_read({"path": "a.py", "start_line": 1})])
    assert checks._covered(walk, "a.py", max_lines) is True
    assert checks._covered(walk, "a.py", max_lines + 1) is False


def test_an_unbounded_read_covers_more_when_the_content_proves_it():
    """The stamped line numbers in the result are the honest record of what was seen."""
    from associate import contract
    from associate.bench import checks

    max_lines = contract.load_policy()["budgets"]["read"]["max_lines"]
    stamped = "".join(f"{number}\tline\n" for number in (1, 2, max_lines + 7))
    walk = _artifacts([_read({"path": "a.py", "start_line": 1}, stamped)])
    assert checks._covered(walk, "a.py", max_lines + 7) is True
    assert checks._covered(walk, "a.py", max_lines + 8) is False


def test_the_offset_limit_vocabulary_of_the_stub_still_works():
    from associate.bench import checks

    walk = _artifacts([_read({"path": "a.py", "offset": 1, "limit": 40})])
    assert checks._covered(walk, "a.py", 40) is True
    assert checks._covered(walk, "a.py", 41) is False


def test_a_citation_outside_every_read_range_is_a_failure():
    from associate.bench import checks

    artifacts = checks.Artifacts(
        [_read({"path": "a.py", "start_line": 1, "end_line": 10})],
        {"outcome": "ok"},
        {
            "statements": [],
            "citations": [{"path": "a.py", "line": 200, "check": "encountered"}],
        },
    )
    failures = checks._check_citations({"citations": [{"path": "a.py", "line": 200}]}, artifacts)
    assert failures and "encountered" in failures[0]


# ---------------------------------------------------------------------------
# A fixture key may never write outside its checkout
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("escaping", ["../x", "/etc/x", "a/../../x", ".", "..", "a//b", ""])
def test_an_escaping_fixture_path_is_refused(escaping, tmp_path):
    case = corpus.Case(
        id="escaper",
        category="local read/find",
        title="t",
        prompt="p",
        fixture_files={escaping: "pwned"},
    )
    with pytest.raises(corpus.CorpusError):
        corpus.materialize(case, tmp_path / "checkout")
    assert not (tmp_path / "x").exists()


def test_the_strict_loader_refuses_an_escaping_fixture_path(tmp_path):
    (tmp_path / "bad.json").write_text(
        json.dumps(
            {
                "id": "bad",
                "category": "local read/find",
                "title": "t",
                "prompt": "p",
                "fixture": {"files": {"../escaped.txt": "pwned"}},
                "expect": {},
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(corpus.CorpusError) as excinfo:
        corpus.load_cases(tmp_path)
    assert "escaped.txt" in str(excinfo.value)


def test_a_symlinked_parent_is_not_traversed(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("original", encoding="utf-8")
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    (checkout / "link").symlink_to(outside, target_is_directory=True)

    case = corpus.Case(
        id="symlinker",
        category="local read/find",
        title="t",
        prompt="p",
        fixture_files={"link/keep.txt": "pwned"},
    )
    with pytest.raises(corpus.CorpusError):
        corpus.materialize(case, checkout)
    assert (outside / "keep.txt").read_text(encoding="utf-8") == "original"


def test_a_normal_nested_fixture_path_is_written(tmp_path):
    case = corpus.Case(
        id="ok",
        category="local read/find",
        title="t",
        prompt="p",
        fixture_files={"src/deep/constants.py": "TIMEOUT_SECONDS = 47\n"},
    )
    checkout = corpus.materialize(case, tmp_path / "checkout")
    assert (checkout / "src" / "deep" / "constants.py").read_text(encoding="utf-8").strip()
