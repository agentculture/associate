"""The ``associate check`` verb and walkstats (issue #20, t16).

The checker, the counts and the matcher behind the verb moved to evidence-cli
and are tested there; this file tests associate's own verb over exports built
by hand, and walkstats.
"""

from __future__ import annotations

import json
import re

from associate.bench import walkstats
from associate.cli import main
from associate.cli._commands import learn
from associate.explain import catalog

# --- a fixture export with a hand count -------------------------------------------

FORMAT_LINE = {"format": {"name": "associate-walk", "version": 2}}


def entry(n, tool, kind, *, saved=True, purpose=None, **extra):
    e = {
        "id": f"w{n}",
        "ts": "2026-11-17T10:00:00Z",
        "tool": tool,
        "args": {},
        "result": {},
        "truncated": False,
        "source_kind": kind,
    }
    if purpose is not None:
        e["purpose"] = purpose
    if saved:
        e["saved_result"] = f"results/w{n}.txt"
    e.update(extra)
    return e


def write_export(root, entries, results, facts=None, *, marker=True, name="export"):
    export = root / name
    (export / "results").mkdir(parents=True)
    lines = (
        ([FORMAT_LINE] if marker else [])
        + entries
        + [
            {
                "run": {
                    "duration_ms": 1,
                    "tool_calls": len(entries),
                    "outcome": "ok",
                    "truncated": False,
                }
            }
        ]
    )
    (export / "walk.jsonl").write_text(
        "\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8"
    )
    for n, text in results.items():
        (export / "results" / f"w{n}.txt").write_text(text, encoding="utf-8")
    if facts is not None:
        (export / "facts.json").write_text(json.dumps(facts), encoding="utf-8")
    return export


def fixture(root):
    entries = [
        entry(1, "read", "file", purpose="read the config"),
        entry(2, "grep", "tool", saved=False, purpose="find the call"),
        entry(3, "bash", "tool", purpose="run the check"),
        entry(4, "ledger_append", "tool", saved=False, error="refused: gate", partial=True),
    ]
    results = {1: "The quick brown fox jumps over the lazy dog", 3: "tests passed: 12 of 12"}
    facts = {
        "facts": [
            {
                "id": "f1",
                "value": "lazy",
                "source": "w1",
                "quote": "over the lazy dog",
            },  # file passed
            {
                "id": "f2",
                "value": "leaps",
                "source": "w1",
                "quote": "brown fox leaps",
            },  # file refused
            {
                "id": "f3",
                "value": "hit",
                "source": "w2",
                "quote": "some grep output",
            },  # tool unchecked
            {
                "id": "f4",
                "value": "12",
                "source": "w3",
                "quote": "tests passed: 12 of 12",
            },  # tool passed
            {
                "id": "f5",
                "value": "x",
                "source": "nowhere",
                "quote": "whatever it was",
            },  # no kind, refused
        ]
    }
    return write_export(root, entries, results, facts)


def run_check(capsys, *argv):
    rc = main(["check", *argv])
    captured = capsys.readouterr()
    return rc, captured.out, captured.err


def test_counts_match_a_hand_count_and_unchecked_is_never_passed(tmp_path, capsys):
    export = fixture(tmp_path)
    rc, out, err = run_check(capsys, str(export), "--json")
    assert rc == 0
    assert err == ""
    result = json.loads(out)
    report = result["report"]
    # Hand count: 5 facts; f1 and f4 passed, f2 and f5 refused, f3 unchecked.
    assert report["facts"] == {"made": 5, "checked": 4, "passed": 2, "refused": 2, "unchecked": 1}
    assert report["by_source_kind"]["file"] == {
        "made": 2,
        "checked": 2,
        "passed": 1,
        "refused": 1,
        "unchecked": 0,
    }
    assert report["by_source_kind"]["tool"] == {
        "made": 2,
        "checked": 1,
        "passed": 1,
        "refused": 0,
        "unchecked": 1,
    }
    for kind in ("web", "memory", "agent", "harness"):
        assert report["by_source_kind"][kind]["made"] == 0
    assert report["python_recheck_ran"] is True
    by_id = {f["id"]: f for f in result["facts"]}
    assert by_id["f3"]["verdict"] == "unchecked"
    assert by_id["f3"]["source_kind"] == "tool"
    assert by_id["f5"]["source_kind"] is None


