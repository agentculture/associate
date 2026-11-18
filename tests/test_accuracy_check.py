"""The Python re-check, the counts and the ``associate check`` verb (issue #20, t16)."""

from __future__ import annotations

import json
import re

import pytest

from associate.accuracy import check as check_mod
from associate.accuracy.check import check_handback, literal_of
from associate.accuracy.counts import count_fact, empty_counts
from associate.bench import walkstats
from associate.cli import main
from associate.cli._commands import learn
from associate.contract import contract_dir, load_accuracy
from associate.explain import catalog

ACCURACY = load_accuracy()
VECTORS = json.loads((contract_dir() / "matcher_vectors.json").read_text(encoding="utf-8"))


def project(got):
    """The fields the shared vectors compare (fix texts are not compared)."""
    return {
        "accepted": got["accepted"],
        "facts": [
            {
                k: f[k]
                for k in (
                    "id",
                    "run",
                    "verdict",
                    "reason",
                    "check",
                    "nearest",
                    "source_kind",
                    "first_hand",
                )
            }
            for f in got["facts"]
        ],
        "verdicts": [
            {k: v[k] for k in ("id", "outcome", "reason", "check")} for v in got["verdicts"]
        ],
        "open_items": [
            {k: v[k] for k in ("id", "outcome", "reason", "check")} for v in got["open_items"]
        ],
        "report": got["report"],
    }


@pytest.mark.parametrize("case", VECTORS["handback_cases"], ids=lambda c: c["name"][:50])
def test_python_checker_reproduces_every_handback_vector(case):
    assert project(check_handback(case["input"], ACCURACY)) == case["expect"]


# --- review fixes: number and boolean literals, a broken contract, malformed children --------


@pytest.mark.parametrize("case", VECTORS["literal_cases"], ids=lambda c: repr(c["value"]))
def test_literal_of_matches_the_shared_literal_cases(case):
    assert literal_of(case["value"]) == case["literal"]


def test_literal_of_treats_non_finite_and_overflowing_numbers_as_no_literal():
    assert literal_of(float("inf")) is None
    assert literal_of(float("nan")) is None
    assert literal_of(10**400) is None


@pytest.mark.parametrize("case", VECTORS["contract_cases"], ids=lambda c: c["name"])
def test_a_broken_min_quote_length_fails_closed_as_in_typescript(case):
    contract = dict(ACCURACY)
    if "min_quote_length" in case:
        contract["min_quote_length"] = case["min_quote_length"]
    else:
        del contract["min_quote_length"]
    got = check_handback(VECTORS["contract_input"], contract)
    assert {
        "accepted": got["accepted"],
        "facts": [{k: f[k] for k in ("id", "verdict", "reason", "check")} for f in got["facts"]],
        "verdicts": [
            {k: v[k] for k in ("id", "outcome", "reason", "check")} for v in got["verdicts"]
        ],
        "flags": got["report"]["flags"],
    } == case["expect"]


def test_a_child_label_with_a_trailing_newline_is_skipped():
    handback = {
        "payload": {"facts": []},
        "entries": [],
        "results": {},
        "children": [{"label": "c1\n", "payload": {}, "entries": [], "results": {}}],
    }
    assert check_handback(handback, ACCURACY)["report"]["children"] == []


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
        (export / check_mod.FACTS_FILENAME).write_text(json.dumps(facts), encoding="utf-8")
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
    assert rc == 0 and err == ""
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
    assert by_id["f3"]["verdict"] == "unchecked" and by_id["f3"]["source_kind"] == "tool"
    assert by_id["f5"]["source_kind"] is None


def test_calls_report_purpose_and_outcome(tmp_path, capsys):
    result = json.loads(run_check(capsys, str(fixture(tmp_path)), "--json")[1])
    calls = {c["id"]: c for c in result["calls"]}
    assert calls["w1"]["purpose"] == "read the config" and calls["w1"]["outcome"] == "ok"
    assert calls["w4"]["purpose"] is None and calls["w4"]["outcome"] == "error"
    text = run_check(capsys, str(fixture(tmp_path / "again")))[1]
    assert "read the config" in text and "source kind: file" in text and "unchecked" in text


def test_count_fact_never_adds_unchecked_to_passed():
    counts = empty_counts()
    for verdict in ("unchecked", "unchecked", "passed", "refused"):
        count_fact(counts, verdict)
    assert counts == {"made": 4, "checked": 2, "passed": 1, "refused": 1, "unchecked": 2}


def test_a_partial_entry_is_unchecked_not_passed(tmp_path, capsys):
    entries = [entry(1, "read", "file", partial=True)]
    facts = {"facts": [{"id": "f1", "value": "lazy", "source": "w1", "quote": "over the lazy dog"}]}
    export = write_export(tmp_path, entries, {1: "over the lazy dog and more"}, facts)
    report = json.loads(run_check(capsys, str(export), "--json")[1])["report"]
    assert report["facts"]["passed"] == 0 and report["facts"]["unchecked"] == 1


# --- exports written before this change ---------------------------------------------


def test_an_old_export_is_read_and_its_facts_are_not_applicable(tmp_path, capsys):
    old = write_export(tmp_path, [entry(1, "read", "file", saved=False)], {}, marker=False)
    rc, out, err = run_check(capsys, str(old), "--json")
    assert rc == 0 and err == ""
    result = json.loads(out)
    assert result["applicable"] is False and result["facts"] == [] and result["report"] is None
    assert "pre-change" in result["not_applicable_reason"]
    assert [c["id"] for c in result["calls"]] == ["w1"]
    text = run_check(capsys, str(old))[1]
    assert "not applicable" in text


def test_a_new_walk_without_a_facts_file_is_not_applicable(tmp_path, capsys):
    export = write_export(tmp_path, [entry(1, "read", "file", saved=False)], {})
    result = json.loads(run_check(capsys, str(export), "--json")[1])
    assert result["applicable"] is False and "facts.json" in result["not_applicable_reason"]


def test_a_saved_result_path_outside_results_is_never_read(tmp_path):
    export = write_export(
        tmp_path, [entry(1, "read", "file", saved=False, saved_result="../secret.txt")], {}
    )
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    assert check_mod.load_export(export)["results"] == {}


def test_bad_inputs_raise_a_cli_error_not_a_traceback(tmp_path, capsys):
    rc, out, err = run_check(capsys, str(tmp_path / "missing"), "--json")
    assert rc == 1 and out == ""
    assert set(json.loads(err)) == {"code", "message", "remediation"}
    export = write_export(tmp_path, [], {}, name="bad")
    (export / "facts.json").write_text("{not json", encoding="utf-8")
    rc, _, err = run_check(capsys, str(export), "--json")
    assert rc == 1 and "facts.json" in json.loads(err)["message"]


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
    assert record["complete"] is False and record["tool_calls"] == 2
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


def test_a_source_reference_with_a_trailing_newline_is_malformed_as_in_typescript():
    """`$` alone would let "w1\\n" through in Python; the TypeScript pattern does not."""
    from associate.accuracy import check

    for ref in ("w1\n", "prior:w3\n"):
        parsed = check.parse_source_ref(ref)
        assert parsed.get("ok") is not True, ref
