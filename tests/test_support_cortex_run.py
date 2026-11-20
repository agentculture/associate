"""The one recorded cortex run with the support score on (plan task t12).

The export of that run, made on 2026-11-20 in report mode, is committed as a
fixture so the plan's first live-run criterion can be read by anyone: every
fact whose quote was found carries a support record. It is one run on an easy
task and says nothing about how the answers go on harder facts.
"""

from __future__ import annotations

import json
from pathlib import Path

from associate.accuracy import inspect_export
from associate.contract import load_accuracy

EXPORT = Path(__file__).parent / "fixtures" / "accuracy" / "cortex_support_score_on_export"


def _load(name: str) -> dict:
    return json.loads((EXPORT / name).read_text(encoding="utf-8"))


def test_every_quote_found_fact_carries_a_support_record() -> None:
    facts = _load("check.json")["facts"]
    assert len(facts) == 3
    for fact in facts:
        assert fact["support"]["status"] == "scored"
        assert fact["support"]["answer"] == "all"


def test_the_report_counts_the_scored_facts_per_option() -> None:
    report = _load("report.json")
    assert report["support_scored"] == 3
    assert report["support_answers"] == {"all": 3, "mostly": 0, "part": 0, "little": 0, "none": 0}


def test_the_python_recheck_reads_the_export_and_passes_the_three_facts() -> None:
    inspected = inspect_export(EXPORT, load_accuracy())
    assert inspected["report"]["facts"]["passed"] == 3
    assert inspected["report"]["facts"]["refused"] == 0


def test_the_fixture_names_no_machine_path() -> None:
    for path in EXPORT.rglob("*"):
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            assert "/home/" not in text and "/tmp/" not in text, path.name