def test_calls_report_purpose_and_outcome(tmp_path, capsys):
    result = json.loads(run_check(capsys, str(fixture(tmp_path)), "--json")[1])
    calls = {c["id"]: c for c in result["calls"]}
    assert calls["w1"]["purpose"] == "read the config"
    assert calls["w1"]["outcome"] == "ok"
    assert calls["w4"]["purpose"] is None
    assert calls["w4"]["outcome"] == "error"
    text = run_check(capsys, str(fixture(tmp_path / "again")))[1]
    assert "read the config" in text
    assert "source kind: file" in text
    assert "unchecked" in text


def test_a_partial_entry_is_unchecked_not_passed(tmp_path, capsys):
    entries = [entry(1, "read", "file", partial=True)]
    facts = {"facts": [{"id": "f1", "value": "lazy", "source": "w1", "quote": "over the lazy dog"}]}
    export = write_export(tmp_path, entries, {1: "over the lazy dog and more"}, facts)
    report = json.loads(run_check(capsys, str(export), "--json")[1])["report"]
    assert report["facts"]["passed"] == 0
    assert report["facts"]["unchecked"] == 1


# --- exports written before this change ---------------------------------------------


def test_an_old_export_is_read_and_its_facts_are_not_applicable(tmp_path, capsys):
    old = write_export(tmp_path, [entry(1, "read", "file", saved=False)], {}, marker=False)
    rc, out, err = run_check(capsys, str(old), "--json")
    assert rc == 0
    assert err == ""
    result = json.loads(out)
    assert result["applicable"] is False
    assert result["facts"] == []
    assert result["report"] is None
    assert "pre-change" in result["not_applicable_reason"]
    assert [c["id"] for c in result["calls"]] == ["w1"]
    text = run_check(capsys, str(old))[1]
    assert "not applicable" in text


def test_a_new_walk_without_a_facts_file_is_not_applicable(tmp_path, capsys):
    export = write_export(tmp_path, [entry(1, "read", "file", saved=False)], {})
    result = json.loads(run_check(capsys, str(export), "--json")[1])
    assert result["applicable"] is False
    assert "facts.json" in result["not_applicable_reason"]


def test_bad_inputs_raise_a_cli_error_not_a_traceback(tmp_path, capsys):
    rc, out, err = run_check(capsys, str(tmp_path / "missing"), "--json")
    assert rc == 1
    assert out == ""
    assert set(json.loads(err)) == {"code", "message", "remediation"}
    export = write_export(tmp_path, [], {}, name="bad")
    (export / "facts.json").write_text("{not json", encoding="utf-8")
    rc, _, err = run_check(capsys, str(export), "--json")
    assert rc == 1
    assert "facts.json" in json.loads(err)["message"]


# --- walkstats ------------------------------------------------------------------------


def test_walkstats_does_not_count_the_format_marker_as_a_call(tmp_path):
    walk = tmp_path / "walk.jsonl"
    lines = [
        FORMAT_LINE,
        entry(1, "read", "file"),
        entry(2, "grep", "tool"),
    ]  # killed: no run record
    walk.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    record = walkstats.load_run_record(walk)
    assert record["complete"] is False
    assert record["tool_calls"] == 2
    old = tmp_path / "old" / "walk.jsonl"
    old.parent.mkdir()
    old.write_text("\n".join(json.dumps(x) for x in lines[1:]) + "\n", encoding="utf-8")
    assert walkstats.load_run_record(old)["tool_calls"] == 2


def test_walkstats_keeps_an_outcome_it_does_not_know_by_name():
    stats = walkstats.aggregate([{"outcome": "ok"}, {"outcome": "facts_refused"}, {}])
    row = stats.as_dict()
    assert row["outcomes"] == {"ok": 1, "incomplete": 1, "facts_refused": 1}
    assert row["failures"] == 2


# --- wording ------------------------------------------------------------------------------


def test_no_output_calls_the_quote_checked_count_accuracy(tmp_path, capsys):
    export = fixture(tmp_path)
    texts = [
        run_check(capsys, str(export))[1],
        run_check(capsys, str(export), "--json")[1],
        catalog.ENTRIES[("check",)],
        learn._TEXT,
        json.dumps(learn._as_json_payload()),
    ]
    old = write_export(tmp_path, [], {}, marker=False, name="old")
    texts.append(run_check(capsys, str(old))[1])
    for text in texts:
        assert not re.search(r"accura", text, re.IGNORECASE), text[:80]


def test_the_verb_is_documented_in_learn_and_explain():
    assert "associate check" in learn._TEXT
    assert any(c["path"] == ["check"] for c in learn._as_json_payload()["commands"])
    assert ("check",) in catalog.ENTRIES
