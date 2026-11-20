"""The measured colleague run in which no fact passed, replayed under strict (plan t9; spec h22).

``tests/fixtures/accuracy/strict_colleague_no_fact_passed_export/`` is the export
the node replay writes (``.pi/extensions/associate/tests/strict-replays.test.ts``
drives the stored old-shape hand-back through the real ``finish`` tool and fails
when its export differs from this directory). It is not hand-written. Here
``associate check`` is run on it and must print the counts the extension wrote.

The 604 replay is node-only; its fixture is checked for stray paths by
``test_accuracy_replays.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from associate.cli import main

EXPORT = Path(__file__).parent / "fixtures" / "accuracy" / "strict_colleague_no_fact_passed_export"


def _check_json(name: str) -> dict:
    return json.loads((EXPORT / name).read_text(encoding="utf-8"))


def test_the_export_holds_the_counts_the_replay_asserts():
    strict = _check_json("check.json")["strict"]
    assert strict["counts"] == {
        "pass": 0,
        "keep_marked": 0,
        "returned": 0,
        "dropped": 10,
        "not_judged": 0,
    }
    assert strict["drop_reasons"] == {"quote_absent": 10, "basis_refused": 1}
    assert _check_json("report.json")["strict"]["dropped"] == {
        "total": 10,
        "by_reason": {"quote_absent": 10},
    }
    answer = (EXPORT / "answer.md").read_text(encoding="utf-8")
    assert "11 items were dropped (10 quote_absent, 1 basis_refused)" in answer
    assert "No fact or conclusion is in the answer." in answer
    items = _check_json("dropped.json")["dropped"]
    assert [i["id"] for i in items] == [f"f{n}" for n in range(1, 11)] + ["v1"]


def test_associate_check_exits_0_and_prints_the_dropped_counts(capsys: pytest.CaptureFixture[str]):
    assert main(["check", str(EXPORT)]) == 0
    out = capsys.readouterr().out
    assert "facts: pass 0  keep_marked 0  returned 0  dropped 10  not_judged 0" in out
    assert "dropped 10: quote_absent 10" in out
    # The strict re-check (evidence-cli) ran and gives the record check.json holds.
    assert "  agrees: yes" in out
    assert "  not compared: none" in out
    assert "  dropped by reason: quote_absent 10, basis_refused 1" in out


def test_associate_check_json_carries_the_same_counts(capsys: pytest.CaptureFixture[str]):
    assert main(["check", str(EXPORT), "--json"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["applicable"] is True
    assert result["python_recheck_ran"] is True
    assert result["python_recheck_agrees"] is True
    assert result["python_recheck_disagreements"] == []
    assert result["strict_recheck"]["recheck"]["counts"]["dropped"] == 10
    strict = result["strict"]
    assert strict["source"] == "extension"
    assert strict["counts"]["dropped"] == 10
    assert strict["dropped"]["total"] == 10
    assert strict["dropped"]["by_reason"] == {"quote_absent": 10, "basis_refused": 1}
    assert strict["report"]["dropped"] == {"total": 10, "by_reason": {"quote_absent": 10}}
